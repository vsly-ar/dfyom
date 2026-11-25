/**
 * The geometry input mapping of shape operations (v0.3 K3): a pocket's or profile's `Shape` (any
 * contour kind) as exact 2D loops in its face frame, in surface-numbering order, plus the nominal
 * tab centres along a profile's loop (resolved against the stock in `tab-hold.ts`). What G1
 * (prisms), T1 (`generateRegionPocket`) and T2 (profiles on general loops) consume. Pure; no port
 * call (except `loopChamferAxis`, which takes the port).
 * Doc: docs/architecture/shapes.md#implementation-k3, docs/modes/design-v0.3.md#surfaces,
 * docs/modes/design-v0.3.md#tabs-on-shapes
 */
import { contourElements } from './contour'
import {
  arc,
  elementLength,
  line,
  regionLoops,
  reverseLoop,
  type Element,
  type Loop,
  type Path,
  type Region,
} from './2d/model'
import { closestOnChains } from './2d/measure'
import { translatePath, translateRegion } from './2d/place'
import { Ok, type AppResult } from '../../shared/result'
import type { Region2dPort } from './2d/port'
import type { LoopChamferGeometry, OperationGeometry, Shape, Vec2 } from './model'

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
 * The region a loop chamfer's edge bounds, in the face frame (or about the shape's centre with
 * `local`): `inside` (E1) the air, its edge operation's shape region (a pocket's region with its
 * islands as holes, an inside profile's opening); `outside` (E2) the part, the profile's loop
 * (`profileChain`: a profile takes one loop). The toolpath (`generateEdgeChamfer`) and the removal
 * solid (`chamfer-solids.ts`) both offset it through `loopChamferAxis`.
 * Doc: docs/modes/edge-chamfers.md#implementation-e2
 */
export function loopChamferRegion(op: Pick<LoopChamferGeometry, 'edge'>, local = false): Region {
  const shape = local ? { center: [0, 0] as const, contour: op.edge.shape.contour } : op.edge.shape
  const o = shapeOutline(shape)
  if (o.kind !== 'region') return { pieces: [] }
  if (op.edge.side === 'inside') return o.region
  const outer = o.region.pieces[0]?.outer
  return outer === undefined ? { pieces: [] } : { pieces: [{ outer, holes: [] }] }
}

/**
 * The edge moved `d` into the air (d ≥ 0): the tool axis region of a chamfer whose tip radius is
 * `d`. `inside`: the air shrunk, its loops with the air on their left; `outside`: the part grown,
 * its loops with the part on their left (climb runs them reversed).
 */
export function loopChamferAxis(
  op: Pick<LoopChamferGeometry, 'edge'>,
  port: Region2dPort,
  d: number,
  local = false,
): AppResult<Region> {
  const r = loopChamferRegion(op, local)
  return port.offset(r, op.edge.side === 'inside' ? d : -d)
}

/**
 * A loop chamfer's edge loops with the air on their left (an outside edge's part loop reversed),
 * in region order, each marked chosen (E4a `edge.loops`; absent = every loop).
 * Doc: docs/modes/edge-chamfers.md#implementation-e4a
 */
export function loopChamferEdgeLoops(
  op: Pick<LoopChamferGeometry, 'edge'>,
  local = false,
): { readonly loop: Loop; readonly chosen: boolean }[] {
  const chosen = op.edge.loops
  return regionLoops(loopChamferRegion(op, local)).map((l, i) => ({
    loop: op.edge.side === 'outside' ? reverseLoop(l) : l,
    chosen: chosen === undefined || chosen.includes(i),
  }))
}

/** True when the chamfer bevels every loop of its edge (E4a: no `loops`, or all of them). */
export function choosesEveryLoop(op: Pick<LoopChamferGeometry, 'edge'>): boolean {
  if (op.edge.loops === undefined) return true
  return loopChamferEdgeLoops(op).every((l) => l.chosen)
}

/** Whether the edge loop nearest `p` is chosen (E4a); true without loops. */
export function nearChosenLoop(
  edges: readonly { readonly loop: Loop; readonly chosen: boolean }[],
  p: Vec2,
): boolean {
  const c = closestOnChains(
    edges.map((e) => e.loop),
    p,
  )
  return c === undefined || edges[c.chain]!.chosen
}

/**
 * A sharp corner a corner lift (E4a) climbs: the edge vertex `v` between two lines of a chosen
 * loop where the air is convex (a concave material corner), `bisector` the unit direction into
 * the material and `sinHalf` = sin(θ/2), θ the air's angle at the corner; the mitre runs
 * width / sinHalf along the bisector.
 */
export interface LiftCorner {
  readonly v: Vec2
  readonly bisector: Vec2
  readonly sinHalf: number
}

/** Largest turn a corner lift takes (rad): a 10° corner, mitre 11.5 × the width. */
export const LIFT_MAX_TURN = (170 * Math.PI) / 180
/** Smaller turns are straight: nothing to lift (rad). */
const LIFT_MIN_TURN = 1e-3

/** The corners a loop chamfer with `cornerLift` lifts into (E4a), face frame (or `local`). */
export function loopChamferLiftCorners(
  op: Pick<LoopChamferGeometry, 'edge'>,
  local = false,
): LiftCorner[] {
  const out: LiftCorner[] = []
  for (const { loop, chosen } of loopChamferEdgeLoops(op, local)) {
    const els = loop.elements
    if (!chosen || els.length < 3) continue
    els.forEach((e, i) => {
      const f = els[(i + 1) % els.length]!
      if (e.kind !== 'line' || f.kind !== 'line') return
      const u = unit2([e.b[0] - e.a[0], e.b[1] - e.a[1]])
      const w = unit2([f.b[0] - f.a[0], f.b[1] - f.a[1]])
      const turn = Math.atan2(u[0] * w[1] - u[1] * w[0], u[0] * w[0] + u[1] * w[1])
      // a left turn with the air on the left: the air is convex there
      if (!(turn > LIFT_MIN_TURN && turn <= LIFT_MAX_TURN + 1e-9)) return
      // into the material: the mean of the two right normals
      const b = unit2([u[1] + w[1], -u[0] - w[0]])
      out.push({ v: e.b, bisector: b, sinHalf: Math.cos(turn / 2) })
    })
  }
  return out
}

function unit2(a: Vec2): Vec2 {
  const l = Math.hypot(a[0], a[1])
  return [a[0] / l, a[1] / l]
}

/** The points within `t` of the chosen loops of a loop chamfer (E4a), face frame. */
export function chosenLoopsBand(
  op: Pick<LoopChamferGeometry, 'edge'>,
  port: Region2dPort,
  t: number,
): AppResult<Region> {
  let out: AppResult<Region> = Ok({ pieces: [] })
  for (const { loop, chosen } of loopChamferEdgeLoops(op)) {
    if (!chosen) continue
    out = out.andThen((acc) => port.offsetPath(loop, t).andThen((b) => port.union(acc, b)))
  }
  return out
}
