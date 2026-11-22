/**
 * `Region2dPort` on the CavalierContours WASM binding, and its loaders for every host.
 * Doc: docs/architecture/shapes.md#2d-port, #where-the-2d-layer-runs
 */
import { Err, Ok, type AppResult, type AsyncAppResult } from '../../../../shared/result'
import { chainLength, chainPointAt, closestOnChains, regionContains } from '../measure'
import {
  arcRadius,
  OFFSET_EPSILON,
  regionLoops,
  reverseLoop,
  signedArea,
  type Loop,
  type Path,
  type Region,
} from '../model'
import type { Region2dPort } from '../port'
import {
  loopInside,
  normaliseLoops,
  regionDifference,
  regionIntersect,
  regionUnion,
  type LoopBoolean,
} from '../regions'
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
): AppResult<{ loop: Loop; neg: boolean }[]> {
  const loops: { loop: Loop; neg: boolean }[] = []
  for (const o of outs) {
    if (!o.closed)
      return Err(region2dError('resultInvalid', 'the 2D library returned an open loop', where))
    const l = fromWire(o, where)
    if (l.isErr()) return Err(l.unwrapErr())
    const loop = l.unwrap()
    if (Math.abs(signedArea(loop)) < SLIVER_AREA) continue
    loops.push({ loop, neg: o.neg })
  }
  return Ok(loops)
}

const orient = (l: Loop, positive: boolean): Loop =>
  signedArea(l) > 0 === positive ? l : reverseLoop(l)

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
        pos: loops.filter((l) => !l.neg).map((l) => orient(l.loop, true)),
        neg: loops.filter((l) => l.neg).map((l) => orient(l.loop, false)),
      }))
  }

  /**
   * One library call; a growth that lost an input piece is redone in steps. The library drops an
   * arc offset past zero radius and relies on its neighbours' offsets crossing; where they cross
   * beyond their ends (an opening's concave arcs, round the reflex corner they came from), the
   * loop came out empty. Doc: docs/architecture/shapes.md#implementation-k1
   */
  function offset(region: Region, d: number): AppResult<Region> {
    const where = 'region2d.offset'
    if (!Number.isFinite(d))
      return Err(region2dError('offsetInvalid', 'the offset is not finite', where, { d }))
    if (d === 0 || region.pieces.length === 0) return Ok(region)
    const once = offsetOnce(region, d, where)
    if (once.isErr() || d > 0 || keepsPieces(region, once.unwrap())) return once
    const stepped = offsetStepped(region, d, where)
    if (stepped.isErr() || keepsPieces(region, stepped.unwrap())) return stepped
    return Err(region2dError('resultInvalid', 'growing the region lost a piece', where, { d }))
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
