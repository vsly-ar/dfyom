/**
 * Keep-out of workholding in region toolpaths (WH-D): a pocket's or facing's region minus the
 * footprints of the items its cut passes under (each grown by the margin), so the clearing goes
 * around them, and the material left uncut there per item (`plan.workholding.unmachined`).
 * Doc: docs/modes/workholding.md#keep-out-in-toolpaths
 *
 * Footprints come in the setup's WCS (the workholding frame); generators work in the face frame,
 * so a rotated setup's footprints are turned back (`fromWcs`) first.
 */
import { Err, Ok, type AppResult } from '../../shared/result'
import {
  arc,
  chainBounds,
  line,
  regionArea,
  regionLoops,
  signedArea,
  type Loop,
  type Region,
} from '../geometry/2d/model'
import type { Region2dPort } from '../geometry/2d/port'
import type { Vec2 } from '../geometry/model'
import type { Footprint } from '../plan/workholding/obstacles'
import { fromWcs, type SetupWcs } from './wcs'

/** One item's prism as region generators see it. */
export interface KeepOutZone {
  readonly itemId: string
  /** In the setup's WCS. */
  readonly footprint: Footprint
  readonly zMax: number
}

/** The keep-out of a region operation's setup (`PlanOperationInput.keepOut`). */
export interface KeepOut {
  readonly zones: readonly KeepOutZone[]
  readonly margin: number
}

/** Material a region operation leaves under one item (face frame, mm², bounds). */
export interface Unmachined {
  readonly itemId: string
  readonly area: number
  readonly bounds: readonly [Vec2, Vec2]
}

/**
 * A footprint as a counter-clockwise loop in the face frame, grown by `grow` (circles exactly).
 * Footprints are in the setup frame: turned by the rotation, never shifted by a moved work zero
 * (DF78, docs/modes/alignment.md#frames), so only the turn is undone.
 */
function footprintLoop(f: Footprint, wcs: SetupWcs | undefined, grow: number): Loop {
  const turned: SetupWcs | undefined =
    wcs === undefined ? undefined : { rotation: wcs.rotation, size: wcs.size }
  const p = (q: Vec2): Vec2 => (turned === undefined ? [q[0], q[1]] : fromWcs(q, turned))
  if (f.kind === 'circle') {
    const c = p(f.center)
    const r = f.radius + grow
    const start: Vec2 = [c[0] + r, c[1]]
    return { elements: [arc(start, start, c, true)] }
  }
  const pts = f.points.map(p)
  const loop: Loop = {
    elements: pts.map((a, i) => line(a, pts[(i + 1) % pts.length]!)),
  }
  if (signedArea(loop) >= 0) return loop
  const rev = [...pts].reverse()
  return { elements: rev.map((a, i) => line(a, rev[(i + 1) % rev.length]!)) }
}

/** The zone of one item grown by the margin, as a region in the face frame. */
function zoneRegion(
  port: Region2dPort,
  zones: readonly KeepOutZone[],
  wcs: SetupWcs | undefined,
  margin: number,
): AppResult<Region> {
  let out: Region = { pieces: [] }
  for (const z of zones) {
    const polygon = z.footprint.kind === 'polygon'
    const base = port.normalise([footprintLoop(z.footprint, wcs, polygon ? 0 : margin)])
    if (base.isErr()) return base
    // a negative offset grows a region
    const grown = polygon && margin > 0 ? port.offset(base.unwrap(), -margin) : base
    if (grown.isErr()) return grown
    const u = port.union(out, grown.unwrap())
    if (u.isErr()) return u
    out = u.unwrap()
  }
  return Ok(out)
}

/**
 * The region to cut and the material left per item, for a cut whose deepest level is `deepest`
 * (Z in the face frame): only zones whose top + margin lies above it keep out. Undefined when no
 * zone touches the region (the operation generates as without workholding).
 */
export function keepOutRegion(
  port: Region2dPort,
  region: Region,
  keepOut: KeepOut,
  deepest: number,
  wcs?: SetupWcs,
): AppResult<{ readonly region: Region; readonly unmachined: readonly Unmachined[] } | undefined> {
  const zones = keepOut.zones.filter((z) => deepest < z.zMax + keepOut.margin)
  if (zones.length === 0) return Ok(undefined)
  const byItem = new Map<string, KeepOutZone[]>()
  for (const z of zones) byItem.set(z.itemId, [...(byItem.get(z.itemId) ?? []), z])
  const unmachined: Unmachined[] = []
  for (const [itemId, list] of byItem) {
    const zone = zoneRegion(port, list, wcs, keepOut.margin)
    if (zone.isErr()) return Err(zone.unwrapErr())
    const inside = port.intersect(region, zone.unwrap())
    if (inside.isErr()) return Err(inside.unwrapErr())
    const area = regionArea(inside.unwrap())
    if (area <= 1e-6) continue
    const b = chainBounds(regionLoops(inside.unwrap()).flatMap((l) => l.elements))
    if (b === undefined) continue
    unmachined.push({ itemId, area, bounds: [b.min, b.max] })
  }
  if (unmachined.length === 0) return Ok(undefined)
  const all = zoneRegion(
    port,
    zones.filter((z) => unmachined.some((u) => u.itemId === z.itemId)),
    wcs,
    keepOut.margin,
  )
  if (all.isErr()) return Err(all.unwrapErr())
  const cut = port.difference(region, all.unwrap())
  if (cut.isErr()) return Err(cut.unwrapErr())
  return Ok({ region: cut.unwrap(), unmachined })
}

/** The facing's region: the stock face grown by the overshoot on every side (face frame). */
export function facingRegion(length: number, width: number, overshoot: number): Region {
  const [a, b, c, d]: Vec2[] = [
    [-overshoot, -overshoot],
    [length + overshoot, -overshoot],
    [length + overshoot, width + overshoot],
    [-overshoot, width + overshoot],
  ]
  return {
    pieces: [
      { outer: { elements: [line(a!, b!), line(b!, c!), line(c!, d!), line(d!, a!)] }, holes: [] },
    ],
  }
}
