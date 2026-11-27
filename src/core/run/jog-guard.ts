/**
 * The workholding guard of a hand move (hardening DF133 RW2): a jog or a Go to step is one straight
 * move of the tool tip; `jogGuard` checks it against the setup's items with the tool's stepped
 * envelope (tool, collet nut, spindle body) and the per-move test of the workholding collision
 * check, plus the stock top for the nut and body (Q188), and shortens it to just before the first
 * contact. A move that starts inside an item may leave it, never go deeper. `nearestClearance` is
 * the live read-out's distance, `itemClearances` the scene's item colours (RW5). Jogs reach it
 * through `guardedJog` (RW3).
 * Doc: docs/modes/run-workholding.md#the-guard, #implementation-rw2
 *
 * Pure and headless; mm in the setup frame (the frame of the items, Z0 on the stock top).
 */
import type { Vec2 } from '../geometry/model'
import type { Vec3 } from '../toolpath/model'
import { GAP_TOLERANCE } from '../plan/workholding/check'
import type { EnvelopePart, EnvelopeSegment } from '../plan/workholding/envelope'
import { segmentDistance, type Footprint, type Prism } from '../plan/workholding/obstacles'

/** The id a contact with the stock top carries (item ids are `wh<n>`). */
export const STOCK_TOP = 'stock'

/** The stop lies this far (mm, along the move) before the first contact. */
export const STOP_BACKOFF = 0.01
/** The first contact is found to this (mm, along the move). */
export const CONTACT_RESOLUTION = 0.005

export interface JogGuardInput {
  /** Where the tool tip is (setup frame, mm). */
  readonly from: Vec3
  /** Where the move would take it. */
  readonly to: Vec3
  /** `toolEnvelope(tool, stickout, holder)`: the tool first, then nut and body when known. */
  readonly envelope: readonly EnvelopeSegment[]
  /** The setup's obstacle prisms (`setupWorkholding(…).prisms`). */
  readonly prisms: readonly Prism[]
  /** The setup's `workholdingMargin` (mm). */
  readonly margin: number
  /**
   * The stock's extents in the setup (X, Y from the front-left corner of the top): the nut and the
   * body stay above its top plane over it (Q188; the tool tip may enter). Absent: not checked.
   */
  readonly stock?: { readonly length: number; readonly width: number }
}

export interface JogContact {
  /** The item hit, or `STOCK_TOP`. */
  readonly itemId: string
  /** The envelope part that hits it first. */
  readonly part: EnvelopePart
  /** The tip where the contact begins (setup frame, mm; within `CONTACT_RESOLUTION`). */
  readonly at: Vec3
  /** Gap between that part and the item at `allowed` (mm; 0 when blocked inside). */
  readonly gap: number
}

export interface JogGuardResult {
  /** How far the move may go: `to` without a contact, `from` when it may not move at all. */
  readonly allowed: Vec3
  readonly contact?: JogContact
}

interface Obstacle {
  readonly itemId: string
  readonly footprint: Footprint
  /** The obstacle's top (`zMax`; the stock top: Z0). */
  readonly surface: number
  /** The plane a part's bottom stays at or above within the margin sideways (`zMax` + margin). */
  readonly top: number
  /** The stock top: only the nut and body count. */
  readonly holderOnly: boolean
}

const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + t * (b[0] - a[0]),
  a[1] + t * (b[1] - a[1]),
  a[2] + t * (b[2] - a[2]),
]
const xy = (p: Vec3): Vec2 => [p[0], p[1]]

function obstaclesOf(input: JogGuardInput): Obstacle[] {
  const out: Obstacle[] = input.prisms.map((p) => ({
    itemId: p.itemId,
    footprint: p.footprint,
    surface: p.zMax,
    top: p.zMax + input.margin,
    holderOnly: false,
  }))
  if (input.stock !== undefined) {
    const { length: l, width: w } = input.stock
    // Z0 over the stock (and within the margin of its sides): the nut and body never below it
    out.push({
      itemId: STOCK_TOP,
      footprint: {
        kind: 'polygon',
        points: [
          [0, 0],
          [l, 0],
          [l, w],
          [0, w],
        ],
      },
      surface: 0,
      top: 0,
      holderOnly: true,
    })
  }
  return out
}

/** The parts of a's→b's tip path below `z` (as `checkWorkholding`'s `below`), or undefined. */
function below(a: Vec3, b: Vec3, z: number): [Vec3, Vec3] | undefined {
  if (a[2] >= z && b[2] >= z) return undefined
  if (a[2] < z && b[2] < z) return [a, b]
  const t = (z - a[2]) / (b[2] - a[2])
  const m: Vec3 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), z]
  return a[2] < z ? [a, m] : [m, b]
}

/**
 * The per-move test of the workholding check for one obstacle: the smallest gap of a part that
 * comes under the obstacle's top within the margin on the tip path a→b, or undefined (clear).
 * The tool first (it is lower); a part counts from its bottom up, as `checkWorkholding`.
 */
function hit(
  a: Vec3,
  b: Vec3,
  o: Obstacle,
  envelope: readonly EnvelopeSegment[],
  margin: number,
): { part: EnvelopePart; gap: number } | undefined {
  let best: { part: EnvelopePart; gap: number } | undefined
  for (const e of envelope) {
    if (o.holderOnly && e.part === 'tool') continue
    const part = below(a, b, o.top - e.zFrom)
    if (part === undefined) continue
    const d = segmentDistance(o.footprint, xy(part[0]), xy(part[1])).distance
    const gap = Math.max(0, d - e.radius)
    if (gap >= margin - GAP_TOLERANCE) continue
    if (best === undefined) best = { part: e.part, gap }
  }
  return best
}

/** The obstacles the path from→p hits, with their part and gap. */
function hits(
  from: Vec3,
  p: Vec3,
  obstacles: readonly Obstacle[],
  envelope: readonly EnvelopeSegment[],
  margin: number,
): { o: Obstacle; part: EnvelopePart; gap: number }[] {
  return obstacles.flatMap((o) => {
    const h = hit(from, p, o, envelope, margin)
    return h === undefined ? [] : [{ o, ...h }]
  })
}

/**
 * May a move that starts inside obstacle `o` go from→to? Only when it never goes deeper: the tip
 * does not go down and its axis never comes closer to the footprint (the distance from a point
 * moving on a line to a convex footprint is convex in the move, so its slope at the start says).
 */
function leaves(from: Vec3, to: Vec3, o: Obstacle): boolean {
  if (to[2] < from[2] - 1e-9) return false
  const len = Math.hypot(to[0] - from[0], to[1] - from[1])
  if (len < 1e-9) return true
  const d0 = segmentDistance(o.footprint, xy(from), xy(from)).distance
  const step = lerp(from, to, Math.min(1, 1e-3 / len))
  const d1 = segmentDistance(o.footprint, xy(step), xy(step)).distance
  return d1 >= d0 - 1e-9
}

/**
 * `jogGuard`: how far the straight move from→to may go before the envelope comes within the
 * margin of an item (or the nut and body under the stock top), and what it would hit.
 */
export function jogGuard(input: JogGuardInput): JogGuardResult {
  const { from, to, envelope, margin } = input
  const all = obstaclesOf(input)
  // starting inside (a crash, an override, a moved zero): those obstacles only forbid going deeper
  const inside = hits(from, from, all, envelope, margin)
  for (const h of inside)
    if (!leaves(from, to, h.o))
      return { allowed: from, contact: { itemId: h.o.itemId, part: h.part, at: from, gap: h.gap } }
  const skip = new Set(inside.map((h) => h.o))
  const rest = all.filter((o) => !skip.has(o))
  const collides = (t: number) => hits(from, lerp(from, to, t), rest, envelope, margin).length > 0
  if (!collides(1)) return { allowed: to }
  // the prefix from → from + t (to − from) collides from t* on: bisect to the resolution
  const length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2])
  let lo = 0
  let hi = 1
  while ((hi - lo) * length > CONTACT_RESOLUTION) {
    const mid = (lo + hi) / 2
    if (collides(mid)) hi = mid
    else lo = mid
  }
  const at = lerp(from, to, hi)
  const allowed = lerp(from, to, Math.max(0, lo - STOP_BACKOFF / length))
  // what it hits: the obstacle with the smallest gap at the contact (the tool before the holder)
  const order: Record<EnvelopePart, number> = { tool: 0, nut: 1, body: 2 }
  const first = hits(from, at, rest, envelope, margin).sort(
    (a, b) => a.gap - b.gap || order[a.part] - order[b.part],
  )[0]!
  const left = clearanceTo(allowed, first.o, envelope, first.part)
  return {
    allowed,
    contact: { itemId: first.o.itemId, part: first.part, at, gap: left },
  }
}

/** The distance from `part` of the envelope at tip `p` to obstacle `o` (mm, 0 when touching). */
function clearanceTo(
  p: Vec3,
  o: Obstacle,
  envelope: readonly EnvelopeSegment[],
  part: EnvelopePart,
): number {
  const e = envelope.find((s) => s.part === part)!
  const d = segmentDistance(o.footprint, xy(p), xy(p)).distance
  const side = Math.max(0, d - e.radius)
  const up = Math.max(0, p[2] + e.zFrom - o.surface)
  return Math.hypot(side, up)
}

/** The nearest item to the envelope at a tip position (the live clearance read-out, RW5). */
export interface Clearance {
  readonly itemId: string
  readonly part: EnvelopePart
  /** mm between that part and the item (sideways, above, or both); 0 touching or inside. */
  readonly gap: number
}

/**
 * `itemClearances(at, envelope, prisms)` (RW5): per item, its nearest part of the envelope at tip
 * `at` and the distance (a part's side and bottom to the prism's footprint and top, combined as
 * `hypot`); one entry per item that has prisms, in the prisms' order.
 */
export function itemClearances(
  at: Vec3,
  envelope: readonly EnvelopeSegment[],
  prisms: readonly Prism[],
): Clearance[] {
  const best = new Map<string, Clearance>()
  for (const p of prisms) {
    const d = segmentDistance(p.footprint, xy(at), xy(at)).distance
    for (const e of envelope) {
      const side = Math.max(0, d - e.radius)
      const up = Math.max(0, at[2] + e.zFrom - p.zMax)
      const gap = Math.hypot(side, up)
      const b = best.get(p.itemId)
      if (b === undefined || gap < b.gap - 1e-12)
        best.set(p.itemId, { itemId: p.itemId, part: e.part, gap })
    }
  }
  return [...best.values()]
}

/**
 * `nearestClearance(at, envelope, prisms)`: the item nearest to any part of the envelope at tip
 * `at` (the smallest of `itemClearances`; the first item on a tie), or undefined without items.
 */
export function nearestClearance(
  at: Vec3,
  envelope: readonly EnvelopeSegment[],
  prisms: readonly Prism[],
): Clearance | undefined {
  let best: Clearance | undefined
  for (const c of itemClearances(at, envelope, prisms))
    if (best === undefined || c.gap < best.gap - 1e-12) best = c
  return best
}
