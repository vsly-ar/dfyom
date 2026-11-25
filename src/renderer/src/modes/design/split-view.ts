// Split parts 4a, renderer view model: the part menu's order (pieces under their source), the
// split editor's args (the whole split from the stored sources, one field changed), the pieces'
// blanks and the preview's rectangles. Pure. Doc: docs/conventions/ui.md#split-part-split-parts-4a,
// docs/modes/split-parts.md#ui-summary-design
import type { PartDTO, SplitDTO } from '../../../../core/design/part.dto'
import type { ProjectDoc } from '../../../../core/project/document'

const mm = (q: { exact: { num: string; den: string } }): number =>
  Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))

/** Parts for the part menu: every source in document order, its pieces right after it. */
export function partMenuOrder(doc: ProjectDoc): { part: PartDTO; inset: boolean }[] {
  const parts = Object.values(doc.parts)
  const out: { part: PartDTO; inset: boolean }[] = []
  for (const p of parts) {
    if (p.derivedFrom !== undefined && Object.hasOwn(doc.parts, p.derivedFrom.partId)) continue
    out.push({ part: p, inset: false })
    for (const piece of piecesOf(doc, p.id)) out.push({ part: piece, inset: true })
  }
  return out
}

/** A source's pieces by number. */
export function piecesOf(doc: ProjectDoc, sourceId: string): PartDTO[] {
  return Object.values(doc.parts)
    .filter((p) => p.derivedFrom?.partId === sourceId)
    .sort((a, b) => a.derivedFrom!.index - b.derivedFrom!.index)
}

/** One dowel hole as sources: `level` indexes the split's levels (split parts 4b). */
export interface DowelHoleArgs {
  readonly level: number
  readonly at: readonly [string, string]
}

/** The dowels arg: absent fields are chosen by the core (Ø to fit, depth, placed holes). */
export interface DowelArgs {
  readonly diameter?: string
  readonly depth?: string
  readonly holes?: readonly DowelHoleArgs[]
}

/** `design.split.set`'s `split` arg as sources. */
export interface SplitArgs {
  readonly lines: readonly { readonly axis: 'x' | 'y'; readonly at: string }[]
  readonly levels: readonly string[]
  readonly margin: string
  /** The lines' key (4b-2); absent = butt lines. */
  readonly joint?: 'puzzle' | 'dovetail'
  /** The keys' socket clearance (4b-2); absent = the stored one, else the default. */
  readonly clearance?: string
  /** Dowels joining the levels (4b); absent = butt levels. */
  readonly dowels?: DowelArgs
}

export function splitArgs(split: SplitDTO): SplitArgs {
  const d = split.joint.dowels
  const kind = split.joint.kind
  const c = split.joint.clearance
  return {
    lines: split.lines.map((l) => ({ axis: l.axis, at: l.at.source })),
    levels: split.levels.map((q) => q.source),
    margin: split.margin.source,
    ...(kind === 'butt'
      ? {}
      : { joint: kind, ...(c === undefined ? {} : { clearance: c.source }) }),
    ...(d === undefined
      ? {}
      : {
          dowels: {
            diameter: d.diameter.source,
            depth: d.depth.source,
            holes: d.holes.map((h) => ({ level: h.level, at: [h.at[0].source, h.at[1].source] })),
          },
        }),
  }
}

/**
 * The split without level `index`: its dowel holes go, the later levels' holes are renumbered
 * (holes index the levels as stored, 4b).
 */
export function withoutLevel(args: SplitArgs, index: number): SplitArgs {
  const levels = args.levels.filter((_, k) => k !== index)
  if (args.dowels?.holes === undefined) return { ...args, levels }
  const holes = args.dowels.holes.flatMap((h) =>
    h.level === index ? [] : [{ ...h, level: h.level > index ? h.level - 1 : h.level }],
  )
  return { ...args, levels, dowels: { ...args.dowels, holes } }
}

/** The dowel holes of a split in the source part frame (mm), for the preview and the list. */
export function dowelHoles(
  split: SplitDTO,
): { readonly k: number; readonly level: number; readonly x: number; readonly y: number }[] {
  return (split.joint.dowels?.holes ?? []).map((h, i) => ({
    k: i + 1,
    level: h.level,
    x: mm(h.at[0]),
    y: mm(h.at[1]),
  }))
}

/** A first split for "Split part…": one level at half the stock height (the user story's cut). */
export function firstSplit(thicknessMm: number, units: 'mm' | 'inch'): SplitArgs {
  const half = thicknessMm / 2
  return {
    lines: [],
    levels: [units === 'mm' ? `${-+half.toFixed(3)} mm` : `${-+(half / 25.4).toFixed(4)}"`],
    margin: units === 'mm' ? '5 mm' : '0.2"',
  }
}

/** Where a new line or level goes: midway in the widest gap between the existing ones. */
export function nextCut(existing: readonly number[], lo: number, hi: number): number {
  const xs = [lo, ...[...existing].sort((a, b) => a - b), hi]
  let best = 0
  for (let i = 1; i < xs.length; i++)
    if (xs[i]! - xs[i - 1]! > xs[best + 1]! - xs[best]!) best = i - 1
  return (xs[best]! + xs[best + 1]!) / 2
}

/** A length in mm as a source in the project units. */
export const cutSource = (v: number, units: 'mm' | 'inch'): string =>
  units === 'mm' ? `${+v.toFixed(3)} mm` : `${+(v / 25.4).toFixed(4)}"`

/** One piece for the chips and the preview (source part frame, mm). */
export interface PieceView {
  readonly id: string
  readonly n: number
  readonly name: string
  /** Blank length, width, thickness. */
  readonly blank: readonly [number, number, number]
  /** The blank's box in the source frame: x0, y0 (front-left) and z0 (bottom) to z1 (top). */
  readonly box: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }
}

export function pieceViews(doc: ProjectDoc, sourceId: string): PieceView[] {
  return piecesOf(doc, sourceId).flatMap((p) => {
    const snap = doc.snapshots[p.stock]
    if (snap?.values.kind !== 'stock' || p.offset === undefined) return []
    const v = snap.values
    const blank = [mm(v.length), mm(v.width), mm(v.thickness)] as const
    const [ox, oy, oz] = p.offset.map(mm) as [number, number, number]
    return [
      {
        id: p.id,
        n: p.derivedFrom!.index,
        name: p.name,
        blank,
        box: {
          x0: -ox,
          x1: -ox + blank[0],
          y0: -oy,
          y1: -oy + blank[1],
          z1: -oz,
          z0: -oz - blank[2],
        },
      },
    ]
  })
}

/** "259.5 × 187 × 40 mm" in the project units. */
export function blankText(blank: readonly number[], units: 'mm' | 'inch'): string {
  const f = (v: number) => (units === 'mm' ? `${+v.toFixed(2)}` : `${+(v / 25.4).toFixed(3)}`)
  return `${blank.map(f).join(' × ')}${units === 'mm' ? ' mm' : '"'}`
}

// ── the exploded preview in the viewport (split parts 4a polish) ─────────────────────────────

/** A split line (`axis` x or y) or level (`axis` z), its value in the source part frame (mm). */
export interface SplitCut {
  readonly kind: 'line' | 'level'
  /** Index into `split.lines` or `split.levels`. */
  readonly index: number
  readonly axis: 'x' | 'y' | 'z'
  readonly at: number
}

/** A cut moved by a viewport drag in progress. */
export interface CutDraft {
  readonly kind: 'line' | 'level'
  readonly index: number
  readonly at: number
}

/** The split's cuts, one of them moved to `draft` (a viewport drag in progress). */
export function splitCuts(split: SplitDTO, draft?: CutDraft | null): SplitCut[] {
  const moved = (kind: 'line' | 'level', index: number, at: number) =>
    draft != null && draft.kind === kind && draft.index === index ? draft.at : at
  return [
    ...split.lines.map((l, i) => ({
      kind: 'line' as const,
      index: i,
      axis: l.axis,
      at: moved('line', i, mm(l.at)),
    })),
    ...split.levels.map((q, i) => ({
      kind: 'level' as const,
      index: i,
      axis: 'z' as const,
      at: moved('level', i, mm(q)),
    })),
  ]
}

/** Stock extents (mm): the part frame box is x 0…L, y 0…W, z −T…0. */
export interface StockSize {
  readonly L: number
  readonly W: number
  readonly T: number
}

type V3 = readonly [number, number, number]

/** One grid cell of the exploded preview: its box in the part frame and how far it is pulled. */
export interface ExplodedCell {
  readonly key: string
  readonly min: V3
  readonly max: V3
  /** The pull along the cut normals at full explode (mm). */
  readonly offset: V3
}

/** The sorted cut values per axis inside the stock (cuts on or past an edge cut nothing). */
function breaks(cuts: readonly SplitCut[], s: StockSize) {
  const inside = (axis: 'x' | 'y' | 'z', lo: number, hi: number) =>
    [
      ...new Set(
        cuts
          .filter((c) => c.axis === axis && c.at > lo + 1e-9 && c.at < hi - 1e-9)
          .map((c) => c.at),
      ),
    ].sort((a, b) => a - b)
  return { x: inside('x', 0, s.L), y: inside('y', 0, s.W), z: inside('z', -s.T, 0) }
}

/** How far pieces are pulled apart per cut (mm): a few % of the part, 4–30 mm. */
export function explodeGap(s: StockSize): number {
  return Math.min(30, Math.max(4, Math.max(s.L, s.W, s.T) * 0.06))
}

/**
 * The stock box cut into grid cells by the lines and levels, each pulled along the cut normals
 * by `gap` per cut it lies beyond, symmetric about the middle (the preview clips the part's mesh to
 * each cell; cells with no material show nothing).
 */
export function explodedCells(
  cuts: readonly SplitCut[],
  s: StockSize,
  gap: number,
): ExplodedCell[] {
  const b = breaks(cuts, s)
  const xs = [0, ...b.x, s.L]
  const ys = [0, ...b.y, s.W]
  const zs = [-s.T, ...b.z, 0]
  const out: ExplodedCell[] = []
  for (let i = 0; i + 1 < xs.length; i++)
    for (let j = 0; j + 1 < ys.length; j++)
      for (let k = 0; k + 1 < zs.length; k++)
        out.push({
          key: `${i}:${j}:${k}`,
          min: [xs[i]!, ys[j]!, zs[k]!],
          max: [xs[i + 1]!, ys[j + 1]!, zs[k + 1]!],
          offset: [
            (i - b.x.length / 2) * gap,
            (j - b.y.length / 2) * gap,
            (k - b.z.length / 2) * gap,
          ],
        })
  return out
}

/** Where a cut's handle sits in the exploded preview: the middle of its gap, along its axis (mm). */
export function cutShift(
  cuts: readonly SplitCut[],
  cut: SplitCut,
  s: StockSize,
  gap: number,
): number {
  const b = breaks(cuts, s)[cut.axis]
  const rank = b.filter((v) => v < cut.at - 1e-9).length
  return (rank + 0.5 - b.length / 2) * gap
}

/** A dragged cut is kept this far (mm) inside the stock. */
const EDGE_KEEP = 1

/**
 * A dragged value snapped (split parts 4a polish): to the part's middle along the axis when within
 * `pull` mm, else to whole millimetres; always kept inside the stock. `snap` false (snapping off,
 * or Alt held) keeps 0.01 mm.
 */
export function snapCut(
  value: number,
  axis: 'x' | 'y' | 'z',
  s: StockSize,
  snap: boolean,
  pull: number,
): number {
  const [lo, hi] = axis === 'x' ? [0, s.L] : axis === 'y' ? [0, s.W] : [-s.T, 0]
  const mid = (lo + hi) / 2
  const v = !snap
    ? Math.round(value * 100) / 100
    : Math.abs(value - mid) <= pull
      ? mid
      : Math.round(value)
  return Math.min(hi - EDGE_KEEP, Math.max(lo + EDGE_KEEP, v))
}

/** The split findings that concern a cut (a thin glue face on it, a feature near it). */
export function cutFindings<W extends { code: string; params?: Record<string, unknown> }>(
  warnings: readonly W[],
  cut: SplitCut,
): W[] {
  const near = (v: unknown) => typeof v === 'number' && Math.abs(v - cut.at) < 1e-6
  const has = (v: unknown) => Array.isArray(v) && v.some(near)
  return warnings.filter((w) => {
    if (w.code !== 'design.split' || w.params === undefined) return false
    const p = w.params
    if (cut.kind === 'level') return near(p['level']) || has(p['nearZ'])
    return (
      (p['axis'] === cut.axis && near(p['at'])) || has(cut.axis === 'x' ? p['nearX'] : p['nearY'])
    )
  })
}
