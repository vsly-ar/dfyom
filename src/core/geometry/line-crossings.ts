/**
 * Crossings of a Line's grooves (engraved-patterns.md § Toolpath, § DFM read-out): the places
 * where two lines, or two stretches of one line, cross or meet, so the tool passes the place twice
 * (the later groove cuts air in the earlier one). Neighbouring elements of one line meet by
 * construction and do not count; a place where several lines meet counts once (points within
 * `CROSSING_MERGE` are one). Exact element intersections (crossings.ts), the elements bucketed by
 * their boxes on a grid, so a tiled pattern of thousands of arcs stays a few milliseconds.
 * Doc: docs/modes/engraved-patterns.md#implementation-e4
 */
import { intersect } from './2d/crossings'
import { chainBounds, type Bounds2, type Element } from './2d/model'

/** Crossing points closer than this (mm) are one place. */
export const CROSSING_MERGE = 0.01

/** One line: its elements end to end, a loop when `closed`. */
export interface CrossingLine {
  readonly elements: readonly Element[]
  readonly closed: boolean
}

const memo = new WeakMap<object, number>()

/** The number of places where the lines cross or meet (see above); cached per lines array. */
export function lineCrossings(lines: readonly CrossingLine[]): number {
  const hit = memo.get(lines)
  if (hit !== undefined) return hit
  const items: { e: Element; box: Bounds2; line: number; k: number; n: number; closed: boolean }[] =
    []
  lines.forEach((l, line) =>
    l.elements.forEach((e, k) =>
      items.push({
        e,
        box: chainBounds([e])!,
        line,
        k,
        n: l.elements.length,
        closed: l.closed,
      }),
    ),
  )
  const all = chainBounds(items.map((i) => i.e))
  if (all === undefined) {
    memo.set(lines, 0)
    return 0
  }
  const span = Math.max(all.max[0] - all.min[0], all.max[1] - all.min[1], 1)
  const size = Math.max(span / Math.max(1, Math.ceil(Math.sqrt(items.length))), 0.5)
  const grid = new Map<string, number[]>()
  const keys = (b: Bounds2): string[] => {
    const out: string[] = []
    for (let x = Math.floor(b.min[0] / size); x <= Math.floor(b.max[0] / size); x++)
      for (let y = Math.floor(b.min[1] / size); y <= Math.floor(b.max[1] / size); y++)
        out.push(`${x},${y}`)
    return out
  }
  const places = new Set<string>()
  const eps = 1e-9
  items.forEach((a, i) => {
    const seen = new Set<number>()
    for (const key of keys(a.box)) {
      const list = grid.get(key)
      if (list === undefined) {
        grid.set(key, [i])
        continue
      }
      for (const j of list) {
        if (seen.has(j)) continue
        seen.add(j)
        const b = items[j]!
        if (
          b.box.min[0] > a.box.max[0] + eps ||
          b.box.max[0] < a.box.min[0] - eps ||
          b.box.min[1] > a.box.max[1] + eps ||
          b.box.max[1] < a.box.min[1] - eps
        )
          continue
        // neighbours along one line meet at their shared end by construction
        if (a.line === b.line) {
          const d = Math.abs(a.k - b.k)
          if (d === 1 || (a.closed && d === a.n - 1)) continue
        }
        const hits = intersect(a.e, b.e)
        if (hits === 'overlap') continue
        for (const h of hits)
          places.add(
            `${Math.round(h.p[0] / CROSSING_MERGE)},${Math.round(h.p[1] / CROSSING_MERGE)}`,
          )
      }
      list.push(i)
    }
  })
  memo.set(lines, places.size)
  return places.size
}
