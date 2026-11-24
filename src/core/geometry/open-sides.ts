/**
 * Open sides of a pocket (hardening DF61): where a pocket's region reaches the stock edge, the
 * walls on or beyond that edge are air, so they must not bound the tool. The **open region** is
 * the pocket region within the stock face plus a band of `reach` outside the stock round that
 * part; the tool-centre region of it lets the tool run past the stock edge along open sides while
 * every real wall (inside the stock) keeps its offset. Pure; the 2D port is passed in.
 * Doc: docs/modes/plan-v0.3.md#open-sides-df61
 */
import type { AppResult } from '../../shared/result'
import { Ok } from '../../shared/result'
import { line, regionArea, type Region } from './2d/model'
import type { Region2dPort } from './2d/port'
import type { StockGeometry } from './model'

/** A wall this close to the stock edge (mm) lies on it: the side is open. */
export const ON_EDGE = 1e-3

/** The face rectangle `[lo, lo] … [length − lo, width − lo]` as a region. */
function faceRectangle(face: Pick<StockGeometry, 'length' | 'width'>, lo = 0): Region {
  const [a, b, c, d] = [
    [lo, lo],
    [face.length - lo, lo],
    [face.length - lo, face.width - lo],
    [lo, face.width - lo],
  ] as const
  return {
    pieces: [
      {
        outer: {
          elements: [
            line([...a], [...b]),
            line([...b], [...c]),
            line([...c], [...d]),
            line([...d], [...a]),
          ],
        },
        holes: [],
      },
    ],
  }
}

/**
 * Whether `region` (in the face frame of `face`) reaches the stock edge: some of it lies on the
 * edge (within `ON_EDGE`) or beyond it. A port failure answers no (the closed pocket, as before).
 */
export function opensStock(
  port: Region2dPort,
  region: Region,
  face: Pick<StockGeometry, 'length' | 'width'>,
): boolean {
  if (face.length <= 2 * ON_EDGE || face.width <= 2 * ON_EDGE) return false
  return port
    .difference(region, faceRectangle(face, ON_EDGE))
    .mapOr(false, (out) => regionArea(out) > ON_EDGE * ON_EDGE)
}

/**
 * How far outside the stock the open region reaches for a tool of radius `r` with a finishing
 * allowance (mm): r (1 + √½) + allowance. The tool centre then runs up to r √½ + allowance past
 * the edge, which is what clears the corner where a real wall meets an open side (the tool
 * touching that corner from 45° below the edge); a wider band only cuts more air.
 */
export function openReach(r: number, allowance: number): number {
  return r * (1 + Math.SQRT1_2) + allowance + ON_EDGE
}

/**
 * The open region of a pocket that `opensStock`: its part within the stock face plus the band
 * within `reach` of that part outside the stock. Its tool-centre region (offset by the tool
 * radius) keeps every point of the tool inside the stock within the pocket (the band lies wholly
 * outside the stock), and with `reach` ≥ `openReach` reaches every point of the pocket along an
 * open side and its corners with the real walls. A region wholly outside the stock is
 * returned unchanged (it cuts only air; DFM warns `dfm.shapeOutsideFace`).
 */
export function openRegion(
  port: Region2dPort,
  region: Region,
  face: Pick<StockGeometry, 'length' | 'width'>,
  reach: number,
): AppResult<Region> {
  const stock = faceRectangle(face)
  return port.intersect(region, stock).andThen((inside) => {
    if (inside.pieces.length === 0) return Ok(region)
    return port
      .offset(inside, -reach)
      .andThen((grown) => port.difference(grown, stock))
      .andThen((band) => port.union(inside, band))
  })
}
