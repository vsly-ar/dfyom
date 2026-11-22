// The operation inspector's view of a pocket's or profile's shape (task U2), pure: the shape
// picker's value and the `shape` args of a choice (inline rectangle or circle, or a named shape),
// whether a named shape is an open path, where a shape sits on its face (the placement map from
// the shape frame to the face frame, for the Shape Editor's face-on view) and the "Round corners
// to ≥ r" fix of a corner warning on a general shape. Commands do the checking.
// Doc: docs/conventions/ui.md#shape-in-the-operation-inspector, #shape-editor;
// docs/modes/design-v0.3.md#placing-a-shape-on-a-face, #dfm-checks-for-shapes
import type { Operation, Part } from '../../../../core/design/operation'
import type { OperationShapeDTO } from '../../../../core/design/part.dto'
import {
  orientedShape,
  placeShape,
  shapeDefinition,
  shapeOrientation,
} from '../../../../core/design/placement'
import { itemChain } from '../../../../core/design/shape-items'
import type { ShapeDTO, ShapeItemDTO } from '../../../../core/design/shape.dto'
import { closestOnChains } from '../../../../core/geometry/2d/measure'
import type { Region2dPort } from '../../../../core/geometry/2d/port'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { Vec2 } from '../../../../core/geometry/model'
import type { UnitSystem } from '../../../../core/project/document'
import { lengthSource } from '../../messages/dfm'
import type { ShapePlacement } from '../../viewport/flat-view'
import { roundLength } from './model'
import { itemNumbers, itemSources } from './shape-model'

/** The picker's value of an inline kind or a named shape. */
export type PickerValue = 'rectangle' | 'circle' | `named:${string}`

export const NEW_SHAPE = 'new' as const

export const pickerValue = (s: OperationShapeDTO): PickerValue =>
  s.kind === 'named' ? `named:${s.shapeId}` : s.kind

const src = (q: { source: string }): string => q.source

/** A named shape that is one open path (only `side: 'on'` can cut it, rule `openNeedsOn`). */
export function isOpenNamed(shape: ShapeDTO | undefined): boolean {
  const only = shape?.items.length === 1 ? shape.items[0] : undefined
  return only?.kind === 'path' && only.closed === false
}

/**
 * The `shape` args of a picker choice, keeping the anchor point (`center`), and a rectangle's or
 * named shape's rotation where the new kind has one. A named shape becoming inline takes the
 * size of its bounding box (`bounds`, mm, rounded to the unit system); inline → inline as v0.2.
 */
export function shapeChoiceArgs(
  current: OperationShapeDTO,
  choice: PickerValue,
  bounds: { min: readonly [number, number]; max: readonly [number, number] } | undefined,
  units: UnitSystem,
): Record<string, unknown> {
  const center = [src(current.center[0]), src(current.center[1])]
  const rotation =
    current.kind !== 'circle' && current.rotation !== undefined
      ? { rotation: src(current.rotation) }
      : {}
  if (choice.startsWith('named:'))
    return {
      kind: 'named',
      shapeId: choice.slice('named:'.length),
      center,
      ...rotation,
      ...(current.kind === 'named' && current.mirror === true ? { mirror: true } : {}),
    }
  const kind = choice as 'rectangle' | 'circle'
  if (current.kind !== 'named') {
    if (kind === 'circle')
      return {
        kind,
        center,
        diameter: current.kind === 'circle' ? src(current.diameter) : src(current.width),
      }
    const size = current.kind === 'circle' ? src(current.diameter) : src(current.length)
    return { kind, center, length: size, width: size, ...rotation }
  }
  const w = bounds ? bounds.max[0] - bounds.min[0] : 20
  const h = bounds ? bounds.max[1] - bounds.min[1] : 20
  if (kind === 'circle') return { kind, center, diameter: roundLength(Math.max(w, h), units) }
  return {
    kind,
    center,
    length: roundLength(w, units),
    width: roundLength(h, units),
    ...rotation,
  }
}

// ── placement ─────────────────────────────────────────────────────────────────────────────

/** The placement of an operation's shape on its face; undefined when it does not resolve. */
export function shapePlacement(
  port: Region2dPort,
  shape: Extract<Operation, { kind: 'pocket' | 'profile' }>['shape'],
  shapes: Part['shapes'],
): ShapePlacement | undefined {
  const placed = placeShape(port, shape, shapes)
  const def = shapeDefinition(shape, shapes)
  if (placed.isErr() || def.isErr()) return undefined
  const o = shapeOrientation(shape)
  const oriented = orientedShape(port, def.unwrap(), o)
  if (oriented.isErr()) return undefined
  const b = oriented.unwrap().bounds
  const mid: Vec2 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]
  const { centre } = placed.unwrap()
  const r = (o.rotation * Math.PI) / 180
  return {
    cos: Math.cos(r),
    sin: Math.sin(r),
    mirror: o.mirror,
    offset: [centre[0] - mid[0], centre[1] - mid[1]],
  }
}

// ── "Round corners to ≥ r" ────────────────────────────────────────────────────────────────

/** A corner closer than this to an item's vertex or edge belongs to that item (mm). */
const CORNER_MATCH_MM = 0.05

/** The corner codes whose fix rounds the shape (design-v0.3.md § DFM: `suggestion: atLeast(r)`). */
export const isCornerWarning = (w: DfmWarning): boolean =>
  (w.code === 'dfm.cornerSharp' || w.code === 'dfm.cornerTooSmall') &&
  w.parameter === 'shape' &&
  w.suggestion?.relation === 'atLeast'

/** The corner markers of a warning, `[u, v]` in the face frame (`at`, then `points`). */
export function cornerPoints(w: DfmWarning): Vec2[] {
  const out: Vec2[] = []
  const at = w.params['at']
  const points = w.params['points']
  if (Array.isArray(points) && points.length >= 2) {
    const flat = points as readonly number[]
    for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!])
    return out
  }
  if (Array.isArray(at) && at.length === 2) out.push([Number(at[0]), Number(at[1])])
  return out
}

/** One `design.shape.item.update` of the fix. */
export interface ItemFix {
  readonly index: number
  readonly fields: Record<string, unknown>
}

const dist = (a: readonly [number, number], b: readonly [number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1])

/** Path vertices in the shape frame: 0 = start, i = end of segment i − 1. */
function pathVertices(item: Extract<ShapeItemDTO, { kind: 'path' }>): Vec2[] | undefined {
  const n = itemNumbers(item)
  if (n === undefined || n.kind !== 'path') return undefined
  return [[n.start[0], n.start[1]], ...n.segments.map((s): Vec2 => [s.to[0], s.to[1]])]
}

/**
 * The item updates that round the named shape's corners at `points` (shape frame, mm) to at least
 * `radius`: a path's fillet at the matching vertex, a rectangle's or polygon's corner radius when
 * the corner lies on its outline. Corners made by combining items (no vertex of their own) have
 * no fix. `source` writes the radius in the project units, rounded up.
 */
export function roundCornerFixes(
  shape: ShapeDTO,
  points: readonly Vec2[],
  radius: number,
  units: UnitSystem,
): ItemFix[] {
  const r = lengthSource(radius, units, 'up')
  const byItem = new Map<number, Record<string, unknown>>()
  for (const p of points) {
    for (const [index, item] of shape.items.entries()) {
      if (item.kind === 'path') {
        const vs = pathVertices(item)
        if (vs === undefined) continue
        const closed = item.closed
        const last = item.segments.length
        let vertex = vs.findIndex((v) => dist(v, p) <= CORNER_MATCH_MM)
        // a closed path's last vertex is its start (vertex 0)
        if (vertex === last && closed) vertex = 0
        if (vertex < 0) continue
        if (!closed && (vertex === 0 || vertex === last)) continue
        const prev =
          (byItem.get(index)?.['fillets'] as { vertex: number; radius: string }[]) ??
          (itemSources(item) as { fillets?: { vertex: number; radius: string }[] }).fillets ??
          []
        const fillets = [...prev.filter((f) => f.vertex !== vertex), { vertex, radius: r }]
        fillets.sort((a, b) => a.vertex - b.vertex)
        byItem.set(index, { fillets })
        break
      }
      if (item.kind !== 'rectangle' && item.kind !== 'polygon') continue
      const n = itemNumbers(item)
      if (n === undefined) continue
      const chain = itemChain(n, index, [])
      if (chain === undefined) continue
      const near = closestOnChains([chain.loop], p)
      if (near === undefined || near.distance > CORNER_MATCH_MM) continue
      byItem.set(index, { cornerRadius: r })
      break
    }
  }
  return [...byItem.entries()].map(([index, fields]) => ({ index, fields }))
}
