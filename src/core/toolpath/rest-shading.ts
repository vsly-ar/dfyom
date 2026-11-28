/**
 * The rest region of an operation cut after its roughing (hardening DF122, R3's viewport item):
 * the material the owner's tool can reach that its roughing left, the uncleared corners and the
 * wall margin band, at the roughing's lowest level, in the setup's WCS. For the Plan viewport's
 * shading (`plan.toolpath.get` `rest`); pure, headless.
 * Doc: docs/modes/roughing.md#plan-viewport-rest-shading
 */
import { Ok, type AppResult } from '../../shared/result'
import { regionArea, reverseLoop, signedArea, type Region } from '../geometry/2d/model'
import type { Region2dPort } from '../geometry/2d/port'
import { patchPolygons, type PatchPolygon } from '../geometry/flat-patch'
import type { GeneratorRequest } from './request'
import { roughCleared } from './region-pocket'
import { profileRoughCleared } from './region-profile'
import { toWcs } from './wcs'

/** Pieces smaller than this (mm²) are 2D-library slivers and are left out. */
const MIN_PIECE = 1e-3

/** What the Plan viewport shades: the rest region (WCS, mm) at its level. */
export interface RestShading {
  /** Z of the roughing's lowest level in the WCS (mm): the rest lies above it. */
  readonly level: number
  /** Its area (mm²). */
  readonly area: number
  readonly patch: readonly PatchPolygon[]
}

/** `region` opened by radius `R` (shrunk, then grown back): what a tool of that radius reaches. */
function reach(port: Region2dPort, region: Region, R: number): AppResult<Region> {
  return port.offset(region, R).andThen((c) => (c.pieces.length === 0 ? Ok(c) : port.offset(c, -R)))
}

/**
 * The rest region of a `regionPocket` or `regionProfile` request whose operation comes after its
 * roughing (`restAfter`); undefined for any other request, or when the roughing left nothing.
 * The rest is the owner's reach (its region, or a profile's slot, opened by its tool radius) less
 * what the roughing cleared at its floor (`roughCleared`, `profileRoughCleared`). A clone group
 * (DF146) shows its first instance's (the source's) rest only.
 */
export function restShading(
  request: GeneratorRequest,
  port: Region2dPort,
): AppResult<RestShading | undefined> {
  if (request.kind === 'group') {
    const first = request.parts[0]
    return first === undefined ? Ok(undefined) : restShading(first, port)
  }
  const shown = (owner: AppResult<Region>, cleared: AppResult<Region>, level: number) =>
    owner
      .andThen((o) =>
        cleared.andThen((c) => (c.pieces.length === 0 ? Ok(o) : port.difference(o, c))),
      )
      .map((rest): RestShading | undefined => {
        const pieces = rest.pieces.filter((p) => regionArea({ pieces: [p] }) >= MIN_PIECE)
        if (pieces.length === 0) return undefined
        const region: Region = { pieces }
        const wcs = request.wcs
        return {
          level,
          area: regionArea(region),
          patch: patchPolygons(region, {
            toWcs: (p) => (wcs === undefined ? p : toWcs(p, wcs)),
            fromWcs: (p) => p,
          }),
        }
      })
  if (request.kind === 'regionPocket') {
    // a partly cleared pocket holds two inputs: the whole region is the last
    const input = request.inputs[request.inputs.length - 1]
    const op = input?.operation
    if (input === undefined || op?.restAfter === undefined) return Ok(undefined)
    return shown(
      reach(port, op.region, input.tool.diameter / 2),
      roughCleared(port, op.region, op.restAfter),
      op.onZ - op.restAfter.floorDepth,
    )
  }
  if (request.kind === 'regionProfile') {
    const input = request.inputs[0]
    const op = input?.operation
    if (input === undefined || op?.restAfter === undefined || !op.closed || op.side === 'on')
      return Ok(undefined)
    const outside = op.side === 'outside'
    const ccw = signedArea(op.chain) > 0 ? op.chain : reverseLoop(op.chain)
    const sw = op.slotWidth
    const rough = op.restAfter
    const owner = port.normalise([ccw]).andThen((L) => {
      // the owner's slot: between the loop and its offset by the slot width
      const far = port.offset(L, outside ? -sw : sw)
      return far
        .andThen((f) =>
          outside ? port.difference(f, L) : f.pieces.length === 0 ? Ok(L) : port.difference(L, f),
        )
        .andThen((slot) => reach(port, slot, input.tool.diameter / 2))
        .map((r) => ({ L, r }))
    })
    if (owner.isErr()) return owner.map(() => undefined)
    const { L, r } = owner.unwrap()
    return shown(Ok(r), profileRoughCleared(port, L, outside, rough), op.onZ - rough.floorDepth)
  }
  return Ok(undefined)
}
