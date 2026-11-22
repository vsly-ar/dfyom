// What the design scene draws without the worker, in the operation's face frame: the live outline
// of an operation while its evaluation is pending (ui.md decision 15: "drawn live as an outline
// from the field values, cheap, no worker"), the point of the error marker of a failing
// operation, the face-frame axes of the selected operation's face (task F1) and its anchor point
// (task F2). Pure, from the analytic model (part frame, mm).
// Doc: docs/conventions/ui.md#evaluation-status-pending-outdated-failed,
// #design-and-plan-controls-v02; docs/modes/design-v0.2.md#face-frame
import { shapeCentre } from '../../../../core/design/anchor'
import {
  CENTRE_ANCHOR,
  isGeneralShape,
  type Operation,
  type Shape,
} from '../../../../core/design/operation'
import type { SurfaceTable } from '../../../../core/design/surfaces'
import {
  DIRECTION,
  faceFrame,
  STOCK_FACE,
  toPartFrame,
  type Direction,
  type FaceFrame,
  type StockSize,
} from '../../../../core/geometry/face'
import type { Stock } from '../../../../core/library/stock'
import type { Vec3 } from '../../viewport'

/** Segments per quarter circle (corner arcs) and per full circle. */
const ARC_SEGMENTS = 8
const CIRCLE_SEGMENTS = 48

/**
 * Closed loop of a shape at face-frame height `w` (the last point does not repeat the first), as
 * `[u, v, w]`; in the part frame for the top face.
 */
export function shapeLoop(shape: Shape, w: number): Vec3[] {
  // named and rotated shapes need the 2D layer: no outline yet (K5 draws them)
  if (shape.kind === 'named' || isGeneralShape(shape)) return []
  const [cx, cy] = shapeCentre(shape) // `center` is the anchor point
  if (shape.kind === 'circle') {
    const r = shape.diameter.canonical / 2
    return Array.from({ length: CIRCLE_SEGMENTS }, (_, i): Vec3 => {
      const a = (i / CIRCLE_SEGMENTS) * 2 * Math.PI
      return [cx + r * Math.cos(a), cy + r * Math.sin(a), w]
    })
  }
  const hx = shape.length.canonical / 2
  const hy = shape.width.canonical / 2
  const r = Math.max(0, Math.min(shape.cornerRadius.canonical, hx, hy))
  if (r === 0) return rectangleLoop(cx - hx, cy - hy, cx + hx, cy + hy, w)
  // corners counter-clockwise from the front right, each arc a quarter turn
  const corners: [number, number, number][] = [
    [cx + hx - r, cy - hy + r, -Math.PI / 2],
    [cx + hx - r, cy + hy - r, 0],
    [cx - hx + r, cy + hy - r, Math.PI / 2],
    [cx - hx + r, cy - hy + r, Math.PI],
  ]
  return corners.flatMap(([x, y, start]) =>
    Array.from({ length: ARC_SEGMENTS + 1 }, (_, i): Vec3 => {
      const a = start + (i / ARC_SEGMENTS) * (Math.PI / 2)
      return [x + r * Math.cos(a), y + r * Math.sin(a), w]
    }),
  )
}

function rectangleLoop(x0: number, y0: number, x1: number, y1: number, w: number): Vec3[] {
  return [
    [x0, y0, w],
    [x1, y0, w],
    [x1, y1, w],
    [x0, y1, w],
  ]
}

const stockSize = (stock: Stock): StockSize => ({
  length: stock.length.canonical,
  width: stock.width.canonical,
  thickness: stock.thickness.canonical,
})

/** The face an operation starts from. */
export interface OperationFace {
  readonly direction: Direction
  /** The frame at the stock face of the direction (`w` = 0 there, negative below it). */
  readonly frame: FaceFrame
  /** `w` of the `on` face: 0 on the stock face, −depth on a floor below it. */
  readonly w: number
  /** Stock size seen in the face frame (`length` along `u`, `width` along `v`, `thickness` along `n`). */
  readonly local: StockSize
}

/** The `on` face of an operation; the stock top when the surface is unknown. */
export function operationFace(op: Operation, stock: Stock, table: SurfaceTable): OperationFace {
  const entry = table.get(op.on).or(table.get(STOCK_FACE['+z']))
  const direction = entry.mapOr<Direction>('+z', (e) => e.direction)
  const size = stockSize(stock)
  const d = DIRECTION[direction]
  return {
    direction,
    frame: faceFrame(direction, size),
    w: entry.mapOr(0, (e) => e.faceZ.toNumber()),
    local: { length: size[d.uSize], width: size[d.vSize], thickness: size[d.extent] },
  }
}

const place = (face: OperationFace, loops: Vec3[][]): Vec3[][] =>
  loops.map((l) => l.map((p) => toPartFrame(face.frame, p)))

/**
 * The operation's shape where it starts and where it ends, in the part frame: the top loop at its
 * `on` face and the bottom loop at its floor (facing: the new face; profile: the stock face and
 * the opposite one).
 */
export function operationOutline(op: Operation, stock: Stock, table: SurfaceTable): Vec3[][] {
  const face = operationFace(op, stock, table)
  const through = -face.local.thickness
  switch (op.kind) {
    case 'facing':
      return place(face, [
        rectangleLoop(0, 0, face.local.length, face.local.width, face.w - op.depth.canonical),
      ])
    case 'pocket':
      return place(face, [
        shapeLoop(op.shape, face.w),
        shapeLoop(op.shape, face.w - op.depth.canonical),
      ])
    case 'drilling': {
      const circle: Shape = {
        kind: 'circle',
        center: op.center,
        anchor: CENTRE_ANCHOR,
        diameter: op.diameter,
      }
      const bottom =
        op.bottom === 'through' || op.depth.isNone()
          ? through
          : face.w - op.depth.unwrap().canonical
      return place(face, [shapeLoop(circle, face.w), shapeLoop(circle, bottom)])
    }
    case 'profile':
      return place(face, [shapeLoop(op.shape, face.w), shapeLoop(op.shape, through)])
  }
}

/** Where the error marker of a failing operation points: its shape's centre at its `on` face. */
export function markerPoint(op: Operation, stock: Stock, table: SurfaceTable): Vec3 {
  const face = operationFace(op, stock, table)
  const at = (u: number, v: number, w = face.w) => toPartFrame(face.frame, [u, v, w])
  switch (op.kind) {
    case 'facing':
      return at(face.local.length / 2, face.local.width / 2, face.w - op.depth.canonical)
    case 'pocket':
    case 'profile':
      return at(...shapeCentre(op.shape))
    case 'drilling':
      return at(op.center[0].canonical, op.center[1].canonical)
  }
}

/** Face-frame axes of the selected operation's face: origin, `u` and `v` (unit), the normal. */
export interface FrameAxes {
  readonly origin: Vec3
  readonly u: Vec3
  readonly v: Vec3
  readonly n: Vec3
  /** Length of the drawn axes (mm): 0.6 of the shorter side of the face rectangle. */
  readonly length: number
}

/** The face frame of the operation's `on` face, at that face's level (design-v0.2.md#face-frame). */
export function frameAxes(op: Operation, stock: Stock, table: SurfaceTable): FrameAxes {
  const face = operationFace(op, stock, table)
  const { u, v, n } = face.frame
  return {
    origin: toPartFrame(face.frame, [0, 0, face.w]),
    u,
    v,
    n,
    length: Math.max(1, Math.min(face.local.length, face.local.width) * 0.6),
  }
}

/**
 * The point the position fields give, on the `on` face (task F2): a pocket's or profile's
 * anchor point, a drilling's centre. Facings have none.
 */
export function anchorPoint(
  op: Operation,
  stock: Stock,
  table: SurfaceTable,
): { at: Vec3; u: Vec3; v: Vec3 } | null {
  if (op.kind === 'facing') return null
  const face = operationFace(op, stock, table)
  const c = op.kind === 'drilling' ? op.center : op.shape.center
  return {
    at: toPartFrame(face.frame, [c[0].canonical, c[1].canonical, face.w]),
    u: face.frame.u,
    v: face.frame.v,
  }
}
