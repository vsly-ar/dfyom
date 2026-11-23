/**
 * `placed` in operation add/update results (hardening A3, finding F9): where an operation landed,
 * as its outline's bounding box in the face frame of its `on` face and the box of the material
 * it removes in the part frame. Pure, from the operation's geometry input.
 * Doc: docs/architecture/llm-api.md#a3-frames-in-the-primer-placed-bounds
 */
import { z } from 'zod'
import type { Region2dPort } from '../geometry/2d/port'
import { chainBounds, type Bounds2 } from '../geometry/2d/model'
import { faceFrame, localStock, toPartFrame } from '../geometry/face'
import {
  chamferDepth,
  type OperationGeometry,
  type StockGeometry,
  type Vec2,
  type Vec3,
} from '../geometry/model'
import { toGeometryInput } from './geometry-input'
import type { Operation, Part } from './operation'
import type { Stock } from '../library/stock'

export interface Placed {
  /** The `on` surface. */
  readonly face: string
  /** The placed outline's bounding box in that face frame (`[u, v]`, mm). */
  readonly min: Vec2
  readonly max: Vec2
  /** The box of the removed material in the part frame (`[x, y, z]`, mm). */
  readonly box: { readonly min: Vec3; readonly max: Vec3 }
}

const Vec2Out = z.tuple([z.number(), z.number()])
const Vec3Out = z.tuple([z.number(), z.number(), z.number()])

export const PlacedSchema = z
  .object({
    face: z.string(),
    min: Vec2Out,
    max: Vec2Out,
    box: z.object({ min: Vec3Out, max: Vec3Out }).describe('Removed material, part frame'),
  })
  .describe('Outline bounds [u, v] in the face frame of face, mm')

const r3 = (v: number): number => Math.round(v * 1000) / 1000 + 0

/** The outline's bounds relative to nothing (face frame), before any slot. */
function outline(g: OperationGeometry, stock: StockGeometry): Bounds2 {
  const disc = (c: Vec2, d: number): Bounds2 => ({
    min: [c[0] - d / 2, c[1] - d / 2],
    max: [c[0] + d / 2, c[1] + d / 2],
  })
  switch (g.kind) {
    case 'facing': {
      const s = localStock(g.direction ?? '+z', stock)
      return { min: [0, 0], max: [s.length, s.width] }
    }
    case 'drilling':
      return disc(g.center, g.diameter)
    case 'chamfer':
      return disc(g.center, g.diameter)
    case 'pocket':
    case 'profile': {
      const { center, contour } = g.shape
      let b: Bounds2 | undefined
      if (contour.kind === 'circle') return disc(center, contour.radius * 2)
      if (contour.kind === 'rectangle')
        b = {
          min: [-contour.length / 2, -contour.width / 2],
          max: [contour.length / 2, contour.width / 2],
        }
      else if (contour.kind === 'path') b = chainBounds(contour.path.elements)
      else
        for (const piece of contour.region.pieces) {
          const p = chainBounds(piece.outer.elements)
          if (p === undefined) continue
          b =
            b === undefined
              ? p
              : {
                  min: [Math.min(b.min[0], p.min[0]), Math.min(b.min[1], p.min[1])],
                  max: [Math.max(b.max[0], p.max[0]), Math.max(b.max[1], p.max[1])],
                }
        }
      b ??= { min: [0, 0], max: [0, 0] }
      return {
        min: [center[0] + b.min[0], center[1] + b.min[1]],
        max: [center[0] + b.max[0], center[1] + b.max[1]],
      }
    }
  }
}

/** The face-frame depth range `[bottom, top]` (w, ≤ 0) the cut removes. */
function depthRange(g: OperationGeometry, stock: StockGeometry): readonly [number, number] {
  const through = -localStock(g.direction ?? '+z', stock).thickness
  switch (g.kind) {
    case 'facing':
      return [-g.depth, 0]
    case 'pocket':
      return [g.onZ - g.depth, g.onZ]
    case 'drilling':
      return [g.bottom.kind === 'through' ? through : g.onZ - g.bottom.depth, g.onZ]
    case 'profile':
      return [g.depth === undefined ? through : -g.depth, 0]
    case 'chamfer':
      return [g.onZ - chamferDepth(g), g.onZ]
  }
}

/** Where an operation is placed (llm-api.md § A3). */
export function placedOf(g: OperationGeometry, stock: StockGeometry, face: string): Placed {
  const b = outline(g, stock)
  const grow =
    g.kind === 'profile'
      ? g.side === 'outside'
        ? g.slotWidth
        : g.side === 'on'
          ? g.slotWidth / 2
          : 0
      : 0
  const [w0, w1] = depthRange(g, stock)
  const frame = faceFrame(g.direction ?? '+z', stock)
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const u of [b.min[0] - grow, b.max[0] + grow])
    for (const v of [b.min[1] - grow, b.max[1] + grow])
      for (const w of [w0, w1]) {
        const p = toPartFrame(frame, [u, v, w])
        for (let i = 0; i < 3; i++) {
          lo[i] = Math.min(lo[i]!, p[i]!)
          hi[i] = Math.max(hi[i]!, p[i]!)
        }
      }
  const v3 = (p: number[]): Vec3 => [r3(p[0]!), r3(p[1]!), r3(p[2]!)]
  return {
    face,
    min: [r3(b.min[0]), r3(b.min[1])],
    max: [r3(b.max[0]), r3(b.max[1])],
    box: { min: v3(lo), max: v3(hi) },
  }
}

/**
 * `placed` of operation `id` of a part after an edit (its operations and loaded shapes); undefined
 * when its geometry input cannot be built (the result then has no `placed`; the edit's own checks
 * already passed, so this does not happen in practice).
 */
export function placedOperation(
  part: Part,
  stock: Stock,
  id: string,
  port?: Region2dPort,
): Placed | undefined {
  const input = toGeometryInput(part, stock, port)
  if (input.isErr()) return undefined
  const g = input.unwrap().operations.find((o) => o.id === id)
  const op = part.operations.find((o: Operation) => o.id === id)
  if (g === undefined || op === undefined) return undefined
  return placedOf(g, input.unwrap().stock, op.on)
}
