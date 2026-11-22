// The Shape Editor's view of a named shape (task U1), pure: stored items as numbers (mm, degrees)
// for the live outline and as sources for command args, the args of one field edit or one handle
// drag (`design.shape.item.update`, sources written in the unit as typed), the items a new shape
// or item starts with, and where a command issue belongs. Commands do the checking.
// Doc: docs/modes/design-v0.3.md#shape-definition, docs/conventions/ui.md#shape-editor
import { itemQuantities, mapItem } from '../../../../core/design/shape'
import type {
  ShapeItem,
  ShapeItemDTO,
  ShapeItemKind,
  ShapeSegment,
} from '../../../../core/design/shape.dto'
import type { UnitSystem } from '../../../../core/project/document'
import { parseLiteral } from '../../../../core/quantity/parse'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import { UNITS } from '../../../../core/quantity/units'
import type { Issue } from '../../../../shared/errors/app-error'
import { isFormula, quantityOf } from './model'

export type ItemNumbers = ShapeItem<number>
export type ItemSources = ShapeItem<string>
type ParamPath = readonly (string | number)[]

/** The item's quantities as numbers (mm, degrees, sides); undefined if a stored value does not load. */
export function itemNumbers(dto: ShapeItemDTO): ItemNumbers | undefined {
  let ok = true
  const out = mapItem(dto, (q: QuantityDTO) => {
    const v = quantityOf(q)
    if (v === undefined) ok = false
    return v?.canonical ?? 0
  })
  return ok ? out : undefined
}

/** The shape's items as numbers (the resolver's definition), or undefined. */
export function definitionNumbers(items: readonly ShapeItemDTO[]): ItemNumbers[] | undefined {
  const out: ItemNumbers[] = []
  for (const dto of items) {
    const n = itemNumbers(dto)
    if (n === undefined) return undefined
    out.push(n)
  }
  return out
}

/** The item as command args: quantities as entered. */
export function itemSources(dto: ShapeItemDTO): ItemSources {
  return mapItem(dto, (q: QuantityDTO) => q.source)
}

/** The DTO quantity at a parameter path (`center.0`, `segments.2.radius`). */
export function quantityAtPath(dto: ShapeItemDTO, path: ParamPath): QuantityDTO | undefined {
  let v: unknown = dto
  for (const seg of path) {
    if (v === null || typeof v !== 'object') return undefined
    v = (v as Record<string | number, unknown>)[seg]
  }
  return v !== null && typeof v === 'object' && 'source' in v ? (v as QuantityDTO) : undefined
}

/** Whether any of these quantities is a formula (its handle is locked: "Remove the formula to drag."). */
export function anyFormula(dto: ShapeItemDTO, paths: readonly ParamPath[]): boolean {
  return paths.some((p) => {
    const q = quantityAtPath(dto, p)
    return q !== undefined && isFormula(q)
  })
}

const setAt = (root: unknown, path: ParamPath, value: unknown): void => {
  let v = root as Record<string | number, unknown>
  for (const seg of path.slice(0, -1)) v = v[seg] as Record<string | number, unknown>
  v[path.at(-1)!] = value
}

/**
 * The `design.shape.item.update` fields of one edited value: a point is sent as its pair, a path
 * as its whole segment (or fillet) list, any other field alone.
 */
export function fieldUpdate(
  dto: ShapeItemDTO,
  path: ParamPath,
  value: unknown,
): Record<string, unknown> {
  const item = structuredClone(itemSources(dto)) as unknown as Record<string, unknown>
  setAt(item, path, value)
  const key = String(path[0])
  return { [key]: item[key] }
}

/**
 * A dragged value as a source in the unit the stored value is written in (a bare number stays
 * bare), rounded to `stepMm` (converted to that unit, 1-2-5 rounded): the field's unit and
 * tolerance stay as typed (ui.md § Shapes: snapping and dragging never change the unit).
 */
export function dragSource(dto: QuantityDTO | undefined, mm: number, stepMm: number): string {
  const kind = dto?.kind ?? 'length'
  const defaultUnit = dto?.defaultUnit ?? 'mm'
  const literal = dto === undefined ? undefined : parseLiteral(dto.source, { kind, defaultUnit })
  const nominal = literal?.isOk() ? literal.unwrap().nominal : undefined
  const unit = nominal?.unit.unwrapOr(defaultUnit) ?? defaultUnit
  const factor = UNITS[unit].factor.toNumber()
  const step = niceStep(stepMm / factor)
  const digits = Math.max(0, -Math.floor(Math.log10(step) + 1e-9))
  const text = String(+(Math.round(mm / factor / step) * step).toFixed(digits))
  if (dto === undefined || nominal === undefined) return text
  return dto.source.slice(0, nominal.start) + text + dto.source.slice(nominal.end)
}

/** The 1-2-5 step at or above `x` (> 0). */
export function niceStep(x: number): number {
  const e = 10 ** Math.floor(Math.log10(x))
  const m = x / e
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e
}

const sameNumber = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9

/**
 * The update fields of a handle drag: every quantity whose number changed gets a source in its
 * written unit (`dragSource`), and the flags that changed (an arc's `large`) are copied; fields
 * that did not change are left out (one point → its pair, a segment → the segment list).
 */
export function dragUpdate(
  dto: ShapeItemDTO,
  before: ItemNumbers,
  after: ItemNumbers,
  stepMm: number,
): Record<string, unknown> {
  const sources = structuredClone(itemSources(dto)) as unknown as Record<string, unknown>
  const changed = new Set<string>()
  const old = itemQuantities(before)
  const next = itemQuantities(after)
  next.forEach(({ path, value }, i) => {
    const prev = old[i]
    if (prev !== undefined && sameNumber(prev.value, value)) return
    const q = quantityAtPath(dto, path)
    const isAngle = q?.kind === 'angle' || path[0] === 'rotation'
    setAt(sources, path, dragSource(q, value, isAngle ? 0.1 : stepMm))
    changed.add(String(path[0]))
  })
  if (after.kind === 'path' && before.kind === 'path')
    after.segments.forEach((s, k) => {
      const b = before.segments[k]
      if (s.kind === 'arc' && b?.kind === 'arc' && Boolean(s.large) !== Boolean(b.large)) {
        setAt(sources, ['segments', k, 'large'], Boolean(s.large))
        changed.add('segments')
      }
    })
  return Object.fromEntries([...changed].map((k) => [k, sources[k]]))
}

/** A length in the project unit as a bare source (the bare-number unit of the project). */
const len = (mm: number, units: UnitSystem): string =>
  units === 'mm' ? String(mm) : String(+(mm / 25.4).toFixed(4))

/** Items a new shape (or a new item of a shape) starts with, as command args. */
export function newItemArgs(kind: ShapeItemKind, units: UnitSystem): Record<string, unknown> {
  const l = (mm: number) => len(mm, units)
  const inch = units === 'inch'
  const centre = ['0', '0']
  switch (kind) {
    case 'rectangle':
      return {
        kind,
        center: centre,
        length: inch ? '1.5' : l(40),
        width: inch ? '0.75' : l(20),
      }
    case 'circle':
      return { kind, center: centre, diameter: inch ? '0.75' : l(20) }
    case 'obround':
      return { kind, center: centre, length: inch ? '1.5' : l(40), width: inch ? '0.5' : l(12) }
    case 'polygon':
      return { kind, center: centre, sides: '6', diameter: inch ? '1.25' : l(30) }
    case 'path': {
      const [w, h, r] = inch ? ['1.5', '0.75', '0.375'] : ['40', '20', '10']
      return {
        kind,
        start: ['0', '0'],
        segments: [
          { kind: 'line', to: [w, '0'] },
          { kind: 'arc', to: [w, h], radius: r, cw: false },
          { kind: 'line', to: ['0', h] },
        ],
        closed: true,
      }
    }
  }
}

/** A new segment after `after` (index; −1 = first): a line continuing from its end. */
export function newSegment(
  path: Extract<ItemNumbers, { kind: 'path' }>,
  dto: Extract<ShapeItemDTO, { kind: 'path' }>,
  after: number,
  units: UnitSystem,
): ShapeSegment<string> {
  const end = (k: number): readonly [number, number] =>
    k < 0 ? path.start : (path.segments[k]?.to ?? path.start)
  const p = end(after)
  const prev = end(after - 1)
  const dx = p[0] - prev[0]
  const dy = p[1] - prev[1]
  const d = Math.hypot(dx, dy)
  const step = units === 'mm' ? 10 : 12.7
  const [ux, uy] = d > 1e-9 ? [-dy / d, dx / d] : [1, 0]
  const source = (k: number, axis: 0 | 1, mm: number) =>
    dragSource(
      k < 0 ? dto.start[axis] : (dto.segments[k]?.to[axis] ?? dto.start[axis]),
      mm,
      units === 'mm' ? 0.01 : 0.0254,
    )
  return { kind: 'line', to: [source(after, 0, p[0] + ux * step), source(after, 1, p[1] + uy * step)] }
}

/** A segment of another type with the same end point (an arc's radius: the chord, so it is valid). */
export function retypeSegment(
  seg: ShapeSegment<string>,
  kind: ShapeSegment<string>['kind'],
  chordMm: number,
  units: UnitSystem,
): ShapeSegment<string> {
  if (kind === 'line') return { kind, to: seg.to }
  if (kind === 'tangentArc') return { kind, to: seg.to }
  const radius = seg.kind === 'arc' ? seg.radius : len(Math.max(chordMm, 1e-3), units)
  return { kind, to: seg.to, radius, cw: seg.kind === 'arc' ? seg.cw : false }
}

/** The path's vertex at the end of segment `k` (fillet cell of the segment row; vertex 0 when it closes there). */
export function endVertex(path: Extract<ItemNumbers, { kind: 'path' }>, k: number): number {
  const n = path.segments.length
  const last = path.segments[n - 1]!.to
  const closesAtStart =
    path.closed && Math.hypot(last[0] - path.start[0], last[1] - path.start[1]) < 1e-6
  return k === n - 1 && closesAtStart ? 0 : k + 1
}

/** Where an issue of item `n` shows: its parameter path inside the item (`center.0`), or undefined. */
export function issueField(issue: Pick<Issue, 'path'>, n: number): string | undefined {
  const p = issue.path
  if (p[0] !== 'items' || p[1] !== n) return undefined
  return p.length > 2 ? p.slice(2).join('.') : ''
}

/** The item an issue belongs to (`items.<n>.…`), or undefined (structure, whole shape). */
export function issueItem(issue: Pick<Issue, 'path'>): number | undefined {
  return issue.path[0] === 'items' && typeof issue.path[1] === 'number' ? issue.path[1] : undefined
}

/** Area in project units² for the summary (mm² or in²). */
export function areaInUnits(mm2: number, units: UnitSystem): number {
  return units === 'mm' ? mm2 : mm2 / 25.4 ** 2
}

export const lengthInUnits = (mm: number, units: UnitSystem): number =>
  units === 'mm' ? mm : mm / 25.4
