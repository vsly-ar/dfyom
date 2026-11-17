/**
 * Curated feeds-and-speeds material data and machine rigidity presets.
 * Doc: docs/architecture/feeds-speeds.md#material-data, #machine-rigidity-presets
 *
 * Code, not user data (no `schemaVersion`); plain float64 numbers in canonical units, since they
 * are constants, not entered quantities. Every number must be tied to a cited source (or marked
 * `estimated` where the doc allows it); `lintMaterialData` enforces that in a test.
 */
import type { MaterialClass } from '../library/item'
import type { Rigidity } from '../library/machine.dto'

/** Inclusive range; the rigidity preset's `rangePos` picks the position within it. */
export interface Range {
  readonly min: number
  readonly max: number
}

/** Upper bounds of the diameter bands (mm): ≤ 3, ≤ 6, ≤ 12, ≤ 25. */
export const DIAMETER_BANDS = [3, 6, 12, 25] as const
export type DiameterBand = (typeof DIAMETER_BANDS)[number]

export interface BandData {
  readonly maxDiameter: DiameterBand
  /** Chip load per tooth (mm) for end mills; absent = no end-mill data in this band. */
  readonly fz?: Range
  /** Feed per revolution (mm/rev) for drills; absent = no drill data in this band. */
  readonly fn?: Range
}

/** Data fields a source can back. */
export type DataField = 'vc' | 'apSlot' | 'kPlunge' | 'u' | 'fz' | 'fn'

export interface DataSource {
  /** Citation: URL of the public vendor chart or handbook reference. */
  readonly ref: string
  /** Which fields of the row this source backs. */
  readonly fields: readonly DataField[]
}

export type DataToolMaterial = 'carbide' | 'hss'
export type DataMaterialClass = Exclude<MaterialClass, 'other'>

/** One `materialClass × toolMaterial` row. */
export interface MaterialRow {
  readonly materialClass: DataMaterialClass
  readonly toolMaterial: DataToolMaterial
  /** Surface speed (m/min); also used for drills (F1 with drill `vc`). */
  readonly vc: Range
  /** Slotting depth of cut as a multiple of D, before the rigidity `apFactor`. */
  readonly apSlot: number
  /** F9 plunge factor. */
  readonly kPlunge: number
  /** Unit power (W·s/mm³) for F7. */
  readonly u: number
  /** Exactly one entry per `DIAMETER_BANDS` entry, in order. */
  readonly bands: readonly BandData[]
  readonly sources: readonly DataSource[]
  /** Fields that are conservative estimates (the doc allows it for wood/plastic `u`). */
  readonly estimated?: readonly DataField[]
}

/**
 * The material table. Empty until the cited per-row values are curated: the accepted doc names
 * the sources but not the numbers, and no value may be invented (see docs/plans/v0.1.md, known
 * issues). Without a row the calculator returns `feeds.noData` and plan mode falls back.
 */
export const MATERIAL_DATA: readonly MaterialRow[] = []

export interface RigidityFactors {
  /** Multiplies `apSlot` for the suggested stepdown. */
  readonly apFactor: number
  /** Position within every `vc`, `fz` and `fn` range (0 = low end, 1 = high end). */
  readonly rangePos: number
}

/** docs/architecture/feeds-speeds.md#machine-rigidity-presets */
export const RIGIDITY_FACTORS: Readonly<Record<Rigidity, RigidityFactors>> = {
  extrusion: { apFactor: 0.3, rangePos: 0 },
  hobby: { apFactor: 0.5, rangePos: 0.25 },
  prosumer: { apFactor: 0.75, rangePos: 0.5 },
  benchMill: { apFactor: 0.9, rangePos: 0.75 },
  rigidMill: { apFactor: 1.0, rangePos: 1.0 },
}

/** Without a machine or a machine rigidity, the lowest preset applies. */
export const DEFAULT_RIGIDITY: Rigidity = 'extrusion'

/** Value at `pos` within a range. */
export const pick = (r: Range, pos: number): number => r.min + pos * (r.max - r.min)

/** Smallest band holding diameter `D` (mm); undefined above the largest band or for D ≤ 0. */
export function bandOf(row: MaterialRow, D: number): BandData | undefined {
  if (!(D > 0)) return undefined
  return row.bands.find((b) => D <= b.maxDiameter)
}

export function findRow(
  data: readonly MaterialRow[],
  materialClass: MaterialClass,
  toolMaterial: string,
): MaterialRow | undefined {
  return data.find((r) => r.materialClass === materialClass && r.toolMaterial === toolMaterial)
}

/** Data lint: problems as readable strings (empty = valid). Run on `MATERIAL_DATA` in a test. */
export function lintMaterialData(data: readonly MaterialRow[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const row of data) {
    const key = `${row.materialClass}×${row.toolMaterial}`
    const say = (m: string) => problems.push(`${key}: ${m}`)
    if (seen.has(key)) say('duplicate row')
    seen.add(key)

    if (row.sources.length === 0) say('no source')
    for (const s of row.sources) if (s.ref.trim() === '') say('empty source ref')
    const cited = new Set(row.sources.flatMap((s) => s.fields))
    const estimated = new Set(row.estimated ?? [])
    const present: DataField[] = ['vc', 'apSlot', 'kPlunge', 'u']
    if (row.bands.some((b) => b.fz !== undefined)) present.push('fz')
    if (row.bands.some((b) => b.fn !== undefined)) present.push('fn')
    for (const f of present)
      if (!cited.has(f) && !estimated.has(f)) say(`${f} has no source and is not estimated`)

    checkRange(row.vc, 'vc', say)
    for (const [name, v] of [
      ['apSlot', row.apSlot],
      ['kPlunge', row.kPlunge],
      ['u', row.u],
    ] as const)
      if (!(v > 0) || !Number.isFinite(v)) say(`${name} must be > 0`)

    const bounds = row.bands.map((b) => b.maxDiameter)
    if (bounds.length !== DIAMETER_BANDS.length || bounds.some((b, i) => b !== DIAMETER_BANDS[i]))
      say(`bands must be ${DIAMETER_BANDS.join(', ')} mm in order (0–25 mm without gaps)`)
    for (const b of row.bands) {
      if (b.fz !== undefined) checkRange(b.fz, `fz ≤ ${b.maxDiameter}`, say)
      if (b.fn !== undefined) checkRange(b.fn, `fn ≤ ${b.maxDiameter}`, say)
    }
  }
  return problems
}

function checkRange(r: Range, name: string, say: (m: string) => void): void {
  if (!(r.min > 0) || !Number.isFinite(r.max) || r.min > r.max)
    say(`${name} range must be 0 < min ≤ max`)
}
