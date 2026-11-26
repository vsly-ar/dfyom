/**
 * The waste of a face (hardening D4, DL-D): the material that is not part of the finished part
 * because a through profile on the same axis cuts it off: the stock frame outside every outside
 * profile's loop and the slug inside an inside profile's loop (glossary: Offcut). The parameter
 * DFM checks skip corners, rest material and reach of cuts that lie only there.
 * Doc: docs/modes/design-llm-first.md#dfm-in-waste
 *
 * Classified in 2D, in the face frame of the measured operation: through profiles of the same
 * direction or the opposite one cut the whole extent along that axis, so their loops are the
 * part's outline on that face. Profiles of other axes, blind profiles (steps), `on` grooves and
 * open paths do not bound the part. Loose pieces (evaluation) are not waste here. Pure; point
 * queries use exact measures, `holds` the 2D port.
 */
import { frameMap, isThroughGeometry, mapRegion, OPPOSITE, rectangle } from './through-depth'
import type { Direction } from './face'
import { localStock } from './face'
import { closestOnChains, regionContains } from './2d/measure'
import { regionArea, reverseLoop, signedArea, type Loop, type Region } from './2d/model'
import type { Region2dPort } from './2d/port'
import { Ok, type AppResult } from '../../shared/result'
import type { OperationGeometry, StockGeometry, Vec2 } from './model'
import { profileChain } from './outline'

/** Where a face's material is waste (face frame of one direction). */
export interface FaceWaste {
  /**
   * Whether every point within `clearance` (mm) of `p` is waste: `p` lies off the part by at
   * least `clearance` (0: strictly off it, not on its outline).
   */
  covers(p: Vec2, clearance: number): boolean
  /** Whether a region lies wholly in waste (its overlap with the part has no area); false when the port fails or is absent. */
  holds(region: Region): boolean
}

/** Off-outline slack (mm): a point on the loop is on the part. */
const ON_OUTLINE = 1e-6
/** Overlap with the part that still counts as none (mm²): slivers along a shared outline. */
const OVERLAP_AREA = 1e-3

const asRegion = (outer: Loop): Region => ({ pieces: [{ outer, holes: [] }] })
const inside = (l: Loop, p: Vec2): boolean => regionContains(asRegion(l), p)
const distance = (l: Loop, p: Vec2): number => closestOnChains([l], p)?.distance ?? Infinity
/** `p` lies at least `c` from loop `l` (at least `ON_OUTLINE` when `c` is 0). */
const clear = (l: Loop, p: Vec2, c: number): boolean =>
  distance(l, p) >= Math.max(c - ON_OUTLINE, ON_OUTLINE)

/**
 * The waste of the face of `direction`, or undefined when no through profile on its axis bounds
 * the part (nothing is waste). `stock` is the part's stock (not the local one).
 */
export function faceWaste(
  operations: readonly OperationGeometry[],
  direction: Direction,
  stock: StockGeometry,
  port?: Region2dPort,
): FaceWaste | undefined {
  const outs: Loop[] = []
  const ins: Loop[] = []
  for (const o of operations) {
    if (!isThroughGeometry(o) || o.side === 'on') continue
    const from = o.direction ?? '+z'
    if (from !== direction && from !== OPPOSITE[direction]) continue
    const { chain, closed } = profileChain(o)
    if (!closed || chain.elements.length === 0) continue
    const loop =
      from === direction
        ? chain
        : mapRegion(asRegion(chain), frameMap(from, direction, stock)).pieces[0]!.outer
    // counter-clockwise, so `normalise` reads it as an outer loop
    ;(o.side === 'outside' ? outs : ins).push(signedArea(loop) < 0 ? reverseLoop(loop) : loop)
  }
  if (outs.length === 0 && ins.length === 0) return undefined
  // a part cut out inside another part's opening is part again, not that opening's slug
  const nestedIn = (i: Loop): Loop[] =>
    outs.filter((o) => {
      const e = o.elements[0]
      return e !== undefined && inside(i, e.a)
    })
  const slugs = ins.map((loop) => ({ loop, nested: nestedIn(loop) }))
  const nearPart = (p: Vec2, c: number) => (o: Loop) => inside(o, p) || !clear(o, p, c)
  let part: Region | null | undefined
  const partRegion = (): Region | null => {
    if (part !== undefined) return part
    if (port === undefined) return (part = null)
    const local = localStock(direction, stock)
    const fold = (
      start: AppResult<Region>,
      loops: readonly Loop[],
      op: (a: Region, b: Region) => AppResult<Region>,
    ) =>
      loops.reduce(
        (acc, l) => acc.andThen((r) => port.normalise([l]).andThen((n) => op(r, n))),
        start,
      )
    const base: AppResult<Region> =
      outs.length > 0
        ? fold(port.normalise([outs[0]!]), outs.slice(1), (a, b) => port.union(a, b))
        : Ok(rectangle(local.length, local.width))
    const cut = fold(base, ins, (a, b) => port.difference(a, b))
    const result = fold(
      cut,
      slugs.flatMap((s) => s.nested),
      (a, b) => port.union(a, b),
    )
    return (part = result.mapOr(null, (r) => r))
  }
  return {
    covers: (p, c) => {
      const near = nearPart(p, c)
      if (outs.length > 0 && !outs.some(near)) return true
      return slugs.some((s) => inside(s.loop, p) && clear(s.loop, p, c) && !s.nested.some(near))
    },
    holds: (region) => {
      const r = partRegion()
      if (r === null) return false
      return port!.intersect(region, r).mapOr(false, (x) => regionArea(x) <= OVERLAP_AREA)
    },
  }
}
