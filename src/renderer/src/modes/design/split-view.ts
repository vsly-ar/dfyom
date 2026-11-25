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

/** `design.split.set`'s `split` arg as sources. */
export interface SplitArgs {
  readonly lines: readonly { readonly axis: 'x' | 'y'; readonly at: string }[]
  readonly levels: readonly string[]
  readonly margin: string
}

export function splitArgs(split: SplitDTO): SplitArgs {
  return {
    lines: split.lines.map((l) => ({ axis: l.axis, at: l.at.source })),
    levels: split.levels.map((q) => q.source),
    margin: split.margin.source,
  }
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
