/**
 * Setup WCS (v0.2 task C3): generators work top-down in the face frame of the setup's direction
 * (`u` → X, `v` → Y, `n` → Z, Z0 on the up-facing stock face); a setup rotation of 90/180/270°
 * about machine +Z then turns the generated toolpath, and the work zero moves to the lower-left
 * corner of the rotated face. `setupFrame` places the WCS in the part frame (preview of a setup).
 * Doc: docs/modes/plan-v0.2.md#toolpaths-per-setup (Implementation (task C3))
 *
 * Quarter turns are a swap and a negation plus the face size, so they stay exact up to one
 * float64 subtraction. Headless: plain data only.
 */
import { DIRECTION, faceFrame, localStock, type Direction, type StockSize } from '../geometry/face'
import { applyPlacement, type Placement, type Vec2, type Vec3 } from '../geometry/model'
import type { AxisRates, Move, Pass, Toolpath } from './model'
import { toolpathStats } from './stats'

/** Quarter turns of a setup about machine +Z (counter-clockwise seen from above); 0 = none. */
export type WcsRotation = 0 | 90 | 180 | 270

/**
 * The turn from the face frame into a rotated setup's WCS: `size` is the stock face rectangle
 * of the direction (`[along u, along v]`) before the turn. Absent on a request = no turn.
 */
export interface SetupWcs {
  readonly rotation: 90 | 180 | 270
  readonly size: Vec2
}

/**
 * The turn of a setup, or `undefined` when its WCS is the face frame itself (rotation 0), so
 * unrotated setups (every v0.1 plan) generate exactly as before.
 */
export function setupWcs(
  direction: Direction,
  rotation: WcsRotation,
  stock: StockSize,
): SetupWcs | undefined {
  if (rotation === 0) return undefined
  const face = localStock(direction, stock)
  return { rotation, size: [face.length, face.width] }
}

/** A face-frame point `[u, v]` in the rotated setup's WCS. */
export function toWcs(p: Vec2, wcs: SetupWcs): Vec2 {
  const [L, W] = wcs.size
  switch (wcs.rotation) {
    case 90:
      return [W - p[1], p[0]]
    case 180:
      return [L - p[0], W - p[1]]
    case 270:
      return [p[1], L - p[0]]
  }
}

/** A WCS point `[X, Y]` back in the face frame (the inverse of `toWcs`). */
export function fromWcs(p: Vec2, wcs: SetupWcs): Vec2 {
  const [L, W] = wcs.size
  switch (wcs.rotation) {
    case 90:
      return [p[1], W - p[0]]
    case 180:
      return [L - p[0], W - p[1]]
    case 270:
      return [L - p[1], p[0]]
  }
}

const xyz = (p: Vec3, wcs: SetupWcs): Vec3 => {
  const [x, y] = toWcs([p[0], p[1]], wcs)
  return [x, y, p[2]]
}

/** A move in the WCS: positions and arc centers turn; Z, feeds and arc sense (a rotation) stay. */
function turnMove(m: Move, wcs: SetupWcs): Move {
  switch (m.kind) {
    case 'rapid':
      return { ...m, to: xyz(m.to, wcs) }
    case 'line':
      return { ...m, to: xyz(m.to, wcs) }
    case 'arc':
      return { ...m, to: xyz(m.to, wcs), center: toWcs(m.center, wcs) }
    case 'drill':
      return { ...m, at: toWcs(m.at, wcs) }
  }
}

/**
 * A toolpath generated in the face frame, turned into the rotated setup's WCS; stats are
 * recomputed, since rapids are timed per axis and a quarter turn swaps X and Y.
 */
export function turnToolpath(tp: Toolpath, wcs: SetupWcs, maxFeedRate?: AxisRates): Toolpath {
  const passes: Pass[] = tp.passes.map((p) => ({
    ...p,
    moves: p.moves.map((m) => turnMove(m, wcs)),
  }))
  return { ...tp, passes, stats: toolpathStats(passes, maxFeedRate) }
}

/**
 * The setup's WCS in the part frame (`[X, Y, Z]` of the WCS → part point): the face frame of the
 * direction at its stock face, turned by the rotation about its `n`. For `+z` without rotation it
 * is the identity, as in v0.1 (work zero at x 0, y 0 on the stock top).
 */
export function setupFrame(
  direction: Direction,
  rotation: WcsRotation,
  stock: StockSize,
): Placement {
  const face = faceFrame(direction, stock)
  const wcs = setupWcs(direction, rotation, stock)
  if (wcs === undefined) return face
  const { u, v, n } = DIRECTION[direction]
  const neg = (a: Vec3): Vec3 => [-a[0] || 0, -a[1] || 0, -a[2] || 0]
  // the WCS X and Y axes in the face frame, from `fromWcs`
  const [x, y] =
    wcs.rotation === 90 ? [neg(v), u] : wcs.rotation === 180 ? [neg(u), neg(v)] : [v, neg(u)]
  const [a, b] = fromWcs([0, 0], wcs)
  return { origin: applyPlacement(face, [a, b, 0]), u: x, v: y, n }
}
