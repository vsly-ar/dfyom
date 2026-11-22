/**
 * Tabs for profile toolpaths: the nominal tab bands of geometry evaluation (same `offsetBand`,
 * so the tool lifts exactly where the geometry keeps material) and the lift over them.
 * Doc: docs/modes/plan-v0.1.md#toolpath-generators-task-210, bands: docs/architecture/geometry.md#offset-loft
 */
import { offsetBand } from '../geometry/loft'
import { EPSILON, type Vec2 } from '../geometry/model'
import { Err, Ok, type AppResult } from '../../shared/result'
import type { ProfileOperation } from './model'
import { segLength, segPoint, segSlice, type Seg3 } from './path'

/** A tab band's outline in XY (part frame) as triangles. */
export type TabBand = readonly (readonly [Vec2, Vec2, Vec2])[]

/**
 * Nominal bands of tabs centred at `centres` (arc lengths along the shape: the count rule with
 * tabs off free sides moved, `analyticTabCentres`): exactly across the slot, as geometry's
 * `nominal` regions. None when the slot covers an inside opening.
 */
export function tabBands(op: ProfileOperation, centres: readonly number[]): AppResult<TabBand[]> {
  const bands: TabBand[] = []
  const outside = op.side === 'outside'
  const [cx, cy] = op.shape.center
  for (const [i, c] of centres.entries()) {
    const mesh = offsetBand(
      op.shape.contour,
      {
        from: c - op.tabs.width / 2,
        to: c + op.tabs.width / 2,
        inner: outside ? 0 : op.slotWidth,
        outer: outside ? -op.slotWidth : 0,
        bottom: 0,
        top: 1,
      },
      { top: 1, bottom: 0, side: 0, end: [0, 0] },
    )
    if (mesh.isErr()) return Err(mesh.unwrapErr().withContext('tabBands', { tab: i }))
    const { positions: p, triangles: t, faces } = mesh.unwrap()
    const band: (readonly [Vec2, Vec2, Vec2])[] = []
    for (let k = 0; k < faces.length; k++) {
      if (faces[k] !== 1) continue
      const v = (j: number): Vec2 => [p[3 * t[3 * k + j]!]! + cx, p[3 * t[3 * k + j]! + 1]! + cy]
      band.push([v(0), v(1), v(2)])
    }
    bands.push(band)
  }
  return Ok(bands)
}

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

function inTriangle(p: Vec2, [a, b, c]: readonly [Vec2, Vec2, Vec2]): boolean {
  const s = (u: Vec2, v: Vec2) => (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0])
  const d1 = s(a, b)
  const d2 = s(b, c)
  const d3 = s(c, a)
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}

/** Does a tool of `radius` at `p` cut into a band? Touching (distance = radius) does not. */
export function diskHitsBands(p: Vec2, radius: number, bands: readonly TabBand[]): boolean {
  for (const band of bands)
    for (const tri of band) {
      if (inTriangle(p, tri)) return true
      for (let j = 0; j < 3; j++)
        if (segmentDistance(p, tri[j]!, tri[(j + 1) % 3]!) < radius - 1e-7) return true
    }
  return false
}

/**
 * Lift `pieces` over the tabs: wherever the tool would cut into a band, Z is raised to at least
 * `top`. Boundaries are found by sampling (at most `step` apart) and bisection.
 */
export function liftOverTabs(
  pieces: readonly Seg3[],
  hits: (p: Vec2) => boolean,
  top: number,
  step: number,
): Seg3[] {
  const out: Seg3[] = []
  for (const piece of pieces) {
    if (Math.min(piece.z0, piece.z1) >= top - EPSILON) {
      out.push(piece)
      continue
    }
    const { seg } = piece
    const n = Math.max(2, Math.ceil(segLength(seg) / step))
    const inside = (u: number) => hits(segPoint(seg, u))
    // split points where `inside` changes
    const cuts: number[] = [0]
    let prev = inside(0)
    for (let i = 1; i <= n; i++) {
      const u = i / n
      const now = inside(u)
      if (now !== prev) {
        let [lo, hi] = [(i - 1) / n, u]
        for (let k = 0; k < 40; k++) {
          const mid = (lo + hi) / 2
          if (inside(mid) === prev) lo = mid
          else hi = mid
        }
        // keep the lifted part on the safe side of the boundary
        cuts.push(prev ? hi : lo)
        prev = now
      }
    }
    cuts.push(1)
    const z = (u: number) => piece.z0 + (piece.z1 - piece.z0) * u
    for (let k = 0; k + 1 < cuts.length; k++) {
      const [u0, u1] = [cuts[k]!, cuts[k + 1]!]
      if (u1 - u0 <= 1e-12) continue
      const lifted = inside((u0 + u1) / 2)
      const sub = (a: number, b: number, za: number, zb: number) =>
        out.push({ seg: segSlice(seg, a, b), z0: za, z1: zb })
      if (!lifted) {
        sub(u0, u1, z(u0), z(u1))
        continue
      }
      // inside a tab: max(z, top); split where a ramp crosses the tab top
      const [za, zb] = [z(u0), z(u1)]
      if ((za - top) * (zb - top) < 0) {
        const uc = u0 + ((u1 - u0) * (top - za)) / (zb - za)
        sub(u0, uc, Math.max(za, top), top)
        sub(uc, u1, top, Math.max(zb, top))
      } else sub(u0, u1, Math.max(za, top), Math.max(zb, top))
    }
  }
  return out
}
