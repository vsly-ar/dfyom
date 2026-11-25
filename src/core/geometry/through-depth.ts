/**
 * Through depths after earlier setups (hardening DF50, drillings DF61): how deep a through
 * profile or through drilling has to cut when facings and pockets of the opposite direction,
 * machined in an earlier setup, already removed material under its whole slot or hole. The
 * geometry evaluation (tabs, `dfm.reach`, tool fit), the toolpaths and the plan's tool checks all
 * read it from `throughDepth` of the operation. `materialBands` (DF61) uses the same model for
 * the material a cut meets, so its toolpath skips passes that lie wholly in air; since the DF61
 * follow-ups also over a pocket's partly cleared region, for drillings, and with openings (inside
 * through profiles without tabs) of earlier setups as removals.
 * Pure; pockets need the 2D port (without it only facings count).
 * Doc: docs/modes/plan-v0.2.md#material-removed-by-earlier-setups,
 * docs/modes/plan-v0.2.md#material-left-for-later-cuts-df61
 */
import { faceFrame, localStock, SETUP_ORDER, type Direction } from './face'
import type { Region2dPort } from './2d/port'
import {
  arc,
  isFullCircle,
  line,
  regionArea,
  reverseLoop,
  type Element,
  type Loop,
  type Region,
} from './2d/model'
import { EPSILON, type OperationGeometry, type StockGeometry, type Vec2, type Vec3 } from './model'
import { pocketRegion, profileChain } from './outline'

type Profile = Extract<OperationGeometry, { kind: 'profile' }>
type Drilling = Extract<OperationGeometry, { kind: 'drilling' }>
type Pocket = Extract<OperationGeometry, { kind: 'pocket' }>
/** Whether `earlier` is machined in a setup before the one of `later` (its own setup: false). */
export type RunsBefore = (earlier: OperationGeometry, later: OperationGeometry) => boolean

/**
 * The design's reading (no plan yet): the default setup order, the bottom first, the sides, the
 * top last (plan-v0.2.md decision 3), so a top profile counts what the bottom setup removed.
 */
export const defaultRunsBefore: RunsBefore = (a, b) =>
  SETUP_ORDER.indexOf(a.direction ?? '+z') < SETUP_ORDER.indexOf(b.direction ?? '+z')

/** Uncovered slot area that still counts as covered (mm²): boolean slivers along shared edges. */
const COVER_AREA = 1e-3

/** Material left below a through cut that is not worth a profile (mm): the cut keeps the stock. */
const MIN_THROUGH = 0.01

export const OPPOSITE: Readonly<Record<Direction, Direction>> = {
  '+z': '-z',
  '-z': '+z',
  '+x': '-x',
  '-x': '+x',
  '+y': '-y',
  '-y': '+y',
}

/** A profile that cuts through: no blind `on` depth. */
export const isThroughGeometry = (op: OperationGeometry): op is Profile =>
  op.kind === 'profile' && op.depth === undefined

/** A pattern's through pocket (patterns P4). */
const isThroughPocket = (op: OperationGeometry): op is Pocket =>
  op.kind === 'pocket' && op.through === true

/**
 * A through profile, a through drilling or a through pocket: what `throughDepths` measures
 * (DF50, DF61, patterns P4 follow-up).
 */
const isThroughCut = (op: OperationGeometry): op is Profile | Drilling | Pocket =>
  isThroughGeometry(op) ||
  (op.kind === 'drilling' && op.bottom.kind === 'through') ||
  isThroughPocket(op)

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/**
 * `[u, v]` of the face frame of `from` → `[u, v]` of the face frame of `to` (opposite
 * directions share their normal axis, so this is a signed swap plus a shift) and whether it keeps
 * the turning sense.
 */
export function frameMap(
  from: Direction,
  to: Direction,
  stock: StockGeometry,
): { at: (p: Vec2) => Vec2; keepsSense: boolean } {
  const a = faceFrame(from, stock)
  const b = faceFrame(to, stock)
  const d: Vec3 = [a.origin[0] - b.origin[0], a.origin[1] - b.origin[1], a.origin[2] - b.origin[2]]
  const uu = dot(a.u, b.u)
  const vu = dot(a.v, b.u)
  const uv = dot(a.u, b.v)
  const vv = dot(a.v, b.v)
  const du = dot(d, b.u)
  const dv = dot(d, b.v)
  return {
    at: (p) => [du + uu * p[0] + vu * p[1] + 0, dv + uv * p[0] + vv * p[1] + 0],
    keepsSense: uu * vv - vu * uv > 0,
  }
}

export function mapRegion(r: Region, m: ReturnType<typeof frameMap>): Region {
  const el = (e: Element): Element => {
    if (e.kind === 'line') return line(m.at(e.a), m.at(e.b))
    const a = m.at(e.a)
    return arc(a, isFullCircle(e) ? a : m.at(e.b), m.at(e.centre), m.keepsSense ? e.ccw : !e.ccw)
  }
  const loop = (l: Loop): Loop => {
    const out = { elements: l.elements.map(el) }
    return m.keepsSense ? out : reverseLoop(out)
  }
  return { pieces: r.pieces.map((p) => ({ outer: loop(p.outer), holes: p.holes.map(loop) })) }
}

export const rectangle = (length: number, width: number): Region => ({
  pieces: [
    {
      outer: {
        elements: [
          line([0, 0], [length, 0]),
          line([length, 0], [length, width]),
          line([length, width], [0, width]),
          line([0, width], [0, 0]),
        ],
      },
      holes: [],
    },
  ],
})

/**
 * The slot a profile sweeps, in its face frame, within the stock face rectangle: outside the loop
 * by the slot width, inside it, or the slot width centred on it (`on`, a closed loop or a path).
 * Undefined when the port fails (the caller then counts no pocket).
 */
export function slotRegion(
  op: Profile,
  stock: StockGeometry,
  port: Region2dPort,
): Region | undefined {
  const { chain, closed } = profileChain(op)
  if (chain.elements.length === 0) return undefined
  const s = op.slotWidth
  const local = localStock(op.direction ?? '+z', stock)
  const loop: Region = { pieces: [{ outer: chain, holes: [] }] }
  const swept = !closed
    ? port.offsetPath(chain, s / 2)
    : op.side === 'outside'
      ? port.offset(loop, -s).andThen((g) => port.difference(g, loop))
      : op.side === 'inside'
        ? port.offset(loop, s).andThen((inner) => port.difference(loop, inner))
        : port
            .offset(loop, -s / 2)
            .andThen((g) => port.offset(loop, s / 2).andThen((i) => port.difference(g, i)))
  return swept
    .andThen((r) => port.intersect(r, rectangle(local.length, local.width)))
    .mapOr(undefined, (r) => r)
}

/** The hole a drilling makes, in its face frame, within the stock face rectangle. */
export function holeRegion(
  op: Drilling,
  stock: StockGeometry,
  port: Region2dPort,
): Region | undefined {
  const r = op.diameter / 2
  const a: Vec2 = [op.center[0] + r, op.center[1]]
  const disc: Region = {
    pieces: [{ outer: { elements: [arc(a, a, op.center, true)] }, holes: [] }],
  }
  const local = localStock(op.direction ?? '+z', stock)
  return port.intersect(disc, rectangle(local.length, local.width)).mapOr(undefined, (x) => x)
}

/**
 * An inside through profile without tabs (an opening, DF61 follow-up): once cut, its loop's
 * interior (slot and slug) is gone through the whole stock. With tabs the slug and the tabs stay.
 */
export const isOpening = (op: OperationGeometry): op is Profile =>
  isThroughGeometry(op) &&
  op.side === 'inside' &&
  op.tabs.count === 0 &&
  (op.tabs.positions === undefined || op.tabs.positions.length === 0)

/** The region inside an opening's loop, in its face frame, within the stock face rectangle. */
export function openingRegion(
  op: Profile,
  stock: StockGeometry,
  port: Region2dPort,
): Region | undefined {
  const { chain, closed } = profileChain(op)
  if (!closed || chain.elements.length === 0) return undefined
  const local = localStock(op.direction ?? '+z', stock)
  return port
    .intersect({ pieces: [{ outer: chain, holes: [] }] }, rectangle(local.length, local.width))
    .mapOr(undefined, (r) => r)
}

/**
 * One clearing as a measured cut sees it: from `top` down to `bottom` (depths below the stock
 * face of the clearing's direction; a pocket starts at its `on` level), over the whole face
 * (`'face'`: a facing) or over a region in the measured cut's face frame (undefined when the port
 * fails: it then counts nowhere).
 */
interface Clear {
  readonly id: string
  readonly top: number
  readonly bottom: number
  readonly region: 'face' | (() => Region | undefined)
}

/**
 * The clearings of facings (and with the port pockets and blind profiles) of `direction` other
 * than `op` machined before it, in the face frame of `frame` (the measured cut's direction). A
 * pocket clears its region (a floor fillet leaves material along the walls: only the region
 * inset by its radius is flat), a blind profile its slot (DF61). With `openings` (a port and the
 * setup order) also the openings of an earlier setup on the same axis: through the whole extent.
 */
function clearsOf(
  ops: readonly OperationGeometry[],
  direction: Direction,
  frame: Direction,
  op: OperationGeometry,
  stock: StockGeometry,
  port: Region2dPort | undefined,
  before: RunsBefore,
  openings?: RunsBefore,
): Clear[] {
  const mapper = (from: Direction) =>
    from === frame ? undefined : lazy(() => frameMap(from, frame, stock))
  const placed = (from: Direction, own: () => Region | undefined) => {
    const m = mapper(from)
    return lazy(() => {
      const r = own()
      return r === undefined || m === undefined ? r : mapRegion(r, m())
    })
  }
  const out: Clear[] = []
  for (const o of ops) {
    if (o === op || !before(o, op) || (o.direction ?? '+z') !== direction) continue
    if (o.kind === 'facing') out.push({ id: o.id, top: 0, bottom: o.depth, region: 'face' })
    else if (port === undefined) continue
    else if (o.kind === 'pocket') {
      const p = o
      const own = () => {
        const r = pocketRegion(p).region
        return p.floorRadius > 0 ? port.offset(r, p.floorRadius).mapOr(undefined, (x) => x) : r
      }
      out.push({ id: o.id, top: -o.onZ, bottom: o.depth - o.onZ, region: placed(direction, own) })
    } else if (o.kind === 'profile' && o.depth !== undefined) {
      const p = o
      const own = () => slotRegion(p, stock, port)
      out.push({ id: o.id, top: 0, bottom: o.depth, region: placed(direction, own) })
    }
  }
  if (openings !== undefined && port !== undefined) {
    const extent = localStock(frame, stock).thickness
    for (const o of ops) {
      const from = o.direction ?? '+z'
      if (o === op || !isOpening(o) || (from !== frame && from !== OPPOSITE[frame])) continue
      if (!openings(o, op)) continue
      const p = o
      const own = () => openingRegion(p, stock, port)
      out.push({ id: o.id, top: 0, bottom: extent, region: placed(from, own) })
    }
  }
  return out
}

/**
 * Depth below the stock face of the clearings' direction (mm) to which `clears` (machined
 * earlier) clear the whole `target`: a facing from the face, a pocket only where its `on` level
 * is already cleared (stacked pockets add up), a blind profile or opening from the face, each only
 * when its region covers the target (less than `COVER_AREA` uncovered).
 */
function clearedDepth(
  clears: readonly Clear[],
  target: () => Region | undefined,
  port: Region2dPort | undefined,
): number {
  const memo = new Map<string, boolean>()
  const covered = (c: Clear): boolean => {
    if (c.region === 'face') return true
    let v = memo.get(c.id)
    if (v === undefined) {
      const t = target()
      const r = c.region()
      v =
        t !== undefined &&
        r !== undefined &&
        port !== undefined &&
        port.difference(t, r).mapOr(false, (left) => regionArea(left) <= COVER_AREA)
      memo.set(c.id, v)
    }
    return v
  }
  let depth = 0
  for (let changed = true; changed;) {
    changed = false
    for (const c of clears) {
      if (c.bottom <= depth + EPSILON || c.top > depth + EPSILON || !covered(c)) continue
      depth = c.bottom
      changed = true
    }
  }
  return depth
}

/**
 * The through depth of every through profile, through drilling or through pocket (patterns P4)
 * whose slot, hole or region an earlier setup partly cleared from the opposite face: the stock
 * extent along its normal less that cleared depth. Cuts without such material removal are left out (they cut the full extent), as
 * are cuts that would keep less than `MIN_THROUGH` (the opposite cuts go through already: the
 * cut keeps the full extent).
 */
export function throughDepths(
  ops: readonly OperationGeometry[],
  stock: StockGeometry,
  port: Region2dPort | undefined,
  before: RunsBefore = defaultRunsBefore,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const op of ops) {
    if (!isThroughCut(op)) continue
    const direction = op.direction ?? '+z'
    const clears = clearsOf(ops, OPPOSITE[direction], direction, op, stock, port, before)
    if (clears.length === 0) continue
    const slot = lazy(() =>
      port === undefined
        ? undefined
        : op.kind === 'profile'
          ? slotRegion(op, stock, port)
          : op.kind === 'pocket'
            ? pocketFaceRegion(op, stock, port)
            : holeRegion(op, stock, port),
    )
    const cleared = clearedDepth(clears, slot, port)
    if (cleared <= EPSILON) continue
    const extent = localStock(direction, stock).thickness
    const depth = extent - cleared
    // a through pocket cuts from its `on` level (a stacked one below the face)
    if (depth - (op.kind === 'pocket' ? -op.onZ : 0) < MIN_THROUGH) continue
    out.set(op.id, depth)
  }
  return out
}

/** A pocket's region in its face frame, within the stock face rectangle. */
function pocketFaceRegion(
  op: Pocket,
  stock: StockGeometry,
  port: Region2dPort,
): Region | undefined {
  const local = localStock(op.direction ?? '+z', stock)
  return port
    .intersect(pocketRegion(op).region, rectangle(local.length, local.width))
    .mapOr(undefined, (r) => r)
}

/** A value computed on first use. */
function lazy<T>(f: () => T): () => T {
  let done = false
  let v: T | undefined
  return () => {
    if (!done) {
      v = f()
      done = true
    }
    return v as T
  }
}

/**
 * The material a cut meets (DF61), as z levels in its face frame (the stock face at 0): `top`
 * where the material over its whole region begins, when earlier cuts of its own direction cleared
 * deeper than its start level; `bottom` where the material over its whole region ends, when
 * earlier cuts from the opposite face cleared up into its depth. Absent: the cut's own start level
 * (top) or floor (bottom).
 */
export interface MaterialBand {
  readonly top?: number
  readonly bottom?: number
}

/**
 * Partial coverage of a pocket (DF61 follow-up): earlier cuts of its own direction cleared
 * `region` (a part of the pocket region, face frame) down to z `level`, below the band's top.
 * The toolpath wiring cuts the rest of the region down to `level` first and the whole region
 * from `level` down (`uncoveredRegion`, docs/modes/plan-v0.2.md#material-left-for-later-cuts-df61).
 */
export interface PartialCover {
  readonly level: number
  readonly region: Region
}

/** A material band with the partial coverage of a pocket (plan side only; not a generator input). */
export interface MaterialCover extends MaterialBand {
  readonly partial?: PartialCover
}

/** Area changes below this (mm²) end the partial-coverage iteration. */
const AREA_STABLE = 1e-6

/**
 * The deepest worthwhile partial coverage of `target` by `clears` (depths below the face), below
 * `from` (where the cut's material begins over its whole region) and not below `floor`: per
 * clearing the part of the target it clears (its region where the material above its own top is
 * already cleared – everywhere down to `whole`, the depth cleared over the whole target – the
 * least fixed point, so stacked pockets chain as in `clearedDepth`), then the
 * level L whose cleared part saves the most volume, (L − from) × area. Undefined without one.
 */
function partialCover(
  port: Region2dPort,
  clears: readonly Clear[],
  target: Region,
  from: number,
  whole: number,
  floor: number,
): PartialCover | undefined {
  const shaped = clears
    .filter((c): c is Clear & { region: () => Region | undefined } => c.region !== 'face')
    .sort((a, b) => a.top - b.top)
  const levels = [
    ...new Set(shaped.map((c) => Math.min(c.bottom, floor)).filter((L) => L > from + EPSILON)),
  ]
  if (levels.length === 0) return undefined
  const ok = <T>(r: { isOk(): boolean; unwrap(): T }): T | undefined =>
    r.isOk() ? r.unwrap() : undefined
  const own = new Map<Clear, Region | undefined>()
  for (const c of shaped) {
    const r = c.region()
    own.set(c, r === undefined ? undefined : ok(port.intersect(r, target)))
  }
  const effective = new Map<Clear, Region>()
  const union = (rs: readonly Region[]): Region | undefined => {
    let acc: Region | undefined
    for (const r of rs) {
      if (r.pieces.length === 0) continue
      acc = acc === undefined ? r : ok(port.union(acc, r))
      if (acc === undefined) return undefined
    }
    return acc ?? { pieces: [] }
  }
  const support = (c: Clear): Region | undefined => {
    if (c.top <= whole + EPSILON) return target
    return union(
      shaped
        .filter((q) => q !== c && q.bottom >= c.top - EPSILON)
        .map((q) => effective.get(q))
        .filter((r): r is Region => r !== undefined),
    )
  }
  let total = -1
  for (let round = 0; round <= shaped.length; round++) {
    for (const c of shaped) {
      const o = own.get(c)
      const s = o === undefined ? undefined : support(c)
      const e = o === undefined || s === undefined ? undefined : ok(port.intersect(o, s))
      if (e === undefined) effective.delete(c)
      else effective.set(c, e)
    }
    const next = [...effective.values()].reduce((a, r) => a + regionArea(r), 0)
    if (Math.abs(next - total) <= AREA_STABLE) break
    total = next
  }
  let best: { score: number; cover: PartialCover } | undefined
  for (const L of levels) {
    const region = union(
      shaped
        .filter((q) => q.bottom >= L - EPSILON)
        .map((q) => effective.get(q))
        .filter((r): r is Region => r !== undefined),
    )
    if (region === undefined) continue
    const area = regionArea(region)
    if (area <= COVER_AREA) continue
    const score = (L - from) * area
    if (best === undefined || score > best.score) best = { score, cover: { level: -L, region } }
  }
  return best?.cover
}

/**
 * The material band of every facing, pocket, profile and drilling for which earlier cuts
 * (`before`, the machining order) cleared material over its **whole** region: facings, pockets
 * and blind profiles of its own direction above it (`top`) and, for a blind milled cut, of the
 * opposite direction below it (`bottom`; a through profile has its `throughDepth` for that, a
 * drilling gets no bottom). The region is the face rectangle (facing), the pocket region, the
 * profile's slot or the hole, clipped to the stock face rectangle. Openings (inside through
 * profiles without tabs) of an earlier setup (`setupBefore`) on the same axis clear their loop's
 * interior through the whole extent. A pocket also gets its best `partial` coverage below the
 * top. Coverage as `throughDepths`; without the port only facings count. Cuts without a band are
 * left out.
 */
export function materialBands(
  ops: readonly OperationGeometry[],
  stock: StockGeometry,
  port: Region2dPort | undefined,
  before: RunsBefore,
  setupBefore: RunsBefore = before,
): Map<string, MaterialCover> {
  const out = new Map<string, MaterialCover>()
  for (const op of ops) {
    if (op.kind === 'chamfer') continue
    const direction = op.direction ?? '+z'
    const local = localStock(direction, stock)
    const face = rectangle(local.length, local.width)
    const target = lazy((): Region | undefined => {
      if (op.kind === 'facing') return face
      if (port === undefined) return undefined
      if (op.kind === 'profile') return slotRegion(op, stock, port)
      if (op.kind === 'drilling') return holeRegion(op, stock, port)
      return pocketFaceRegion(op, stock, port)
    })
    // depths below the face where the cut starts and where its floor is (none: through, a hole)
    const start = op.kind === 'pocket' || op.kind === 'drilling' ? -op.onZ : 0
    const floor =
      op.kind === 'pocket' ? op.depth - op.onZ : op.kind === 'drilling' ? undefined : op.depth
    let top: number | undefined
    let partial: PartialCover | undefined
    const same = clearsOf(ops, direction, direction, op, stock, port, before, setupBefore)
    if (same.length > 0) {
      const cleared = clearedDepth(same, target, port)
      if (cleared > start + EPSILON) top = -cleared
      const t = target()
      if (op.kind === 'pocket' && port !== undefined && t !== undefined && floor !== undefined)
        partial = partialCover(port, same, t, Math.max(start, cleared), cleared, floor)
    }
    let bottom: number | undefined
    // a through pocket has its `throughDepth` for that, as a through profile
    if (floor !== undefined && !isThroughPocket(op)) {
      const opposite = OPPOSITE[direction]
      const below = clearsOf(ops, opposite, direction, op, stock, port, before)
      if (below.length > 0) {
        const cleared = clearedDepth(below, target, port)
        const z = cleared - local.thickness
        if (cleared > EPSILON && z > -floor + EPSILON) bottom = z
      }
    }
    if (top !== undefined || bottom !== undefined || partial !== undefined)
      out.set(op.id, {
        ...(top === undefined ? {} : { top }),
        ...(bottom === undefined ? {} : { bottom }),
        ...(partial === undefined ? {} : { partial }),
      })
  }
  return out
}

/**
 * Profiles, drillings and pockets with their `throughDepth` set from `depths` (others: without
 * one).
 */
export function withThroughDepths(
  ops: readonly OperationGeometry[],
  depths: ReadonlyMap<string, number>,
): OperationGeometry[] {
  return ops.map((o) => {
    if (o.kind !== 'profile' && o.kind !== 'drilling' && o.kind !== 'pocket') return o
    const d = depths.get(o.id)
    if (d === undefined) {
      if (o.throughDepth === undefined) return o
      const { throughDepth: _, ...rest } = o
      return rest
    }
    return o.throughDepth === d ? o : { ...o, throughDepth: d }
  })
}
