/**
 * The findings of an edge chamfer (E3) from 2D offsets of its edge, through the 2D port:
 * - `chamferMeets`: material beside the chamfered loops narrower than 2 × width (a tooth, an island,
 *   a wall between two loops): the bevels from both sides meet in a ridge and the top face goes.
 *   The material within 2w + 1 of the edge, rest material of a disc of radius w (corners left out,
 *   they are mitres); the wall's width by bisecting that radius.
 * - `chamferIncomplete`: air beside the edge narrower than the tool's tip (a neck, a narrow notch
 *   round an outline): the tip's axis region (the air shrunk by dt/2) stays farther than dt/2 from
 *   part of the edge, so that part is chamfered narrower than asked or not at all. Gated by the
 *   air's rest material for the tip radius, then measured by sampling the edge every 0.5 mm.
 * Both are in the face frame, sharp inside corners left out (`cornerZones`: `dfm.cornerSharp`
 * covers them), on a split piece only within its cell. A port failure gives no finding (the
 * harmless side; the evaluation reports the port fault). Pure.
 * Doc: docs/modes/edge-chamfers.md#dfm-findings, docs/modes/edge-chamfers.md#implementation-e3
 */
import { Ok, type AppResult } from '../../shared/result'
import { chainSampler, closestOnChains } from './2d/measure'
import { regionLoops, type Loop, type Region } from './2d/model'
import type { Region2dPort } from './2d/port'
import { cornerZones, findRestMaterial, type RestPiece } from './2d/rest-material'
import type { LoopChamferGeometry, Vec2 } from './model'
import { loopChamferRegion } from './outline'

/** Widths and tips are checked this much below their size (`FIT_SLACK`): equal is no finding. */
const SLACK = 0.005
/** The edge is sampled this often (mm) for the part a tip does not reach. */
const SAMPLE_STEP = 0.5
/** An edge point farther than the tip radius plus this (mm) from the tip's axis is not reached. */
const REACH_TOLERANCE = 0.01
/** The wall width is bisected to this (mm). */
const WALL_PRECISION = 0.01
/** Markers listed at most. */
const POINTS_MAX = 10
const CACHE_SIZE = 32

/** The material between chamfered loops is narrower than 2 × width. */
export interface ChamferMeet {
  /** The largest piece's marker, face frame. */
  readonly at: Vec2
  /** Every piece's marker (flat u, v pairs), largest first. */
  readonly points: readonly number[]
  /** The narrowest material width there (mm, within 0.01): the widest bevel that keeps a top. */
  readonly wall: number
}

/** Part of the edge the tip does not reach. */
export interface ChamferMiss {
  /** Edge length not reached (mm, to the 0.5 mm sampling). */
  readonly length: number
  /** The middle of the longest stretch, face frame. */
  readonly at: Vec2
  /** Each stretch's middle (flat u, v pairs), longest first. */
  readonly points: readonly number[]
}

type Op = Pick<LoopChamferGeometry, 'edge' | 'width'>

const caches = new WeakMap<Region2dPort, Map<string, unknown>>()

function cached<T>(port: Region2dPort, key: string, make: () => T): T {
  let cache = caches.get(port)
  if (cache === undefined) caches.set(port, (cache = new Map()))
  if (cache.has(key)) {
    const hit = cache.get(key) as T
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const v = make()
  cache.set(key, v)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return v
}

/** In the split piece's cell (no `within`: everywhere). */
const inCell = (op: Op, p: Vec2): boolean => {
  const w = op.edge.within
  return (
    w === undefined ||
    (p[0] >= w.min[0] - 1e-6 &&
      p[0] <= w.max[0] + 1e-6 &&
      p[1] >= w.min[1] - 1e-6 &&
      p[1] <= w.max[1] + 1e-6)
  )
}

/** The air beside the edge, at least `t` wide round an outside edge (a band round the part). */
function airAround(op: Op, port: Region2dPort, t: number): AppResult<Region> {
  const r = loopChamferRegion(op)
  if (op.edge.side === 'inside') return Ok(r)
  return port.offset(r, -t).andThen((g) => port.difference(g, r))
}

/** The material within `t` of the edge. */
function materialAround(op: Op, port: Region2dPort, t: number): AppResult<Region> {
  const r = loopChamferRegion(op)
  if (op.edge.side === 'inside') return port.offset(r, -t).andThen((g) => port.difference(g, r))
  return port.offset(r, t).andThen((s) => port.difference(r, s))
}

/**
 * `chamferMeets`: undefined when every bit of material beside the loops is at least 2 × width
 * wide (or the port fails).
 */
export function chamferMeets(op: Op, port: Region2dPort): ChamferMeet | undefined {
  const w = op.width
  if (!(w > SLACK)) return undefined
  const key = JSON.stringify(['meets', op.edge, w])
  return cached(port, key, () => {
    const band = materialAround(op, port, 2 * w + 1)
    if (band.isErr()) return undefined
    const rest = (r: number): RestPiece[] =>
      findRestMaterial(port, band.unwrap(), r)
        .unwrapOr([])
        .filter((p) => inCell(op, p.at))
    const pieces = rest(w - SLACK)
    if (pieces.length === 0) return undefined
    // the widest disc that still fits everywhere: half the narrowest wall
    let lo = 0
    let hi = w - SLACK
    while (hi - lo > WALL_PRECISION / 2) {
      const mid = (lo + hi) / 2
      if (rest(mid).length === 0) lo = mid
      else hi = mid
    }
    return {
      at: pieces[0]!.at,
      points: pieces.slice(0, POINTS_MAX).flatMap((p) => [p.at[0], p.at[1]]),
      wall: 2 * lo,
    }
  })
}

/**
 * `chamferIncomplete` for a tip of Ø `tip`: undefined when the tip's axis comes within its radius
 * of the whole edge (sharp inside corners aside), for a pointed tool, or when the port fails.
 */
export function chamferIncomplete(
  op: Op,
  port: Region2dPort,
  tip: number,
): ChamferMiss | undefined {
  const r = tip / 2
  if (!(r > SLACK)) return undefined
  const key = JSON.stringify(['incomplete', op.edge, op.width, tip])
  return cached(port, key, () => {
    const air = airAround(op, port, tip + 2 * op.width + 1)
    if (air.isErr()) return undefined
    // the cheap gate: nothing of the air beyond the tip's reach but its corners
    const rest = findRestMaterial(port, air.unwrap(), r - SLACK).unwrapOr([])
    if (!rest.some((p) => inCell(op, p.at))) return undefined
    const axis = port.offset(air.unwrap(), r)
    if (axis.isErr()) return undefined
    const axisLoops = regionLoops(axis.unwrap())
    const zones = cornerZones(air.unwrap(), r)
      .map((z) => z.elements[0])
      .flatMap((e) =>
        e?.kind === 'arc'
          ? [{ c: e.centre, r: Math.hypot(e.a[0] - e.centre[0], e.a[1] - e.centre[1]) }]
          : [],
      )
    const reached = (p: Vec2): boolean => {
      if (!inCell(op, p)) return true
      if (zones.some((z) => Math.hypot(p[0] - z.c[0], p[1] - z.c[1]) <= z.r)) return true
      const d = closestOnChains(axisLoops, p)
      return d !== undefined && d.distance <= r + REACH_TOLERANCE
    }
    const stretches: { length: number; at: Vec2 }[] = []
    for (const loop of edgeLoops(op)) stretches.push(...missing(loop, port, reached))
    if (stretches.length === 0) return undefined
    stretches.sort((a, b) => b.length - a.length)
    return {
      length: stretches.reduce((s, x) => s + x.length, 0),
      at: stretches[0]!.at,
      points: stretches.slice(0, POINTS_MAX).flatMap((s) => [s.at[0], s.at[1]]),
    }
  })
}

/** The chamfered loops (an outside edge: the part's outline only). */
const edgeLoops = (op: Op): Loop[] => regionLoops(loopChamferRegion(op))

/** The stretches of a closed loop whose samples are not reached: length and middle. */
function missing(
  loop: Loop,
  port: Region2dPort,
  reached: (p: Vec2) => boolean,
): { length: number; at: Vec2 }[] {
  const total = port.length(loop)
  if (!(total > 0)) return []
  const n = Math.max(4, Math.ceil(total / SAMPLE_STEP))
  const step = total / n
  const at = chainSampler(loop, true)
  const points: Vec2[] = []
  const miss: boolean[] = []
  for (let i = 0; i < n; i++) {
    const p = at((i + 0.5) * step)
    if (p.isErr()) return []
    points.push(p.unwrap().point)
    miss.push(!reached(p.unwrap().point))
  }
  if (miss.every((m) => m)) return [{ length: total, at: points[Math.floor(n / 2)]! }]
  // start after a reached sample, so no stretch wraps round the loop's start
  const first = miss.findIndex((m) => !m)
  const out: { length: number; at: Vec2 }[] = []
  let run: number[] = []
  for (let k = 1; k <= n; k++) {
    const i = (first + k) % n
    if (miss[i]) run.push(i)
    else {
      // one sample alone is the tolerance at a zone's rim, not a stretch
      if (run.length > 1)
        out.push({ length: run.length * step, at: points[run[Math.floor(run.length / 2)]!]! })
      run = []
    }
  }
  return out
}
