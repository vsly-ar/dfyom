/**
 * The geometry input mapping of shape operations (v0.3 K3): a pocket's or profile's `Shape` (any
 * contour kind) as exact 2D loops in its face frame, in surface-numbering order, plus the nominal
 * tab centres along a profile's loop (resolved against the stock in `tab-hold.ts`). What G1
 * (prisms), T1 (`generateRegionPocket`) and T2 (profiles on general loops) consume. Pure; no port
 * call.
 * Doc: docs/architecture/shapes.md#implementation-k3, docs/modes/design-v0.3.md#surfaces,
 * docs/modes/design-v0.3.md#tabs-on-shapes
 */
import { contourElements } from './contour'
import {
  arc,
  elementLength,
  line,
  type Element,
  type Loop,
  type Path,
  type Region,
} from './2d/model'
import { translatePath, translateRegion } from './2d/place'
import type { LoopChamferGeometry, OperationGeometry, Shape } from './model'

/** A shape placed in its face frame: a region (closed) or one open path, in mm. */
export type Outline =
  | { readonly kind: 'region'; readonly region: Region }
  | { readonly kind: 'path'; readonly path: Path }

/**
 * A v0.1 contour (rectangle, circle) as one counter-clockwise loop of exact elements from its
 * start point (the front-left end of the front wall; a circle's front point): the order of
 * `contourElements`, without zero-size elements (sharp corners, a full-round end's walls).
 */
function analyticLoop(c: Extract<Shape['contour'], { kind: 'rectangle' | 'circle' }>): Loop {
  const out: Element[] = []
  for (const e of contourElements(c)) {
    if (e.kind === 'line') {
      out.push(line(e.from, e.to))
      continue
    }
    const at = (t: number): readonly [number, number] => [
      e.center[0] + e.radius * Math.cos(t),
      e.center[1] + e.radius * Math.sin(t),
    ]
    const a = at(e.start)
    // a whole circle ends exactly where it starts
    const b = e.sweep >= 2 * Math.PI ? a : at(e.start + e.sweep)
    out.push(arc(a, b, e.center, true))
  }
  return { elements: out.filter((e) => elementLength(e) > 0) }
}

/** The shape in its face frame (absolute `[u, v]`), for every contour kind. */
export function shapeOutline(shape: Shape): Outline {
  const c = shape.contour
  switch (c.kind) {
    case 'region':
      return { kind: 'region', region: translateRegion(c.region, shape.center) }
    case 'path':
      return { kind: 'path', path: translatePath(c.path, shape.center) }
    default: {
      const loop = translatePath(analyticLoop(c), shape.center)
      return { kind: 'region', region: { pieces: [{ outer: loop, holes: [] }] } }
    }
  }
}

/** True for the v0.3 contours (named or rotated shapes) that only general builders take. */
export const isGeneralContour = (shape: Shape): boolean =>
  shape.contour.kind === 'region' || shape.contour.kind === 'path'

/**
 * The region of a pocket in its face frame (holes = islands), with `onZ` and `depth`: the
 * `operation` of `generateRegionPocket` (T1) before the setup's WCS turn, and G1's prism input.
 */
export function pocketRegion(op: Extract<OperationGeometry, { kind: 'pocket' }>): {
  readonly region: Region
  readonly onZ: number
  readonly depth: number
} {
  const o = shapeOutline(op.shape)
  // a pocket's shape always resolves to a region (design refuses open paths: `openNeedsOn`)
  const region = o.kind === 'region' ? o.region : { pieces: [] }
  return { region, onZ: op.onZ, depth: op.depth }
}

/** The loop or path a profile cuts along (a profile takes one loop, `profileOneLoop`). */
export function profileChain(op: Extract<OperationGeometry, { kind: 'profile' }>): {
  readonly chain: Loop
  readonly closed: boolean
} {
  const o = shapeOutline(op.shape)
  if (o.kind === 'path') return { chain: o.path, closed: false }
  return { chain: o.region.pieces[0]?.outer ?? { elements: [] }, closed: true }
}

/**
 * Tab centres as distances along a closed loop of length `length` from its start point
 * (design-v0.3.md#tabs-on-shapes): the given `positions`, else `count` evenly spaced with the
 * first half a spacing after the start point (so tabs never straddle the start point).
 */
export function tabCentres(
  length: number,
  tabs: { readonly count: number; readonly positions?: readonly number[] },
): number[] {
  if (tabs.positions !== undefined) return [...tabs.positions]
  const n = Number.isInteger(tabs.count) && tabs.count > 0 ? tabs.count : 0
  return Array.from({ length: n }, (_, i) => ((i + 0.5) * length) / n)
}

/**
 * The air side of a loop chamfer's edge (edge-chamfers.md E1): its edge operation's shape region
 * (a pocket's region with its islands as holes, an inside profile's opening), in the face frame,
 * or about the shape's centre with `local`. The toolpath (`generateEdgeChamfer`) and the removal
 * solid (`chamfer-solids.ts`) both offset this region.
 */
export function loopChamferAir(op: Pick<LoopChamferGeometry, 'edge'>, local = false): Region {
  const shape = local ? { center: [0, 0] as const, contour: op.edge.shape.contour } : op.edge.shape
  const o = shapeOutline(shape)
  return o.kind === 'region' ? o.region : { pieces: [] }
}
