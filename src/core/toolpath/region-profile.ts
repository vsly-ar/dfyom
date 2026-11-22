/**
 * Profile of a general loop or open path (task T2): passes by offset from the offcut side to the
 * part side (`outside`, `inside`), centreline grooves (`on`, closed loops and open paths, the
 * open ones zigzag by level), ramp or plunge entry, lifts over tabs placed by arc length, and a
 * finishing pass at full depth with tangent lead-in and lead-out arcs of `leadRadius`. Every
 * offset comes from the 2D port; arcs stay exact (G2/G3).
 * Doc: docs/modes/plan-v0.3.md#profile-on-general-loops
 *
 * Region-level only: the operation mapping (shape → placed loop) arrives with K3; until then the
 * v0.1 rectangle/circle profiles keep `generateProfile`.
 */
import { EPSILON, type Vec2, type Vec3 } from '../geometry/model'
import { regionLoops, reverseLoop, signedArea, type Loop, type Region } from '../geometry/2d/model'
import type { Region2dPort } from '../geometry/2d/port'
import { checkChain } from '../geometry/2d/wire'
import { chainLength, chainPointAt } from '../geometry/2d/measure'
import { Err, Ok, type AppResult } from '../../shared/result'
import { noSteps, type Steps } from '../workers/steps'
import { commonIssues, levels, passSteps, toolpath } from './common'
import { rowPositions } from './facing'
import type { GeneratorInput, ProfileStrategy, Toolpath, ToolpathTool } from './model'
import {
  flat,
  MoveBuilder,
  segPoint,
  segReverse,
  segsLength,
  slope,
  walkRing,
  type Seg,
  type Seg3,
} from './path'
import { TOOL_FIT_TOLERANCE } from './pocket'
import { tangentAt } from './region-pocket'
import { elementSeg, linkInside, loopRing, ringClosest, ringFrom, ringStart } from './region-rings'
import { diskHitsGeneralBands, generalTabBands, type GeneralTabBand } from '../geometry/tab-bands'
import { liftOverTabs } from './tabs'

export type RegionProfileSide = 'outside' | 'inside' | 'on'

/** A profile of one loop or open path, placed in the setup's work plane (WCS XY, mm). */
export interface RegionProfileOperation {
  /**
   * The loop (closed) or path (open) of K3's `profileChain` (geometry/outline.ts), turned into
   * the setup's WCS. Tab positions and the start point are arc lengths from its first point in
   * its own direction (`profileChain` starts at the design's start point, counter-clockwise seen
   * from outside); a WCS turn that mirrors it (clockwise) is fine, offsets do not depend on it.
   */
  readonly chain: Loop
  readonly closed: boolean
  readonly side: RegionProfileSide
  readonly slotWidth: number
  /** Z of the surface the cut starts on. */
  readonly onZ: number
  /** Down to the stock bottom for a through cut, else a blind `on` groove's depth. */
  readonly depth: number
  /** Through cuts go `breakthrough` below the depth; only `on` may be blind. */
  readonly through: boolean
  readonly tabs: {
    /**
     * Tab centres as arc lengths along the loop, in [0, length): K3's `tabCentres(length,
     * op.tabs)` (the centres of `tabStretches`; empty for open or blind cuts). Empty: no tabs.
     */
    readonly positions: readonly number[]
    readonly width: number
    /** Up from the bottom of the cut (`onZ − depth`). */
    readonly thickness: number
  }
}

export interface RegionProfileStrategy extends ProfileStrategy {
  /** Lead-in/out arc radius of the finishing pass (mm, default 0.5 D); 0 = straight leads. */
  readonly leadRadius: number
}

export type RegionProfileInput = GeneratorInput<RegionProfileOperation, RegionProfileStrategy>

/**
 * Pass spacing on general loops: min(stepover, R), for a blind groove's floor min(stepover, flat
 * radius). With steps ≤ the radius every point between two offset passes lies within reach of the
 * outer one for any loop (the pocket's argument, plan-v0.3.md § Pocket); v0.1's analytic shapes
 * allowed up to 2R (√2·R inside rectangles). Larger stepovers are clamped (T-G, T-H note).
 */
export function profileStep(tool: ToolpathTool, stepover: number, blind: boolean): number {
  return Math.min(stepover, tool.diameter / 2 - (blind ? tool.cornerRadius : 0))
}

/** Whether `profileStep` clamps the requested stepover (the T-H info note). */
export function profileStepClamped(tool: ToolpathTool, stepover: number, blind: boolean): boolean {
  return profileStep(tool, stepover, blind) < stepover - EPSILON
}

/** One closed pass with the side its offcut (the cleared slot) lies on, seen along travel. */
interface Ring {
  readonly segs: Seg[]
  readonly offcutLeft: boolean
}

interface Passes {
  /** Groups of closed rings per pass distance, in cutting order; pieces nearest-first. */
  readonly rough: Ring[][]
  /** The open path's centreline (zigzag by level). */
  readonly centre?: Seg[]
  readonly finish: Ring[]
  /** Tool centres of the roughing: straight links stay inside it, else retract (T-I). */
  readonly link: Region
  /** Tool centres of the whole slot: lead arcs must stay inside it. */
  readonly free: Region
  /** Straight lead length (the allowance) when no arc fits. */
  readonly straight: number
  /** The slot covers an inside opening (no slug): no tabs. */
  readonly covers: boolean
}

const EMPTY: Region = { pieces: [] }
/** Lead arc radii tried, as fractions of `leadRadius`. */
const LEAD_FRACTIONS = [1, 0.5, 0.25] as const
const LEAD_SAMPLES = 16

/** `steps.step()` before every level and before the finishing pass. */
export function generateRegionProfile(
  input: RegionProfileInput,
  port: Region2dPort,
  steps: Steps = noSteps,
): AppResult<Toolpath> {
  const { tool, cutting, heights, operation: op, strategy: st } = input
  const where = 'generateRegionProfile'
  const R = tool.diameter / 2
  const sw = op.slotWidth
  const on = op.side === 'on'
  const issues = commonIssues(input)
  issues.positive('operation.slotWidth', sw)
  issues.positive('operation.depth', op.depth)
  issues.nonNegative('strategy.breakthrough', st.breakthrough)
  issues.nonNegative('strategy.finishAllowance', st.finishAllowance)
  issues.nonNegative('strategy.leadRadius', st.leadRadius)
  if (!(st.rampAngle >= 0.5 && st.rampAngle <= 30))
    issues.rule('invariant', 'strategy.rampAngle', 'range', 'rampAngle must be 0.5°–30°', {
      rampAngle: st.rampAngle,
    })
  if (cutting.stepover > tool.diameter + EPSILON)
    issues.rule('invariant', 'cutting.stepover', 'atMost', 'stepover must be ≤ tool diameter', {
      stepover: cutting.stepover,
      max: tool.diameter,
    })
  const chainOk = checkChain(op.chain.elements, op.closed, where)
  if (chainOk.isErr())
    for (const i of chainOk.unwrapErr().issues)
      issues.rule('invariant', 'operation.chain', i.rule, i.message, i.params ?? {})
  const length = chainOk.isOk() ? chainLength(op.chain) : 0
  if (chainOk.isOk() && op.closed && Math.abs(signedArea(op.chain)) <= 1e-9)
    issues.rule('invariant', 'operation.chain', 'noArea', 'the loop encloses no area')
  if (chainOk.isOk() && length <= 1e-3)
    issues.rule('invariant', 'operation.chain', 'empty', 'the path is too short to cut', {
      length,
    })
  if (!op.closed && !on)
    issues.rule('invariant', 'operation.side', 'openNeedsOn', 'an open path needs side "on"')
  if (!op.through && !on)
    issues.rule('invariant', 'operation.through', 'onlyOn', 'only a profile on can stop at a depth')
  const tabs = op.tabs
  if (tabs.positions.length > 0) {
    if (!op.closed || !op.through)
      issues.rule(
        'invariant',
        'operation.tabs.positions',
        'tabsNotAllowed',
        'tabs need a closed loop cut through',
      )
    issues.positive('operation.tabs.width', tabs.width)
    if (!(tabs.thickness > 0 && tabs.thickness < op.depth))
      issues.rule(
        'invariant',
        'operation.tabs.thickness',
        'range',
        'tabs.thickness must be > 0 and < the depth',
        { thickness: tabs.thickness },
      )
    tabs.positions.forEach((s, i) => {
      if (!(Number.isFinite(s) && s >= 0 && s < length))
        issues.rule(
          'invariant',
          `operation.tabs.positions.${i}`,
          'tabOutside',
          'a tab lies outside the loop',
          { position: s, length },
        )
    })
    const sorted = [...tabs.positions].sort((a, b) => a - b)
    for (let i = 0; i < sorted.length && sorted.length > 1; i++) {
      const gap =
        i + 1 < sorted.length ? sorted[i + 1]! - sorted[i]! : sorted[0]! + length - sorted[i]!
      if (gap < tabs.width - 1e-9) {
        issues.rule('invariant', 'operation.tabs.positions', 'tabsOverlap', 'tabs overlap', {
          width: tabs.width,
        })
        break
      }
    }
  }
  if (tool.diameter > sw + TOOL_FIT_TOLERANCE)
    issues.rule('check', 'tool.diameter', 'toolTooLarge', 'the tool is wider than the slot', {
      diameter: tool.diameter,
      slotWidth: sw,
    })
  const blind = !op.through
  const flatRadius = R - tool.cornerRadius
  if (blind && sw > tool.diameter + EPSILON && flatRadius <= EPSILON)
    issues.rule('check', 'tool', 'noFlat', 'the tool has no flat bottom to clear a wide groove', {
      cornerRadius: tool.cornerRadius,
    })
  // the loop as a region; an inside tool up to TOOL_FIT_TOLERANCE wider than it is accepted
  let L: Region = EMPTY
  let wallD = R
  if (issues.invariant.length === 0 && op.closed) {
    // counter-clockwise first: `normalise` subtracts a lone clockwise loop
    const ccw = signedArea(op.chain) > 0 ? op.chain : reverseLoop(op.chain)
    const norm = port.normalise([ccw])
    if (norm.isErr()) return Err(norm.unwrapErr())
    L = norm.unwrap()
    if (op.side === 'inside') {
      const fits = (d: number): AppResult<boolean> =>
        port.offset(L, d).map((r) => r.pieces.length > 0)
      const full = fits(R)
      if (full.isErr()) return Err(full.unwrapErr())
      if (!full.unwrap()) {
        wallD = R - TOOL_FIT_TOLERANCE
        const near = fits(wallD)
        if (near.isErr()) return Err(near.unwrapErr())
        if (!near.unwrap())
          issues.rule(
            'check',
            'tool.diameter',
            'toolTooLarge',
            'the tool is wider than the opening',
            {
              diameter: tool.diameter,
            },
          )
      }
    }
  }
  const pre = issues.result(where, input.planOperationId)
  if (pre.isErr()) return Err(pre.unwrapErr())

  const spacing = profileStep(tool, cutting.stepover, blind)
  const climb = st.direction === 'climb'
  const a = st.finishAllowance
  const plan = !op.closed
    ? onPathPasses(port, op.chain, R, sw, a, spacing, climb)
    : on
      ? onLoopPasses(port, L, R, sw, a, spacing, climb)
      : sidePasses(port, L, op.side === 'outside', wallD, R, sw, a, spacing, climb)
  if (plan.isErr())
    return Err(plan.unwrapErr().withContext(where, { planOperationId: input.planOperationId }))
  const passes = plan.unwrap()

  // tabs: bands across the slot at the given positions (none when the slot covers an opening)
  let bands: GeneralTabBand[] = []
  if (tabs.positions.length > 0 && !passes.covers) {
    const ccw = signedArea(op.chain) > 0
    const [lo, hi]: [number, number] = on
      ? [-sw / 2, sw / 2]
      : (op.side === 'outside') === ccw
        ? [-sw, 0]
        : [0, sw]
    bands = generalTabBands(op.chain, tabs.positions, tabs.width, lo, hi)
  }
  const tabTop = op.onZ - op.depth + tabs.thickness
  const hits = (p: Vec2) => diskHitsGeneralBands(p, R, bands)
  const lift = (pieces: Seg3[]): Seg3[] =>
    bands.length === 0 ? pieces : liftOverTabs(pieces, hits, tabTop, Math.min(R / 4, 0.5))
  const liftZ = (p: Vec2, z: number) => (z < tabTop && bands.length > 0 && hits(p) ? tabTop : z)

  // the start point: the chain's start, unless a tab is there (then mid-way to the next tab)
  let s0 = 0
  if (bands.length > 0) {
    const sorted = [...tabs.positions].sort((a, b) => a - b)
    const reach = tabs.width / 2 + R
    const circ = (a: number) => Math.min(Math.abs(a), length - Math.abs(a))
    const i = sorted.findIndex((c) => circ(c) < reach)
    if (i >= 0) {
      const c = sorted[i]!
      const next = i + 1 < sorted.length ? sorted[i + 1]! : sorted[0]! + length
      s0 = ((sorted.length === 1 ? c + length / 2 : (c + next) / 2) + length) % length
    }
  }
  const P0 = chainPointAt(op.chain, s0, op.closed).unwrap().point

  const bottom = op.onZ - op.depth - (op.through ? st.breakthrough : 0)
  const retract = op.onZ + heights.retractHeight
  const tan = Math.tan((st.rampAngle * Math.PI) / 180)
  const feed = cutting.feedRate
  const b = new MoveBuilder()
  const at = (p: Vec2, z: number): Vec3 => [p[0], p[1], z]
  const xy = (): Vec2 => [b.position![0], b.position![1]]
  /** Pieces in order, vertical moves (tab lifts and drops) between them at the plunge rate. */
  const emit = (pieces: readonly Seg3[]) => {
    for (const piece of pieces) {
      const pos = b.position!
      if (Math.abs(pos[2] - piece.z0) > EPSILON)
        b.line([pos[0], pos[1], piece.z0], cutting.plungeRate)
      b.seg(piece, feed)
    }
  }
  const lineTo = (p: Vec2, z: number): Seg3[] => [
    { seg: { kind: 'line', from: xy(), to: p }, z0: z, z1: z },
  ]
  /** Up to the retract plane (if below it) and over to `p` on it. */
  const goTo = (p: Vec2) => {
    const pos = b.position
    if (pos === undefined) b.rapid(at(p, heights.clearanceHeight))
    else if (pos[2] < retract) b.rapid([pos[0], pos[1], retract])
    b.rapid(at(p, retract))
  }
  const linkRings = regionLoops(passes.link).map((l) => loopRing(l))
  const canLink = (p: Vec2, q: Vec2, z: number) =>
    b.position !== undefined &&
    Math.abs(b.position[2] - z) <= 1e-9 &&
    passes.link.pieces.length > 0 &&
    linkInside(port, passes.link, linkRings, p, q)
  /** To `p` at level z: a straight feed inside the roughed band, else retract, rapid, plunge. */
  const reach = (p: Vec2, z: number) => {
    if (canLink(xy(), p, z)) emit(lift(lineTo(p, z)))
    else {
      goTo(p)
      b.line(at(p, liftZ(p, z)), cutting.plungeRate)
    }
  }
  /** Cut the rings of a group nearest-first, from their points closest to the tool. */
  const cutGroup = (group: readonly Ring[], z: number) => {
    const todo = [...group]
    while (todo.length > 0) {
      const here = xy()
      let bi = 0
      let best = ringClosest(todo[0]!.segs, here)!
      todo.forEach((r, i) => {
        const c = ringClosest(r.segs, here)!
        if (c.distance < best.distance) {
          bi = i
          best = c
        }
      })
      const ring = ringFrom(todo.splice(bi, 1)[0]!.segs, best.index, best.u)
      reach(ringStart(ring), z)
      emit(lift(flat(ring, z)))
    }
  }
  const canRamp = (segs: readonly Seg[], drop: number) =>
    st.entry === 'ramp' && drop > EPSILON && segsLength(segs) >= tool.diameter - EPSILON

  const zs = levels(op.onZ, bottom, cutting.stepdown)
  const finishing = passes.finish.length > 0
  const pass = passSteps(steps, zs.length + (finishing ? 1 : 0))
  let previous = op.onZ
  let fromStart = true
  for (const [k, z] of zs.entries()) {
    const s = pass(k)
    if (s.isErr()) return Err(s.unwrapErr())
    b.pass('rough')
    let groups = passes.rough
    if (passes.centre !== undefined) {
      // open path: along, then back one level lower (T-E), from the end nearest the tool
      const fwd = passes.centre
      const rev = [...fwd].reverse().map(segReverse)
      if (b.position !== undefined) {
        const here = xy()
        const a = ringStart(fwd)
        const e = ringStart(rev)
        fromStart =
          Math.hypot(here[0] - a[0], here[1] - a[1]) <= Math.hypot(here[0] - e[0], here[1] - e[1])
      }
      const path = fromStart ? fwd : rev
      const e0 = ringStart(path)
      const pos = b.position
      const there =
        pos !== undefined &&
        Math.hypot(pos[0] - e0[0], pos[1] - e0[1]) <= 1e-9 &&
        Math.abs(pos[2] - previous) <= 1e-9
      if (!there) {
        goTo(e0)
        b.line(at(e0, previous), cutting.plungeRate)
      }
      if (canRamp(path, previous - z)) {
        const { walked, back } = zigzag(path, (previous - z) / tan)
        emit(slope(walked, previous, z))
        emit(flat(back, z))
      } else b.line(at(e0, z), cutting.plungeRate)
      emit(flat(path, z))
      fromStart = !fromStart
    } else {
      // closed: the first ring from the start point, entered by ramp along it or plunge
      const first = Math.max(
        0,
        groups.findIndex((g) => g.length > 0),
      )
      const group = [...groups[first]!]
      let bi = 0
      let best = ringClosest(group[0]!.segs, P0)!
      group.forEach((r, i) => {
        const c = ringClosest(r.segs, P0)!
        if (c.distance < best.distance) {
          bi = i
          best = c
        }
      })
      const ring = ringFrom(group.splice(bi, 1)[0]!.segs, best.index, best.u)
      const p0 = ringStart(ring)
      goTo(p0)
      if (canRamp(ring, previous - z)) {
        b.line(at(p0, liftZ(p0, previous)), cutting.plungeRate)
        const { walked, lap } = walkRing(ring, (previous - z) / tan)
        emit(lift(slope(walked, previous, z)))
        emit(lift(flat(lap, z)))
      } else {
        b.line(at(p0, liftZ(p0, z)), cutting.plungeRate)
        emit(lift(flat(ring, z)))
      }
      cutGroup(group, z)
      groups = groups.slice(first + 1)
    }
    for (const g of groups) cutGroup(g, z)
    // closed loops lift after each level (v0.1); an open groove stays down for the way back
    if (passes.centre === undefined || passes.rough.length > 0) b.rapid(at(xy(), retract))
    previous = z
  }

  // finishing: the part-side pass(es) at full depth, lead arcs from the offcut side (T-D)
  if (finishing) {
    const s = pass(zs.length)
    if (s.isErr()) return Err(s.unwrapErr())
    b.pass('finish')
    const todo = [...passes.finish]
    while (todo.length > 0) {
      const here = xy()
      let bi = 0
      let bd = Infinity
      todo.forEach((r, i) => {
        const d = ringClosest(r.segs, here)!.distance
        if (d < bd) {
          bd = d
          bi = i
        }
      })
      const r = todo.splice(bi, 1)[0]!
      const p = ringClosest(r.segs, P0)!
      const lead = profileLead(
        port,
        ringFrom(r.segs, p.index, p.u),
        r.offcutLeft,
        st.leadRadius,
        passes.free,
        passes.straight,
      )
      goTo(lead.start)
      b.line(at(lead.start, liftZ(lead.start, bottom)), cutting.plungeRate)
      emit(lift(flat([...lead.leadIn, ...lead.ring, ...lead.leadOut], bottom)))
      b.rapid(at(xy(), retract))
    }
  }
  if (b.position !== undefined && b.position[2] < retract) b.rapid(at(xy(), retract))
  b.rapid(at(xy(), heights.clearanceHeight))
  return Ok(toolpath(input, b.build()))
}

// ---------------------------------------------------------------- passes per kind

/** Closed rings of every loop of `region`, region-on-left unless `reverse`. */
function ringsOf(region: Region, reverse: boolean, offcutInRegion: boolean): Ring[] {
  return regionLoops(region)
    .map((l) => ({ segs: loopRing(l, reverse), offcutLeft: offcutInRegion !== reverse }))
    .filter((r) => r.segs.length > 0)
}

/** Distances from `a` to `b` in equal steps ≤ `step`, or just `a` if they meet. */
const spaced = (a: number, b: number, step: number): number[] =>
  b - a <= EPSILON ? [a] : rowPositions(a, b, step)

/**
 * `outside` / `inside`: tool-centre passes at distances from the loop, the part side at R +
 * allowance, toward the offcut in steps ≤ `spacing`, cut from the offcut side. Rings of an
 * outside pass keep the part on their left when climbing reversed (v0.1: outside climb runs
 * clockwise, inside climb counter-clockwise); every loop of an offset is cut (necks split).
 */
function sidePasses(
  port: Region2dPort,
  L: Region,
  outside: boolean,
  wallD: number,
  R: number,
  sw: number,
  allowance: number,
  spacing: number,
  climb: boolean,
): AppResult<Passes> {
  const regions = new Map<number, Region>()
  /** The tool-centre region at distance d (cached): outside grows, inside shrinks. */
  const off = (d: number): AppResult<Region> => {
    const hit = regions.get(d)
    if (hit !== undefined) return Ok(hit)
    const r = port.offset(L, outside ? -d : d)
    if (r.isOk()) regions.set(d, r.unwrap())
    return r
  }
  const far = Math.max(wallD, sw - R)
  const first = Math.min(wallD + allowance, far)
  const reverse = outside ? climb : !climb
  const offcutIn = !outside
  const rough: Ring[][] = []
  for (const d of spaced(first, far, spacing).reverse()) {
    const r = off(d)
    if (r.isErr()) return Err(r.unwrapErr())
    const rings = ringsOf(r.unwrap(), reverse, offcutIn)
    if (rings.length > 0) rough.push(rings)
  }
  const wall = off(wallD)
  const farR = off(far)
  const firstR = off(first)
  const slug = outside ? Ok(L) : port.offset(L, sw)
  for (const r of [wall, farR, firstR, slug]) if (r.isErr()) return Err(r.unwrapErr())
  const between = (inner: Region, outer: Region) =>
    outside ? port.difference(outer, inner) : port.difference(inner, outer)
  const link = between(firstR.unwrap(), farR.unwrap())
  if (link.isErr()) return Err(link.unwrapErr())
  const free = between(wall.unwrap(), farR.unwrap())
  if (free.isErr()) return Err(free.unwrapErr())
  const wallRings = ringsOf(wall.unwrap(), reverse, offcutIn)
  const finishing = first - wallD > EPSILON && rough.length > 0
  return Ok({
    // too narrow for the allowance anywhere: rough at the wall itself (v0.1 clamps it)
    rough: rough.length > 0 ? rough : [wallRings],
    finish: finishing ? wallRings : [],
    link: link.unwrap(),
    free: free.unwrap(),
    straight: first - wallD,
    covers: !outside && slug.unwrap().pieces.length === 0,
  })
}

/** Half-width of tool-centre travel in an `on` slot; slightly negative within the fit tolerance. */
function onEdge(R: number, sw: number): number {
  return Math.max(0, sw / 2 - R)
}

/**
 * `on` a closed loop: the centreline ring, then pairs of rings at ±d (inner side: offset +d,
 * outer side: −d) out to the walls less the allowance; finishing rings at both walls. The inner
 * side runs as an outside profile of the loop (the island is the part), the outer side as an
 * inside profile; the centreline as the inner side.
 */
function onLoopPasses(
  port: Region2dPort,
  L: Region,
  R: number,
  sw: number,
  allowance: number,
  spacing: number,
  climb: boolean,
): AppResult<Passes> {
  const edge = onEdge(R, sw)
  const roughEdge = Math.max(0, edge - allowance)
  const pair = (d: number): AppResult<Ring[]> => {
    const inner = port.offset(L, d)
    if (inner.isErr()) return Err(inner.unwrapErr())
    const outer = port.offset(L, -d)
    if (outer.isErr()) return Err(outer.unwrapErr())
    return Ok([...ringsOf(inner.unwrap(), climb, false), ...ringsOf(outer.unwrap(), !climb, true)])
  }
  const band = (d: number): AppResult<Region> => {
    if (d <= EPSILON) return Ok(EMPTY)
    const outer = port.offset(L, -d)
    if (outer.isErr()) return Err(outer.unwrapErr())
    const inner = port.offset(L, d)
    if (inner.isErr()) return Err(inner.unwrapErr())
    return port.difference(outer.unwrap(), inner.unwrap())
  }
  const rough: Ring[][] = [ringsOf(L, climb, false)]
  for (const d of spaced(0, roughEdge, spacing).slice(1)) {
    const r = pair(d)
    if (r.isErr()) return Err(r.unwrapErr())
    if (r.unwrap().length > 0) rough.push(r.unwrap())
  }
  const link = band(roughEdge)
  if (link.isErr()) return Err(link.unwrapErr())
  const free = band(edge)
  if (free.isErr()) return Err(free.unwrapErr())
  let finish: Ring[] = []
  if (edge - roughEdge > EPSILON) {
    const r = pair(edge)
    if (r.isErr()) return Err(r.unwrapErr())
    finish = r.unwrap()
  }
  return Ok({
    rough,
    finish,
    link: link.unwrap(),
    free: free.unwrap(),
    straight: edge - roughEdge,
    covers: false,
  })
}

/**
 * `on` an open path: the centreline zigzag by level (T-E), then closed rings round the path
 * (`offsetPath` by d) out to the walls less the allowance, and the finishing ring(s) of the band
 * at the walls. The walls lie outside the band region, so its rings run as an inside profile.
 */
function onPathPasses(
  port: Region2dPort,
  chain: Loop,
  R: number,
  sw: number,
  allowance: number,
  spacing: number,
  climb: boolean,
): AppResult<Passes> {
  const centre: Seg[] = []
  for (const e of chain.elements) {
    const s = elementSeg(e)
    if (s !== undefined) centre.push(s)
  }
  const edge = onEdge(R, sw)
  const roughEdge = Math.max(0, edge - allowance)
  const bandOf = (d: number): AppResult<Region> =>
    d <= EPSILON ? Ok(EMPTY) : port.offsetPath(chain, d)
  const rough: Ring[][] = []
  for (const d of spaced(0, roughEdge, spacing).slice(1)) {
    const r = bandOf(d)
    if (r.isErr()) return Err(r.unwrapErr())
    const rings = ringsOf(r.unwrap(), !climb, true)
    if (rings.length > 0) rough.push(rings)
  }
  const link = bandOf(roughEdge)
  if (link.isErr()) return Err(link.unwrapErr())
  const free = bandOf(edge)
  if (free.isErr()) return Err(free.unwrapErr())
  const finish = edge - roughEdge > EPSILON ? ringsOf(free.unwrap(), !climb, true) : []
  return Ok({
    rough,
    centre,
    finish,
    link: link.unwrap(),
    free: free.unwrap(),
    straight: edge - roughEdge,
    covers: false,
  })
}

// ---------------------------------------------------------------- open-path ramp

/**
 * The first `length` mm along the open path `fwd`, turning back at its ends as often as needed
 * (`walked`), and the way back from where that ends to the path's start along the path (`back`).
 */
export function zigzag(fwd: readonly Seg[], length: number): { walked: Seg[]; back: Seg[] } {
  const total = segsLength(fwd)
  const rev = [...fwd].reverse().map(segReverse)
  const walked: Seg[] = []
  let left = length
  let forward = true
  for (;;) {
    const leg = forward ? fwd : rev
    if (left <= total + 1e-9) {
      walked.push(...walkRing(leg, Math.min(left, total)).walked)
      const t = forward ? Math.min(left, total) : total - Math.min(left, total)
      const back = t > 1e-9 ? walkRing(fwd, t).walked.reverse().map(segReverse) : []
      return { walked, back }
    }
    walked.push(...leg)
    left -= total
    forward = !forward
  }
}

// ---------------------------------------------------------------- leads

interface Lead {
  readonly start: Vec2
  readonly leadIn: Seg[]
  readonly ring: Seg[]
  readonly leadOut: Seg[]
}

/** Unit tangent at the end of a piece. */
const tangentEnd = (s: Seg): Vec2 => {
  const t = tangentAt(segReverse(s))
  return [-t[0], -t[1]]
}

/**
 * Lead-in and lead-out of the finishing ring `ring` (closed, from its start): quarter-circle arcs
 * of `leadRadius` (then ½, ¼) tangent to the ring on its offcut side, if both stay in `free` (the
 * slot's tool-centre region, sampled); else straight leads of `straight` along the normal (v0.1:
 * from the part-side rough pass), else none.
 */
export function profileLead(
  port: Region2dPort,
  ring: Seg[],
  offcutLeft: boolean,
  leadRadius: number,
  free: Region,
  straight: number,
): Lead {
  const P = ringStart(ring)
  const t0 = tangentAt(ring[0]!)
  const t1 = tangentEnd(ring.at(-1)!)
  const side = offcutLeft ? 1 : -1
  const normal = (t: Vec2): Vec2 => [-t[1] * side, t[0] * side]
  const n0 = normal(t0)
  const n1 = normal(t1)
  const inFree = (s: Seg) => {
    for (let k = 1; k <= LEAD_SAMPLES; k++)
      if (!port.contains(free, segPoint(s, k / LEAD_SAMPLES))) return false
    return true
  }
  if (leadRadius > EPSILON && free.pieces.length > 0)
    for (const f of LEAD_FRACTIONS) {
      const r = leadRadius * f
      const sweep = (side * Math.PI) / 2
      const c0: Vec2 = [P[0] + r * n0[0], P[1] + r * n0[1]]
      const S: Vec2 = [c0[0] - r * t0[0], c0[1] - r * t0[1]]
      const leadIn: Seg = {
        kind: 'arc',
        center: c0,
        radius: r,
        start: Math.atan2(S[1] - c0[1], S[0] - c0[0]),
        sweep,
      }
      const c1: Vec2 = [P[0] + r * n1[0], P[1] + r * n1[1]]
      const leadOut: Seg = {
        kind: 'arc',
        center: c1,
        radius: r,
        start: Math.atan2(P[1] - c1[1], P[0] - c1[0]),
        sweep,
      }
      if (inFree(segReverse(leadIn)) && inFree(leadOut))
        return { start: S, leadIn: [leadIn], ring, leadOut: [leadOut] }
    }
  if (straight > EPSILON) {
    const L: Vec2 = [P[0] + straight * n0[0], P[1] + straight * n0[1]]
    const seg: Seg = { kind: 'line', from: P, to: L }
    if (free.pieces.length > 0 && inFree(seg))
      return { start: L, leadIn: [{ kind: 'line', from: L, to: P }], ring, leadOut: [seg] }
  }
  return { start: P, leadIn: [], ring, leadOut: [] }
}
