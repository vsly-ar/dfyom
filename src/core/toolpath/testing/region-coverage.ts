/**
 * Coverage oracle for pockets of regions (spike S4's three-way classification,
 * docs/modes/plan-v0.3.md#tests): the toolpath heightmap (`Heightmap.sweep`) against the region
 * and its tool-centre region C0 = offset(region, R). Each cell centre inside the region is
 * **reachable** when within R − tol of C0 and must be at the floor, else it is **leftover**; the
 * rest of the region is **rest** material and must stay; a cut more than tol outside the region
 * (walls, islands) is a **gouge**. Test-only.
 */
import type { Vec2 } from '../../geometry/model'
import { chainBounds, regionLoops, type Loop, type Region } from '../../geometry/2d/model'
import { flattenLoop, segmentGrid } from '../../geometry/2d/testing/oracles'
import type { Toolpath, ToolpathTool } from '../model'
import { Heightmap } from './oracles'

export interface Coverage {
  /** Reachable cells left above the floor (mm²). */
  readonly leftover: number
  /** Region cells the tool cannot reach, left uncut (mm²). */
  readonly rest: number
  /** Cells cut deeper than the stock top more than `tol` outside the region (mm²). */
  readonly gouge: number
  /** Region cells cut below the floor (mm²). */
  readonly belowFloor: number
  /** Tab cells (`tabs.inBand`) cut below the tab top (mm²); 0 without tabs. */
  readonly tabCut: number
  /** Tab cells kept at or above the tab top (mm²); 0 without tabs. */
  readonly tabKept: number
}

/**
 * Tabs of a profile (task T2): cells in a band must stay at the tab top; cells near a band (the
 * crescents the lifted tool leaves at the tab ends) are not classified.
 */
export interface CoverageTabs {
  readonly inBand: (p: Vec2) => boolean
  readonly nearBand: (p: Vec2) => boolean
  readonly top: number
}

type Poly = Vec2[]

/** Even-odd crossings of a row at height y, sorted. */
function rowSpans(polys: readonly Poly[], y: number): number[] {
  const xs: number[] = []
  for (const pts of polys)
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i]!
      const b = pts[j]!
      if (a[1] > y !== b[1] > y) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]))
    }
  return xs.sort((p, q) => p - q)
}

function inSpans(xs: readonly number[], x: number): boolean {
  let n = 0
  for (const v of xs) if (v < x) n++
  return n % 2 === 1
}

/** Distance to the nearest polygon edge (closing edges included), exact, through a segment grid. */
function distToPolys(polys: readonly Poly[]): (p: Vec2) => number {
  return segmentGrid(
    polys.flatMap((pts) => pts.map((b, i) => [pts[i === 0 ? pts.length - 1 : i - 1]!, b] as const)),
  )
}

/**
 * Sweeps the toolpath over `size` (from the origin) and classifies the cells. `floor` is the
 * pocket's floor Z (a through profile's: its breakthrough Z); the stock top is Z 0. For a
 * profile, `region` is the slot and `c0` the slot's tool-centre region.
 */
export function regionCoverage(
  region: Region,
  c0: Region,
  tp: Toolpath,
  tool: ToolpathTool,
  size: { length: number; width: number },
  floor: number,
  cell = 0.1,
  tol = 0.01,
  tabs?: CoverageTabs,
  /** Toolpaths cut before `tp` (DF108: a roughing pass before the rest machining). */
  before: readonly { readonly tool: ToolpathTool; readonly tp: Toolpath }[] = [],
): Coverage {
  const hm = new Heightmap(size.length, size.width, cell)
  for (const b of before) hm.sweep(b.tool, b.tp, cell)
  hm.sweep(tool, tp, cell)
  const regionPolys = regionLoops(region).map((l) => flattenLoop(l, 0.001))
  const c0Polys = regionLoops(c0).map((l) => flattenLoop(l, 0.001))
  const toRegion = distToPolys(regionPolys)
  const toC0 = distToPolys(c0Polys)
  const R = tool.diameter / 2
  const area = cell * cell
  let leftover = 0
  let rest = 0
  let gouge = 0
  let belowFloor = 0
  let tabCut = 0
  let tabKept = 0
  for (let j = 0; j < hm.ny; j++) {
    const y = (j + 0.5) * cell
    const spans = rowSpans(regionPolys, y)
    const c0Spans = rowSpans(c0Polys, y)
    for (let i = 0; i < hm.nx; i++) {
      const h = hm.z[j * hm.nx + i]!
      const p: Vec2 = [(i + 0.5) * cell, y]
      if (inSpans(spans, p[0])) {
        if (tabs !== undefined && tabs.inBand(p)) {
          if (h < tabs.top - 1e-6) tabCut += area
          else tabKept += area
          continue
        }
        if (tabs !== undefined && tabs.nearBand(p)) continue
        if (h < floor - 1e-6) belowFloor += area
        if (h <= floor + 1e-6) continue
        const d = inSpans(c0Spans, p[0]) ? 0 : toC0(p)
        if (d <= R - tol) leftover += area
        else rest += area
      } else if (h < -1e-9 && toRegion(p) > tol) gouge += area
    }
  }
  return { leftover, rest, gouge, belowFloor, tabCut, tabKept }
}

/** Loops moved so their bounding box starts at (margin, margin), and the heightmap size. */
export function placeLoops(
  loops: readonly Loop[],
  margin = 5,
): { loops: Loop[]; size: { length: number; width: number } } {
  const b = chainBounds(loops.flatMap((l) => l.elements))!
  const dx = margin - b.min[0]
  const dy = margin - b.min[1]
  const mv = (p: Vec2): Vec2 => [p[0] + dx, p[1] + dy]
  const moved = loops.map((l) => ({
    elements: l.elements.map((e) =>
      e.kind === 'line'
        ? { kind: 'line' as const, a: mv(e.a), b: mv(e.b) }
        : { kind: 'arc' as const, a: mv(e.a), b: mv(e.b), centre: mv(e.centre), ccw: e.ccw },
    ),
  }))
  return {
    loops: moved,
    size: { length: b.max[0] - b.min[0] + 2 * margin, width: b.max[1] - b.min[1] + 2 * margin },
  }
}
