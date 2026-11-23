/**
 * Common fields of library items, `LibraryItemKind`, `MaterialClass` and shared model helpers.
 * Doc: docs/architecture/library.md#common-fields
 */
import { z } from 'zod'
import type { InvariantChecker } from '../../shared/model'
import { collect, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import { Quantity } from '../quantity/quantity'
import { QuantityDtoSchema, type QuantityDTO } from '../quantity/quantity.dto'
import { Rational } from '../quantity/rational'
import type { QuantityKind } from '../quantity/units'

export const LIBRARY_ITEM_KINDS = ['stock', 'tool', 'machine'] as const
export type LibraryItemKind = (typeof LIBRARY_ITEM_KINDS)[number]
export const LibraryItemKindSchema = z.enum(LIBRARY_ITEM_KINDS)

/** Fixed enum; users cannot add classes (docs/architecture/library.md#stock). */
export const MATERIAL_CLASSES = [
  'softwood',
  'hardwood',
  'sheetGood',
  'plastic',
  'aluminum',
  'brass',
  'steel',
  'other',
] as const
export type MaterialClass = (typeof MATERIAL_CLASSES)[number]
export const MaterialClassSchema = z.enum(MATERIAL_CLASSES)

/**
 * A material class in words, lower case, for core-built visible text (reasons, warnings): never
 * the enum key (DF44; ui.md § Copy and terminology). The renderer's own labels are capitalized.
 */
export const MATERIAL_CLASS_WORDS: Record<MaterialClass, string> = {
  softwood: 'softwood',
  hardwood: 'hardwood',
  sheetGood: 'sheet good',
  plastic: 'plastic',
  aluminum: 'aluminium',
  brass: 'brass',
  steel: 'steel',
  other: 'other',
}

export const NAME_MAX = 120
export const NOTES_MAX = 4000
/**
 * Ids are file names (`<id>.json`), so they are restricted to a path-safe, lowercase alphabet:
 * on case-insensitive file systems (APFS, NTFS) `Tool-1` and `tool-1` would be the same file.
 */
export const ITEM_ID_PATTERN = /^[a-z0-9_-]{1,120}$/
export const ITEM_ID_RULE = 'must be 1–120 lowercase letters, digits, _ or -'

// The pattern states the characters; repeating them costs tools/list size (llm-api.md#implementation-task-310).
export const ItemIdSchema = z.string().regex(ITEM_ID_PATTERN).describe('Library item id')

/**
 * `id`, `revision`, `updatedAt` and a stock variant's `parentId`: library bookkeeping, not part of
 * a snapshot's `values` (library.md#stock-variants-df13).
 */
export const ItemMetaDtoSchema = z.object({
  id: ItemIdSchema,
  revision: z.number().int().min(1).describe('Increments by 1 on every write'),
  updatedAt: z.iso.datetime({ offset: true }).describe('ISO 8601 time of the last write'),
  parentId: ItemIdSchema.optional().describe('Stock variants: the parent stock'),
})
export type ItemMetaDTO = z.output<typeof ItemMetaDtoSchema>

/** `name` and `notes`, shared by all value schemas. */
export const commonValuesShape = {
  name: z.string().min(1).max(NAME_MAX).describe('Display label; also in gCode comments'),
  notes: z.string().max(NOTES_MAX).optional(),
}

/** A quantity DTO restricted to one kind (shape check, so agents see the kind in the schema). */
export function quantityDto<K extends QuantityKind>(kind: K) {
  return QuantityDtoSchema.extend({ kind: z.literal(kind) })
}

// ── model helpers ──────────────────────────────────────────────────────────────────────────

/** Common name/notes rules inside a constructor's `invariants()` body. */
export function checkNameAndNotes(c: InvariantChecker, name: string, notes: Option<string>): void {
  checkText(c, ['name'], name, 1, NAME_MAX)
  if (notes.isSome()) checkText(c, ['notes'], notes.unwrap(), 0, NOTES_MAX)
}

export function checkText(
  c: InvariantChecker,
  path: readonly (string | number)[],
  value: string,
  min: number,
  max: number,
): void {
  c.check(
    value.length >= min && value.length <= max,
    path,
    'length',
    `must be ${min} to ${max} characters`,
    { min, max, actual: value.length },
  )
}

/** Kind check; returns whether the kind fits, so value rules are skipped for a wrong kind. */
export function checkKind(
  c: InvariantChecker,
  path: readonly (string | number)[],
  q: Quantity,
  kind: QuantityKind,
): boolean {
  c.check(q.kind === kind, path, 'quantityKind', `must be a ${kind}`, { kind, actual: q.kind })
  return q.kind === kind
}

/** `kind` and `> 0`. */
export function checkPositive(
  c: InvariantChecker,
  path: readonly (string | number)[],
  q: Quantity,
  kind: QuantityKind,
): void {
  if (!checkKind(c, path, q, kind)) return
  c.check(isPositive(q), path, 'positive', 'must be greater than 0', { actual: q.canonical })
}

export const isPositive = (q: Quantity): boolean => q.exact.compare(Rational.ZERO) > 0

/** Exact comparison in the canonical unit (same kind assumed). */
export const lessThan = (a: Quantity, b: Quantity): boolean => a.exact.compare(b.exact) < 0

/** `Option<T>` ↔ optional DTO field. */
export function optionalField<K extends string, T>(key: K, v: Option<T>): { [P in K]?: T } {
  return (v.isSome() ? { [key]: v.unwrap() } : {}) as { [P in K]?: T }
}

export const toOption = <T>(v: T | undefined): Option<T> => (v === undefined ? None : Some(v))

/** Quantity from DTO with issues prefixed by `path`. */
export function quantityFromDTO(
  dto: QuantityDTO,
  ...path: (string | number)[]
): AppResult<Quantity> {
  return Quantity.fromDTO(dto).mapErr((e) => e.prefixIssues(...path))
}

export function optionalQuantityFromDTO(
  dto: QuantityDTO | undefined,
  ...path: (string | number)[]
): AppResult<Option<Quantity>> {
  if (dto === undefined) return Ok(None)
  return quantityFromDTO(dto, ...path).map((q) => Some(q))
}

type OkOf<R> = R extends AppResult<infer T> ? T : never

/**
 * Like `collect()` for a record of results: all `model.invariant` issues are merged (so a form
 * shows every field), any other error short-circuits.
 */
export function collectFields<F extends Record<string, AppResult<unknown>>>(
  fields: F,
): AppResult<{ [K in keyof F]: OkOf<F[K]> }> {
  const keys = Object.keys(fields) as (keyof F & string)[]
  const all = collect(keys.map((k) => fields[k] as AppResult<unknown>))
  if (all.isErr()) return all
  const values = all.unwrap()
  return Ok(
    Object.fromEntries(keys.map((k, i) => [k, values[i]])) as { [K in keyof F]: OkOf<F[K]> },
  )
}

export const optionalQuantityDTO = <K extends string>(
  key: K,
  q: Option<Quantity>,
): { [P in K]?: QuantityDTO } =>
  optionalField(
    key,
    q.map((v) => v.toDTO()),
  )
