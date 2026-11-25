/**
 * Pocket of a region (task T1): offset clearing by a ring tree (rings from the inside out per
 * branch, steps ≤ min(stepover, flat radius)), straight feed links inside the parent ring's region
 * else retract, helix/ramp/plunge entry per leaf, and one finishing ring per loop with tangent
 * lead-in and lead-out arcs. Every offset comes from the 2D port; arcs stay exact (G2/G3).
 * Doc: docs/modes/plan-v0.3.md#pocket-offset-clearing-of-a-region (spike: spikes/clearing/,
 * docs/research/s4-offset-clearing.md)
 *
 * General shapes reach it as `regionPocket` requests (K3's `pocketRegion`, the T1 wiring in
 * inputs.ts); v0.1 rectangle/circle pockets keep `generatePocket` (plan-v0.3.md#wiring-t1-t2).
 */
import { EPSILON, type Vec2, type Vec3 } from '../geometry/model'
import {
  chainBounds,
  regionArea,
  regionLoops,
  type Bounds2,
  type Region,
} from '../geometry/2d/model'
import type { Region2dPort } from '../geometry/2d/port'
import { Err, Ok, type AppResult } from '../../shared/result'
import { noSteps, type Steps } from '../workers/steps'
import { commonIssues, cutLevels, cutTop, passSteps, toolpath } from './common'
import type { GeneratorInput, PocketStrategy, Toolpath, ToolpathTool } from './model'
import { flat, MoveBuilder, segLength, segsLength, slope, walkRing, type Seg } from './path'
import { TOOL_FIT_TOLERANCE } from './pocket'
import {
  deepestPoint,
  linkInside,
  loopRing,
  regionDistance,
  ringClosest,
  ringFrom,
  ringStart,
  ringTree,
  type RingNode,
} from './region-rings'

/** A pocket of any region, placed in the setup's work plane (WCS XY, mm). */
export interface RegionPocketOperation {
  /** Normalised (`Region2dPort.normalise` or another port result): pieces with islands. */
  readonly region: Region
  /** Z of the surface the pocket starts on. */
  readonly onZ: number
  readonly depth: number
  /**
   * A pattern's roughing pocket (DF108): roughing levels only, leaving `finishAllowance` on the
   * walls; no finishing ring. Pieces its tool does not fit get no rings.
   */
  readonly roughing?: true | undefined
  /**
   * Rest machining after a roughing pocket of the same region (DF108): that pocket's tool radius,
   * corner radius and finishing allowance. Ring-tree nodes whose tool-centre region lies where
   * the roughing cleared (`restInside`) are skipped with their children.
   */
  readonly restAfter?: RestAfter | undefined
}

/** What an earlier roughing pocket of the same region cleared, by its tool (DF108). */
export interface RestAfter {
  readonly radius: number
  readonly cornerRadius: number
  readonly allowance: number
}

/** The skip test keeps this much (mm) off the roughed area's edge (2D library epsilons). */
const REST_MARGIN = 0.01
/** A node left over by less than this (mm²) counts as wholly in the roughed area. */
const REST_AREA = 1e-6

export type RegionPocketInput = GeneratorInput<RegionPocketOperation, PocketStrategy>

/**
 * Ring spacing of offset clearing: min(stepover, flat radius). With steps ≤ the radius every
 * point between a ring and its child lies within reach of the ring's sweep, for any region
 * (S4); larger stepovers are clamped (T-G) and the plan shows the effective value (T-H).
 */
export function clearingStep(tool: ToolpathTool, stepover: number): number {
  return Math.min(stepover, tool.diameter / 2 - tool.cornerRadius)
}

/** Whether `clearingStep` clamps the requested stepover (the T-H info note). */
export function stepoverClamped(tool: ToolpathTool, stepover: number): boolean {
  return clearingStep(tool, stepover) < stepover - EPSILON
}

/** Lead arc radii tried for the finishing ring, as fractions of the tool radius. */
const LEAD_FRACTIONS = [1, 0.5, 0.25] as const

interface Leaf {
  /** Helix centre and the loop/point where the ring starts after it; undefined: no helix. */
  readonly helix?: { readonly center: Vec2; readonly loop: number; readonly from: Vec2 }
}

/** `steps.step()` while building the ring tree and before every roughing and finishing level. */
export function generateRegionPocket(
  input: RegionPocketInput,
  port: Region2dPort,
  steps: Steps = noSteps,
): AppResult<Toolpath> {
  const { tool, cutting, heights, operation: op, strategy: st } = input
  const where = 'generateRegionPocket'
  const issues = commonIssues(input)
  issues.positive('operation.depth', op.depth)
  issues.nonNegative('strategy.finishAllowance', st.finishAllowance)
  issues.positive('strategy.finishStepdown', st.finishStepdown)
  issues.positive('strategy.helixDiameter', st.helixDiameter)
  if (!(st.rampAngle >= 0.5 && st.rampAngle <= 30))
    issues.rule('invariant', 'strategy.rampAngle', 'range', 'rampAngle must be 0.5°–30°', {
      rampAngle: st.rampAngle,
    })
  if (cutting.stepover > 0.9 * tool.diameter + EPSILON)
    issues.rule(
      'invariant',
      'cutting.stepover',
      'atMost',
      'stepover must be ≤ 0.9 × tool diameter',
      { stepover: cutting.stepover, max: 0.9 * tool.diameter },
    )
  if (op.region.pieces.length === 0)
    issues.rule('invariant', 'operation.region', 'empty', 'the region is empty')
  const R = tool.diameter / 2
  const flatRadius = R - tool.cornerRadius
  if (tool.diameter > 0 && flatRadius <= EPSILON)
    issues.rule('check', 'tool', 'noFlat', 'the tool has no flat bottom to clear a floor', {
      cornerRadius: tool.cornerRadius,
    })

  // the wall's tool-centre region; a tool up to TOOL_FIT_TOLERANCE too wide is accepted (v0.1)
  let wall: Region = { pieces: [] }
  if (issues.invariant.length === 0) {
    for (const d of [R, R - TOOL_FIT_TOLERANCE]) {
      const r = port.offset(op.region, d)
      if (r.isErr()) return Err(r.unwrapErr())
      wall = r.unwrap()
      if (wall.pieces.length > 0) break
    }
    if (wall.pieces.length === 0)
      issues.rule('check', 'tool.diameter', 'toolTooLarge', 'the tool is wider than the pocket', {
        diameter: tool.diameter,
      })
  }
  const ok = issues.result(where, input.planOperationId)
  if (ok.isErr()) return Err(ok.unwrapErr())

  // roughing roots: each wall piece shrunk by the finishing allowance; a piece too narrow for it
  // is roughed at the wall itself (no finishing ring there, as v0.1 clamps the allowance)
  const a = st.finishAllowance
  const rootPieces: Region['pieces'][number][] = []
  const finishPieces: Region['pieces'][number][] = []
  for (const piece of wall.pieces) {
    if (a <= EPSILON) {
      rootPieces.push(piece)
      continue
    }
    const r = port.offset({ pieces: [piece] }, a)
    if (r.isErr()) return Err(r.unwrapErr())
    const got = r.unwrap().pieces
    if (got.length === 0) rootPieces.push(piece)
    else {
      rootPieces.push(...got)
      finishPieces.push(piece)
    }
  }
  const roots: Region = { pieces: rootPieces }
  const step = clearingStep(tool, cutting.stepover)
  const treeR = ringTree(port, roots, R + a, step, steps)
  if (treeR.isErr()) return Err(treeR.unwrapErr())
  let tree = treeR.unwrap()
  if (op.restAfter !== undefined) {
    const inside = restInside(port, op.region, op.restAfter, R)
    if (inside.isErr()) return Err(inside.unwrapErr())
    const pruned = pruneCleared(port, tree, inside.unwrap())
    if (pruned.isErr()) return Err(pruned.unwrapErr())
    tree = pruned.unwrap()
  }

  const cw = st.direction === 'conventional'
  const ringsOf = new Map<RingNode, Seg[][]>()
  const rings = (n: RingNode): Seg[][] => {
    let r = ringsOf.get(n)
    if (r === undefined) {
      r = [n.piece.outer, ...n.piece.holes].map((l) => loopRing(l, cw)).filter((x) => x.length > 0)
      ringsOf.set(n, r)
    }
    return r
  }

  // entries per leaf, computed once for every level
  const helixRadius = Math.min(st.helixDiameter, tool.diameter) / 2
  const order = ['helix', 'ramp', 'plunge'] as const
  const allowed = order.slice(order.indexOf(st.entry))
  const leaves = new Map<RingNode, Leaf>()
  for (const root of tree) {
    const stack: RingNode[] = [root]
    while (stack.length > 0) {
      const n = stack.pop()!
      stack.push(...n.children)
      if (n.children.length > 0) continue
      let helix: Leaf['helix']
      if (allowed.includes('helix')) {
        const deep = deepestPoint(port, n.region, step)
        if (deep.isErr()) return Err(deep.unwrapErr())
        const c = deep.unwrap().point
        const room = port.distance(regionLoops(root.region), c)?.distance ?? 0
        if (port.contains(root.region, c) && room >= helixRadius - 1e-9) {
          // the ring starts at its closest point to the centre: that link stays in the bore
          const near = rings(n)
            .map((ring, loop) => ({ loop, p: ringClosest(ring, c) }))
            .filter((x) => x.p !== undefined)
            .sort((x, y) => x.p!.distance - y.p!.distance)[0]
          if (near !== undefined) helix = { center: c, loop: near.loop, from: near.p!.point }
        }
      }
      leaves.set(n, helix === undefined ? {} : { helix })
    }
  }

  const floor = op.onZ - op.depth
  const retract = op.onZ + heights.retractHeight
  const tan = Math.tan((st.rampAngle * Math.PI) / 180)
  const feed = cutting.feedRate
  const b = new MoveBuilder()
  const at = (p: Vec2, z: number): Vec3 => [p[0], p[1], z]
  const xy = (): Vec2 | undefined => {
    const p = b.position
    return p === undefined ? undefined : [p[0], p[1]]
  }
  /** Up to the retract plane (if below it) and over to `p` on it. */
  const goTo = (p: Vec2) => {
    const pos = b.position
    if (pos === undefined) b.rapid(at(p, heights.clearanceHeight))
    else if (pos[2] < retract) b.rapid([pos[0], pos[1], retract])
    b.rapid(at(p, retract))
  }
  const cutRing = (ring: readonly Seg[], z: number, f = feed) => {
    for (const s of flat(ring, z)) b.seg(s, f)
  }

  // over the material earlier cuts left (DF61): no passes wholly in air
  const roughZ = cutLevels(op.onZ, floor, cutting.stepdown, input.material)
  const finishing = finishPieces.length > 0 && op.roughing !== true
  const finishZ = finishing ? cutLevels(op.onZ, floor, st.finishStepdown, input.material) : []
  const pass = passSteps(steps, roughZ.length + finishZ.length)

  /** Enter a leaf at level z from `top`; returns the loop index and the started ring. */
  const enter = (n: RingNode, z: number, top: number): { loop: number; ring: Seg[] } => {
    const leaf = leaves.get(n)!
    const all = rings(n)
    if (leaf.helix !== undefined) {
      const { center: c, loop, from } = leaf.helix
      const start: Vec2 = [c[0], c[1] - helixRadius]
      const circle: Seg = {
        kind: 'arc',
        center: c,
        radius: helixRadius,
        start: -Math.PI / 2,
        sweep: cw ? -2 * Math.PI : 2 * Math.PI,
      }
      const turns = Math.max(1, Math.ceil((top - z) / (2 * Math.PI * helixRadius * tan) - 1e-9))
      goTo(start)
      b.line(at(start, top), cutting.plungeRate)
      for (const s of slope(Array<Seg>(turns).fill(circle), top, z)) b.seg(s, feed)
      for (const s of flat([circle], z)) b.seg(s, feed) // flatten the helix floor
      const p = ringClosest(all[loop]!, from)!
      const ring = ringFrom(all[loop]!, p.index, p.u)
      b.line(at(ringStart(ring), z), feed)
      return { loop, ring }
    }
    // ramp along (or plunge onto) the leaf's outer ring, from its point nearest the tool
    const here = xy()
    const outer = all[0]!
    const p = here === undefined ? undefined : ringClosest(outer, here)
    const ring = p === undefined ? outer : ringFrom(outer, p.index, p.u)
    const s0 = ringStart(ring)
    goTo(s0)
    if (allowed.includes('ramp') && segsLength(ring) >= tool.diameter - EPSILON) {
      b.line(at(s0, top), cutting.plungeRate)
      const { walked, lap } = walkRing(ring, (top - z) / tan)
      for (const s of slope(walked, top, z)) b.seg(s, feed)
      return { loop: 0, ring: lap }
    }
    b.line(at(s0, z), cutting.plungeRate)
    return { loop: 0, ring }
  }

  /** Cut a node's rings at z, the entered one first, then nearest-first with links. */
  const cutNode = (n: RingNode, z: number, first?: { loop: number; ring: Seg[] }) => {
    const all = rings(n)
    const todo = all.map((ring, loop) => ({ ring, loop }))
    // tool at the level: a straight feed link is possible
    let down = b.position !== undefined && Math.abs(b.position[2] - z) <= 1e-9
    if (first !== undefined) {
      todo.splice(
        todo.findIndex((t) => t.loop === first.loop),
        1,
      )
      cutRing(first.ring, z)
      down = true
    }
    while (todo.length > 0) {
      const here = xy()!
      const cands = todo
        .map((t, i) => ({ i, p: ringClosest(t.ring, here)! }))
        .sort((x, y) => x.p.distance - y.p.distance)
      const safe = down
        ? cands.find((c) => linkInside(port, n.region, all, here, c.p.point))
        : undefined
      const pick = safe ?? cands[0]!
      const t = todo.splice(pick.i, 1)[0]!
      const ring = ringFrom(t.ring, pick.p.index, pick.p.u)
      const s0 = ringStart(ring)
      if (safe !== undefined) b.line(at(s0, z), feed)
      else {
        // blocked link (or first ring of the level): retract, rapid, plunge (T-I)
        goTo(s0)
        b.line(at(s0, z), cutting.plungeRate)
      }
      cutRing(ring, z)
      down = true
    }
  }

  // the node nearest the tool, ties to the earlier one; nodes whose box is farther than the best
  // distance found are not measured (patterns P1: hundreds of cells, S8 finding 6)
  const boxes = new Map<RingNode, Bounds2 | undefined>()
  const boxOf = (n: RingNode) => {
    if (!boxes.has(n)) boxes.set(n, chainBounds(n.region.pieces.flatMap((p) => p.outer.elements)))
    return boxes.get(n)
  }
  const nearestFirst = (nodes: readonly RingNode[]): RingNode | undefined => {
    const here = xy()
    if (here === undefined) return nodes[0]
    const i = nearestIndex(
      nodes.length,
      (k) => boxDistance(boxOf(nodes[k]!), here),
      (k) => regionDistance(port, nodes[k]!.region, here),
    )
    return i < 0 ? undefined : nodes[i]
  }

  /** Post-order: children nearest-first (each from its innermost ring out), then the node. */
  const visit = (n: RingNode, z: number, top: number) => {
    if (n.children.length === 0) {
      cutNode(n, z, enter(n, z, top))
      return
    }
    const left = [...n.children]
    while (left.length > 0) {
      const c = nearestFirst(left)!
      left.splice(left.indexOf(c), 1)
      visit(c, z, top)
    }
    cutNode(n, z)
  }

  let top = cutTop(op.onZ, floor, input.material)
  // DF108: rest machining may leave no ring to cut (the roughing cleared every node)
  for (const [k, z] of (tree.length === 0 ? [] : roughZ).entries()) {
    const s = pass(k)
    if (s.isErr()) return Err(s.unwrapErr())
    b.pass('rough')
    const left = [...tree]
    let visited = 0
    while (left.length > 0) {
      // an abort point per group of pieces within a level (patterns P1: a level of 2 000 cells)
      if (++visited % PIECES_PER_STEP === 0) {
        const g = steps.step()
        if (g.isErr()) return Err(g.unwrapErr())
      }
      const r = nearestFirst(left)!
      left.splice(left.indexOf(r), 1)
      visit(r, z, top)
    }
    const pos = b.position!
    b.rapid([pos[0], pos[1], retract])
    top = z
  }

  if (finishing) {
    b.pass('finish')
    // DF74: the finishing feed keeps the chip load at the allowance's radial engagement
    const finishFeed = cutting.finishFeedRate ?? feed
    const finishRegion: Region = { pieces: finishPieces }
    const loops = regionLoops(finishRegion)
      .map((l) => loopRing(l, cw))
      .filter((r) => r.length > 0)
    const ringBoxes = new Map<readonly Seg[], Bounds2>()
    const ringBoxOf = (r: readonly Seg[]) => {
      let bx = ringBoxes.get(r)
      if (bx === undefined) ringBoxes.set(r, (bx = segsBox(r)))
      return bx
    }
    let finished = 0
    while (loops.length > 0) {
      if (++finished % PIECES_PER_STEP === 0) {
        const g = steps.step()
        if (g.isErr()) return Err(g.unwrapErr())
      }
      const here = xy()!
      const bi = Math.max(
        0,
        nearestIndex(
          loops.length,
          (i) => boxDistance(ringBoxOf(loops[i]!), here),
          (i) => ringClosest(loops[i]!, here)!.distance,
        ),
      )
      const ring0 = loops.splice(bi, 1)[0]!
      const lead = finishLead(port, ring0, wall, roots, R, a, cw)
      goTo(lead.start)
      for (const [k, z] of finishZ.entries()) {
        const s = pass(roughZ.length + k)
        if (s.isErr()) return Err(s.unwrapErr())
        b.line(at(lead.start, z), cutting.plungeRate)
        for (const sg of flat(lead.leadIn, z)) b.seg(sg, finishFeed)
        cutRing(lead.ring, z, finishFeed)
        for (const sg of flat(lead.leadOut, z)) b.seg(sg, finishFeed)
        if (k < finishZ.length - 1) b.line(at(lead.start, z), finishFeed)
      }
      const pos = b.position!
      b.rapid([pos[0], pos[1], retract])
    }
  }
  const end = b.position
  if (end !== undefined) b.rapid([end[0], end[1], heights.clearanceHeight])
  return Ok(toolpath(input, b.build()))
}

/**
 * The tool-centre positions (radius `R`) whose disc lies wholly in what a roughing pocket of
 * `region` cleared (DF108): the region shrunk by the roughing tool's radius + allowance (its
 * tool-centre region, as `generateRegionPocket` roughs it) grown back by its flat radius, then
 * shrunk by `R` + `REST_MARGIN`. Pieces the roughing tool does not fit add nothing.
 */
export function restInside(
  port: Region2dPort,
  region: Region,
  rough: RestAfter,
  R: number,
): AppResult<Region> {
  return port
    .offset(region, rough.radius + rough.allowance)
    .andThen((centres) =>
      centres.pieces.length === 0
        ? Ok(centres)
        : port.offset(centres, -(rough.radius - rough.cornerRadius)),
    )
    .andThen((cleared) =>
      cleared.pieces.length === 0 ? Ok(cleared) : port.offset(cleared, R + REST_MARGIN),
    )
}

/**
 * The ring tree without the nodes whose tool-centre region lies in `inside` (DF108): their rings
 * would cut only air the roughing cleared, and so would their children's (each lies in its
 * parent). A node is one piece, so it lies in at most one piece of `inside`: the pieces whose box
 * holds the node's box are tried.
 */
export function pruneCleared(
  port: Region2dPort,
  tree: readonly RingNode[],
  inside: Region,
): AppResult<RingNode[]> {
  const boxes = inside.pieces.map((p) => chainBounds(p.outer.elements))
  const holds = (b: Bounds2 | undefined, n: Bounds2 | undefined) =>
    b !== undefined &&
    n !== undefined &&
    b.min[0] <= n.min[0] + BOX_SLACK &&
    b.min[1] <= n.min[1] + BOX_SLACK &&
    b.max[0] >= n.max[0] - BOX_SLACK &&
    b.max[1] >= n.max[1] - BOX_SLACK
  const covered = (n: RingNode): AppResult<boolean> => {
    const box = chainBounds(n.piece.outer.elements)
    for (const [i, piece] of inside.pieces.entries()) {
      if (!holds(boxes[i], box)) continue
      const left = port.difference(n.region, { pieces: [piece] })
      if (left.isErr()) return Err(left.unwrapErr())
      if (regionArea(left.unwrap()) < REST_AREA) return Ok(true)
    }
    return Ok(false)
  }
  const prune = (n: RingNode): AppResult<RingNode | undefined> => {
    const c = covered(n)
    if (c.isErr()) return Err(c.unwrapErr())
    if (c.unwrap()) return Ok(undefined)
    const children: RingNode[] = []
    for (const child of n.children) {
      const k = prune(child)
      if (k.isErr()) return Err(k.unwrapErr())
      if (k.unwrap() !== undefined) children.push(k.unwrap()!)
    }
    return Ok(children.length === n.children.length ? n : { ...n, children })
  }
  const out: RingNode[] = []
  for (const root of tree) {
    const k = prune(root)
    if (k.isErr()) return Err(k.unwrapErr())
    if (k.unwrap() !== undefined) out.push(k.unwrap()!)
  }
  return Ok(out)
}

/** Pieces (ring tree roots, finishing loops) cut between two abort points within a level. */
const PIECES_PER_STEP = 64
/** Slack of the box lower bounds (mm): float noise only. */
const BOX_SLACK = 1e-9

/** Distance from `p` to a box (0 inside; 0 without a box: no bound). */
function boxDistance(b: Bounds2 | undefined, p: Vec2): number {
  if (b === undefined) return 0
  const dx = Math.max(b.min[0] - p[0], 0, p[0] - b.max[0])
  const dy = Math.max(b.min[1] - p[1], 0, p[1] - b.max[1])
  return Math.hypot(dx, dy)
}

/** A box holding every piece of a ring (an arc's whole circle: a bound, not exact). */
function segsBox(ring: readonly Seg[]): Bounds2 {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const s of ring) {
    const pts: Vec2[] =
      s.kind === 'line'
        ? [s.from, s.to]
        : [
            [s.center[0] - s.radius, s.center[1] - s.radius],
            [s.center[0] + s.radius, s.center[1] + s.radius],
          ]
    for (const p of pts) {
      x0 = Math.min(x0, p[0])
      y0 = Math.min(y0, p[1])
      x1 = Math.max(x1, p[0])
      y1 = Math.max(y1, p[1])
    }
  }
  return { min: [x0, y0], max: [x1, y1] }
}

/**
 * The index of the smallest `exact(i)` among `n` candidates, ties to the smallest index (as a
 * scan with a strict `<`), measuring only candidates whose lower bound `bound(i)` ≤ `exact(i)`
 * does not rule them out: the one with the smallest bound first, then the others in order.
 * −1 when every distance is infinite.
 */
export function nearestIndex(
  n: number,
  bound: (i: number) => number,
  exact: (i: number) => number,
): number {
  if (n === 0) return -1
  const lb = new Float64Array(n)
  let seed = 0
  for (let i = 0; i < n; i++) {
    lb[i] = bound(i)
    if (lb[i]! < lb[seed]!) seed = i
  }
  let best = -1
  let bd = Infinity
  const d0 = exact(seed)
  if (d0 < Infinity) {
    best = seed
    bd = d0
  }
  for (let i = 0; i < n; i++) {
    if (i === seed || lb[i]! > bd + BOX_SLACK) continue
    const d = exact(i)
    if (d < bd || (d === bd && d < Infinity && i < best)) {
      bd = d
      best = i
    }
  }
  return best
}

interface Lead {
  readonly start: Vec2
  readonly leadIn: Seg[]
  readonly ring: Seg[]
  readonly leadOut: Seg[]
}

/**
 * The finishing ring of one loop from the middle of its longest piece, with quarter-circle lead
 * arcs on the cleared side (T-D): radius R, R/2 or R/4, the first whose circle lies inside the
 * wall's tool-centre region and whose ends lie in the roughed region. Else straight leads from
 * the roughed ring (v0.1), or none when that point is not roughed either.
 */
export function finishLead(
  port: Region2dPort,
  ring0: readonly Seg[],
  wall: Region,
  roughed: Region,
  R: number,
  allowance: number,
  cw: boolean,
): Lead {
  let li = 0
  ring0.forEach((s, i) => {
    const better =
      (s.kind === 'line') !== (ring0[li]!.kind === 'line')
        ? s.kind === 'line'
        : segLength(s) > segLength(ring0[li]!)
    if (better) li = i
  })
  const ring = ringFrom(ring0, li, 0.5)
  const P = ringStart(ring)
  const t = tangentAt(ring[0]!)
  // the cleared side: left of the direction of travel for climb (the region lies left of its
  // loops), right for conventional
  const side = cw ? -1 : 1
  const n: Vec2 = [-t[1] * side, t[0] * side]
  const wallLoops = regionLoops(wall)
  for (const f of LEAD_FRACTIONS) {
    const r = R * f
    const c: Vec2 = [P[0] + r * n[0], P[1] + r * n[1]]
    const S: Vec2 = [c[0] - r * t[0], c[1] - r * t[1]]
    const E: Vec2 = [c[0] + r * t[0], c[1] + r * t[1]]
    const room = port.distance(wallLoops, c)?.distance ?? 0
    if (
      port.contains(wall, c) &&
      room >= r - 1e-9 &&
      port.contains(roughed, S) &&
      port.contains(roughed, E)
    ) {
      const sweep = (side * Math.PI) / 2
      const a0 = Math.atan2(S[1] - c[1], S[0] - c[0])
      const a1 = Math.atan2(P[1] - c[1], P[0] - c[0])
      return {
        start: S,
        leadIn: [{ kind: 'arc', center: c, radius: r, start: a0, sweep }],
        ring,
        leadOut: [{ kind: 'arc', center: c, radius: r, start: a1, sweep }],
      }
    }
  }
  const L: Vec2 = [P[0] + allowance * n[0], P[1] + allowance * n[1]]
  if (allowance > EPSILON && port.contains(roughed, L))
    return {
      start: L,
      leadIn: [{ kind: 'line', from: L, to: P }],
      ring,
      leadOut: [{ kind: 'line', from: P, to: L }],
    }
  return { start: P, leadIn: [], ring, leadOut: [] }
}

/** Unit tangent at the start of a piece. */
export function tangentAt(s: Seg): Vec2 {
  if (s.kind === 'line') {
    const len = segLength(s)
    return [(s.to[0] - s.from[0]) / len, (s.to[1] - s.from[1]) / len]
  }
  const d = s.sweep >= 0 ? 1 : -1
  return [-Math.sin(s.start) * d, Math.cos(s.start) * d]
}
