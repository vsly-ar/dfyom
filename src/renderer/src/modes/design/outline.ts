// What the design scene draws without the worker: the live outline of an operation while its
// evaluation is pending (ui.md decision 15: "drawn live as an outline from the field values,
// cheap, no worker") and the anchor of the error marker of a failing operation. Pure, from the
// analytic model (part frame, mm). Doc: docs/conventions/ui.md#evaluation-status-pending-outdated-failed
import type { Operation, Shape } from '../../../../core/design/operation'
import type { SurfaceTable } from '../../../../core/design/surfaces'
import type { Stock } from '../../../../core/library/stock'
import type { Vec3 } from '../../viewport'

/** Segments per quarter circle (corner arcs) and per full circle. */
const ARC_SEGMENTS = 8
const CIRCLE_SEGMENTS = 48

/** Closed loop of a shape at height `z` (the last point does not repeat the first). */
export function shapeLoop(shape: Shape, z: number): Vec3[] {
  const [cx, cy] = [shape.center[0].canonical, shape.center[1].canonical]
  if (shape.kind === 'circle') {
    const r = shape.diameter.canonical / 2
    return Array.from({ length: CIRCLE_SEGMENTS }, (_, i): Vec3 => {
      const a = (i / CIRCLE_SEGMENTS) * 2 * Math.PI
      return [cx + r * Math.cos(a), cy + r * Math.sin(a), z]
    })
  }
  const hx = shape.length.canonical / 2
  const hy = shape.width.canonical / 2
  const r = Math.max(0, Math.min(shape.cornerRadius.canonical, hx, hy))
  if (r === 0)
    return [
      [cx - hx, cy - hy, z],
      [cx + hx, cy - hy, z],
      [cx + hx, cy + hy, z],
      [cx - hx, cy + hy, z],
    ]
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
      return [x + r * Math.cos(a), y + r * Math.sin(a), z]
    }),
  )
}

/** z (mm) of a surface the operation starts from; the stock top (0) when unknown. */
function surfaceZ(table: SurfaceTable, id: string): number {
  // the face frame's z; non-top faces are drawn in their frame with task F1
  return table.get(id).mapOr(0, (e) => e.faceZ.toNumber())
}

function rectangleLoop(x0: number, y0: number, x1: number, y1: number, z: number): Vec3[] {
  return [
    [x0, y0, z],
    [x1, y0, z],
    [x1, y1, z],
    [x0, y1, z],
  ]
}

/**
 * The operation's shape where it starts and where it ends: the top loop at its `on` surface and
 * the bottom loop at its floor (facing: the new top face; profile: top and bottom of the stock).
 */
export function operationOutline(op: Operation, stock: Stock, table: SurfaceTable): Vec3[][] {
  const thickness = stock.thickness.canonical
  switch (op.kind) {
    case 'facing':
      return [
        rectangleLoop(0, 0, stock.length.canonical, stock.width.canonical, -op.depth.canonical),
      ]
    case 'pocket': {
      const top = surfaceZ(table, op.on)
      return [shapeLoop(op.shape, top), shapeLoop(op.shape, top - op.depth.canonical)]
    }
    case 'drilling': {
      const top = surfaceZ(table, op.on)
      const circle: Shape = { kind: 'circle', center: op.center, diameter: op.diameter }
      const bottom = op.depth.isSome() ? top - op.depth.unwrap().canonical : -thickness
      return [
        shapeLoop(circle, top),
        shapeLoop(circle, op.bottom === 'through' ? -thickness : bottom),
      ]
    }
    case 'profile':
      return [shapeLoop(op.shape, 0), shapeLoop(op.shape, -thickness)]
  }
}

/** Where the error marker of a failing operation points: its shape's center at its top. */
export function operationAnchor(op: Operation, stock: Stock, table: SurfaceTable): Vec3 {
  switch (op.kind) {
    case 'facing':
      return [stock.length.canonical / 2, stock.width.canonical / 2, -op.depth.canonical]
    case 'pocket':
      return [op.shape.center[0].canonical, op.shape.center[1].canonical, surfaceZ(table, op.on)]
    case 'drilling':
      return [op.center[0].canonical, op.center[1].canonical, surfaceZ(table, op.on)]
    case 'profile':
      return [op.shape.center[0].canonical, op.shape.center[1].canonical, 0]
  }
}
