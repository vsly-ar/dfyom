/**
 * Split layout (split parts 4a): the part's footprint (the inside of its one through outline
 * profile, else the stock rectangle), the cells that the split's lines and levels cut it into,
 * and each non-empty cell's region, bounds and number. Pure; the 2D port does the booleans.
 * Doc: docs/modes/split-parts.md#split, docs/modes/split-parts.md#source-and-pieces
 */
import { Err, Ok, type AppResult } from '../../../shared/result'
import type { Region2dPort } from '../../geometry/2d/port'
import {
  arc,
  chainBounds,
  line,
  regionArea,
  regionLoops,
  type Bounds2,
  type Element,
  type Loop,
  type Region,
} from '../../geometry/2d/model'
import { translateRegion } from '../../geometry/2d/place'
import type { OperationGeometry, Shape as ShapeGeometry } from '../../geometry/model'
import type { Operation } from '../operation'
import type { SplitDTO } from '../part.dto'
import { STOCK_TOP } from '../surfaces'

/** Lengths below this (mm) are equal; regions below `EPS²` are empty. */
export const EPS = 1e-6

/** An axis-aligned rectangle in the part frame (mm). */
export interface Rect {
  readonly x0: number
  readonly x1: number
  readonly y0: number
  readonly y1: number
}

/** A Z band of the part frame (z ≤ 0 down from the stock top): bottom and top (mm). */
export interface Band {
  readonly zb: number
  readonly zt: number
}

/** The split's numbers (mm), sorted. */
export interface SplitNumbers {
  readonly id: string
  readonly xs: readonly number[]
  readonly ys: readonly number[]
  readonly levels: readonly number[]
  readonly margin: number
}

export function splitNumbers(split: SplitDTO): SplitNumbers {
  const mm = (q: { exact: { num: string; den: string } }) =>
    Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))
  const sorted = (a: number[]) => [...new Set(a)].sort((p, q) => p - q)
  return {
    id: split.id,
    xs: sorted(split.lines.filter((l) => l.axis === 'x').map((l) => mm(l.at))),
    ys: sorted(split.lines.filter((l) => l.axis === 'y').map((l) => mm(l.at))),
    levels: sorted(split.levels.map(mm)),
    margin: mm(split.margin),
  }
}

/** One non-empty cell: a piece-to-be. */
export interface Cell {
  /** 1-based, by position: X, then Y, then Z, from the front-left bottom. */
  readonly n: number
  readonly ix: number
  readonly iy: number
  readonly iz: number
  readonly rect: Rect
  readonly band: Band
  /** The footprint inside `rect` (part frame). */
  readonly region: Region
  /** Bounds of `region`. */
  readonly bounds: Bounds2
}

export interface Footprint {
  /** Index of the one through outline profile; undefined = none (`noOutline`, the stock rectangle). */
  readonly outline: number | undefined
  /** The part frame region of the footprint. */
  readonly region: Region
}

export interface Layout {
  readonly footprint: Footprint
  readonly cells: readonly Cell[]
  readonly stock: { readonly length: number; readonly width: number; readonly thickness: number }
}

/** A rounded rectangle's counter-clockwise loop (corner radius 0: four lines). */
export function rectLoop(c: readonly [number, number], l: number, w: number, r = 0): Loop {
  const x0 = c[0] - l / 2
  const x1 = c[0] + l / 2
  const y0 = c[1] - w / 2
  const y1 = c[1] + w / 2
  const rr = Math.min(r, l / 2, w / 2)
  const els: Element[] = []
  const seg = (a: readonly [number, number], b: readonly [number, number]) => {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > EPS) els.push(line(a, b))
  }
  if (rr <= EPS) {
    seg([x0, y0], [x1, y0])
    seg([x1, y0], [x1, y1])
    seg([x1, y1], [x0, y1])
    seg([x0, y1], [x0, y0])
    return { elements: els }
  }
  seg([x0 + rr, y0], [x1 - rr, y0])
  els.push(arc([x1 - rr, y0], [x1, y0 + rr], [x1 - rr, y0 + rr], true))
  seg([x1, y0 + rr], [x1, y1 - rr])
  els.push(arc([x1, y1 - rr], [x1 - rr, y1], [x1 - rr, y1 - rr], true))
  seg([x1 - rr, y1], [x0 + rr, y1])
  els.push(arc([x0 + rr, y1], [x0, y1 - rr], [x0 + rr, y1 - rr], true))
  seg([x0, y1 - rr], [x0, y0 + rr])
  els.push(arc([x0, y0 + rr], [x0 + rr, y0], [x0 + rr, y0 + rr], true))
  return { elements: els }
}

export const rectRegion = (r: Rect): Region => ({
  pieces: [
    {
      outer: rectLoop([(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2], r.x1 - r.x0, r.y1 - r.y0),
      holes: [],
    },
  ],
})

/**
 * A shape geometry's region in its face frame: analytic rectangles and circles built here,
 * general shapes from their placed region; undefined for an open path.
 */
export function shapeRegion(s: ShapeGeometry): Region | undefined {
  const c = s.center
  switch (s.contour.kind) {
    case 'rectangle':
      return {
        pieces: [
          {
            outer: rectLoop(c, s.contour.length, s.contour.width, s.contour.cornerRadius),
            holes: [],
          },
        ],
      }
    case 'circle': {
      const a: [number, number] = [c[0] + s.contour.radius, c[1]]
      return { pieces: [{ outer: { elements: [arc(a, a, c, true)] }, holes: [] }] }
    }
    case 'region':
      return translateRegion(s.contour.region, c)
    default:
      return undefined
  }
}

export const regionBounds = (r: Region): Bounds2 | undefined =>
  chainBounds(regionLoops(r).flatMap((l) => l.elements))

/**
 * The through outline profile: the one `outside`, through profile on the stock top with a closed
 * shape. Several or none: undefined (the footprint is the stock rectangle).
 */
export function outlineIndex(
  ops: readonly Operation[],
  geometry: readonly OperationGeometry[],
): number | undefined {
  const found = ops.flatMap((op, i) => {
    const g = geometry[i]
    if (op.kind !== 'profile' || g?.kind !== 'profile') return []
    if (op.side !== 'outside' || op.depth.isSome() || op.on !== STOCK_TOP) return []
    return shapeRegion(g.shape) === undefined ? [] : [i]
  })
  return found.length === 1 ? found[0] : undefined
}

/** The layout of a split on a part (stock sizes in mm, geometry input of its operations). */
export function splitLayout(
  port: Region2dPort,
  split: SplitNumbers,
  stock: Layout['stock'],
  ops: readonly Operation[],
  geometry: readonly OperationGeometry[],
): AppResult<Layout> {
  const outline = outlineIndex(ops, geometry)
  const stockRect: Rect = { x0: 0, x1: stock.length, y0: 0, y1: stock.width }
  let footprint = rectRegion(stockRect)
  if (outline !== undefined) {
    const g = geometry[outline] as Extract<OperationGeometry, { kind: 'profile' }>
    const r = port.normalise(regionLoops(shapeRegion(g.shape)!))
    if (r.isErr()) return Err(r.unwrapErr().withContext('splitLayout'))
    footprint = r.unwrap()
  }
  // facings over the whole face: a band above the top facings' floor (or below the bottom's) is air
  let top = 0
  let bottom = -stock.thickness
  ops.forEach((op, i) => {
    const g = geometry[i]
    if (op.kind !== 'facing' || g?.kind !== 'facing') return
    if (g.direction === undefined) top = Math.min(top, -g.depth)
    else if (g.direction === '-z') bottom = Math.max(bottom, -stock.thickness + g.depth)
  })
  const xs = [0, ...split.xs, stock.length]
  const ys = [0, ...split.ys, stock.width]
  const zs = [-stock.thickness, ...split.levels, 0]
  const cells: Cell[] = []
  for (let iz = 0; iz + 1 < zs.length; iz++) {
    const band = { zb: zs[iz]!, zt: zs[iz + 1]! }
    if (band.zb >= top - EPS || band.zt <= bottom + EPS) continue
    for (let iy = 0; iy + 1 < ys.length; iy++)
      for (let ix = 0; ix + 1 < xs.length; ix++) {
        const rect = { x0: xs[ix]!, x1: xs[ix + 1]!, y0: ys[iy]!, y1: ys[iy + 1]! }
        let region = rectRegion(rect)
        if (outline !== undefined) {
          const r = port.intersect(footprint, region)
          if (r.isErr()) return Err(r.unwrapErr().withContext('splitLayout'))
          region = r.unwrap()
        }
        if (regionArea(region) < 1e-3) continue
        const bounds = regionBounds(region)
        if (bounds === undefined) continue
        cells.push({ n: cells.length + 1, ix, iy, iz, rect, band, region, bounds })
      }
  }
  return Ok({ footprint: { outline, region: footprint }, cells, stock })
}
