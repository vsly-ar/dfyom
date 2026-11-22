/**
 * Face directions and face frames (v0.2): every operation targets a planar face whose outward
 * normal is ±X, ±Y or ±Z; the face gives it a local 2D frame `{ origin, u, v, n }`.
 * Doc: docs/modes/design-v0.2.md#face-frame, docs/architecture/geometry.md#non-top-faces-v02
 *
 * Pure data and float64 helpers, shared by the design model (surface table, checks) and
 * geometry (parameter checks; building in the face frame is task A1b).
 */
import type { Vec3 } from './model'

/** The six approach directions (outward normal of the face), in the order of the face table. */
export const DIRECTIONS = ['+z', '-z', '-y', '+x', '+y', '-x'] as const
export type Direction = (typeof DIRECTIONS)[number]
export type Axis = 'x' | 'y' | 'z'
export type StockDimension = 'length' | 'width' | 'thickness'

/** Surface id of the stock face of each direction (ids unchanged from v0.1). */
export const STOCK_FACE: Readonly<Record<Direction, string>> = {
  '+z': 'stock.top',
  '-z': 'stock.bottom',
  '-y': 'stock.side[0]',
  '+x': 'stock.side[1]',
  '+y': 'stock.side[2]',
  '-x': 'stock.side[3]',
}

/** Display name of a direction ("needs 3 setups (top, right, bottom)"). */
export const DIRECTION_LABEL: Readonly<Record<Direction, string>> = {
  '+z': 'top',
  '-z': 'bottom',
  '-y': 'front',
  '+x': 'right',
  '+y': 'back',
  '-x': 'left',
}

export interface DirectionInfo {
  /** Part-frame axis of the normal. */
  readonly axis: Axis
  /** Sign of the normal along its axis. */
  readonly sign: 1 | -1
  readonly n: Vec3
  readonly u: Vec3
  readonly v: Vec3
  /** Stock size along `u` / `v`: the stock face rectangle of this direction. */
  readonly uSize: StockDimension
  readonly vSize: StockDimension
  /** Stock size along `n` (T for ±z, L for ±x, W for ±y). */
  readonly extent: StockDimension
  /**
   * Level (`n · p`) of the stock face of this direction: the named stock size, or 0 (`undefined`).
   * The part frame's stock spans x ∈ [0, L], y ∈ [0, W], z ∈ [−T, 0].
   */
  readonly faceLevel: StockDimension | undefined
}

/** The face table of design-v0.2.md: seen from outside, `u` right, `v` up, `u × v = n`. */
export const DIRECTION: Readonly<Record<Direction, DirectionInfo>> = {
  '+z': {
    axis: 'z',
    sign: 1,
    n: [0, 0, 1],
    u: [1, 0, 0],
    v: [0, 1, 0],
    uSize: 'length',
    vSize: 'width',
    extent: 'thickness',
    faceLevel: undefined,
  },
  '-z': {
    axis: 'z',
    sign: -1,
    n: [0, 0, -1],
    u: [1, 0, 0],
    v: [0, -1, 0],
    uSize: 'length',
    vSize: 'width',
    extent: 'thickness',
    faceLevel: 'thickness',
  },
  '-y': {
    axis: 'y',
    sign: -1,
    n: [0, -1, 0],
    u: [1, 0, 0],
    v: [0, 0, 1],
    uSize: 'length',
    vSize: 'thickness',
    extent: 'width',
    faceLevel: undefined,
  },
  '+x': {
    axis: 'x',
    sign: 1,
    n: [1, 0, 0],
    u: [0, 1, 0],
    v: [0, 0, 1],
    uSize: 'width',
    vSize: 'thickness',
    extent: 'length',
    faceLevel: 'length',
  },
  '+y': {
    axis: 'y',
    sign: 1,
    n: [0, 1, 0],
    u: [-1, 0, 0],
    v: [0, 0, 1],
    uSize: 'length',
    vSize: 'thickness',
    extent: 'width',
    faceLevel: 'width',
  },
  '-x': {
    axis: 'x',
    sign: -1,
    n: [-1, 0, 0],
    u: [0, -1, 0],
    v: [0, 0, 1],
    uSize: 'width',
    vSize: 'thickness',
    extent: 'length',
    faceLevel: undefined,
  },
}

/** Stock sizes in float64 mm (the shape of `StockGeometry`). */
export interface StockSize {
  readonly length: number
  readonly width: number
  readonly thickness: number
}

/** The direction whose normal is `vec` (an axis unit vector). */
export function directionOf(vec: Vec3): Direction {
  return DIRECTIONS.find((d) => DIRECTION[d].n.every((c, i) => c === vec[i]))!
}

/** Level (`n · p`) of the stock face of `direction`. */
export function stockFaceLevel(direction: Direction, stock: StockSize): number {
  const f = DIRECTION[direction].faceLevel
  return f === undefined ? 0 : stock[f]
}

/**
 * The stock as seen in the face frame of `direction`: the face rectangle (`length` along `u`,
 * `width` along `v`) and the extent along `n` (`thickness`). For `+z` it is the stock itself.
 */
export function localStock(direction: Direction, stock: StockSize): StockSize {
  const d = DIRECTION[direction]
  return { length: stock[d.uSize], width: stock[d.vSize], thickness: stock[d.extent] }
}

/**
 * Stock faces around the face rectangle of `direction`, by edge of the rectangle in the face
 * frame: lowest `v`, highest `u`, highest `v`, lowest `u` (the wall order of design-v0.2.md).
 */
export function adjacentStockFaces(
  direction: Direction,
): readonly [vMin: string, uMax: string, vMax: string, uMin: string] {
  const { u, v } = DIRECTION[direction]
  const neg = (a: Vec3): Vec3 => [-a[0] || 0, -a[1] || 0, -a[2] || 0]
  const face = (vec: Vec3) => STOCK_FACE[directionOf(vec)]
  return [face(neg(v)), face(u), face(v), face(neg(u))]
}

export interface FaceFrame {
  readonly origin: Vec3
  readonly u: Vec3
  readonly v: Vec3
  readonly n: Vec3
}

/**
 * Face frame of a face of `direction` at `level` (`n · p`; default: the stock face): the origin
 * is the lower-left corner of the stock face seen from outside, moved along `n` to the level.
 */
export function faceFrame(
  direction: Direction,
  stock: StockSize,
  level = stockFaceLevel(direction, stock),
): FaceFrame {
  const { u, v, n } = DIRECTION[direction]
  const min: Vec3 = [0, 0, -stock.thickness]
  const max: Vec3 = [stock.length, stock.width, 0]
  const origin = [0, 1, 2].map((i) => {
    if (n[i] !== 0) return n[i]! * level
    const a = u[i] !== 0 ? u[i]! : v[i]!
    return a > 0 ? min[i]! : max[i]!
  })
  return { origin: [origin[0]!, origin[1]!, origin[2]!], u, v, n }
}

/** A point `[u, v, w]` of the face frame (w along `n`) in the part frame. */
export function toPartFrame(frame: FaceFrame, p: Vec3): Vec3 {
  const at = (i: number) =>
    frame.origin[i]! + frame.u[i]! * p[0] + frame.v[i]! * p[1] + frame.n[i]! * p[2]
  return [at(0), at(1), at(2)]
}
