/**
 * Setup WCS (v0.2 task C3): generators work top-down in the face frame of the setup's direction
 * (`u` → X, `v` → Y, `n` → Z, Z0 on the up-facing stock face); a setup rotation of 90/180/270°
 * about machine +Z then turns the generated toolpath, and the work zero moves to the lower-left
 * corner of the rotated face. Alignment phase 1 (DF78) then shifts the WCS by the setup's work
 * zero (anywhere in the turned face's frame, negative X/Y valid). `setupFrame` places the WCS in
 * the part frame (preview of a setup).
 * Doc: docs/modes/plan-v0.2.md#toolpaths-per-setup (Implementation (task C3)),
 * docs/modes/alignment.md#setup-work-zero-q61
 *
 * Quarter turns are a swap and a negation plus the face size, so they stay exact up to one
 * float64 subtraction. Headless: plain data only.
 */
import {
  DIRECTION,
  directionOf,
  faceFrame,
  localStock,
  type Direction,
  type StockSize,
} from '../geometry/face'
import { applyPlacement, type Placement, type Vec2, type Vec3 } from '../geometry/model'
import type { AxisRates, Move, Pass, Toolpath } from './model'
import { toolpathStats } from './stats'

/** Quarter turns of a setup about machine +Z (counter-clockwise seen from above); 0 = none. */
export type WcsRotation = 0 | 90 | 180 | 270

/**
 * The turn from the face frame into a rotated setup's WCS: `size` is the stock face rectangle
 * of the direction (`[along u, along v]`) before the turn; `zero` the work zero after the turn
 * (the setup frame, alignment phase 1), absent = its front-left corner. Absent on a request = the
 * face frame is the WCS.
 */
export interface SetupWcs {
  readonly rotation: WcsRotation
  readonly size: Vec2
  readonly zero?: Vec2
}

/** A zero that moves nothing (absent or `[0, 0]`) is left out, so goldens stay byte-identical. */
const movedZero = (zero: Vec2 | undefined): Vec2 | undefined =>
  zero === undefined || (zero[0] === 0 && zero[1] === 0) ? undefined : zero

/**
 * The turn and shift of a setup, or `undefined` when its WCS is the face frame itself (rotation
 * 0, zero at the corner), so such setups (every v0.1 plan) generate exactly as before.
 */
export function setupWcs(
  direction: Direction,
  rotation: WcsRotation,
  stock: StockSize,
  zero?: Vec2,
): SetupWcs | undefined {
  const z = movedZero(zero)
  if (rotation === 0 && z === undefined) return undefined
  const face = localStock(direction, stock)
  return { rotation, size: [face.length, face.width], ...(z === undefined ? {} : { zero: z }) }
}

/** A face-frame point `[u, v]` in the setup frame (turned, not shifted). */
function turn(p: Vec2, wcs: SetupWcs): Vec2 {
  const [L, W] = wcs.size
  switch (wcs.rotation) {
    case 0:
      return p
    case 90:
      return [W - p[1], p[0]]
    case 180:
      return [L - p[0], W - p[1]]
    case 270:
      return [p[1], L - p[0]]
  }
}

/** A face-frame point `[u, v]` in the setup's WCS: turned, then shifted by the zero. */
export function toWcs(p: Vec2, wcs: SetupWcs): Vec2 {
  const t = turn(p, wcs)
  const z = wcs.zero
  return z === undefined ? t : [t[0] - z[0], t[1] - z[1]]
}

/** A WCS point `[X, Y]` back in the face frame (the inverse of `toWcs`). */
export function fromWcs(q: Vec2, wcs: SetupWcs): Vec2 {
  const z = wcs.zero
  const p: Vec2 = z === undefined ? q : [q[0] + z[0], q[1] + z[1]]
  const [L, W] = wcs.size
  switch (wcs.rotation) {
    case 0:
      return p
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
 * A toolpath generated in the face frame, turned and shifted into the setup's WCS; stats are
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
 * direction at its stock face, turned by the rotation about its `n`, its origin moved to the
 * work zero (`zero` in the setup frame; absent = the front-left corner of the up face). For `+z`
 * without rotation and zero it is the identity, as in v0.1 (work zero at x 0, y 0 on the top).
 */
export function setupFrame(
  direction: Direction,
  rotation: WcsRotation,
  stock: StockSize,
  zero?: Vec2,
): Placement {
  const face = faceFrame(direction, stock)
  const wcs = setupWcs(direction, rotation, stock, zero)
  if (wcs === undefined) return face
  const { u, v, n } = DIRECTION[direction]
  const neg = (a: Vec3): Vec3 => [-a[0] || 0, -a[1] || 0, -a[2] || 0]
  // the WCS X and Y axes in the face frame, from `fromWcs`
  const [x, y] =
    wcs.rotation === 0
      ? [u, v]
      : wcs.rotation === 90
        ? [neg(v), u]
        : wcs.rotation === 180
          ? [neg(u), neg(v)]
          : [v, neg(u)]
  const [a, b] = fromWcs([0, 0], wcs)
  return { origin: applyPlacement(face, [a, b, 0]), u: x, v: y, n }
}

/**
 * The part corner a setup's work zero (G54) sits at, named by the part faces that meet there
 * besides the up face: "front left" for an unrotated top setup, "back left" for the bottom. On
 * the machine it is always the front-left corner of the up face (docs/modes/plan-v0.2.md
 * #implementation-task-f6; run-mode setup-change prompt, hardening M7).
 */
export function setupZeroCorner(
  direction: Direction,
  rotation: WcsRotation,
  stock: StockSize,
): string {
  const o = setupFrame(direction, rotation, stock).origin
  const zero = (a: number) => Math.abs(a) < 1e-9
  const axis = direction[1]
  const words: string[] = []
  if (axis !== 'z') words.push(zero(o[2]) ? 'top' : 'bottom')
  if (axis !== 'y') words.push(zero(o[1]) ? 'front' : 'back')
  if (axis !== 'x') words.push(zero(o[0]) ? 'left' : 'right')
  return words.join(' ')
}

/**
 * How the stock sits on the machine for a setup (the run-mode setup-change prompt, task E2): its
 * extents along machine X, Y, Z (`u`/`v` swapped by a 90°/270° turn) and the part faces the
 * operator sees on top (machine +Z), in front (machine −Y) and on the right (machine +X). The
 * corner it names is the front-left corner of the top; the work zero is there unless the setup
 * moves it (alignment phase 1, `SetupDTO.zero`), Z0 on the top.
 */
export interface SetupOrientation {
  readonly size: Vec3
  readonly up: Direction
  readonly front: Direction
  readonly right: Direction
}

export function setupOrientation(
  direction: Direction,
  rotation: WcsRotation,
  stock: StockSize,
): SetupOrientation {
  const f = setupFrame(direction, rotation, stock)
  const face = localStock(direction, stock)
  const turned = rotation % 180 !== 0
  const neg = (a: Vec3): Vec3 => [-a[0] || 0, -a[1] || 0, -a[2] || 0]
  return {
    size: [turned ? face.width : face.length, turned ? face.length : face.width, face.thickness],
    up: directionOf(f.n),
    front: directionOf(neg(f.v)),
    right: directionOf(f.u),
  }
}
