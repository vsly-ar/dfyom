/**
 * Coverage oracle for pockets of regions (spike S4's three-way classification,
 * docs/modes/plan-v0.3.md#tests): the toolpath heightmap (`Heightmap.sweep`) against the region
 * and its tool-centre region C0 = offset(region, R). Each cell centre inside the region is
 * **reachable** when within R − tol of C0 and must be at the floor, else it is **leftover**; the
 * rest of the region is **rest** material and must stay; a cut more than tol outside the region
 * (walls, islands) is a **gouge**. Test-only.
 */
import type { Vec2, Vec3 } from '../../geometry/model'
import { chainBounds, regionLoops, type Loop, type Region } from '../../geometry/2d/model'
import { flattenLoop, segmentGrid } from '../../geometry/2d/testing/oracles'
import type { Toolpath, ToolpathTool } from '../model'
import { LINK_RADIAL_MARGIN } from '../links'
import { SLOT_CLEARANCE } from '../region-pocket'
import { Heightmap, samples, steps } from './oracles'

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

/** Feed moves that cut air (DF122 R3), lengths in mm. */
export interface AirCut {
  /** Horizontal feed length that removes more than `tol` somewhere. */
  readonly cutting: number
  /** Horizontal feed length that removes nothing (links, bridges, rings in air the roughing or the tool's own earlier rings cleared). */
  readonly air: number
  /** Vertical feed plunges that remove more than `tol` (into uncut material). */
  readonly plunges: number
}

/**
 * Area (mm²) where two cut sequences leave heights more than `tol` apart (DF122 R3: roughing +
 * rest against the pocket's tool alone). Test-only.
 */
export function heightDifference(
  size: { length: number; width: number },
  a: readonly { readonly tool: ToolpathTool; readonly tp: Toolpath }[],
  b: readonly { readonly tool: ToolpathTool; readonly tp: Toolpath }[],
  cell = 0.1,
  tol = 0.02,
): number {
  const ha = new Heightmap(size.length, size.width, cell)
  const hb = new Heightmap(size.length, size.width, cell)
  for (const x of a) ha.sweep(x.tool, x.tp, cell)
  for (const x of b) hb.sweep(x.tool, x.tp, cell)
  let n = 0
  for (let i = 0; i < ha.z.length; i++) if (Math.abs(ha.z[i]! - hb.z[i]!) > tol) n++
  return n * cell * cell
}

/**
 * Sweeps `before` (the roughing), then the rough passes of `tp` move by move, sorting their
 * horizontal feed moves into cutting and air by whether any cell drops more than `tol` under the
 * tool shrunk by `radial` (a sliver at the disc's edge is the rest tolerance, not material).
 * Test-only.
 */
export function airCut(
  tp: Toolpath,
  tool: ToolpathTool,
  size: { length: number; width: number },
  before: readonly { readonly tool: ToolpathTool; readonly tp: Toolpath }[],
  cell = 0.1,
  tol = 0.02,
  radial = 0.02,
): AirCut {
  // a material sliver thinner than `radial` at the disc's edge counts as air (the rest tolerance)
  const slim = { ...tool, diameter: tool.diameter - 2 * radial }
  const hm = new Heightmap(size.length, size.width, cell)
  for (const b of before) hm.sweep(b.tool, b.tp, cell)
  let cutting = 0
  let air = 0
  let plunges = 0
  const rough = new Set(tp.passes.filter((p) => p.kind === 'rough').flatMap((p) => p.moves))
  for (const s of steps(tp)) {
    if (s.move.kind === 'rapid') continue
    const pts = samples(s, cell)
    let most = 0
    for (const p of pts) {
      most = Math.max(most, hm.probe(slim, p))
      hm.stamp(tool, p)
    }
    if (!rough.has(s.move)) continue
    const a = pts[0]!
    const b = pts.at(-1)!
    if (Math.abs(a[2] - b[2]) > 1e-9 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) {
      if (b[2] < a[2] && most > tol) plunges++
      continue
    }
    let length = 0
    for (let i = 1; i < pts.length; i++)
      length += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1])
    if (most > tol) {
      cutting += length
      continue
    }
    air += length
  }
  return { cutting, air, plunges }
}

/** Margins `rapidClearance` checks (mm). */
export interface RapidMargins {
  /** Rapids wholly at or above this Z are not checked beyond collision (the retract plane). */
  readonly retractZ: number
  /** A rapid down below `retractZ` ends at least this over the material under the tool. */
  readonly vertical: number
  /** A horizontal rapid below `retractZ` passes at least this over the material… */
  readonly horizontal: number
  /** …under the tool's disc grown by this. */
  readonly radial: number
}

/**
 * Rapids against the material the toolpath (after `before`) has left when they run (DF136 low
 * entries and links inside a pocket): no rapid enters material (the tool's exact profile, from
 * the tip up); a rapid down below the retract plane ends at least `vertical` over the material
 * in its own column; a horizontal rapid below it passes at least `horizontal` over every cell
 * within the tool's radius + `radial`. Both margins less one cell (the heightmap's raster).
 * Returns the failures. Test-only.
 */
export function rapidClearance(
  tp: Toolpath,
  tool: ToolpathTool,
  size: { length: number; width: number },
  margins: RapidMargins,
  opts: {
    readonly before?: readonly { readonly tool: ToolpathTool; readonly tp: Toolpath }[]
    readonly cell?: number
    /** The heightmap's (0, 0) in toolpath coordinates. */
    readonly origin?: Vec2
    /** The stock top's Z in toolpath coordinates (the heightmap starts flat there). */
    readonly top?: number
    /** The heightmap to cut (`size` and `cell` unused), to read the result afterwards. */
    readonly heightmap?: Heightmap
  } = {},
): string[] {
  const { before = [], origin = [0, 0], top = 0 } = opts
  const hm = opts.heightmap ?? new Heightmap(size.length, size.width, opts.cell ?? 0.1)
  const cell = hm.cell
  const at = (p: Vec3, dz = 0): Vec3 => [p[0] - origin[0], p[1] - origin[1], p[2] - top + dz]
  const sweep = (t: ToolpathTool, x: Toolpath) => {
    for (const s of steps(x))
      if (s.move.kind !== 'rapid') for (const p of samples(s, cell)) hm.stamp(t, at(p))
  }
  for (const b of before) sweep(b.tool, b.tp)
  const grown = {
    ...tool,
    diameter: tool.diameter + 2 * Math.max(0, margins.radial - cell),
  }
  const out: string[] = []
  const fmt = (p: Vec3) => p.map((n) => n.toFixed(3)).join(',')
  for (const s of steps(tp)) {
    const m = s.move
    if (m.kind !== 'rapid') {
      for (const p of samples(s, cell)) hm.stamp(tool, at(p))
      continue
    }
    const pts = samples(s, cell)
    const hit = pts.find((p) => hm.probe(tool, at(p)) > 1e-6)
    if (hit !== undefined) {
      out.push(`rapid into material at ${fmt(hit)}`)
      continue
    }
    const horizontal = Math.hypot(m.to[0] - s.from[0], m.to[1] - s.from[1]) > 1e-9
    if (horizontal) {
      if (Math.min(s.from[2], m.to[2]) >= margins.retractZ - 1e-9) continue
      const low = pts.find((p) => hm.probe(grown, at(p, -(margins.horizontal - cell))) > 1e-6)
      if (low !== undefined) out.push(`low rapid within the margins at ${fmt(low)}`)
    } else if (m.to[2] < s.from[2] && m.to[2] < margins.retractZ - 1e-9) {
      if (hm.probe(tool, at(m.to, -(margins.vertical - 1e-6))) > 1e-6)
        out.push(`rapid down to ${fmt(m.to)}: less than ${margins.vertical} over the material`)
    }
  }
  return out
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

/**
 * `rapidClearance` of a region pocket's toolpath over its own stock (flat at `onZ`, the region's
 * box + 10 mm), with the generator's margins: the entry clearance down, the retract height and
 * the safe-links radial margin across; `before`: the cuts that ran first (a roughing). Test-only.
 */
export function pocketRapids(
  tp: Toolpath,
  inp: {
    readonly tool: ToolpathTool
    readonly heights: { readonly retractHeight: number }
    readonly operation: { readonly region: Region; readonly onZ: number }
  },
  cell = 0.1,
  before: readonly { readonly tool: ToolpathTool; readonly tp: Toolpath }[] = [],
): string[] {
  const box = chainBounds(inp.operation.region.pieces.flatMap((p) => p.outer.elements))
  if (box === undefined) return []
  const pad = 10
  const origin: Vec2 = [box.min[0] - pad, box.min[1] - pad]
  return rapidClearance(
    tp,
    inp.tool,
    { length: box.max[0] - box.min[0] + 2 * pad, width: box.max[1] - box.min[1] + 2 * pad },
    {
      retractZ: inp.operation.onZ + inp.heights.retractHeight,
      vertical: SLOT_CLEARANCE,
      horizontal: inp.heights.retractHeight,
      radial: LINK_RADIAL_MARGIN,
    },
    { cell, origin, top: inp.operation.onZ, before },
  )
}
