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

/** Material the split of a partly cleared pocket may leave uncut (mm²): boolean slivers only. */
export const SPLIT_SLIVER = 1e-2

/**
 * The region a partly cleared pocket still cuts above the cleared level (DF61 follow-up,
 * `PartialCover`): the part of `region` (the pocket's region or open region) outside `covered`,
 * grown by `reach` into the covered part (clipped to `region`), so the cleared part acts as an
 * open side – its tool-centre region keeps every real wall's offset while the tool runs into the
 * cleared part, which clears the corners where a real wall meets it. An empty region when
 * `covered` covers `region`. Undefined (no split: cut the whole region from the top) unless the
 * check holds that nothing is skipped: every point of the uncovered part a tool of radius `r`
 * reaches in the whole region (its opening) it also reaches in the grown one, up to
 * `SPLIT_SLIVER`. Port failures answer undefined (the conservative side).
 */
export function uncoveredRegion(
  port: Region2dPort,
  region: Region,
  covered: Region,
  reach: number,
  r: number,
): Region | undefined {
  const opening = (x: Region) => port.offset(x, r).andThen((c) => port.offset(c, -r))
  const split = port.difference(region, covered).andThen((left): AppResult<Region | undefined> => {
    if (regionArea(left) <= SPLIT_SLIVER) return Ok({ pieces: [] })
    return port
      .offset(left, -reach)
      .andThen((grown) => port.intersect(grown, region))
      .andThen((grown) =>
        opening(region).andThen((all) =>
          port.intersect(left, all).andThen((needed) =>
            opening(grown)
              .andThen((reached) => port.difference(needed, reached))
              .map((missed) => (regionArea(missed) <= SPLIT_SLIVER ? grown : undefined)),
          ),
        ),
      )
  })
  return split.mapOr(undefined, (x) => x)
}

/**
 * Whether a v0.1 rectangle pocket (centre and size in the face frame of `face`) has a corner
 * that is a wall: the middle of its corner arc (the vertex when sharp) lies inside the stock face,
 * more than `ON_EDGE` from its edge. A corner on the stock edge or beyond it is reached from
 * outside the stock (open sides, DF61 follow-up), so it does not constrain the tool – the same
 * rule as a general shape's corners (`shapeMeasure` with the face).
 */
export function rectangleWallCorner(
  center: readonly [number, number],
  rect: { readonly length: number; readonly width: number; readonly cornerRadius: number },
  face: Pick<StockGeometry, 'length' | 'width'>,
): boolean {
  const inset = rect.cornerRadius * (1 - Math.SQRT1_2)
  const du = rect.length / 2 - inset
  const dv = rect.width / 2 - inset
  for (const su of [-1, 1])
    for (const sv of [-1, 1]) {
      const u = center[0] + su * du
      const v = center[1] + sv * dv
      if (Math.min(u, v, face.length - u, face.width - v) > ON_EDGE) return true
    }
  return false
}
