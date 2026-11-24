/**
 * Through depths after earlier setups (hardening DF50, drillings DF61): how deep a through
 * profile or through drilling has to cut when facings and pockets of the opposite direction,
 * machined in an earlier setup, already removed material under its whole slot or hole. The
 * geometry evaluation (tabs, `dfm.reach`, tool fit), the toolpaths and the plan's tool checks all
 * read it from `throughDepth` of the operation. `materialBands` (DF61) uses the same model for
 * the material a cut meets, so its toolpath skips passes that lie wholly in air.
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
/** What clears material from a face: facings, pockets and blind profiles (steps, grooves). */
type Removal = Extract<OperationGeometry, { kind: 'facing' | 'pocket' }> | Profile
type Shaped = Exclude<Removal, { kind: 'facing' }>

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

const OPPOSITE: Readonly<Record<Direction, Direction>> = {
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

/** A through profile or a through drilling: what `throughDepths` measures (DF50, DF61). */
const isThroughCut = (op: OperationGeometry): op is Profile | Drilling =>
  isThroughGeometry(op) || (op.kind === 'drilling' && op.bottom.kind === 'through')

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/**
 * `[u, v]` of the face frame of `from` → `[u, v]` of the face frame of `to` (opposite
 * directions share their normal axis, so this is a signed swap plus a shift) and whether it keeps
 * the turning sense.
 */
function frameMap(
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

function mapRegion(r: Region, m: ReturnType<typeof frameMap>): Region {
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

const rectangle = (length: number, width: number): Region => ({
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
function slotRegion(op: Profile, stock: StockGeometry, port: Region2dPort): Region | undefined {
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
function holeRegion(op: Drilling, stock: StockGeometry, port: Region2dPort): Region | undefined {
  const r = op.diameter / 2
  const a: Vec2 = [op.center[0] + r, op.center[1]]
  const disc: Region = {
    pieces: [{ outer: { elements: [arc(a, a, op.center, true)] }, holes: [] }],
  }
  const local = localStock(op.direction ?? '+z', stock)
  return port.intersect(disc, rectangle(local.length, local.width)).mapOr(undefined, (x) => x)
}

/**
 * Whether pocket or blind profile `p` clears the whole `target` (a region in the face frame of the
 * target's direction; `m` maps `p`'s frame into it, absent: the same frame). A pocket clears its
 * region (a floor fillet leaves material along the walls: only the region inset by its radius is
 * flat), a blind profile its slot (DF61).
 */
function removalCovers(
  port: Region2dPort,
  stock: StockGeometry,
  p: Shaped,
  target: Region,
  m?: ReturnType<typeof frameMap>,
): boolean {
  let region: Region | undefined
  if (p.kind === 'profile') region = slotRegion(p, stock, port)
  else {
    const own = pocketRegion(p).region
    region = p.floorRadius > 0 ? port.offset(own, p.floorRadius).mapOr(undefined, (r) => r) : own
  }
  if (region === undefined) return false
  return port
    .difference(target, m === undefined ? region : mapRegion(region, m))
    .mapOr(false, (left) => regionArea(left) <= COVER_AREA)
}

/**
 * Depth below the stock face of the removals' direction (mm) to which `removals` (machined
 * earlier) clear the whole `slot`: a facing from the face, a pocket only where its `on` level is
 * already cleared (stacked pockets add up), a blind profile from the face, each only when its
 * region (less its floor fillet zone) or slot covers the slot.
 */
function clearedDepth(
  removals: readonly Removal[],
  slot: () => Region | undefined,
  covers: (p: Shaped, slot: Region) => boolean,
): number {
  const memo = new Map<string, boolean>()
  const covered = (r: Removal): boolean => {
    if (r.kind === 'facing') return true
    let c = memo.get(r.id)
    if (c === undefined) {
      const s = slot()
      c = s !== undefined && covers(r, s)
      memo.set(r.id, c)
    }
    return c
  }
  let depth = 0
  for (let changed = true; changed;) {
    changed = false
    for (const r of removals) {
      const top = r.kind === 'pocket' ? -r.onZ : 0
      // removals are facings, pockets and blind profiles: a depth each
      const bottom = r.kind === 'pocket' ? r.depth - r.onZ : r.depth!
      if (bottom <= depth + EPSILON || top > depth + EPSILON || !covered(r)) continue
      depth = bottom
      changed = true
    }
  }
  return depth
}

/**
 * The through depth of every through profile or through drilling whose slot or hole an earlier
 * setup partly cleared from the opposite face: the stock extent along its normal less that
 * cleared depth. Cuts without such material removal are left out (they cut the full extent), as
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
    const opposite = OPPOSITE[direction]
    const removals = removalsOf(ops, opposite, op, port, before)
    if (removals.length === 0) continue
    const slot = lazy(() =>
      port === undefined
        ? undefined
        : op.kind === 'profile'
          ? slotRegion(op, stock, port)
          : holeRegion(op, stock, port),
    )
    const m = frameMap(opposite, direction, stock)
    // `port` is defined: pockets are only collected with it
    const cleared = clearedDepth(removals, slot, (p, s) => removalCovers(port!, stock, p, s, m))
    if (cleared <= EPSILON) continue
    const extent = localStock(direction, stock).thickness
    const depth = extent - cleared
    if (depth < MIN_THROUGH) continue
    out.set(op.id, depth)
  }
  return out
}

/**
 * Facings (and with the port pockets and blind profiles) of `direction` other than `op` machined
 * before it.
 */
function removalsOf(
  ops: readonly OperationGeometry[],
  direction: Direction,
  op: OperationGeometry,
  port: Region2dPort | undefined,
  before: RunsBefore,
): Removal[] {
  return ops.filter(
    (o): o is Removal =>
      o !== op &&
      (o.kind === 'facing' ||
        (port !== undefined &&
          (o.kind === 'pocket' || (o.kind === 'profile' && o.depth !== undefined)))) &&
      (o.direction ?? '+z') === direction &&
      before(o, op),
  )
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
 * The material band of every facing, pocket and profile for which earlier cuts (`before`)
 * cleared material over its **whole** region: facings and pockets of its own direction above it
 * (`top`) and, for a blind cut, of the opposite direction below it (`bottom`; a through profile
 * has its `throughDepth` for that). The region is the face rectangle (facing), the pocket region
 * or the profile's slot, clipped to the stock face rectangle. Coverage as `throughDepths`; without
 * the port only facings count. Cuts without a band are left out.
 */
export function materialBands(
  ops: readonly OperationGeometry[],
  stock: StockGeometry,
  port: Region2dPort | undefined,
  before: RunsBefore,
): Map<string, MaterialBand> {
  const out = new Map<string, MaterialBand>()
  for (const op of ops) {
    if (op.kind !== 'facing' && op.kind !== 'pocket' && op.kind !== 'profile') continue
    const direction = op.direction ?? '+z'
    const local = localStock(direction, stock)
    const face = rectangle(local.length, local.width)
    const target = lazy((): Region | undefined => {
      if (op.kind === 'facing') return face
      if (port === undefined) return undefined
      if (op.kind === 'profile') return slotRegion(op, stock, port)
      return port.intersect(pocketRegion(op).region, face).mapOr(undefined, (r) => r)
    })
    // depths below the face where the cut starts and where its floor is (none: through)
    const start = op.kind === 'pocket' ? -op.onZ : 0
    const floor = op.kind === 'pocket' ? op.depth - op.onZ : op.depth
    let top: number | undefined
    const same = removalsOf(ops, direction, op, port, before)
    if (same.length > 0) {
      const cleared = clearedDepth(same, target, (p, s) => removalCovers(port!, stock, p, s))
      if (cleared > start + EPSILON) top = -cleared
    }
    let bottom: number | undefined
    if (floor !== undefined) {
      const opposite = OPPOSITE[direction]
      const below = removalsOf(ops, opposite, op, port, before)
      if (below.length > 0) {
        const m = frameMap(opposite, direction, stock)
        const cleared = clearedDepth(below, target, (p, s) => removalCovers(port!, stock, p, s, m))
        const z = cleared - local.thickness
        if (cleared > EPSILON && z > -floor + EPSILON) bottom = z
      }
    }
    if (top !== undefined || bottom !== undefined)
      out.set(op.id, {
        ...(top === undefined ? {} : { top }),
        ...(bottom === undefined ? {} : { bottom }),
      })
  }
  return out
}

/** Profiles and drillings with their `throughDepth` set from `depths` (others: without one). */
export function withThroughDepths(
  ops: readonly OperationGeometry[],
  depths: ReadonlyMap<string, number>,
): OperationGeometry[] {
  return ops.map((o) => {
    if (o.kind !== 'profile' && o.kind !== 'drilling') return o
    const d = depths.get(o.id)
    if (d === undefined) {
      if (o.throughDepth === undefined) return o
      const { throughDepth: _, ...rest } = o
      return rest
    }
    return o.throughDepth === d ? o : { ...o, throughDepth: d }
  })
}
