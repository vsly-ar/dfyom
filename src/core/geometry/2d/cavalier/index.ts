/**
 * `Region2dPort` on the CavalierContours WASM binding, and its loaders for every host.
 * Doc: docs/architecture/shapes.md#2d-port, #where-the-2d-layer-runs
 */
import type { AppError } from '../../../../shared/errors/app-error'
import { Err, Ok, type AppResult, type AsyncAppResult } from '../../../../shared/result'
import { CHORD_TOLERANCE } from '../../model'
import {
  chainLength,
  chainPointAt,
  closestOnChains,
  elementPointAt,
  regionContains,
} from '../measure'
import {
  arcRadius,
  arcSweep,
  line,
  MIN_ELEMENT_LENGTH,
  OFFSET_EPSILON,
  regionArea,
  regionLoops,
  reverseLoop,
  signedArea,
  type Loop,
  type Path,
  type Region,
} from '../model'
import type { Region2dPort } from '../port'
import {
  dropSpikes,
  isSliver,
  loopInside,
  normaliseLoops,
  regionDifference,
  regionIntersect,
  regionUnion,
  type LoopBoolean,
} from '../regions'
import { nearestIndex } from './nearest'
import { checkChain, fromWire, region2dError, toWire, type WireLoop } from '../wire'
import { loadCavalier, loadCavalierSync, type CavalierBinding, type WireOut } from './binding'

/** Result loops with a smaller |area| (mm²) are slivers of the library's epsilons, dropped. */
const SLIVER_AREA = 1e-10

/** Loads the module synchronously (dispatcher hosts, workers, the CLI, tests). */
export function loadRegion2dSync(bytes: Uint8Array | ArrayBuffer): AppResult<Region2dPort> {
  return loadCavalierSync(bytes).map(createCavalierPort)
}

/** Loads the module asynchronously (the renderer's main thread). */
export async function loadRegion2d(bytes: Uint8Array | ArrayBuffer): AsyncAppResult<Region2dPort> {
  return (await loadCavalier(bytes)).map(createCavalierPort)
}

function decodeAll(
  outs: readonly WireOut[],
  where: string,
): AppResult<{ loop: Loop; neg: boolean; area: number }[]> {
  const loops: { loop: Loop; neg: boolean; area: number }[] = []
  for (const o of outs) {
    if (!o.closed) {
      // a stray piece shorter than the chord tolerance is a slice the library failed to stitch
      // between near-coincident loops (B2); a longer one is a loop it failed to close
      const piece = fromWire(o, where)
      if (piece.isOk() && chainLength(piece.unwrap()) < CHORD_TOLERANCE) continue
      return Err(region2dError('resultInvalid', 'the 2D library returned an open loop', where))
    }
    const l = fromWire(o, where)
    if (l.isErr()) return Err(l.unwrapErr())
    // zero-width spikes and loops are the library's epsilons at work, never region boundary
    const loop = dropSpikes(straightenMicroArcs(l.unwrap()))
    const area = signedArea(loop)
    if (Math.abs(area) < SLIVER_AREA || isSliver(loop.elements, area)) continue
    loops.push({ loop, neg: o.neg, area })
  }
  return Ok(loops)
}

/**
 * Arcs of a radius under `MIN_ELEMENT_LENGTH` as their chords (the error stays below the
 * radius): the library leaves them where an offset nearly collapses an arc, and the port's input
 * check refuses arcs of a radius up to `POSITION_EPSILON`, so the result could not be offset or
 * combined again (B2).
 */
function straightenMicroArcs(l: Loop): Loop {
  if (!l.elements.some((e) => e.kind === 'arc' && arcRadius(e) < MIN_ELEMENT_LENGTH)) return l
  return {
    elements: l.elements.map((e) =>
      e.kind === 'arc' && arcRadius(e) < MIN_ELEMENT_LENGTH ? line(e.a, e.b) : e,
    ),
  }
}

const orient = (l: Loop, positive: boolean): Loop => orientBy(l, signedArea(l), positive)

/** `orient` with the loop's signed area known (`decodeAll` has it). */
const orientBy = (l: Loop, area: number, positive: boolean): Loop =>
  area > 0 === positive ? l : reverseLoop(l)

export function createCavalierPort(binding: CavalierBinding): Region2dPort {
  const loopBoolean: LoopBoolean = (a, b, op) => {
    const where = `region2d.boolean.${op}`
    const wa = toWire(a.elements, true, where)
    if (wa.isErr()) return Err(wa.unwrapErr())
    const wb = toWire(b.elements, true, where)
    if (wb.isErr()) return Err(wb.unwrapErr())
    return binding
      .boolean(wa.unwrap(), wb.unwrap(), op)
      .andThen((outs) => decodeAll(outs, where))
      .map((loops) => ({
        pos: loops.filter((l) => !l.neg).map((l) => orientBy(l.loop, l.area, true)),
        neg: loops.filter((l) => l.neg).map((l) => orientBy(l.loop, l.area, false)),
      }))
  }

  /**
   * The offset by `d`, checked (`offsetChecked`); when the library fails or its result fails the
   * checks, the same offset is retried at the radius of the arc it nearly collapses, then nudged
   * by up to `MAX_NUDGE` (`retryOffsets`): the library's failures sit at specific offsets, and
   * the result stays within the nudge of the exact one. Fails with `resultInvalid` naming the
   * offset when every try fails. Doc: docs/architecture/shapes.md#implementation-k1
   */
  function offset(region: Region, d: number): AppResult<Region> {
    const where = 'region2d.offset'
    if (!Number.isFinite(d))
      return Err(region2dError('offsetInvalid', 'the offset is not finite', where, { d }))
    if (d === 0 || region.pieces.length === 0) return Ok(region)
    const first = offsetChecked(region, d, where)
    if (first.isOk() || !retryable(first.unwrapErr())) return first
    for (const alt of retryOffsets(region, d)) {
      const r = offsetChecked(region, alt, where)
      if (r.isOk()) return r
    }
    const cause = first.unwrapErr()
    const verb = d > 0 ? 'shrinking' : 'growing'
    return Err(
      region2dError(
        'resultInvalid',
        `${verb} the region by ${formatMm(Math.abs(d))} mm failed in the 2D library (${cause.message}), also with the offset nudged by up to ${formatMm(MAX_NUDGE)} mm; change the offset or the shape slightly (e.g. by 0.01 mm) and try again`,
        where,
        { d, cause: cause.message },
      ),
    )
  }

  /**
   * One library call, then the result's checks (`offsetProblem`). A growth that lost an input
   * piece is redone in steps first: the library drops an arc offset past zero radius and relies
   * on its neighbours' offsets crossing; where they cross beyond their ends (an opening's concave
   * arcs, round the reflex corner they came from), the loop came out empty. A result that fails
   * the checks is likewise redone in steps.
   */
  function offsetChecked(region: Region, d: number, where: string): AppResult<Region> {
    let out = offsetOnce(region, d, where)
    if (out.isOk() && d < 0 && !keepsPieces(region, out.unwrap())) {
      out = offsetStepped(region, d, where)
      if (out.isOk() && !keepsPieces(region, out.unwrap()))
        return Err(region2dError('resultInvalid', 'growing the region lost a piece', where, { d }))
    }
    if (out.isErr()) return out
    const problem = offsetProblem(region, out.unwrap(), d)
    if (problem !== undefined) {
      // an offset the library got wrong past an arc's collapse (B2: a shrink drops a hole whose
      // arcs it collapses; a growth just past a flat concave arc's radius bridges the region):
      // the same offset in steps of the collapsing radii, exact as offsets compose
      const stepped = offsetStepped(region, d, where)
      if (stepped.isOk() && offsetProblem(region, stepped.unwrap(), d) === undefined) return stepped
    }
    return problem === undefined ? out : Err(region2dError('resultInvalid', problem, where, { d }))
  }

  /**
   * Offsetting by exactly an arc's radius turns it into a corner, and offsets compose (dilations
   * and erosions by discs add up), so stepping by the smallest collapsing radius first keeps every
   * arc from collapsing in a call. A last step under `MIN_FINAL_STEP` is dropped: the library
   * fails on such small offsets of the cusps the steps leave, and the error stays below its
   * offset epsilon.
   */
  function offsetStepped(region: Region, d: number, where: string): AppResult<Region> {
    const sign = Math.sign(d)
    let left = Math.abs(d)
    let cur = region
    for (let i = 0; i < MAX_OFFSET_STEPS; i++) {
      const r = smallestCollapsingRadius(cur, d > 0, left)
      if (r === undefined) break
      const step = offsetOnce(cur, sign * r, where)
      if (step.isErr()) return step
      cur = step.unwrap()
      left -= r
      if (cur.pieces.length === 0) return Ok(cur)
    }
    return left < MIN_FINAL_STEP ? Ok(cur) : offsetOnce(cur, sign * left, where)
  }

  function offsetOnce(region: Region, d: number, where: string): AppResult<Region> {
    const wires: WireLoop[] = []
    for (const p of region.pieces) {
      const outer = toWire(orient(p.outer, true).elements, true, where)
      if (outer.isErr()) return Err(outer.unwrapErr())
      wires.push(outer.unwrap())
      for (const h of p.holes) {
        const hole = toWire(orient(h, false).elements, true, where)
        if (hole.isErr()) return Err(hole.unwrapErr())
        wires.push(hole.unwrap())
      }
    }
    return binding
      .shapeOffset(wires, d)
      .andThen((outs) => decodeAll(outs, where))
      .andThen((loops) => nest(loops, where))
  }

  function offsetPath(path: Path, d: number): AppResult<Region> {
    const where = 'region2d.offsetPath'
    if (!Number.isFinite(d) || d <= 0)
      return Err(
        region2dError('offsetInvalid', 'the band half-width must be positive', where, { d }),
      )
    const w = toWire(path.elements, false, where)
    if (w.isErr()) return Err(w.unwrapErr())
    return binding
      .plineOffset(doubledBack(w.unwrap()), d)
      .andThen((outs) => decodeAll(outs, where))
      .andThen((decoded) => {
        // the band's outer boundary comes out clockwise (its holes counter-clockwise): flip all
        // so the largest loop is counter-clockwise, then nest by area
        const loops = decoded.map((l) => l.loop)
        const largest = loops.reduce<Loop | undefined>(
          (m, l) => (m === undefined || Math.abs(signedArea(l)) > Math.abs(signedArea(m)) ? l : m),
          undefined,
        )
        const flip = largest !== undefined && signedArea(largest) < 0
        return normaliseLoops(loopBoolean, flip ? loops.map(reverseLoop) : loops)
      })
  }

  /** Fast paths skip the library, so inputs are checked up front (cheap next to a boolean). */
  const checked = <T>(
    where: string,
    loops: readonly Loop[],
    run: () => AppResult<T>,
  ): AppResult<T> => {
    for (const l of loops) {
      const c = checkChain(l.elements, true, where)
      if (c.isErr()) return Err(c.unwrapErr())
    }
    return run()
  }

  return {
    normalise: (loops) =>
      checked('region2d.normalise', loops, () => normaliseLoops(loopBoolean, loops)),
    union: (a, b) =>
      checked('region2d.union', [...regionLoops(a), ...regionLoops(b)], () =>
        regionUnion(loopBoolean, a, b),
      ),
    difference: (a, b) =>
      checked('region2d.difference', [...regionLoops(a), ...regionLoops(b)], () =>
        regionDifference(loopBoolean, a, b),
      ),
    intersect: (a, b) =>
      checked('region2d.intersect', [...regionLoops(a), ...regionLoops(b)], () =>
        regionIntersect(loopBoolean, a, b),
      ),
    offset,
    offsetPath,
    length: chainLength,
    pointAt: chainPointAt,
    contains: regionContains,
    distance: closestOnChains,
  }
}

/**
 * An open polyline traversed forward and back as one closed (zero-area) polyline: its offset is
 * the band around the path with round ends (the 180° turns at both ends become arcs).
 */
function doubledBack(w: WireLoop): WireLoop {
  const n = w.v.length / 3
  const v: number[] = []
  for (let i = 0; i < n - 1; i++) v.push(w.v[3 * i]!, w.v[3 * i + 1]!, w.v[3 * i + 2]!)
  for (let i = n - 1; i >= 1; i--) v.push(w.v[3 * i]!, w.v[3 * i + 1]!, -w.v[3 * (i - 1) + 2]!)
  return { closed: true, v }
}

/**
 * Offset steps before the rest goes in one call (each step removes every arc of the smallest
 * collapsing radius, so this is the number of distinct radii; beyond it the library decides).
 */
const MAX_OFFSET_STEPS = 32
/** Arcs of a smaller radius (mm) are left to the library (after a step they are corners). */
const MIN_COLLAPSE_RADIUS = OFFSET_EPSILON
/** An arc collapses when its radius is below the offset by more than this (mm); the library's is 1e-8. */
const COLLAPSE_EPSILON = 1e-9
/** A last offset step below this (mm) is dropped (`offsetStepped`). */
const MIN_FINAL_STEP = OFFSET_EPSILON

/**
 * Whether a grown region still holds every piece of `input`: a growth contains its input, so
 * a point of each outer loop must lie in it (the library's failure loses whole loops).
 */
function keepsPieces(input: Region, grown: Region): boolean {
  return input.pieces.every((p) => {
    const e = p.outer.elements[0]
    return e === undefined || regionContains(grown, e.a)
  })
}

/**
 * The smallest radius of an arc that an offset by `left` (shrinking when `shrink`) takes past
 * zero, if any. With the region's interior on the left of every loop (outer loops
 * counter-clockwise, holes clockwise), shrinking reduces the counter-clockwise arcs' radii and
 * growing the clockwise ones'.
 */
function smallestCollapsingRadius(
  region: Region,
  shrink: boolean,
  left: number,
): number | undefined {
  let min: number | undefined
  const visit = (l: Loop) => {
    for (const e of l.elements) {
      if (e.kind !== 'arc' || e.ccw !== shrink) continue
      const r = arcRadius(e)
      if (r > MIN_COLLAPSE_RADIUS && r < left - COLLAPSE_EPSILON && (min === undefined || r < min))
        min = r
    }
  }
  for (const p of region.pieces) {
    visit(orient(p.outer, true))
    for (const h of p.holes) visit(orient(h, false))
  }
  return min
}

/**
 * Offsets within this distance (mm) of the radius of an arc they collapse, or whose offset of
 * that arc is shorter than this (flat arcs: the band widens as the sweep shrinks), are where the
 * library fails or returns wrong loops (B2: open loops, crossing pieces, loops far from the
 * offset), so results there get the offset oracle.
 */
const NEAR_COLLAPSE = 2e-3
/**
 * An offset this close (mm) to an arc's radius collapses it exactly, which the library handles
 * unless the arc is flat (an opening regrows by the radius of the arcs its shrink made: float
 * noise only); the failures start at about 1e-8 mm, and skipping the oracle here keeps openings
 * within their budget.
 */
const EXACT_COLLAPSE = 1e-9
/** Arcs of a smaller sweep (rad) fail even at their exact collapse (a 4444 mm radius, B2). */
const FLAT_SWEEP = 0.01
/** The largest change of the offset a retry makes (mm), below the 0.01 mm chord tolerance. */
const MAX_NUDGE = 2e-3
/** Nudges of a retry after the collapse radius, larger |d| first (mm). */
const NUDGES = [1e-4, -1e-4, 5e-4, -5e-4, MAX_NUDGE, -MAX_NUDGE] as const
/** Largest allowed distance error of a result point (mm) under the offset oracle. */
const ORACLE_TOLERANCE = 1e-3
/** Oracle samples per result element (inside it: its ends are its neighbours' too). */
const ORACLE_SAMPLES = [0.25, 0.5, 0.75] as const

/** Failures of the library or its result are retried; refused input is not. */
const retryable = (e: AppError): boolean =>
  e.issues.some((i) => i.rule === 'resultInvalid' || i.rule === 'kernel')

const formatMm = (v: number): string => String(Number(v.toPrecision(6)))

/**
 * The radius nearest `|d|` of an arc that an offset by `d` nearly collapses (`NEAR_COLLAPSE`), if
 * any. With the interior on the left of every loop, shrinking reduces the counter-clockwise
 * arcs' radii and growing the clockwise ones'.
 */
function nearCollapseRadius(region: Region, d: number): number | undefined {
  const shrink = d > 0
  const a = Math.abs(d)
  let best: number | undefined
  const visit = (l: Loop) => {
    for (const e of l.elements) {
      if (e.kind !== 'arc' || e.ccw !== shrink) continue
      const r = arcRadius(e)
      const diff = Math.abs(a - r)
      const sweep = Math.abs(arcSweep(e))
      const exact = diff <= EXACT_COLLAPSE && sweep >= FLAT_SWEEP
      const near = !exact && (diff <= NEAR_COLLAPSE || diff * sweep <= NEAR_COLLAPSE)
      if (near && (best === undefined || diff < Math.abs(a - best))) best = r
    }
  }
  for (const p of region.pieces) {
    visit(orient(p.outer, true))
    for (const h of p.holes) visit(orient(h, false))
  }
  return best
}

/** Offsets to retry a failed offset by `d` with: the near collapse radius (within `MAX_NUDGE`), then the nudges. */
function retryOffsets(region: Region, d: number): number[] {
  const sign = Math.sign(d)
  const out: number[] = []
  const r = nearCollapseRadius(region, d)
  if (r !== undefined && sign * r !== d && Math.abs(Math.abs(d) - r) <= MAX_NUDGE)
    out.push(sign * r)
  for (const n of NUDGES) {
    const alt = d + sign * n
    if (Math.sign(alt) === sign) out.push(alt)
  }
  return out
}

/**
 * Why an offset result is wrong, if it is: a growth smaller than its input or a shrink larger, or
 * a shrink covering a point of an input loop;
 * near a collapse (`NEAR_COLLAPSE`) also the offset oracle both ways, which every exact offset
 * meets: each result point lies exactly |d| from the input boundary, and each input boundary
 * point lies at least |d| − tolerance from the result boundary, inside a growth and outside a
 * shrink (this catches loops or pieces the library lost).
 */
function offsetProblem(input: Region, out: Region, d: number): string | undefined {
  const a0 = regionArea(input)
  const a1 = regionArea(out)
  const slack = 1e-9 * Math.max(1, Math.abs(a0))
  if (d < 0 ? a1 < a0 - slack : a1 > a0 + slack)
    return d < 0 ? 'the grown region is smaller' : 'the shrunk region is larger'
  // a shrink lies inside its input, away from its boundary: a point of each input loop lies
  // outside it (the library drops holes whose arcs a shrink collapses, B2)
  if (d > 0 && out.pieces.length > 0)
    for (const l of regionLoops(input)) {
      const e = l.elements[0]
      if (e !== undefined && regionContains(out, elementPointAt(e, 0.5).point))
        return 'the shrunk region covers part of the input boundary'
    }
  if (nearCollapseRadius(input, d) === undefined) return undefined
  const want = Math.abs(d)
  const inLoops = regionLoops(input)
  const outLoops = regionLoops(out)
  const nearIn = nearestIndex(inLoops)
  for (const l of outLoops)
    for (const e of l.elements)
      for (const t of ORACLE_SAMPLES) {
        const dist = nearIn.within(elementPointAt(e, t).point, want + ORACLE_TOLERANCE)
        if (Math.abs(dist - want) > ORACLE_TOLERANCE)
          return 'a result loop lies off the offset distance'
      }
  if (out.pieces.length === 0 || want <= ORACLE_TOLERANCE) return undefined
  // no input point comes near the result boundary, so each input loop lies on one side of it
  const nearOut = nearestIndex(outLoops)
  for (const l of inLoops)
    for (const e of l.elements)
      for (const t of ORACLE_SAMPLES)
        if (nearOut.within(elementPointAt(e, t).point, want - ORACLE_TOLERANCE) < Infinity)
          return 'the result boundary comes too close to the input'
  for (const l of inLoops) {
    const e = l.elements[0]
    if (e !== undefined && regionContains(out, elementPointAt(e, 0.5).point) !== d < 0)
      return d < 0
        ? 'the grown region misses part of the input'
        : 'the shrunk region reaches the input'
  }
  return undefined
}

/** Offset loops (counter-clockwise outer, clockwise holes) to pieces: each hole into the smallest outer around it. */
function nest(loops: readonly { loop: Loop; neg: boolean }[], where: string): AppResult<Region> {
  const outers = loops.filter((l) => !l.neg).map((l) => l.loop)
  const holes = loops.filter((l) => l.neg).map((l) => l.loop)
  for (const o of outers)
    if (signedArea(o) <= 0)
      return Err(region2dError('resultInvalid', 'an offset outer loop is clockwise', where))
  const pieces = outers.map((outer) => ({ outer, holes: [] as Loop[] }))
  for (const h of holes) {
    if (signedArea(h) >= 0)
      return Err(region2dError('resultInvalid', 'an offset hole is counter-clockwise', where))
    let best: { outer: Loop; holes: Loop[] } | undefined
    for (const p of pieces)
      if (
        loopInside(h, p.outer) &&
        (best === undefined || signedArea(p.outer) < signedArea(best.outer))
      )
        best = p
    if (best === undefined)
      return Err(region2dError('resultInvalid', 'an offset hole lies in no outer loop', where))
    best.holes.push(h)
  }
  return Ok({ pieces })
}
