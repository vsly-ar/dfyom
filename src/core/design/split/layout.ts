/**
 * Split layout (split parts 4a): the part's footprint (the inside of its one through outline
 * profile, else the stock rectangle), the cells that the split's lines and levels cut it into,
 * and each non-empty cell's region, bounds and number. Pure; the 2D port does the booleans.
 * Doc: docs/modes/split-parts.md#split, docs/modes/split-parts.md#source-and-pieces
 */
import type { Issue } from '../../../shared/errors/app-error'
import { Err, fail, Ok, type AppResult } from '../../../shared/result'
import type { Region2dPort } from '../../geometry/2d/port'
import {
  arc,
  arcRadius,
  arcSweep,
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
import type { OperationGeometry, Shape as ShapeGeometry, Vec2 } from '../../geometry/model'
import type { Operation } from '../operation'
import { isShapeLine, type SplitDTO } from '../part.dto'
import type { ShapeDTO } from '../shape.dto'
import { definitionOf, resolveShape, shapeFromDTO } from '../shape'
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
  /**
   * Every line as a path in the part frame when one of them is a shape line (4e): the layout's
   * cells are then regions; undefined = straight lines only, 4a's rectangles.
   */
  readonly paths?: readonly LinePath[] | undefined
}

/** A split line as a path in the part frame, edge to edge (split parts 4e). */
export interface LinePath {
  /** Index into `split.lines`. */
  readonly index: number
  readonly path: Loop
  /** A shape line's shape id; undefined for a straight line. */
  readonly shapeId?: string | undefined
}

export function splitNumbers(split: SplitDTO): SplitNumbers {
  const mm = (q: { exact: { num: string; den: string } }) =>
    Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))
  const sorted = (a: number[]) => [...new Set(a)].sort((p, q) => p - q)
  return {
    id: split.id,
    xs: sorted(split.lines.flatMap((l) => (!isShapeLine(l) && l.axis === 'x' ? [mm(l.at)] : []))),
    ys: sorted(split.lines.flatMap((l) => (!isShapeLine(l) && l.axis === 'y' ? [mm(l.at)] : []))),
    levels: sorted(split.levels.map(mm)),
    margin: mm(split.margin),
  }
}

/**
 * The split's numbers with its lines as paths when one is a shape line (4e): the layout's input.
 * Fails as `splitLinePaths`.
 */
export function splitNumbersOf(
  port: Region2dPort,
  split: SplitDTO,
  shapes: readonly ShapeDTO[] | undefined,
  stock: { readonly length: number; readonly width: number },
): AppResult<SplitNumbers> {
  return splitLinePaths(port, split, shapes, stock).map((paths) => ({
    ...splitNumbers(split),
    paths,
  }))
}

/** One non-empty cell: a piece-to-be. */
export interface Cell {
  /** 1-based, by position: X, then Y, then Z, from the front-left bottom. */
  readonly n: number
  readonly ix: number
  readonly iy: number
  readonly iz: number
  /** The cell's rectangle (4a); with shape lines (4e) the bounds of `cut`. */
  readonly rect: Rect
  readonly band: Band
  /**
   * With shape lines (4e): the cell's region of the stock before the footprint (one piece, no
   * holes), the region its lines' sides make; undefined for 4a's rectangles.
   */
  readonly cut?: Region | undefined
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
  /** Every line as a path when one is a shape line (4e); undefined = 4a's rectangles. */
  readonly paths?: readonly LinePath[] | undefined
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
  if (split.paths !== undefined)
    return regionLayout(port, split, split.paths, stock, footprint, outline, top, bottom)
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

// ── split lines as shapes (4e) ──────────────────────────────────────────────────────────────

/** A shape line's ends must lie this close (mm) to the stock's edge, or outside it. */
export const LINE_END_TOLERANCE = 0.01

/**
 * Every line of `split` as a path in the part frame when one of them is a shape line (4e); Ok
 * undefined when all are straight (4a's rectangles). A shape line must be an open path of a
 * named shape (`lineShape`), reach the stock's edge at both ends (`lineEnds`) and not cross
 * itself (`lineCrossing`): `model.invariant` at `split.lines.<i>`.
 * Doc: docs/modes/split-parts.md#implementation-4e
 */
export function splitLinePaths(
  port: Region2dPort,
  split: SplitDTO,
  shapes: readonly ShapeDTO[] | undefined,
  stock: { readonly length: number; readonly width: number },
): AppResult<readonly LinePath[] | undefined> {
  if (!split.lines.some(isShapeLine)) return Ok(undefined)
  const L = stock.length
  const W = stock.width
  const mm = (q: { exact: { num: string; den: string } }) =>
    Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))
  const issues: Issue[] = []
  const out: LinePath[] = []
  split.lines.forEach((l, index) => {
    if (!isShapeLine(l)) {
      const at = mm(l.at)
      // the X line drawn +Y and the Y line drawn −X: the lower piece is on the left (4b-2's male)
      out.push({
        index,
        path: { elements: [l.axis === 'x' ? line([at, 0], [at, W]) : line([L, at], [0, at])] },
      })
      return
    }
    const at = ['split', 'lines', index]
    const path = shapeLinePath(port, l.shape, shapes)
    if (path === undefined) {
      issues.push({
        path: at,
        rule: 'lineShape',
        message: `${l.shape} must be a named shape of this part that is one open path`,
        params: { shapeId: l.shape },
      })
      return
    }
    const els = path.elements
    const ends = [els[0]!.a, els[els.length - 1]!.b]
    const t = LINE_END_TOLERANCE
    const onEdge = (p: Vec2) => p[0] <= t || p[0] >= L - t || p[1] <= t || p[1] >= W - t
    if (!ends.every(onEdge)) {
      issues.push({
        path: at,
        rule: 'lineEnds',
        message: `${l.shape} must run from edge to edge of the stock: both ends on or outside it`,
        params: { shapeId: l.shape },
      })
      return
    }
    if (selfCrossing(els)) {
      issues.push({
        path: at,
        rule: 'lineCrossing',
        message: `${l.shape} crosses itself`,
        params: { shapeId: l.shape },
      })
      return
    }
    out.push({ index, path, shapeId: l.shape })
  })
  if (issues.length > 0)
    return fail('model.invariant', issues.map((i) => i.message).join('; '), {
      issues,
      where: 'splitLinePaths',
    })
  return Ok(out)
}

/** A named shape's open path in its own frame (= the part frame's top), else undefined. */
export function shapeLinePath(
  port: Region2dPort,
  shapeId: string,
  shapes: readonly ShapeDTO[] | undefined,
): Loop | undefined {
  const dto = shapes?.find((x) => x.id === shapeId)
  if (dto === undefined || dto.pattern !== undefined) return undefined
  const named = shapeFromDTO(dto)
  if (named.isErr()) return undefined
  const resolved = resolveShape(port, definitionOf(named.unwrap().items))
  if (resolved.isErr()) return undefined
  const r = resolved.unwrap()
  return r.kind === 'path' && r.path.elements.length > 0 ? r.path : undefined
}

/** Points along a chain: lines by their ends, arcs every ≤ 3°. */
export function chainPoints(els: readonly Element[]): Vec2[] {
  const pts: Vec2[] = [els[0]!.a]
  for (const e of els) {
    if (e.kind === 'arc') {
      const sweep = arcSweep(e)
      const r = arcRadius(e)
      const a0 = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
      const n = Math.max(2, Math.ceil(Math.abs(sweep) / ((3 * Math.PI) / 180)))
      for (let k = 1; k < n; k++) {
        const a = a0 + (sweep * k) / n
        pts.push([e.centre[0] + r * Math.cos(a), e.centre[1] + r * Math.sin(a)])
      }
    }
    pts.push(e.b)
  }
  return pts
}

/** Whether two segments cross properly (a shared end is no crossing). */
function segmentsCross(p: Vec2, q: Vec2, r: Vec2, s: Vec2): boolean {
  const d = (a: Vec2, b: Vec2, c: Vec2) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const d1 = d(r, s, p)
  const d2 = d(r, s, q)
  const d3 = d(p, q, r)
  const d4 = d(p, q, s)
  return d1 * d2 < -1e-12 && d3 * d4 < -1e-12
}

/** Whether an open chain crosses itself (tessellated; neighbouring segments share an end). */
function selfCrossing(els: readonly Element[]): boolean {
  const pts = chainPoints(els)
  for (let i = 0; i + 1 < pts.length; i++)
    for (let j = i + 2; j + 1 < pts.length; j++)
      if (segmentsCross(pts[i]!, pts[i + 1]!, pts[j]!, pts[j + 1]!)) return true
  return false
}

/**
 * The left side of a line (4e): the path, its ends carried straight out to a box around the stock
 * and the path, closed round that box counter-clockwise.
 */
function lineSide(port: Region2dPort, path: Loop, stock: Layout['stock']): AppResult<Region> {
  const els = path.elements
  const b = chainBounds(els)!
  const x0 = Math.min(0, b.min[0]) - 10
  const y0 = Math.min(0, b.min[1]) - 10
  const x1 = Math.max(stock.length, b.max[0]) + 10
  const y1 = Math.max(stock.width, b.max[1]) + 10
  // the nearest side of the box to a point: 0 bottom, 1 right, 2 top, 3 left
  const out = (p: Vec2): { side: number; q: Vec2 } => {
    const d = [p[1] - y0, x1 - p[0], y1 - p[1], p[0] - x0]
    const side = d.indexOf(Math.min(...d))
    const q: Vec2 =
      side === 0 ? [p[0], y0] : side === 1 ? [x1, p[1]] : side === 2 ? [p[0], y1] : [x0, p[1]]
    return { side, q }
  }
  const s = out(els[0]!.a)
  const e = out(els[els.length - 1]!.b)
  // corner k ends side k, counter-clockwise
  const corners: Vec2[] = [
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ]
  // the distance along the counter-clockwise perimeter from the bottom-left corner
  const perim = (side: number, q: Vec2) =>
    side === 0
      ? q[0] - x0
      : side === 1
        ? x1 - x0 + (q[1] - y0)
        : side === 2
          ? x1 - x0 + (y1 - y0) + (x1 - q[0])
          : 2 * (x1 - x0) + (y1 - y0) + (y1 - q[1])
  const walk: Vec2[] = []
  if (!(s.side === e.side && perim(s.side, s.q) > perim(e.side, e.q))) {
    let side = e.side
    do {
      walk.push(corners[side]!)
      side = (side + 1) % 4
    } while (side !== s.side)
  }
  const pts: Vec2[] = [e.q, ...walk, s.q]
  const elements: Element[] = []
  const seg = (a: Vec2, c: Vec2) => {
    if (Math.hypot(c[0] - a[0], c[1] - a[1]) > EPS) elements.push(line(a, c))
  }
  seg(s.q, els[0]!.a)
  elements.push(...els)
  seg(els[els.length - 1]!.b, e.q)
  for (let k = 0; k + 1 < pts.length; k++) seg(pts[k]!, pts[k + 1]!)
  return port.normalise([{ elements }])
}

/**
 * The cells of a split with shape lines (4e): the stock cut by one side of every line into
 * connected regions (`cut`), each intersected with the footprint; numbered by band, then the cut's
 * bounds centre Y, then X.
 */
function regionLayout(
  port: Region2dPort,
  split: SplitNumbers,
  paths: readonly LinePath[],
  stock: Layout['stock'],
  footprint: Region,
  outline: number | undefined,
  top: number,
  bottom: number,
): AppResult<Layout> {
  let parts: Region[] = [rectRegion({ x0: 0, x1: stock.length, y0: 0, y1: stock.width })]
  for (const p of paths) {
    const side = lineSide(port, p.path, stock)
    if (side.isErr()) return Err(side.unwrapErr().withContext('splitLayout'))
    const next: Region[] = []
    for (const r of parts) {
      const a = port.intersect(r, side.unwrap())
      if (a.isErr()) return Err(a.unwrapErr().withContext('splitLayout'))
      const b = port.difference(r, side.unwrap())
      if (b.isErr()) return Err(b.unwrapErr().withContext('splitLayout'))
      for (const x of [a.unwrap(), b.unwrap()])
        for (const piece of x.pieces) {
          const one = { pieces: [piece] }
          if (regionArea(one) >= 1e-3) next.push(one)
        }
    }
    parts = next
  }
  const cuts = parts.flatMap((cut) => {
    const b = regionBounds(cut)
    return b === undefined
      ? []
      : [{ cut, b, cx: (b.min[0] + b.max[0]) / 2, cy: (b.min[1] + b.max[1]) / 2 }]
  })
  cuts.sort((p, q) => (Math.abs(p.cy - q.cy) > 1e-6 ? p.cy - q.cy : p.cx - q.cx))
  const zs = [-stock.thickness, ...split.levels, 0]
  const cells: Cell[] = []
  for (let iz = 0; iz + 1 < zs.length; iz++) {
    const band = { zb: zs[iz]!, zt: zs[iz + 1]! }
    if (band.zb >= top - EPS || band.zt <= bottom + EPS) continue
    for (const [ix, c] of cuts.entries()) {
      const r = port.intersect(footprint, c.cut)
      if (r.isErr()) return Err(r.unwrapErr().withContext('splitLayout'))
      const region = r.unwrap()
      if (regionArea(region) < 1e-3) continue
      const bounds = regionBounds(region)
      if (bounds === undefined) continue
      const rect = { x0: c.b.min[0], x1: c.b.max[0], y0: c.b.min[1], y1: c.b.max[1] }
      cells.push({ n: cells.length + 1, ix, iy: 0, iz, rect, band, region, bounds, cut: c.cut })
    }
  }
  return Ok({ footprint: { outline, region: footprint }, cells, stock, paths })
}
