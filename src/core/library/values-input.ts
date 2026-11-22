/**
 * Command input of library values: the stored value schema with every quantity as a string
 * (as entered, like every other command), parsed into the stored quantity DTOs.
 * Doc: docs/architecture/library.md#command-input
 *
 * The input schema is derived from the DTO schema, so the two cannot drift: a quantity DTO node
 * (`quantityDto(kind)`) becomes a source string, everything else is kept with its description.
 */
import { z } from 'zod'
import { collect, Ok, type AppResult } from '../../shared/result'
import type { UnitSystem } from '../project/document'
import { MAX_SOURCE_LENGTH, parseLiteral } from '../quantity/parse'
import type { QuantityDTO } from '../quantity/quantity.dto'
import { Quantity } from '../quantity/quantity'
import type { QuantityKind, UnitId } from '../quantity/units'

/** Bare-number unit of a library field for this unit system (forms and command input). */
export function libraryUnit(kind: QuantityKind, units: UnitSystem): UnitId {
  switch (kind) {
    case 'length':
      return units === 'mm' ? 'mm' : 'in'
    case 'feedRate':
      return units === 'mm' ? 'mm/min' : 'in/min'
    case 'spindleSpeed':
      return 'rpm'
    case 'power':
      return 'W'
    case 'angle':
      return 'deg'
    case 'scalar':
      return '1'
  }
}

/** The quantity kind of a `quantityDto(kind)` node, else undefined (structural check). */
function quantityKindOf(s: z.ZodType): QuantityKind | undefined {
  if (!(s instanceof z.ZodObject)) return undefined
  const shape = s.shape as Record<string, z.ZodType>
  const kind = shape['kind']
  if (!('exact' in shape) || !('defaultUnit' in shape) || !(kind instanceof z.ZodLiteral))
    return undefined
  return kind.value as QuantityKind
}

const described = <S extends z.ZodType>(s: S, from: z.ZodType): S =>
  from.description === undefined ? s : s.describe(from.description)

/** The input schema of a value schema: quantity DTOs → `z.string()` (1–256 characters). */
export function valuesInputSchema(s: z.ZodType): z.ZodType {
  if (s instanceof z.ZodOptional)
    return described(valuesInputSchema(s.unwrap() as z.ZodType).optional(), s)
  if (s instanceof z.ZodDefault)
    return described(
      valuesInputSchema(s.unwrap() as z.ZodType).default(s.def.defaultValue as never),
      s,
    )
  if (s instanceof z.ZodArray)
    return described(z.array(valuesInputSchema(s.element as z.ZodType)), s)
  if (quantityKindOf(s) !== undefined) return described(z.string().min(1).max(MAX_SOURCE_LENGTH), s)
  if (s instanceof z.ZodObject) {
    const shape = s.shape as Record<string, z.ZodType>
    const mapped = Object.fromEntries(
      Object.entries(shape).map(([k, v]) => [k, valuesInputSchema(v)]),
    )
    return described(z.object(mapped), s)
  }
  return s
}

/**
 * Parse every quantity string of shape-checked input `value` (against the value schema `s`) into
 * its DTO; bare numbers take `libraryUnit(kind, units)`. Issues are prefixed with their path
 * (`values.diameter`); `model.invariant` issues of all fields are merged, other errors
 * (`quantity.syntax`, `quantity.unit`) are returned for the first field, as `collect()` does.
 */
export function valuesFromInput(
  s: z.ZodType,
  value: unknown,
  units: UnitSystem,
  path: readonly (string | number)[],
): AppResult<unknown> {
  if (s instanceof z.ZodOptional || s instanceof z.ZodDefault)
    return value === undefined
      ? Ok(undefined)
      : valuesFromInput(s.unwrap() as z.ZodType, value, units, path)
  if (s instanceof z.ZodArray && Array.isArray(value))
    return collect(
      value.map((v, i) => valuesFromInput(s.element as z.ZodType, v, units, [...path, i])),
    )
  const kind = quantityKindOf(s)
  if (kind !== undefined && typeof value === 'string')
    return Quantity.parse(value, { kind, defaultUnit: libraryUnit(kind, units) })
      .map((q) => q.toDTO())
      .mapErr((e) => e.prefixIssues(...path))
  if (s instanceof z.ZodObject && typeof value === 'object' && value !== null) {
    const shape = s.shape as Record<string, z.ZodType>
    const entries = Object.entries(value as Record<string, unknown>)
    const parsed = collect(
      entries.map(([k, v]) =>
        shape[k] === undefined ? Ok(v) : valuesFromInput(shape[k], v, units, [...path, k]),
      ),
    )
    return parsed.map((vs) =>
      Object.fromEntries(entries.map(([k], i) => [k, vs[i]]).filter(([, v]) => v !== undefined)),
    )
  }
  return Ok(value)
}

// ── values → command input (the Library window's draft, task L1) ─────────────────────────

/** A stored quantity DTO node (structural: `kind`, `source`, `defaultUnit`, `exact`). */
function isQuantityDto(v: unknown): v is QuantityDTO {
  return (
    typeof v === 'object' &&
    v !== null &&
    'source' in v &&
    'defaultUnit' in v &&
    'exact' in v &&
    'kind' in v
  )
}

/**
 * The quantity's source with its unit written out when the source has none and its bare-number
 * unit differs from `units`' (`1/4` entered in inches → `1/4 in`), so it reads the same with any
 * `units` arg; otherwise the source unchanged. A source that no longer parses is returned as is
 * (the command reports it).
 */
export function sourceFor(q: QuantityDTO, units: UnitSystem): string {
  if (q.defaultUnit === libraryUnit(q.kind, units)) return q.source
  const parsed = parseLiteral(q.source, { kind: q.kind, defaultUnit: q.defaultUnit })
  if (parsed.isErr()) return q.source
  const { end, unit } = parsed.unwrap().nominal
  if (unit.isSome()) return q.source
  return `${q.source.slice(0, end)} ${q.defaultUnit}${q.source.slice(end)}`
}

/**
 * Command input (`values` of `library.<kind>.add` / `.update`) from stored values: every quantity
 * DTO becomes its source (`sourceFor`, so stored sources stay as entered when `units` is the
 * item's own unit system), `kind` is dropped. Doc: docs/architecture/library.md#command-input
 */
export function valuesInputFromDTO(values: object, units: UnitSystem): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (isQuantityDto(v)) return sourceFor(v, units)
    if (Array.isArray(v)) return v.map(walk)
    if (typeof v === 'object' && v !== null)
      return Object.fromEntries(
        Object.entries(v).flatMap(([k, x]) => (x === undefined ? [] : [[k, walk(x)]])),
      )
    return v
  }
  const { kind: _kind, ...rest } = values as Record<string, unknown>
  return walk(rest) as Record<string, unknown>
}

/**
 * The unit system an item was entered in: that of its first length quantity's bare-number unit
 * (`in` → `inch`), else `fallback`. Saving with it keeps unchanged sources byte for byte.
 */
export function itemUnitSystem(values: object, fallback: UnitSystem): UnitSystem {
  const find = (v: unknown): QuantityDTO | undefined => {
    if (isQuantityDto(v)) return v.kind === 'length' ? v : undefined
    if (typeof v !== 'object' || v === null) return undefined
    for (const x of Object.values(v)) {
      const q = find(x)
      if (q !== undefined) return q
    }
    return undefined
  }
  const q = find(values)
  if (q === undefined) return fallback
  return q.defaultUnit === 'in' ? 'inch' : q.defaultUnit === 'mm' ? 'mm' : fallback
}
