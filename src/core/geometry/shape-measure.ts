/**
 * Measures of a shape operation for the parameter DFM checks and the tool fit (v0.3 K4): the
 * inside corners of the cut, whether a tool radius fits the region (the region eroded by it is
 * not empty), the region's narrowest width, and the rest material a tool leaves. Pure and
 * headless; the 2D port is passed in. Measures are cached per port, per region (in the shape's
 * own frame, so moving a shape keeps them) and per tool radius.
 * Doc: docs/architecture/shapes.md#parameter-checks-for-shapes,
 * docs/modes/design-v0.3.md#dfm-checks-for-shapes
 */
import { Ok, type AppResult } from '../../shared/result'
import { elementPointAt } from './2d/measure'
import {
  arcRadius,
  arcSweep,
  chainBounds,
  regionLoops,
  type Bounds2,
  type Loop,
  type Region,
} from './2d/model'
import type { Region2dPort } from './2d/port'
import { translateRegion } from './2d/place'
import { findRestMaterial, type RestPiece } from './2d/rest-material'
import type { OperationGeometry, StockGeometry, Vec2 } from './model'
import { ON_EDGE, openReach, openRegion, opensStock } from './open-sides'
import { pocketRegion, profileChain, shapeOutline } from './outline'

/**
 * A vertex is a sharp corner when its elements turn by more than this (rad, 5°): a smaller kink
 * leaves under 0.006 mm of material with a Ø12 mm tool (R (1 / cos(turn / 2) − 1)), so the
 * tangent joins of fitted curves (SVG biarcs) are not corners.
 */
export const CORNER_MIN_TURN = (5 * Math.PI) / 180

/** One inside corner of the cut, in the shape's frame (relative to `Shape.center`). */
export interface InsideCorner {
  /** The vertex, or the middle of the arc. */
  readonly at: Vec2
  /** 0 for a sharp vertex, else the arc's radius. */
  readonly radius: number
  /**
   * How far from `at` a tool of radius r leaves material, per unit r (≥ 1): the tangent points
   * of the tool in the corner lie r · tan(turn / 2) from a sharp vertex (r for 90°; turns capped
   * at `SPREAD_MAX_TURN`), an arc adds its offset from that vertex. DF53's open corners.
   */
  readonly spread: number
}

/** Turns above this (rad, 170°) count as this for `InsideCorner.spread` (a slot end). */
const SPREAD_MAX_TURN = (170 * Math.PI) / 180

const spreadOf = (turn: number): number => {
  const t = Math.min(Math.abs(turn), SPREAD_MAX_TURN) / 2
  return Math.max(1, Math.tan(t))
}

/**
 * Whether the leftover a tool of radius `r` leaves in corner `c` lies wholly beyond the stock:
 * its point, placed by the shape's `center` in the face frame, lies at least `r · spread`
 * outside the face rectangle of `face` (the local stock; `r` 0: just outside it). Such a corner
 * leaves material only in air, so it is not a wall corner (hardening DF53).
 * Doc: docs/modes/design-v0.3.md#dfm-checks-for-shapes
 */
export function openCorner(
  c: InsideCorner,
  center: readonly [number, number],
  face: Pick<StockGeometry, 'length' | 'width'>,
  r: number,
): boolean {
  const u = c.at[0] + center[0]
  const v = c.at[1] + center[1]
  const du = Math.max(-u, 0, u - face.length)
  const dv = Math.max(-v, 0, v - face.width)
  const outside = Math.hypot(du, dv)
  return outside > OPEN_EPSILON && outside >= r * c.spread - OPEN_EPSILON
}

const OPEN_EPSILON = 1e-6

/** The corners of `m` that are walls for a tool of radius `r` (not `openCorner`). */
export function wallCorners(
  m: ShapeMeasure,
  center: readonly [number, number],
  face: Pick<StockGeometry, 'length' | 'width'>,
  r: number,
): InsideCorner[] {
  return m.corners.filter((c) => !openCorner(c, center, face, r))
}

/** The smallest radius of the wall corners for a tool of radius `r`; Infinity without any. */
export function smallestWallCorner(
  m: ShapeMeasure,
  center: readonly [number, number],
  face: Pick<StockGeometry, 'length' | 'width'>,
  r: number,
): number {
  if (m.corners.length === 0) return Infinity
  return wallCorners(m, center, face, r).reduce((s, c) => Math.min(s, c.radius), Infinity)
}

/** Which side of the loops the tool works on. */
export type CutSide = 'pocket' | 'inside' | 'outside'

/** The measures of one shape operation (`pocket`, or a profile `inside` / `outside`). */
export interface ShapeMeasure {
  readonly side: CutSide
  /** Every inside corner of the cut (sharp vertices and arcs of the cut's sense), loop order. */
  readonly corners: readonly InsideCorner[]
  /** The smallest corner radius (0 with a sharp corner); Infinity without corners. */
  readonly smallestCornerRadius: number
  /** Exact bounds of the shape's loops in the shape's frame. */
  readonly bounds: Bounds2
  /**
   * Whether a tool of radius `r` fits the region somewhere (the region offset inward by `r` is
   * not empty). Profiles: the loop's interior (`inside`) or always true (`outside`).
   */
  fits(r: number): boolean
  /** Twice the largest inscribed radius (mm, within 0.001 mm): the region's narrowest width. */
  narrowest(): number
  /** Rest material a tool of radius `r` leaves away from corners (pieces in the shape's frame). */
  rest(r: number): readonly RestPiece[]
}

/** Width and rest-material checks run this much below the tool radius (`TOOL_MATCH_TOLERANCE` / 2). */
export const FIT_SLACK = 0.005

const NARROWEST_PRECISION = 0.001
const CACHE_SIZE = 64

interface Entry {
  readonly measure: ShapeMeasure
}

const caches = new WeakMap<Region2dPort, Map<string, Entry>>()
const byGeometry = new WeakMap<OperationGeometry, ShapeMeasure | null>()

/**
 * The measures of a pocket or profile, or undefined when it has none (an `on` groove, a facing
 * or drilling). Analytic contours are measured too (callers keep their v0.1 rules for them).
 * A port failure leaves the affected answer at its harmless side (fits, no rest material): the
 * region already resolved and normalised, so it is a library fault the evaluation reports.
 * With `face` (the local stock of the operation's direction) a pocket that reaches the stock edge
 * is measured with its open sides (DF61, `openMeasure`).
 */
export function shapeMeasure(
  port: Region2dPort,
  op: OperationGeometry,
  face?: Pick<StockGeometry, 'length' | 'width'>,
): ShapeMeasure | undefined {
  if (op.kind !== 'pocket' && op.kind !== 'profile') return undefined
  let m: ShapeMeasure | undefined
  const known = byGeometry.get(op)
  if (known !== undefined) m = known ?? undefined
  else {
    m = measureOf(port, op)
    byGeometry.set(op, m ?? null)
  }
  if (m === undefined || face === undefined || op.kind !== 'pocket') return m
  let byFace = openByGeometry.get(op)
  if (byFace === undefined) openByGeometry.set(op, (byFace = new Map()))
  const key = `${face.length}×${face.width}`
  if (!byFace.has(key)) {
    const placed = pocketRegion(op).region
    byFace.set(key, opensStock(port, placed, face) ? openMeasure(port, m, op, face) : m)
  }
  return byFace.get(key)
}

const openByGeometry = new WeakMap<OperationGeometry, Map<string, ShapeMeasure>>()

/**
 * The measures of a pocket with open sides (DF61): the tool enters from beyond the stock edge,
 * so every tool fits (`fits` true, `narrowest` Infinity, as for an outside profile), and the rest
 * material is what the tool leaves of the open region (`openRegion` with `openReach`) inside the
 * stock face. Corners on the stock edge or beyond it are dropped (the tool reaches them from
 * outside; DF53's `openCorner` already drops those far enough outside); bounds stay the shape's.
 */
function openMeasure(
  port: Region2dPort,
  base: ShapeMeasure,
  op: Extract<OperationGeometry, { kind: 'pocket' }>,
  face: Pick<StockGeometry, 'length' | 'width'>,
): ShapeMeasure {
  const restMemo = new Map<number, readonly RestPiece[]>()
  const [cu, cv] = op.shape.center
  const inFace = (p: Vec2) => p[0] >= 0 && p[0] <= face.length && p[1] >= 0 && p[1] <= face.width
  // a corner on the stock edge (or beyond it) is reached from outside the stock
  const inside = (c: InsideCorner) => {
    const u = c.at[0] + cu
    const v = c.at[1] + cv
    return Math.min(u, v, face.length - u, face.width - v) > ON_EDGE
  }
  const corners = base.corners.filter(inside)
  return {
    ...base,
    corners,
    smallestCornerRadius: corners.reduce((m, c) => Math.min(m, c.radius), Infinity),
    fits: () => true,
    narrowest: () => Infinity,
    rest(r: number) {
      const known = restMemo.get(r)
      if (known !== undefined) return known
      const pieces = openRegion(port, pocketRegion(op).region, face, openReach(r, 0))
        .andThen((open) => findRestMaterial(port, open, r))
        .unwrapOr([])
        .filter((p) => inFace(p.at))
        .map((p): RestPiece => ({ area: p.area, at: [p.at[0] - cu, p.at[1] - cv] }))
      restMemo.set(r, pieces)
      return pieces
    },
  }
}

function measureOf(
  port: Region2dPort,
  op: Extract<OperationGeometry, { kind: 'pocket' | 'profile' }>,
): ShapeMeasure | undefined {
  const side: CutSide | undefined =
    op.kind === 'pocket' ? 'pocket' : op.side === 'on' ? undefined : op.side
  if (side === undefined) return undefined
  // in the shape's own frame: the measures do not change when the shape moves
  const local = { ...op.shape, center: [0, 0] as Vec2 }
  // resolved regions are normalised already (a placed copy stays so); a profile takes one loop
  let region: Region
  if (op.kind === 'pocket') {
    const o = shapeOutline(local)
    if (o.kind !== 'region') return undefined
    region = o.region
  } else {
    const { chain, closed } = profileChain({ ...op, shape: local })
    if (!closed) return undefined
    region = { pieces: [{ outer: chain, holes: [] }] }
  }
  if (region.pieces.length === 0 || region.pieces[0]!.outer.elements.length === 0) return undefined
  const key = `${side}:${JSON.stringify(region)}`
  let cache = caches.get(port)
  if (cache === undefined) {
    cache = new Map()
    caches.set(port, cache)
  }
  const hit = cache.get(key)
  if (hit !== undefined) {
    // most recently used last
    cache.delete(key)
    cache.set(key, hit)
    return hit.measure
  }
  const m = build(port, side, region)
  if (m === undefined) return undefined
  cache.set(key, { measure: m })
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return m
}

/**
 * Regions of at least this many pieces are measured one piece per distinct geometry (patterns
 * P2: a pattern's cells are copies of one cell), see `grouped`.
 */
export const GROUP_PIECES_MIN = 8

interface PieceGroup {
  /** The piece moved to its box corner at the origin. */
  readonly region: Region
  /** The box corners of the pieces with this geometry. */
  readonly at: Vec2[]
}

/**
 * The region's pieces grouped by geometry up to translation (each moved to its box corner, the
 * key its coordinates rounded to 10⁻⁶ mm); undefined when no two pieces share one.
 */
function groupPieces(region: Region): PieceGroup[] | undefined {
  const groups = new Map<string, PieceGroup>()
  for (const piece of region.pieces) {
    const b = chainBounds(piece.outer.elements)!
    const moved = translateRegion({ pieces: [piece] }, [-b.min[0], -b.min[1]])
    const key = JSON.stringify(moved, (_k, v: unknown) =>
      typeof v === 'number' ? Math.round(v * 1e6) : v,
    )
    const g = groups.get(key)
    if (g === undefined) groups.set(key, { region: moved, at: [b.min] })
    else g.at.push(b.min)
  }
  return groups.size < region.pieces.length ? [...groups.values()] : undefined
}

/**
 * The measures of a region of many repeated pieces from one piece per geometry (patterns P2,
 * S8's tool-fit cost near 2 000 cells): erosion and opening act on disjoint pieces one by one, so
 * a tool fits the region where it fits a piece, the narrowest width is the widest piece's, and the
 * rest material is each piece's moved to every copy (largest first, as `findRestMaterial`).
 * Corners and bounds are the whole region's.
 */
function grouped(
  port: Region2dPort,
  side: CutSide,
  groups: readonly PieceGroup[],
  loops: readonly Loop[],
  bounds: Bounds2,
): ShapeMeasure | undefined {
  const measures: { m: ShapeMeasure; at: Vec2[] }[] = []
  for (const g of groups) {
    const m = build(port, side, g.region)
    if (m === undefined) return undefined
    measures.push({ m, at: g.at })
  }
  const corners = insideCorners(loops, side === 'outside' ? -1 : 1)
  const restMemo = new Map<number, readonly RestPiece[]>()
  let narrow: number | undefined
  return {
    side,
    corners,
    smallestCornerRadius: corners.reduce((m, c) => Math.min(m, c.radius), Infinity),
    bounds,
    fits: (r) => measures.some(({ m }) => m.fits(r)),
    narrowest: () => (narrow ??= Math.max(...measures.map(({ m }) => m.narrowest()))),
    rest(r) {
      const known = restMemo.get(r)
      if (known !== undefined) return known
      const pieces = measures
        .flatMap(({ m, at }) =>
          m
            .rest(r)
            .flatMap((p) =>
              at.map((o): RestPiece => ({ area: p.area, at: [p.at[0] + o[0], p.at[1] + o[1]] })),
            ),
        )
        .sort((x, y) => y.area - x.area)
      restMemo.set(r, pieces)
      return pieces
    },
  }
}

function build(port: Region2dPort, side: CutSide, region: Region): ShapeMeasure | undefined {
  const loops = regionLoops(region)
  const bounds = chainBounds(loops.flatMap((l) => l.elements))
  if (bounds === undefined) return undefined
  if (side === 'pocket' && region.pieces.length >= GROUP_PIECES_MIN) {
    const groups = groupPieces(region)
    if (groups !== undefined) return grouped(port, side, groups, loops, bounds)
  }
  const corners = insideCorners(loops, side === 'outside' ? -1 : 1)
  const smallestCornerRadius = corners.reduce((m, c) => Math.min(m, c.radius), Infinity)
  const insets = new Map<number, AppResult<Region>>()
  const restMemo = new Map<number, readonly RestPiece[]>()
  let narrow: number | undefined
  /** The region offset inward by r (the tool-centre region), shared by `fits` and `rest`. */
  const inset = (r: number): AppResult<Region> => {
    let known = insets.get(r)
    if (known === undefined) insets.set(r, (known = port.offset(region, r)))
    return known
  }
  const fits = (r: number): boolean => {
    if (side === 'outside') return true
    // monotonic: a larger radius that fits, or a smaller one that does not, answers it
    for (const [k, v] of insets) {
      if (v.isErr()) continue
      const f = v.unwrap().pieces.length > 0
      if (f && k >= r) return true
      if (!f && k <= r) return false
    }
    const inner = inset(r)
    return inner.isErr() || inner.unwrap().pieces.length > 0
  }
  // the region the tool clears for rest material: an outside profile's surroundings, wide
  // enough that only the loop's notches can trap material
  const restRegion = (r: number): AppResult<Region> => {
    if (side !== 'outside') return Ok(region)
    const grown = port.offset(region, -(2 * r + 2 * NARROWEST_PRECISION + 1))
    return grown.andThen((g) => port.difference(g, region))
  }
  return {
    side,
    corners,
    smallestCornerRadius,
    bounds,
    fits,
    narrowest() {
      if (narrow !== undefined) return narrow
      if (side === 'outside') return (narrow = Infinity)
      // the inradius lies below half the smaller side of the bounds; bisect on `fits`
      let lo = 0
      let hi = Math.min(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]) / 2
      while (hi - lo > NARROWEST_PRECISION / 2) {
        const mid = (lo + hi) / 2
        if (fits(mid)) lo = mid
        else hi = mid
      }
      return (narrow = lo + hi)
    },
    rest(r: number) {
      const known = restMemo.get(r)
      if (known !== undefined) return known
      const pieces = restRegion(r)
        .andThen((cut) => findRestMaterial(port, cut, r, side === 'outside' ? undefined : inset(r)))
        .unwrapOr([])
      restMemo.set(r, pieces)
      return pieces
    },
  }
}

/**
 * Inside corners of the cut: the region lies left of its loops; `sense` +1 for a pocket or an
 * inside profile (the tool works on the region: corners turn left, towards the region), −1 for
 * an outside profile (the tool works on the outside: the loop's concave notches turn right).
 */
export function insideCorners(loops: readonly Loop[], sense: 1 | -1): InsideCorner[] {
  const out: InsideCorner[] = []
  for (const l of loops) {
    const els = l.elements
    for (let i = 0; i < els.length; i++) {
      const e = els[i]!
      if (e.kind === 'arc' && (e.ccw ? 1 : -1) === sense) {
        // its middle lies ρ (1 / cos(sweep / 2) − 1) from the virtual vertex, and ρ < r where it
        // leaves material (a larger arc leaves nothing)
        const half = Math.min(Math.abs(arcSweep(e)), SPREAD_MAX_TURN) / 2
        out.push({
          at: elementPointAt(e, 0.5).point,
          radius: arcRadius(e),
          spread: spreadOf(arcSweep(e)) + 1 / Math.cos(half) - 1,
        })
      }
      const next = els[(i + 1) % els.length]!
      if (next === e) continue
      const tin = elementPointAt(e, 1).tangent
      const tout = elementPointAt(next, 0).tangent
      const turn = Math.atan2(
        tin[0] * tout[1] - tin[1] * tout[0],
        tin[0] * tout[0] + tin[1] * tout[1],
      )
      if (sense * turn > CORNER_MIN_TURN) out.push({ at: e.b, radius: 0, spread: spreadOf(turn) })
    }
  }
  return out
}
