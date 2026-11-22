/**
 * Rest material of a pocket region for one tool radius (task T1's finding behind
 * `plan.restMaterial`, the plan's copy of `dfm.restMaterial`): the region minus its morphological
 * opening, minus the corner zones (corners are the corner rules' job), pieces above 0.5 × R².
 * Doc: docs/modes/plan-v0.3.md#pocket-offset-clearing-of-a-region,
 * docs/architecture/shapes.md#parameter-checks-for-shapes
 */
import { Err, Ok, type AppResult } from '../../shared/result'
import type { Vec2 } from '../geometry/model'
import {
  arc,
  arcRadius,
  arcSweep,
  boundsOverlap,
  chainBounds,
  regionArea,
  regionLoops,
  type Element,
  type Loop,
  type Region,
} from '../geometry/2d/model'
import { elementPointAt } from '../geometry/2d/measure'
import type { Region2dPort } from '../geometry/2d/port'

/** One piece of rest material: its area (mm²) and a point inside it for the marker. */
export interface RestPiece {
  readonly area: number
  readonly at: Vec2
}

/** Corners turning more than this (rad) are U-turns (a slot end): no zone, the slot is rest. */
const MAX_CORNER_TURN = (170 * Math.PI) / 180
/** Turns below this (rad) are tangent joins, not corners. */
const MIN_CORNER_TURN = 1e-6

/** Unit tangent of an element at its start (`end` false) or end. */
function tangent(e: Element, end: boolean): Vec2 {
  return elementPointAt(e, end ? 1 : 0).tangent
}

const disc = (c: Vec2, r: number): Loop => {
  const a: Vec2 = [c[0] - r, c[1]]
  const b: Vec2 = [c[0] + r, c[1]]
  return { elements: [arc(a, b, c, true), arc(b, a, c, true)] }
}

/**
 * Zones (discs) around the inside corners of the cut that hold their rest material: a sharp
 * convex vertex of interior angle θ leaves material up to R / tan(θ/2) from the vertex (where the
 * tool touches both sides); a convex arc of radius r < R and sweep φ does the same round the
 * intersection of its end tangents, with θ = π − φ. The region lies left of its loops.
 */
export function cornerZones(region: Region, R: number): Loop[] {
  const zones: Loop[] = []
  const add = (v: Vec2, turn: number) => {
    if (turn <= MIN_CORNER_TURN || turn > MAX_CORNER_TURN) return
    const theta = Math.PI - turn
    zones.push(disc(v, (R / Math.tan(theta / 2)) * 1.01 + 1e-3))
  }
  for (const l of regionLoops(region)) {
    const els = l.elements
    for (let i = 0; i < els.length; i++) {
      const e = els[i]!
      const next = els[(i + 1) % els.length]!
      const tin = tangent(e, true)
      const tout = tangent(next, false)
      add(e.b, Math.atan2(tin[0] * tout[1] - tin[1] * tout[0], tin[0] * tout[0] + tin[1] * tout[1]))
      if (e.kind === 'arc') {
        const sweep = arcSweep(e)
        const r = arcRadius(e)
        if (sweep > 0 && r < R && sweep < Math.PI) {
          const mid = elementPointAt(e, 0.5).point
          const dx = mid[0] - e.centre[0]
          const dy = mid[1] - e.centre[1]
          const k = 1 / Math.cos(sweep / 2)
          add([e.centre[0] + dx * k, e.centre[1] + dy * k], sweep)
        }
      }
    }
  }
  return zones
}

/**
 * Rest material a tool of radius `R` leaves in a pocket region away from its corners (necks
 * narrower than the tool between two parts of the region, pieces the tool cannot enter): pieces
 * of `region − opening(region, R) − corner zones` above 0.5 × R², largest first.
 */
export function findRestMaterial(
  port: Region2dPort,
  region: Region,
  R: number,
): AppResult<RestPiece[]> {
  const inner = port.offset(region, R)
  if (inner.isErr()) return Err(inner.unwrapErr())
  let opening: Region = { pieces: [] }
  if (inner.unwrap().pieces.length > 0) {
    const o = port.offset(inner.unwrap(), -R)
    if (o.isErr()) return Err(o.unwrapErr())
    opening = o.unwrap()
  }
  const restR = opening.pieces.length > 0 ? port.difference(region, opening) : Ok(region)
  if (restR.isErr()) return Err(restR.unwrapErr())
  let rest = restR.unwrap()
  const min = 0.5 * R * R
  if (regionArea(rest) <= min) return Ok([])
  for (const z of cornerZones(region, R)) {
    if (rest.pieces.length === 0) break
    const zb = chainBounds(z.elements)!
    const rb = chainBounds(regionLoops(rest).flatMap((l) => l.elements))!
    if (!boundsOverlap(zb, rb)) continue
    const zr = port.normalise([z])
    if (zr.isErr()) return Err(zr.unwrapErr())
    const d = port.difference(rest, zr.unwrap())
    if (d.isErr()) return Err(d.unwrapErr())
    rest = d.unwrap()
  }
  const out: RestPiece[] = []
  for (const piece of rest.pieces) {
    const one: Region = { pieces: [piece] }
    const area = regionArea(one)
    if (area > min) out.push({ area, at: pointIn(port, one) })
  }
  return Ok(out.sort((x, y) => y.area - x.area))
}

/** A point inside a piece: the centre of its bounding box if inside, else on its outer loop. */
function pointIn(port: Region2dPort, r: Region): Vec2 {
  const outer = r.pieces[0]!.outer
  const b = chainBounds(outer.elements)!
  const c: Vec2 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]
  if (port.contains(r, c)) return c
  return elementPointAt(outer.elements[0]!, 0.5).point
}
