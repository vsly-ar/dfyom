// Tabs of a selected profile along its loop (task U2), pure: the loop in the face frame as the
// geometry input builds it (its start point, counter-clockwise), the tab centres the cut uses
// (`tabs.positions`, else the count rule: evenly from half a spacing after the start point, v0.1
// rectangles and circles from the middle of their front wall), the distance along the loop of a
// point, a dragged marker kept off its neighbours, and a new tab in the largest gap.
// Doc: docs/conventions/ui.md#tab-markers, docs/modes/design-v0.3.md#tabs-on-shapes
import { toGeometryInput } from '../../../../core/design/geometry-input'
import { profileChain, tabCentres } from '../../../../core/geometry/outline'
import { chainLength, chainPointAt, closestOnChains } from '../../../../core/geometry/2d/measure'
import {
  arcRadius,
  elementLength,
  type Loop,
} from '../../../../core/geometry/2d/model'
import type { Region2dPort } from '../../../../core/geometry/2d/port'
import type { OperationGeometry, Vec2 } from '../../../../core/geometry/model'
import { wallMiddle } from '../../../../core/toolpath/pocket'
import type { DesignPart } from './model'

type ProfileGeometry = Extract<OperationGeometry, { kind: 'profile' }>

export interface ProfileTabs {
  /** The loop (or open path) in the face frame, from its start point. */
  readonly chain: Loop
  readonly closed: boolean
  readonly length: number
  readonly side: ProfileGeometry['side']
  readonly slotWidth: number
  /** Tab width (mm). */
  readonly width: number
  /** Tab centres as distances from the start point, in the order stored (mm). */
  readonly centres: readonly number[]
  /** The centres are `tabs.positions` (entered), not the count rule. */
  readonly entered: boolean
  /** Tabs hold this cut: a closed loop cut through. */
  readonly allowed: boolean
}

const cache = new WeakMap<DesignPart, Map<string, ProfileTabs | null>>()

/** The tabs of profile `operationId`; undefined when it does not resolve (or is no profile). */
export function profileTabs(
  part: DesignPart,
  operationId: string,
  port: Region2dPort | undefined,
): ProfileTabs | undefined {
  const loaded = part.loaded
  if (loaded === undefined) return undefined
  let byOp = cache.get(part)
  if (byOp === undefined) cache.set(part, (byOp = new Map()))
  const key = `${operationId}:${port === undefined ? 0 : 1}`
  const hit = byOp.get(key)
  if (hit !== undefined) return hit ?? undefined
  const input = toGeometryInput(loaded.part, loaded.stock, port)
  const g = input.isOk()
    ? input.unwrap().operations.find((o) => o.id === operationId)
    : undefined
  const out = g?.kind === 'profile' ? tabsOf(g) : undefined
  byOp.set(key, out ?? null)
  return out
}

function tabsOf(g: ProfileGeometry): ProfileTabs {
  const { chain, closed } = profileChain(g)
  const length = chainLength(chain)
  const c = g.shape.contour
  const entered = g.tabs.positions !== undefined
  let centres: number[]
  if (entered || (c.kind !== 'rectangle' && c.kind !== 'circle'))
    centres = tabCentres(length, g.tabs)
  else {
    // v0.1 rule (toolpath/tabs.ts): the first at the middle of the front wall
    const n = Number.isInteger(g.tabs.count) && g.tabs.count > 0 ? g.tabs.count : 0
    const s0 = wallMiddle(c)
    centres = Array.from({ length: n }, (_, i) => mod(s0 + (i * length) / n, length))
  }
  return {
    chain,
    closed,
    length,
    side: g.side,
    slotWidth: g.slotWidth,
    width: g.tabs.width,
    centres,
    entered,
    allowed: closed && g.depth === undefined,
  }
}

const mod = (x: number, m: number): number => (m > 0 ? ((x % m) + m) % m : 0)

/** The distance along `chain` of its point closest to `q` (face frame, mm). */
export function distanceAlong(chain: Loop, q: Vec2): number {
  const near = closestOnChains([chain], q)
  if (near === undefined) return 0
  let s = 0
  for (let i = 0; i < near.element; i++) s += elementLength(chain.elements[i]!)
  const e = chain.elements[near.element]!
  if (e.kind === 'line') return s + Math.hypot(near.point[0] - e.a[0], near.point[1] - e.a[1])
  const r = arcRadius(e)
  const a0 = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
  const a1 = Math.atan2(near.point[1] - e.centre[1], near.point[0] - e.centre[0])
  let d = e.ccw ? a1 - a0 : a0 - a1
  d = mod(d, 2 * Math.PI)
  return s + Math.min(d * r, elementLength(e))
}

/** The point and unit tangent at distance `s` along the chain. */
export function pointAlong(t: ProfileTabs, s: number): { point: Vec2; tangent: Vec2 } | undefined {
  const r = chainPointAt(t.chain, s, t.closed)
  return r.isOk() ? { point: r.unwrap().point, tangent: r.unwrap().tangent } : undefined
}

/**
 * Tab `index` moved to `s`, kept on the loop (0 ≤ s < length) and at least a tab width (plus
 * `margin` for rounding) from its neighbours around the loop, so a drag never makes `tabsOverlap`.
 * Past a neighbour it stops at that neighbour's edge (the interval's end nearer around the loop).
 */
export function clampTab(
  centres: readonly number[],
  index: number,
  s: number,
  width: number,
  length: number,
  margin = 0.02,
): number {
  const from = centres[index] ?? s
  const others = centres.filter((_, i) => i !== index)
  const target = mod(s, length)
  if (others.length === 0 || length <= 0) return target
  const gap = width + margin
  // the neighbours before and after the tab's place at the drag's start
  let prev = -Infinity
  let next = Infinity
  for (const o of others) {
    const back = mod(from - o, length)
    const ahead = mod(o - from, length)
    if (from - back > prev) prev = from - back
    if (from + ahead < next) next = from + ahead
  }
  const lo = prev + gap
  const hi = next - gap
  if (lo > hi) return mod(from, length)
  // the target unwrapped nearest the middle of the tab's interval, clamped into it
  const mid = (lo + hi) / 2
  const t = mid + mod(target - mid + length / 2, length) - length / 2
  return mod(Math.min(hi, Math.max(lo, t)), length)
}

/** A new tab's place: the middle of the largest gap between tabs (half the loop when none). */
export function newTabPosition(centres: readonly number[], length: number): number {
  if (centres.length === 0) return length / 2
  const sorted = [...centres].map((c) => mod(c, length)).sort((a, b) => a - b)
  let best = { at: 0, gap: -1 }
  sorted.forEach((c, i) => {
    const next = i + 1 < sorted.length ? sorted[i + 1]! : sorted[0]! + length
    if (next - c > best.gap) best = { at: c + (next - c) / 2, gap: next - c }
  })
  return mod(best.at, length)
}
