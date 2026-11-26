/**
 * `dfm.lineMerge` (engraved-patterns.md § DFM, E4): where two grooves of a Line (two lines, or
 * two stretches of one line) run side by side closer than half their widths plus 0.3 mm, so the
 * wall left between them is under 0.3 mm (or gone) and breaks away. Found as
 * `dfm.patternThinWeb` finds webs, by measuring: every line is sampled along its arc length, the
 * samples bucketed on a grid, and pairs that run side by side (tangents within 25° of parallel)
 * compared across their lines' widths at those depths. Crossings, tangencies, T-junctions and
 * lines running on from one another are not merges: a crossing's tangents differ, a run-on has no
 * sideways offset, and near where two lines meet (a tangent ring, a shallow crossing) they join
 * by design, with no wall between them. Up to `LINE_MERGE_MARKERS` places, one per pair of lines, thinnest first.
 * Doc: docs/modes/engraved-patterns.md#dfm, docs/modes/engraved-patterns.md#implementation-e4
 */
import { elementLength } from './2d/model'
import { elementPointAt } from './2d/measure'
import { grooveWidth, lineChains, profileAt, type LineChainsInput } from './line'
import type { LineCutter, Vec2 } from './model'

/** A wall under this between two grooves breaks away (mm). */
export const LINE_MERGE_WALL = 0.3
/** At most these many places are reported. */
export const LINE_MERGE_MARKERS = 10
/** Grooves whose centrelines are this close sideways meet as one (a junction, not a wall; mm). */
const TOUCH = 0.05
/** Side by side: tangents within this angle of parallel (or antiparallel). */
const PARALLEL_SIN = Math.sin((25 * Math.PI) / 180)
/** A close stretch within this many reaches of where its two lines meet is part of that joint. */
const MEET_REACH = 10
/** Open ends run on this many reaches for the meet test. */
const AHEAD_REACH = 4

/** A joint turning back by more than 150° is a cusp. */
const CUSP_COS = Math.cos((150 * Math.PI) / 180)

const neg = (v: Vec2): Vec2 => [-v[0], -v[1]]

/** One thin wall: where (face frame), its thickness (negative: the grooves overlap) and lines. */
export interface LineMerge {
  readonly at: Vec2
  readonly wall: number
  readonly lines: readonly [number, number]
}

interface Sample {
  readonly p: Vec2
  readonly t: Vec2
  readonly line: number
  readonly s: number
  readonly half: number
  /** On an open end's extension (where a cut-off line would have gone): meets only. */
  readonly ahead?: true
}

const memo = new WeakMap<object, readonly LineMerge[]>()

/** The thin walls between a Line's grooves (see above), thinnest first; cached per geometry. */
export function lineMerges(
  op: LineChainsInput & { readonly cutter: LineCutter },
): readonly LineMerge[] {
  const hit = memo.get(op)
  if (hit !== undefined) return hit
  const lines = lineChains(op).lines
  let widest = 0
  for (const l of lines)
    for (const d of l.profile.d) widest = Math.max(widest, grooveWidth(op.cutter, d))
  const reach = widest + LINE_MERGE_WALL
  // samples about a third of the narrowest gap that counts apart, at most 0.5 mm
  const step = Math.min(0.5, Math.max(0.1, reach / 4))
  const samples: Sample[] = []
  // where pairs of lines meet (crossings, touches; a line with itself: its cusps)
  const meets = new Map<string, Vec2[]>()
  const meet = (pair: string, m: Vec2) => {
    const list = meets.get(pair)
    if (list === undefined) meets.set(pair, [m])
    else list.push(m)
  }
  lines.forEach((l, li) => {
    // a cusp (the line turning back on itself at a joint, as scales chained end to end): the
    // two stretches either side join there by design
    l.elements.forEach((e, k) => {
      const next = l.elements[k + 1] ?? (l.closed ? l.elements[0] : undefined)
      if (next === undefined) return
      const t0 = elementPointAt(e, 1).tangent
      const t1 = elementPointAt(next, 0).tangent
      if (t0[0] * t1[0] + t0[1] * t1[1] < CUSP_COS) meet(`${li}:${li}`, e.b)
    })
    let acc = 0
    for (const e of l.elements) {
      const len = elementLength(e)
      const n = Math.max(1, Math.ceil(len / step))
      for (let k = 0; k < n; k++) {
        const u = (k + 0.5) / n
        const { point, tangent } = elementPointAt(e, u)
        const s = acc + u * len
        samples.push({
          p: point,
          t: tangent,
          line: li,
          s,
          half: grooveWidth(op.cutter, profileAt(l.profile, s)) / 2,
        })
      }
      acc += len
    }
    // an open line runs on straight past its ends for a while: two lines cut off (clipped at a
    // boundary) just before they meet still meet there, while parallel ends never do
    if (!l.closed) {
      const first = l.elements[0]!
      const last = l.elements.at(-1)!
      const ends: [Vec2, Vec2][] = [
        [first.a, neg(elementPointAt(first, 0).tangent)],
        [last.b, elementPointAt(last, 1).tangent],
      ]
      const n = Math.ceil((AHEAD_REACH * reach) / step)
      for (const [p, t] of ends)
        for (let k = 1; k <= n; k++)
          samples.push({
            p: [p[0] + t[0] * k * step, p[1] + t[1] * k * step],
            t,
            line: li,
            s: -1,
            half: 0,
            ahead: true,
          })
    }
  })
  const cell = Math.max(reach, step)
  const grid = new Map<string, number[]>()
  const key = (x: number, y: number) => `${x},${y}`
  samples.forEach((q, i) => {
    const k = key(Math.floor(q.p[0] / cell), Math.floor(q.p[1] / cell))
    const list = grid.get(k)
    if (list === undefined) grid.set(k, [i])
    else list.push(i)
  })
  // candidates per pair of lines
  const found = new Map<string, LineMerge[]>()
  const meetAt = step * 0.75
  samples.forEach((a, i) => {
    const gx = Math.floor(a.p[0] / cell)
    const gy = Math.floor(a.p[1] / cell)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(key(gx + dx, gy + dy)) ?? []) {
          if (j <= i) continue
          const b = samples[j]!
          const vx = b.p[0] - a.p[0]
          const vy = b.p[1] - a.p[1]
          const pair = a.line < b.line ? `${a.line}:${b.line}` : `${b.line}:${a.line}`
          if (a.line !== b.line && Math.hypot(vx, vy) < meetAt)
            meet(pair, [(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2])
          if (a.ahead === true || b.ahead === true) continue
          // side by side: b lies across a's tangent (not along it), the two run parallel
          const along = Math.abs(a.t[0] * vx + a.t[1] * vy)
          const side = Math.abs(a.t[0] * vy - a.t[1] * vx)
          if (along > step || side <= TOUCH) continue
          if (Math.abs(a.t[0] * b.t[1] - a.t[1] * b.t[0]) > PARALLEL_SIN) continue
          const wall = side - a.half - b.half
          if (wall >= LINE_MERGE_WALL) continue
          if (a.line === b.line) {
            // two stretches of one line: not neighbours along it (a closed line wraps)
            const l = lines[a.line]!
            const ds = Math.abs(a.s - b.s)
            const apart = l.closed ? Math.min(ds, l.length - ds) : ds
            if (apart <= 2 * reach + Math.PI * side) continue
          }
          const m: LineMerge = {
            at: [(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2],
            wall,
            lines: [Math.min(a.line, b.line), Math.max(a.line, b.line)],
          }
          const list = found.get(pair)
          if (list === undefined) found.set(pair, [m])
          else list.push(m)
        }
  })
  // lines that cross or touch near a close stretch join there by design (a tangent ring, a
  // shallow crossing): no wall stands between them, so that stretch is no merge
  const near = MEET_REACH * reach
  const best = new Map<string, LineMerge>()
  for (const [pair, list] of found) {
    const at = meets.get(pair) ?? []
    for (const m of list) {
      if (at.some((p) => Math.hypot(p[0] - m.at[0], p[1] - m.at[1]) < near)) continue
      const was = best.get(pair)
      if (was === undefined || m.wall < was.wall) best.set(pair, m)
    }
  }
  const out = [...best.values()].sort((x, y) => x.wall - y.wall).slice(0, LINE_MERGE_MARKERS)
  memo.set(op, out)
  return out
}
