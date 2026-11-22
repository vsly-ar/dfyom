/**
 * Built-in fastener table: ISO metric screw sizes with clearance holes, tap drills and head
 * sizes for hole features. Doc: docs/modes/design-v0.4.md#fastener-table
 *
 * Code, not user data (no `schemaVersion`, the table version is not stored: a hole copies the
 * values it uses). Plain float64 numbers in mm, since they are constants, not entered
 * quantities. Every column cites its standard in `FASTENER_SOURCES`; `lintFastenerTable`
 * enforces sources and monotonic sizes in a test. Values ported from cnc-code's hole helper
 * (D30 Q7, relicensed by the author) and re-checked per column below.
 */

export const FASTENER_STANDARDS = ['isoMetric'] as const
export type FastenerStandard = (typeof FASTENER_STANDARDS)[number]

/** ISO 273 series: fine / medium / coarse, named close / normal / loose in DFYOM. */
export const FASTENER_FITS = ['close', 'normal', 'loose'] as const
export type FastenerFit = (typeof FASTENER_FITS)[number]

/** Columns a source backs. */
export type FastenerColumn =
  'pitch' | 'tapDrill' | 'clearance' | 'socketHead' | 'counterbore' | 'countersunkHead'

export interface FastenerSource {
  /** Short key cited by rows (`ISO 273`). */
  readonly key: string
  /** Full citation. */
  readonly ref: string
  readonly columns: readonly FastenerColumn[]
}

/**
 * The standards behind the columns. ISO and DIN texts are paywalled: values are the ones printed
 * in the standards' dimension tables as reproduced by manufacturer catalogues and engineering
 * handbooks, cross-checked against the cnc-code port; DIN 974-1 is checked against secondary
 * charts only (every value exceeds ISO 4762 dk max, the lint checks it).
 */
export const FASTENER_SOURCES: readonly FastenerSource[] = [
  {
    key: 'ISO 261',
    ref: 'ISO 261:1998, ISO general purpose metric screw threads – general plan (coarse pitch)',
    columns: ['pitch'],
  },
  {
    key: 'ISO 2306',
    ref: 'ISO 2306:1972, Drills for use prior to tapping screw threads (6H, coarse pitch); same sizes as DIN 336',
    columns: ['tapDrill'],
  },
  {
    key: 'ISO 273',
    ref: 'ISO 273:1979, Fasteners – clearance holes for bolts and screws (fine / medium / coarse series)',
    columns: ['clearance'],
  },
  {
    key: 'ISO 4762',
    ref: 'ISO 4762:2004, Hexagon socket head cap screws (dk max plain head, k max = d)',
    columns: ['socketHead'],
  },
  {
    key: 'DIN 974-1',
    ref: 'DIN 974-1:2008-02, Diameters of counterbores – part 1: hexagon socket head cap screws (series 1, for ISO 4762)',
    columns: ['counterbore'],
  },
  {
    key: 'ISO 10642',
    ref: 'ISO 10642:2004, Hexagon socket countersunk head screws (dk theoretical max, 90°; M3 and up)',
    columns: ['countersunkHead'],
  },
  {
    key: 'ISO 7046-1',
    ref: 'ISO 7046-1:2011, Cross recessed countersunk flat head screws (dk theoretical max, 90°; used below M3, which ISO 10642 does not cover)',
    columns: ['countersunkHead'],
  },
]

export interface FastenerRow {
  /** Table key: `M3`. */
  readonly size: string
  readonly standard: FastenerStandard
  /** Nominal thread diameter d (mm). */
  readonly nominal: number
  /** Coarse thread pitch P (mm), ISO 261. */
  readonly pitch: number
  /** Tap drill Ø (mm) for the coarse thread, ISO 2306. */
  readonly tapDrill: number
  /** Clearance hole Ø (mm) per fit, ISO 273. */
  readonly clearance: Readonly<Record<FastenerFit, number>>
  /** Socket head cap screw head, ISO 4762: Ø dk max and height k max (mm). */
  readonly socketHead: { readonly diameter: number; readonly height: number }
  /** Counterbore Ø (mm) for that head, DIN 974-1 series 1. */
  readonly counterbore: { readonly diameter: number }
  /** Countersunk head: Ø dk theoretical max (mm), included angle (°) and its standard. */
  readonly countersunkHead: {
    readonly diameter: number
    readonly angle: number
    readonly source: 'ISO 10642' | 'ISO 7046-1'
  }
  /** Source keys backing this row (`FASTENER_SOURCES`). */
  readonly sources: readonly string[]
}

const SOURCES_M3_UP = ['ISO 261', 'ISO 2306', 'ISO 273', 'ISO 4762', 'DIN 974-1', 'ISO 10642']
const SOURCES_BELOW_M3 = ['ISO 261', 'ISO 2306', 'ISO 273', 'ISO 4762', 'DIN 974-1', 'ISO 7046-1']

type RowInput = [
  size: string,
  nominal: number,
  pitch: number,
  tapDrill: number,
  clearance: [close: number, normal: number, loose: number],
  socketHead: [dk: number, k: number],
  counterbore: number,
  countersunkHead: number,
]

function row([
  size,
  nominal,
  pitch,
  tapDrill,
  [close, normal, loose],
  [dk, k],
  cb,
  cs,
]: RowInput): FastenerRow {
  const below = nominal < 3
  return {
    size,
    standard: 'isoMetric',
    nominal,
    pitch,
    tapDrill,
    clearance: { close, normal, loose },
    socketHead: { diameter: dk, height: k },
    counterbore: { diameter: cb },
    countersunkHead: { diameter: cs, angle: 90, source: below ? 'ISO 7046-1' : 'ISO 10642' },
    sources: below ? SOURCES_BELOW_M3 : SOURCES_M3_UP,
  }
}

/**
 * ISO metric M1.6–M12 (Q29). Columns: size, d, P (ISO 261), tap drill (ISO 2306), ISO 273
 * close/normal/loose, ISO 4762 [dk max, k max], DIN 974-1 counterbore Ø, countersunk head dk
 * theoretical max (ISO 7046-1 below M3, ISO 10642 from M3).
 */
export const FASTENER_TABLE: readonly FastenerRow[] = (
  [
    ['M1.6', 1.6, 0.35, 1.25, [1.7, 1.8, 2.0], [3.0, 1.6], 3.5, 3.6],
    ['M2', 2, 0.4, 1.6, [2.2, 2.4, 2.6], [3.8, 2], 4.4, 4.4],
    ['M2.5', 2.5, 0.45, 2.05, [2.7, 2.9, 3.1], [4.5, 2.5], 5.5, 5.5],
    ['M3', 3, 0.5, 2.5, [3.2, 3.4, 3.6], [5.5, 3], 6.5, 6.72],
    ['M4', 4, 0.7, 3.3, [4.3, 4.5, 4.8], [7.0, 4], 8, 8.96],
    ['M5', 5, 0.8, 4.2, [5.3, 5.5, 5.8], [8.5, 5], 10, 11.2],
    ['M6', 6, 1, 5.0, [6.4, 6.6, 7.0], [10.0, 6], 11, 13.44],
    ['M8', 8, 1.25, 6.8, [8.4, 9.0, 10.0], [13.0, 8], 15, 17.92],
    ['M10', 10, 1.5, 8.5, [10.5, 11.0, 12.0], [16.0, 10], 18, 22.4],
    ['M12', 12, 1.75, 10.2, [13.0, 13.5, 14.5], [18.0, 12], 20, 26.88],
  ] satisfies RowInput[]
).map(row)

/** Rows of a standard (all standards when absent), optionally one size; table order. */
export function fastenerRows(filter: {
  readonly standard?: FastenerStandard | undefined
  readonly size?: string | undefined
}): readonly FastenerRow[] {
  return FASTENER_TABLE.filter(
    (r) =>
      (filter.standard === undefined || r.standard === filter.standard) &&
      (filter.size === undefined || r.size === filter.size),
  )
}

/**
 * Table lint (test-enforced): every row cites known sources that together back every column;
 * sizes grow monotonically in every column; each hole fits its screw (tap drill < d < close <
 * normal < loose; head < counterbore; countersink > clearance).
 */
export function lintFastenerTable(rows: readonly FastenerRow[]): string[] {
  const out: string[] = []
  const byKey = new Map(FASTENER_SOURCES.map((s) => [s.key, s]))
  const columns: FastenerColumn[] = [
    'pitch',
    'tapDrill',
    'clearance',
    'socketHead',
    'counterbore',
    'countersunkHead',
  ]
  const seen = new Set<string>()
  for (const r of rows) {
    const at = r.size
    if (seen.has(at)) out.push(`${at}: duplicate size`)
    seen.add(at)
    const backed = new Set<FastenerColumn>()
    for (const key of r.sources) {
      const s = byKey.get(key)
      if (s === undefined) out.push(`${at}: unknown source ${key}`)
      else s.columns.forEach((c) => backed.add(c))
    }
    for (const c of columns) if (!backed.has(c)) out.push(`${at}: ${c} has no source`)
    if (!r.sources.includes(r.countersunkHead.source))
      out.push(`${at}: countersunk head source ${r.countersunkHead.source} not cited`)
    const { close, normal, loose } = r.clearance
    if (!(r.tapDrill < r.nominal - r.pitch / 2 && r.tapDrill > r.nominal - 1.25 * r.pitch))
      out.push(`${at}: tap drill must be about d − P`)
    if (!(r.nominal < close && close < normal && normal < loose))
      out.push(`${at}: clearance must be d < close < normal < loose`)
    if (!(r.socketHead.diameter < r.counterbore.diameter))
      out.push(`${at}: counterbore must exceed the head Ø`)
    if (!(r.counterbore.diameter > loose)) out.push(`${at}: counterbore must exceed the clearance`)
    if (!(r.countersunkHead.diameter > loose))
      out.push(`${at}: countersink must exceed the clearance`)
  }
  const values = (r: FastenerRow): number[] => [
    r.nominal,
    r.pitch,
    r.tapDrill,
    r.clearance.close,
    r.clearance.normal,
    r.clearance.loose,
    r.socketHead.diameter,
    r.socketHead.height,
    r.counterbore.diameter,
    r.countersunkHead.diameter,
  ]
  for (let i = 1; i < rows.length; i++) {
    const a = values(rows[i - 1]!)
    const b = values(rows[i]!)
    if (a.some((v, j) => !(v < b[j]!))) out.push(`${rows[i]!.size}: sizes must grow with the size`)
  }
  return out
}
