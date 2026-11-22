// The hole inspector's pure model (v0.4 U2): the hole record read for the inspector, the section
// illustration's values (resolved mm, the material below the face, the chosen screw), the size
// fields of a type, the "entered sizes replaced" count of a refill, the custom-size note at its
// field ("ISO for M3: 6.5 mm." with "Use 6.5 mm") and the line naming the sources of the filled
// sizes. Doc: docs/conventions/ui.md#hole-inspector, docs/modes/design-v0.4.md#parameters
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import { fastenerRow, holeTableSizes } from '../../../../core/design/hole'
import { DEFAULTS } from '../../../../core/design/operation'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { UnitSystem } from '../../../../core/project/document'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import type {
  HoleSectionBottom,
  HoleSectionFastener,
  HoleSectionType,
  HoleSectionValues,
} from '../../viewport/hole-section'
import { lengthSource } from '../../messages/dfm'
import { quantityOf, type DesignPart } from './model'

export type HoleType = HoleSectionType
export type HolePurpose = 'clearance' | 'tapDrill'
export type HoleFit = 'close' | 'normal' | 'loose'

/** The size fields of the hole record (quantities). */
export type HoleSizeField =
  'diameter' | 'depth' | 'cbDiameter' | 'cbDepth' | 'csDiameter' | 'csAngle' | 'headSink'

/** The stored hole as the inspector reads it (the record is flat, design-v0.4.md § F3). */
export interface HoleRecord {
  readonly id: string
  readonly name: string
  readonly on: string
  readonly type: HoleType
  readonly fastener: string | undefined
  readonly purpose: HolePurpose
  readonly fit: HoleFit
  readonly bottom: HoleSectionBottom
  readonly center: readonly [QuantityDTO, QuantityDTO]
  readonly sizes: Partial<Record<HoleSizeField, QuantityDTO>>
}

const SIZE_FIELDS: readonly HoleSizeField[] = [
  'diameter',
  'depth',
  'cbDiameter',
  'cbDepth',
  'csDiameter',
  'csAngle',
  'headSink',
]

export function holeRecord(feature: FeatureDTO): HoleRecord {
  const d = feature as Record<string, unknown>
  const sizes: Partial<Record<HoleSizeField, QuantityDTO>> = {}
  for (const k of SIZE_FIELDS) if (d[k] !== undefined) sizes[k] = d[k] as QuantityDTO
  return {
    id: feature.id,
    name: feature.name,
    on: String(d['on'] ?? 'stock.top'),
    type: (d['type'] as HoleType | undefined) ?? 'simple',
    fastener: typeof d['fastener'] === 'string' ? d['fastener'] : undefined,
    purpose: (d['purpose'] as HolePurpose | undefined) ?? 'clearance',
    fit: (d['fit'] as HoleFit | undefined) ?? 'normal',
    bottom: (d['bottom'] as HoleSectionBottom | undefined) ?? 'through',
    center: d['center'] as [QuantityDTO, QuantityDTO],
    sizes,
  }
}

/** The size fields shown for a type and bottom, in the inspector's order (head sink apart). */
export function sizeFields(h: Pick<HoleRecord, 'type' | 'bottom'>): HoleSizeField[] {
  const fields: HoleSizeField[] = ['diameter']
  if (h.bottom !== 'through') fields.push('depth')
  if (h.type === 'counterbore') fields.push('cbDiameter', 'cbDepth')
  if (h.type === 'countersink') fields.push('csDiameter', 'csAngle')
  return fields
}

/** A row of `design.fastener.list` (mm). */
export interface FastenerListRow {
  readonly size: string
  readonly nominal: number
  readonly tapDrill: number
  readonly clearance: Readonly<Record<HoleFit, number>>
  readonly socketHead: { readonly diameter: number; readonly height: number }
  readonly counterbore: { readonly diameter: number }
  readonly countersunkHead: {
    readonly diameter: number
    readonly angle: number
    readonly source: string
  }
}

export interface FastenerSourceRef {
  readonly key: string
  readonly ref: string
}

export interface FastenerList {
  readonly rows: readonly FastenerListRow[]
  readonly sources: readonly FastenerSourceRef[]
}

const mm = (q: QuantityDTO | undefined): number | undefined => {
  if (q === undefined) return undefined
  const v = quantityOf(q)?.canonical
  return v !== undefined && Number.isFinite(v) ? v : undefined
}

/**
 * Material below the hole's face along its axis: the stock's extent in the face's direction plus
 * the face's (non-positive) level; undefined when the part or the face is not known.
 */
export function stockBelow(
  part: Pick<DesignPart, 'loaded' | 'table'>,
  on: string,
): number | undefined {
  const stock = part.loaded?.stock
  const entry = part.table?.get(on)
  if (stock === undefined || entry === undefined || entry.isNone()) return undefined
  const e = entry.unwrap()
  const axis = e.direction[1]
  const extent =
    axis === 'z'
      ? stock.thickness.canonical
      : axis === 'x'
        ? stock.length.canonical
        : stock.width.canonical
  return extent + e.faceZ.toNumber()
}

/** The section illustration's values from the stored hole (resolved quantities, mm). */
export function sectionValues(
  h: HoleRecord,
  part: Pick<DesignPart, 'loaded' | 'table'>,
  rows: readonly FastenerListRow[],
  invalid: readonly string[] = [],
): HoleSectionValues {
  const row = h.fastener === undefined ? undefined : rows.find((r) => r.size === h.fastener)
  const fastener: HoleSectionFastener | undefined =
    row === undefined
      ? undefined
      : {
          size: row.size,
          nominal: row.nominal,
          socketHead: row.socketHead,
          countersunkHead: row.countersunkHead,
        }
  return {
    type: h.type,
    purpose: h.purpose,
    diameter: mm(h.sizes.diameter) ?? 1,
    bottom: h.bottom,
    depth: mm(h.sizes.depth),
    cbDiameter: mm(h.sizes.cbDiameter),
    cbDepth: mm(h.sizes.cbDepth),
    csDiameter: mm(h.sizes.csDiameter),
    csAngle: mm(h.sizes.csAngle),
    headSink: mm(h.sizes.headSink) ?? 0,
    stockDepth: stockBelow(part, h.on),
    fastener,
    invalid,
  }
}

/** What a refill is asked with: the hole's choices after the edit. */
export interface RefillChoice {
  readonly type: HoleType
  readonly fastener: string | undefined
  readonly purpose: HolePurpose
  readonly fit: HoleFit
}

/**
 * How many sizes a refill will overwrite that the user had entered (the toast's count), worked out
 * before the command from the same table the core refills from: sizes of the new type that exist
 * now, differ from the new table value, and were entered – not the previous fastener's table value
 * (`custom`: the fields with a `dfm.holeCustomSize` note), or, without a fastener, anything but the
 * core default diameter and the starting head sizes (`headDefaults`).
 */
export function enteredSizesReplaced(
  h: HoleRecord,
  next: RefillChoice,
  custom: ReadonlySet<string>,
  units: UnitSystem,
): number {
  const row = next.fastener === undefined ? undefined : fastenerRow(next.fastener)
  const sink = h.sizes.headSink === undefined ? undefined : quantityOf(h.sizes.headSink)
  if (row === undefined || sink === undefined) return 0
  const table = holeTableSizes(row, next.purpose, next.fit, sink, units)
  if (table.isErr()) return 0
  const t = table.unwrap()
  const fields = sizeFields({ type: next.type, bottom: 'through' }) as (keyof typeof t)[]
  return fields.filter((k) => {
    const was = h.sizes[k]
    if (was === undefined) return false
    const q = quantityOf(was)
    if (q === undefined || q.exact.equals(t[k].exact)) return false
    if (h.fastener !== undefined) return custom.has(k)
    if (k === 'diameter') return was.source !== DEFAULTS.holeDiameter[units]
    // the inspector's own starting head sizes are not entered either
    return h.type === 'simple' || headDefaults(h, h.type, units)[k] !== was.source
  }).length
}

/** The standard family behind a size field's table value ("ISO", "DIN"). */
const STANDARD_OF: Readonly<Record<string, string>> = {
  diameter: 'ISO',
  cbDiameter: 'DIN',
  cbDepth: 'ISO',
  csDiameter: 'ISO',
  csAngle: 'ISO',
}

/**
 * `dfm.holeCustomSize` at its field: "ISO for M3: 6.5 mm." and the fix's value (the table's, as
 * the table writes it: `<n> mm` in either unit system, `<n>°` for the angle).
 */
export function customSizeNote(
  w: DfmWarning,
  units: UnitSystem,
): { text: string; source: string } | undefined {
  if (w.code !== 'dfm.holeCustomSize') return undefined
  const table = w.params['table']
  const field = String(w.params['field'] ?? w.parameter)
  const fastener = w.params['fastener']
  if (typeof table !== 'number' || typeof fastener !== 'string') return undefined
  const angle = field === 'csAngle'
  const source = angle ? `${+table.toFixed(4)}°` : `${+table.toFixed(4)} mm`
  const shown = angle
    ? source
    : units === 'inch'
      ? `${+(table / 25.4).toFixed(4)}" (${source})`
      : source
  return { text: `${STANDARD_OF[field] ?? 'ISO'} for ${fastener}: ${shown}.`, source }
}

/** The sources of the filled sizes, in field order: `[standard key, what it gave]`. */
export function fastenerSources(
  h: Pick<HoleRecord, 'type' | 'purpose' | 'fit' | 'fastener'>,
  rows: readonly FastenerListRow[],
): [string, string][] {
  const row = rows.find((r) => r.size === h.fastener)
  if (row === undefined) return []
  const out: [string, string][] = [
    h.purpose === 'tapDrill' ? ['ISO 2306', 'tap drill'] : ['ISO 273', h.fit],
  ]
  if (h.type === 'counterbore') out.push(['ISO 4762', 'head'], ['DIN 974-1', 'counterbore'])
  if (h.type === 'countersink') out.push([row.countersunkHead.source, 'head'])
  return out
}

/**
 * Starting head sizes for a hole without a fastener that gets a head (the core requires them
 * then): a counterbore 1.8 × the diameter wide and one diameter deep, a countersink twice the
 * diameter wide (90° from the core) – kept within a blind hole's depth. In the project's units.
 */
export function headDefaults(
  h: HoleRecord,
  type: 'counterbore' | 'countersink',
  units: UnitSystem,
): Record<string, string> {
  const d = mm(h.sizes.diameter) ?? 6
  const depth = h.bottom === 'through' ? undefined : mm(h.sizes.depth)
  const room = depth === undefined ? Infinity : depth * 0.5
  if (type === 'counterbore')
    return {
      cbDiameter: lengthSource(1.8 * d, units),
      cbDepth: lengthSource(Math.min(d, room), units),
    }
  // a 90° cone is as deep as its overhang
  return { csDiameter: lengthSource(d + 2 * Math.min(d / 2, room), units) }
}

/** Default depth when a hole becomes blind: the diameter, below the head's step for a head. */
export function blindDepth(h: HoleRecord): number {
  const d = mm(h.sizes.diameter) ?? 6
  const step =
    h.type === 'counterbore'
      ? (mm(h.sizes.cbDepth) ?? 0)
      : h.type === 'countersink'
        ? ((mm(h.sizes.csDiameter) ?? d) - d) /
          2 /
          Math.tan(((mm(h.sizes.csAngle) ?? 90) * Math.PI) / 360)
        : 0
  return step + Math.max(d, 1)
}
