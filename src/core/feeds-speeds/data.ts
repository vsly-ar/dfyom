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
import { KP_TO_UNIT_POWER } from './formulas'

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
export type DataField = 'vc' | 'n' | 'apSlot' | 'kPlunge' | 'u' | 'fz' | 'fn'

export interface DataSource {
  /** Citation: URL of the public vendor chart or handbook reference. */
  readonly ref: string
  /** Which fields of the row this source backs. */
  readonly fields: readonly DataField[]
}

export type DataToolMaterial = 'carbide' | 'hss'
export type DataMaterialClass = Exclude<MaterialClass, 'other'>

/**
 * One `materialClass × toolMaterial` row. Exactly one of `vc` and `n` is set (the lint checks it):
 * machining charts give a surface speed, router-bit charts a fixed spindle speed
 * (docs/architecture/feeds-speeds.md#material-data).
 */
export interface MaterialRow {
  readonly materialClass: DataMaterialClass
  readonly toolMaterial: DataToolMaterial
  /** Surface speed (m/min) for F1; also used for drills (F1 with drill `vc`). */
  readonly vc?: Range
  /** Spindle speed (rpm) used directly instead of F1, for router-bit charts that state one. */
  readonly n?: Range
  /** Slotting depth of cut as a multiple of D, before the rigidity `apFactor`. */
  readonly apSlot: number
  /** F9 plunge factor. */
  readonly kPlunge: number
  /** Unit power (W·s/mm³) for F7. */
  readonly u: number
  /** Exactly one entry per `DIAMETER_BANDS` entry, in order. */
  readonly bands: readonly BandData[]
  readonly sources: readonly DataSource[]
  /** Fields that are derived estimates; the reasoning is in the doc (Material data). */
  readonly estimated?: readonly DataField[]
  /**
   * Which kind of chart the row comes from: `router` (router-bit charts, already for routers) or
   * `machining` (machining-centre charts: scaled for the machine class, corrected power model;
   * docs/architecture/feeds-speeds.md#hobby-metal-cutting-hardening-df131).
   */
  readonly chart: 'router' | 'machining'
}

/** The row's speed: surface speed `vc` (F1) or chart spindle speed `n`; undefined if neither. */
export function speedOf(row: MaterialRow): { field: 'vc' | 'n'; range: Range } | undefined {
  if (row.n !== undefined) return { field: 'n', range: row.n }
  if (row.vc !== undefined) return { field: 'vc', range: row.vc }
  return undefined
}

// ---------------------------------------------------------------------------------------------
// Material table (task 2.12, "carbide only for now"). Doc: docs/architecture/feeds-speeds.md
// #material-data-v01 – sources, the conservative-envelope rule and every estimate's reasoning.
// Charts are in inch units; the helpers convert them so each number reads as printed.

const INCH = 25.4
const FOOT = 0.3048
/** Chip load range printed in inches per tooth → mm. A single printed value gives min = max. */
const ipt = (min: number, max = min): Range => ({ min: min * INCH, max: max * INCH })
/** Surface speed range printed in SFM → m/min. */
const sfm = (min: number, max = min): Range => ({ min: min * FOOT, max: max * FOOT })
/**
 * Bottom of a machining-centre chip-load range as a share of the printed value (DF131): the
 * printed value is the top (a rigid machine), this share of it the bottom, the hobby end (at 1/8"
 * still above the ~0.013 mm minimum chip). Doc: docs/architecture/feeds-speeds.md#hobby-metal-cutting-hardening-df131
 */
export const HOBBY_FZ_SHARE = 0.5
/** A machining-centre chip load printed in inches per tooth → [share × printed, printed] mm. */
const machiningIpt = (printed: number): Range => ({
  min: printed * INCH * HOBBY_FZ_SHARE,
  max: printed * INCH,
})
/** Machine unit horsepower (hp per in³/min) → W·s/mm³ (F7). */
const unitHp = (hp: number): number => hp * KP_TO_UNIT_POWER

/**
 * Bands ≤ 6, ≤ 12, ≤ 25 mm filled from the chart's 1/8", 1/4", 1/2" values; ≤ 3 mm from its 1/16"
 * value when given (router rows, hardening DF39), else left empty (doc).
 */
const bandsFrom = (b6: Range, b12: Range, b25: Range, b3?: Range): BandData[] => [
  b3 === undefined ? { maxDiameter: 3 } : { maxDiameter: 3, fz: b3 },
  { maxDiameter: 6, fz: b6 },
  { maxDiameter: 12, fz: b12 },
  { maxDiameter: 25, fz: b25 },
]

const HARVEY_GUIDE =
  'Harvey Tool, General Machining Guidelines, tables "Carbide End Mills – Non-Ferrous" and "– Iron, Steel, Stainless": SFM and chip load (IPT) at 1/8", 1/4", 1/2" – https://www.harveytool.com/resources/general-machining-guidelines'
const HARVEY_13900 =
  'Harvey Tool, Speeds & Feeds, Miniature End Mills – Square – Stub & Standard, 2 Flutes (series 139xx, 502xx), "Slotting" rows: SFM, chip load (IPT) at 0.125", 0.250", 0.500", depth of cut 1 x Dia radial / .50 x Dia axial – https://harveyperformance.widen.net/content/pnhfzhydtu/pdf/SF_13900.pdf'
const MMS_UNIT_HP =
  'Modern Machine Shop, "Start With The Right Speeds And Feeds", Table I "Unit Horsepower" – https://www.mmsonline.com/articles/start-with-the-right-speeds-and-feeds'
const AMANA_BALL =
  'Amana Tool, 2 Flute Solid Carbide CNC Spiral Ball Nose Router Bits speed chart: "CNC Operating Spindle Speed: 18,000 RPM / Depth of Cut: 1 x Tool Diameter", chip load per tooth at 1/16", 1/8", 1/4", 1/2", "Ramp Down: Feed Rate IPM / # of flutes" – https://www.amanatool.com/pub/media/productattachments/Spiral-Ball-Nose-Speed-Chart-v6.pdf'
const AMANA_BALL_PLASTIC =
  'Amana Tool, 2 & 4 Flute Solid Carbide Spiral Ball Nose for Plastics speed chart: 18,000 RPM, 1 x D, 2 Flute chip load at 6mm-1/4" and 12mm-1/2" – https://www.amanatool.com/pub/media/productattachments/Spiral-Ball-Nose-for-Plastics-Speed_Chart-v7.pdf'
const onsrud = (title: string, page: number, series: string, file: string): string =>
  `LMT Onsrud, ${title} Cutting Data Recommendations (catalog p. ${page}), series ${series} row, chip load per tooth at 1/8", 1/4", 1/2", "DEPTH OF CUT: 1 x D Use recommended chip load" – https://onsrud.com/images/${file}.pdf`

const ONSRUD_FIELDS: readonly DataField[] = ['apSlot', 'fz']
const AMANA_FIELDS: readonly DataField[] = ['n', 'apSlot', 'fz']

/** Router rows: Amana 18,000 rpm, 1 x D, ramp-down rule for 2 flutes; `u` estimated (doc). */
function routerRow(
  materialClass: DataMaterialClass,
  bands: BandData[],
  onsrudRefs: string[],
  amanaRefs: string[],
): MaterialRow {
  return {
    materialClass,
    toolMaterial: 'carbide',
    n: { min: 18_000, max: 18_000 },
    apSlot: 1,
    kPlunge: 0.5,
    u: unitHp(0.25),
    bands,
    sources: [
      ...onsrudRefs.map((ref) => ({ ref, fields: ONSRUD_FIELDS })),
      ...amanaRefs.map((ref) => ({ ref, fields: AMANA_FIELDS })),
      { ref: AMANA_BALL, fields: ['kPlunge'] },
      { ref: MMS_UNIT_HP, fields: ['u'] },
    ],
    estimated: ['kPlunge', 'u'],
    chart: 'router',
  }
}

/**
 * Machining rows: Harvey Tool SFM and slotting chip loads, printed in IPT (each band's range is
 * [HOBBY_FZ_SHARE × printed, printed], DF131); `kPlunge` estimated (doc).
 */
function metalRow(
  materialClass: DataMaterialClass,
  vc: Range,
  b6: number,
  b12: number,
  b25: number,
  u: number,
): MaterialRow {
  return {
    materialClass,
    toolMaterial: 'carbide',
    chart: 'machining',
    vc,
    apSlot: 0.5,
    kPlunge: 0.25,
    u,
    bands: bandsFrom(machiningIpt(b6), machiningIpt(b12), machiningIpt(b25)),
    sources: [
      { ref: HARVEY_GUIDE, fields: ['vc', 'fz'] },
      { ref: HARVEY_13900, fields: ['vc', 'fz', 'apSlot'] },
      { ref: AMANA_BALL, fields: ['kPlunge'] },
      { ref: MMS_UNIT_HP, fields: ['u'] },
    ],
    estimated: ['kPlunge'],
  }
}

/**
 * The material table: carbide end mills only (HSS rows and drill `fn` bands have no curated
 * source yet → `feeds.noData`). Each range is the conservative envelope of its sources
 * (min = lowest printed minimum, max = lowest printed maximum). Bands ≤ 3 mm: the router rows
 * take Amana's 1/16" column (the only cited chart printing one; sheetGood ← MDF), metal rows are
 * empty (docs/architecture/feeds-speeds.md#small-end-mills-hardening-df39).
 */
export const MATERIAL_DATA: readonly MaterialRow[] = [
  routerRow(
    'softwood',
    bandsFrom(ipt(0.005, 0.007), ipt(0.007, 0.009), ipt(0.009, 0.011), ipt(0.003, 0.005)),
    [onsrud('Soft Wood', 114, '52-200/57-200', 'Soft%20Wood')],
    [AMANA_BALL],
  ),
  routerRow(
    'hardwood',
    bandsFrom(ipt(0.003, 0.005), ipt(0.005, 0.007), ipt(0.007, 0.009), ipt(0.002, 0.004)),
    [onsrud('Hard Wood', 115, '52-200/57-200', 'Hard%20Wood')],
    [AMANA_BALL],
  ),
  routerRow(
    'sheetGood',
    bandsFrom(ipt(0.005, 0.007), ipt(0.006, 0.008), ipt(0.008, 0.01), ipt(0.003, 0.005)),
    [
      onsrud('MDF', 116, '52-200/57-200', 'MDF'),
      onsrud('Soft Plywood', 117, '52-200/57-200', 'Soft%20Plywood'),
      onsrud('Hard Plywood', 118, '52-200', 'Hard%20Plywood'),
    ],
    [AMANA_BALL],
  ),
  routerRow(
    'plastic',
    bandsFrom(ipt(0.002, 0.004), ipt(0.003, 0.005), ipt(0.006, 0.008), ipt(0.002, 0.004)),
    [
      onsrud('Soft Plastic', 120, '52-200B/BL', 'Soft%20Plastic'),
      onsrud('Hard Plastic', 121, '52-200B/BL', 'Hard%20Plastic'),
    ],
    [AMANA_BALL, AMANA_BALL_PLASTIC],
  ),
  // vc: HT guide 500–1000 / 800–1500; SF_13900 wrought 1000, castings 750/700/650 (≤ 12 % Si).
  // DF131: 500–1000, the wrought rows' 1000 as the top (not the castings' 650): a low speed is not
  // the safe side on a router spindle, and the speed is the range's top.
  // fz: HT guide .001/.002/.004 < SF_13900 slotting .00151/.00303/.00605 (.00136/.00272/.00545 Si).
  metalRow('aluminum', sfm(500, 1000), 0.001, 0.002, 0.004, unitHp(0.25)),
  // vc: HT guide brass 600–1000 / 800–1500; SF_13900 brass 500. fz: HT guide .001/.002/.003 <
  // SF_13900 .00121/.00242/.00484. u: MMS "Brass (Hard)" 0.50 (> "Soft" 0.33).
  metalRow('brass', sfm(500), 0.001, 0.002, 0.003, unitHp(0.5)),
  // Carbon and low-alloy steels only. vc: HT guide 10XX/11XX/13XX 100–300, 23XX/31XX 100–150;
  // SF_13900 600 (free-machining) / 200 (1030–1095, alloy). fz: lowest of HT guide .0005/.0015/.003
  // and SF_13900 .00052/.00104/.00208, .00048/.00095/.00190. u: MMS "Steel 400 BHN" 2.00.
  metalRow('steel', sfm(100, 150), 0.00048, 0.00095, 0.0019, unitHp(2.0)),
]

export interface RigidityFactors {
  /** Multiplies `apSlot` for the suggested stepdown (router rows). */
  readonly apFactor: number
  /** Position within the router rows' `fz` and every `fn` range (0 = low end, 1 = high end). */
  readonly rangePos: number
  /** Multiplies `apSlot` for the suggested stepdown of machining rows (metals, DF131). */
  readonly machiningApFactor: number
  /** Position within the machining rows' `fz` range (metals, DF131). */
  readonly machiningFzPos: number
}

/**
 * docs/architecture/feeds-speeds.md#machine-rigidity-presets; the machining (metal) columns:
 * #hobby-metal-cutting-hardening-df131. Speeds are the top of their range for every preset (DF131).
 */
export const RIGIDITY_FACTORS: Readonly<Record<Rigidity, RigidityFactors>> = {
  extrusion: { apFactor: 0.3, rangePos: 0, machiningApFactor: 0.1, machiningFzPos: 0 },
  hobby: { apFactor: 0.5, rangePos: 0.25, machiningApFactor: 0.12, machiningFzPos: 0.1 },
  prosumer: { apFactor: 0.75, rangePos: 0.5, machiningApFactor: 0.16, machiningFzPos: 0.2 },
  fixedGantry: { apFactor: 0.85, rangePos: 0.6, machiningApFactor: 0.16, machiningFzPos: 0.2 },
  benchMill: { apFactor: 0.9, rangePos: 0.75, machiningApFactor: 0.5, machiningFzPos: 0.5 },
  rigidMill: { apFactor: 1.0, rangePos: 1.0, machiningApFactor: 1.0, machiningFzPos: 1.0 },
}

/** The stepdown factor and chip-load position for `row` on a machine of class `rigidity`. */
export function classFactors(
  row: MaterialRow,
  rigidity: Rigidity,
): { readonly apFactor: number; readonly fzPos: number } {
  const f = RIGIDITY_FACTORS[rigidity]
  return row.chart === 'machining'
    ? { apFactor: f.machiningApFactor, fzPos: f.machiningFzPos }
    : { apFactor: f.apFactor, fzPos: f.rangePos }
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
    const present: DataField[] = ['apSlot', 'kPlunge', 'u']
    if (row.vc !== undefined) present.push('vc')
    if (row.n !== undefined) present.push('n')
    if (row.bands.some((b) => b.fz !== undefined)) present.push('fz')
    if (row.bands.some((b) => b.fn !== undefined)) present.push('fn')
    for (const f of present)
      if (!cited.has(f) && !estimated.has(f)) say(`${f} has no source and is not estimated`)

    if ((row.vc === undefined) === (row.n === undefined)) say('exactly one of vc and n must be set')
    if (row.vc !== undefined) checkRange(row.vc, 'vc', say)
    if (row.n !== undefined) checkRange(row.n, 'n', say)
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
