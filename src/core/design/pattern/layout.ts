/**
 * A pattern's cells (patterns P1, P2): the lattice laid over the area (the boundary less the
 * margin), the cell placed at every node whose cell lies wholly inside (`whole`) or cut to the
 * area (`clip`, slivers dropped), emitted as region pieces with no boolean (cells are disjoint:
 * the overlap check below), so 2 000 cells resolve in milliseconds (S8 finding 2). `invert` makes
 * the cells holes of the area; a split piece's `clip` rectangle cuts the result last. P4: a
 * stacked pattern's area is the region of the pattern below it, less the margin.
 * Doc: docs/modes/patterns.md#owned-shape-and-operations, docs/modes/patterns.md#implementation-p1,
 * docs/modes/patterns.md#implementation-p2, docs/modes/patterns.md#implementation-p4,
 * docs/modes/patterns.md#implementation-p5 (flip, ghosts)
 *
 * Pure numbers (mm, degrees) and the 2D port; the cell's and the boundary's own resolution is
 * passed in (shape.ts resolves named shapes and primitives), so this module has no shape-layer
 * import.
 */
import type { Issue } from '../../../shared/errors/app-error'
import { Err, fail, Ok, type AppResult } from '../../../shared/result'
import type { Vec2 } from '../../geometry/model'
import { regionContains } from '../../geometry/2d/measure'
import {
  arcRadius,
  arcSweep,
  chainBounds,
  line,
  onSweep,
  regionArea,
  reverseLoop,
  type Bounds2,
  type Element,
  type Loop,
  type Region,
  type RegionPiece,
} from '../../geometry/2d/model'
import { orientRegion, translateRegion } from '../../geometry/2d/place'
import type { Region2dPort } from '../../geometry/2d/port'
import type { PatternRecord, ShapeItem } from '../shape.dto'
import { latticePairs, patternWeb, type LatticePair, type PatternWeb, type WebInput } from './web'

/** Most cells of one pattern (`patternTooMany`; S8: 2 000 with the P1 changes). */
export const PATTERN_CELLS_MAX = 2000
/**
 * Region chords from which a pattern is heavy (`dfm.patternHeavy`; S8: ≈ 150 cells of a
 * rounded hexagon, ≈ 5 000 chords at the evaluation's chord tolerance).
 */
export const PATTERN_HEAVY_CHORDS = 5000
/** Cells closer than this (mm) count as touching, i.e. overlapping (`patternOverlap`). */
export const PATTERN_MIN_WEB = 0.001
/**
 * A clipped fragment narrower than this (mm) is dropped (`fit: 'clip'`, P2); the fragments kept,
 * and an inverted pattern's pocket, are opened by half of it, so the sharp corners where a cell
 * meets the boundary become R 0.5 mm and a Ø 1 mm end mill fits them.
 */
export const PATTERN_SLIVER = 1
/** Neighbour offsets the overlap check measures at most; more means the pitch is far too small. */
const OVERLAP_CHECKS_MAX = 64
const SLACK = 1e-9
/** A cell whose area inside the area differs from its own by less than this share is inside. */
const AREA_SHARE = 1e-9

type ItemsDef = readonly ShapeItem<number>[]
/** What the resolver callback takes: items, or (P4) the pattern a stacked one stands on. */
type Def = ItemsDef | readonly [PatternDefinition]

/** A pattern as the resolver reads it: the record with the cell's (and boundary's) items. */
export interface PatternDefinition extends Omit<PatternRecord, 'cell' | 'area' | 'floor'> {
  readonly kind: 'pattern'
  readonly op: 'add'
  /** The cell's shape definition (a primitive item centred on the origin, or a named shape's). */
  readonly cell: ItemsDef
  /** A named boundary shape's items, placed (P2); absent = the face rectangle. */
  readonly area?:
    { readonly items: ItemsDef; readonly center: Vec2; readonly rotation: number } | undefined
  /** P4: the definition of the pattern this one is stacked on (its region bounds the area). */
  readonly floor?: readonly [PatternDefinition] | undefined
}

/** What the layout found besides the region (the read-out, DFM and the viewport). */
export interface PatternFacts {
  /** Cells laid out (inverted: islands). */
  readonly cells: number
  /** Clipped fragments dropped as slivers (`fit: 'clip'`). */
  readonly dropped: number
  /** The boundary less the margin, face frame (the viewport's dashed outline). */
  readonly area: Region
  /** The narrowest web (or island) when under the limit (`dfm.patternThinWeb`). */
  readonly web?: PatternWeb | undefined
  /** What the web is measured on (P3: again at twice a chamfer's width, `dfm.chamferMeets`). */
  readonly webInput?: WebInput | undefined
  /**
   * P5: the cells left out at the border (crossing the area with `whole`, or dropped as slivers
   * with `clip`), whole, face frame: the viewport's ghosts. At most `PATTERN_GHOSTS_MAX` pieces.
   */
  readonly ghosts?: Region | undefined
}

/** Ghost pieces kept at most (the viewport draws them dashed). */
export const PATTERN_GHOSTS_MAX = 500

/** The resolved cells: one region of disjoint pieces, in face-frame coordinates. */
export interface PatternCells extends PatternFacts {
  readonly region: Region
  /** The boundary rectangle: placement anchors by it, not by the cells (placement.ts). */
  readonly frame: Bounds2
  /** Pitch along the rows and between rows (mm; polar: along a ring and between rings). */
  readonly pitch: Vec2
}

type CellResult = AppResult<{ kind: 'region'; region: Region } | { kind: 'path' }>

const issue = (path: (string | number)[], rule: string, message: string, params?: object) =>
  ({
    path,
    rule,
    message,
    ...(params === undefined ? {} : { params: params as Record<string, unknown> }),
  }) satisfies Issue

function invalid(issues: Issue[]): AppResult<never> {
  return fail('model.invariant', issues.map((i) => i.message).join('; '), {
    issues,
    where: 'resolvePattern',
  })
}

const cosSin = (deg: number): Vec2 => {
  const r = (deg * Math.PI) / 180
  return [Math.cos(r), Math.sin(r)]
}
const rot = ([c, s]: Vec2, p: Vec2): Vec2 => [c * p[0] - s * p[1], s * p[0] + c * p[1]]

const regionElements = (r: Region): Element[] =>
  r.pieces.flatMap((p) => [...p.outer.elements, ...p.holes.flatMap((h) => h.elements)])
const boundsOf = (r: Region): Bounds2 | undefined => chainBounds(regionElements(r))

const rectLoop = (lo: Vec2, hi: Vec2): Loop => {
  const c: Vec2[] = [lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]]
  return { elements: c.map((p, i) => line(p, c[(i + 1) % 4]!)) }
}
const rectRegion = (lo: Vec2, hi: Vec2): Region => ({
  pieces: [{ outer: rectLoop(lo, hi), holes: [] }],
})

const inside = (b: Bounds2, lo: Vec2, hi: Vec2): boolean =>
  b.min[0] >= lo[0] - SLACK &&
  b.max[0] <= hi[0] + SLACK &&
  b.min[1] >= lo[1] - SLACK &&
  b.max[1] <= hi[1] + SLACK
const disjoint = (b: Bounds2, lo: Vec2, hi: Vec2): boolean =>
  b.max[0] < lo[0] - SLACK ||
  b.min[0] > hi[0] + SLACK ||
  b.max[1] < lo[1] - SLACK ||
  b.min[1] > hi[1] + SLACK

/** The farthest distance from the origin of any point of the region (its circumscribed radius). */
export function circumRadius(r: Region): number {
  let m = 0
  for (const e of regionElements(r)) {
    m = Math.max(m, Math.hypot(e.a[0], e.a[1]), Math.hypot(e.b[0], e.b[1]))
    if (e.kind === 'arc') {
      const c = Math.hypot(e.centre[0], e.centre[1])
      const start = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
      const far = c === 0 ? start : Math.atan2(e.centre[1], e.centre[0])
      if (onSweep(start, arcSweep(e), far)) m = Math.max(m, c + arcRadius(e))
    }
  }
  return m
}

/**
 * The pattern's cells. Issues (`model.invariant`) at the feature's field names: `cell`
 * (`patternCellOpen`: an open path), `boundary` (`patternBoundaryOpen`), `spacing` (`positive`,
 * `patternOverlap`: neighbouring cells overlap or touch), `spacing` (`patternTooMany`: more than
 * `PATTERN_CELLS_MAX` cells). No cell fitting is no error (`dfm.patternEmpty`).
 */
export function resolvePattern(
  port: Region2dPort,
  p: PatternDefinition,
  resolveCell: (def: Def) => CellResult,
): AppResult<PatternCells> {
  const resolved = resolveCell(p.cell)
  if (resolved.isErr()) return Err(resolved.unwrapErr().prefixIssues('cell'))
  const r = resolved.unwrap()
  if (r.kind !== 'region')
    return invalid([issue(['cell'], 'patternCellOpen', 'the cell must be a closed shape')])
  // P4: a through cell with a hole of its own would leave that island loose
  if (p.through === true && r.region.pieces.some((x) => x.holes.length > 0))
    return invalid([
      issue(
        ['cell'],
        'patternThroughIslands',
        'a cell with a hole cut through would leave its island loose: use a cell without holes or turn off Through',
      ),
    ])
  // the cell turned by its own rotation, its box centred on the origin (the node)
  const turned = orientRegion(r.region, { rotation: p.cellRotation, mirror: false })
  const tb = boundsOf(turned)!
  const centred = translateRegion(turned, [
    -(tb.min[0] + tb.max[0]) / 2,
    -(tb.min[1] + tb.max[1]) / 2,
  ])
  const ex = tb.max[0] - tb.min[0]
  const ey = tb.max[1] - tb.min[1]
  const polar = p.lattice === 'polar'
  // P5: every other cell turned 180° about its box centre (the same box)
  const flip = p.alternate === 'flip'
  const flippedCentred = flip ? orientRegion(centred, { rotation: 180, mirror: false }) : centred
  // polar: cells keep their orientation, so any two closer than the circumscribed diameter may
  // touch (P2)
  const diameter = 2 * circumRadius(centred)
  // pitch along the rows (a) and between rows (b); hex rows 60° apart
  let a: number
  let b: number
  if ('gap' in p.spacing) {
    const g = p.spacing.gap
    if (!(g > 0))
      return invalid([
        issue(['spacing', 'gap'], 'positive', 'must be greater than 0', { actual: g }),
      ])
    if (polar) a = b = diameter + g
    else if (flip) {
      // P5: flipped neighbours nest (triangles), so both pitches are bisected to a web of g
      const nested = flipPitches(port, centred, flippedCentred, ex, ey, g, p.lattice !== 'square')
      if (nested.isErr()) return nested
      ;[a, b] = nested.unwrap()
    } else {
      a = ex + g
      b = p.lattice === 'hex' ? (a * Math.sqrt(3)) / 2 : ey + g
    }
  } else {
    ;[a, b] = p.spacing.pitch
    if (!(a > 0 && b > 0))
      return invalid([
        issue(['spacing', 'pitch'], 'positive', 'both pitches must be greater than 0', {
          actual: [a, b],
        }),
      ])
  }
  const overlap = polar
    ? Ok(Math.min(a, b) < diameter + PATTERN_MIN_WEB)
    : cellsOverlap(port, [centred, flippedCentred], ex, ey, {
        a,
        b,
        shifted: p.lattice !== 'square',
        angle: 0,
        flip,
      })
  if (overlap.isErr()) return overlap
  if (overlap.unwrap())
    return invalid([
      issue(
        ['spacing'],
        'patternOverlap',
        polar
          ? `neighbouring cells may overlap (pitch ${round(a)} × ${round(b)} mm for a cell ${round(diameter)} mm across its corners): widen the spacing`
          : `neighbouring cells overlap or touch (pitch ${round(a)} × ${round(b)} mm for a ${round(ex)} × ${round(ey)} mm cell): widen the spacing`,
        { pitch: [round(a), round(b)], extent: polar ? [round(diameter)] : [round(ex), round(ey)] },
      ),
    ])

  // the area: the boundary less the margin
  const frame: Bounds2 = { min: [...p.boundary.min], max: [...p.boundary.max] }
  const empty: Region = { pieces: [] }
  const none: PatternCells = {
    region: empty,
    cells: 0,
    dropped: 0,
    area: empty,
    frame,
    pitch: [a, b],
  }
  const area = areaOf(port, p, resolveCell)
  if (area.isErr()) return area
  const { region: areaRegion, rect } = area.unwrap()
  const ab = boundsOf(areaRegion)
  if (ab === undefined) return Ok(none)
  const lo = ab.min
  const hi = ab.max
  const origin: Vec2 = p.origin ?? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2]
  const cell =
    polar || p.angle === 0 ? centred : orientRegion(centred, { rotation: p.angle, mirror: false })
  const cb = boundsOf(cell)!
  const cellArea = regionArea(cell)
  // P5: the flipped cell (about the node, so its box is the cell's mirrored through the node)
  const flipped = flip ? orientRegion(cell, { rotation: 180, mirror: false }) : cell
  const fb: Bounds2 = { min: [-cb.max[0], -cb.max[1]], max: [-cb.min[0], -cb.min[1]] }
  const cellAt = (f: boolean) => (f ? flipped : cell)

  const tooMany = () =>
    invalid([
      issue(
        ['spacing'],
        'patternTooMany',
        `more than ${PATTERN_CELLS_MAX} cells: widen the spacing, enlarge the cell or the margin`,
        { max: PATTERN_CELLS_MAX },
      ),
    ])
  const clip = p.fit === 'clip'
  const index = rect ? undefined : new EdgeIndex(regionElements(areaRegion))
  const whole: Vec2[] = []
  const wholeFlips: boolean[] = []
  const fragments: RegionPiece[] = []
  const ghosts: RegionPiece[] = []
  let crossing = 0
  let dropped = 0
  const keep = (n: Vec2, f: boolean) => {
    whole.push(n)
    wholeFlips.push(f)
  }
  const ghost = (n: Vec2, f: boolean) => {
    if (ghosts.length < PATTERN_GHOSTS_MAX) ghosts.push(...translateRegion(cellAt(f), n).pieces)
  }
  /** Sorts one node: kept whole, cut (clip), or left out (a ghost when it crosses the area). */
  const place = (n: Vec2, f: boolean): AppResult<void> => {
    const c = f ? fb : cb
    const box: Bounds2 = {
      min: [n[0] + c.min[0], n[1] + c.min[1]],
      max: [n[0] + c.max[0], n[1] + c.max[1]],
    }
    if (disjoint(box, lo, hi)) return Ok(undefined)
    let cut: Region | undefined
    if (rect) {
      if (inside(box, lo, hi)) {
        keep(n, f)
        return Ok(undefined)
      }
      if (!clip) {
        ghost(n, f)
        return Ok(undefined)
      }
    } else if (!index!.touches(box)) {
      if (regionContains(areaRegion, n)) keep(n, f)
      return Ok(undefined)
    } else {
      const x = port.intersect(translateRegion(cellAt(f), n), areaRegion)
      if (x.isErr()) return Err(x.unwrapErr())
      const share = regionArea(x.unwrap())
      if (share >= cellArea * (1 - AREA_SHARE)) {
        keep(n, f)
        return Ok(undefined)
      }
      if (share > cellArea * AREA_SHARE) ghost(n, f)
      if (!clip || share <= cellArea * AREA_SHARE) return Ok(undefined)
      cut = x.unwrap()
    }
    if (cut === undefined) {
      const x = port.intersect(translateRegion(cellAt(f), n), areaRegion)
      if (x.isErr()) return Err(x.unwrapErr())
      cut = x.unwrap()
      if (cut.pieces.length > 0) ghost(n, f)
    }
    let kept = false
    for (const piece of cut.pieces) {
      const opened = opening(port, { pieces: [piece] })
      if (opened.isErr()) return opened
      if (opened.unwrap().pieces.length === 0) dropped++
      else {
        // inverted, the raw fragment is subtracted and the pocket opened as a whole
        fragments.push(...(p.invert === true ? [piece] : opened.unwrap().pieces))
        kept = true
      }
    }
    if (kept) crossing++
    return Ok(undefined)
  }

  // nodes covering the area
  const nodes = polar
    ? polarNodes(origin, lo, hi, a, b, p.angle, flip)
    : rowNodes(origin, lo, hi, a, b, p, flip)
  for (const { at: n, flip: f } of nodes) {
    const done = place(n, f)
    if (done.isErr()) return done
    if (whole.length + crossing > PATTERN_CELLS_MAX) return tooMany()
  }

  let pieces: RegionPiece[] = []
  if (p.invert === true) {
    // our own sharp corners (the margin's rectangle, cells meeting the boundary) are rounded
    const round = fragments.length > 0 || (rect && p.margin > 0)
    const holes = invertCells(port, areaRegion, cellAt, whole, wholeFlips, fragments, round)
    if (holes.isErr()) return holes
    pieces = holes.unwrap()
  } else {
    whole.forEach((n, i) =>
      pieces.push(...translateRegion(cellAt(wholeFlips[i]!), [n[0] + 0, n[1] + 0]).pieces),
    )
    pieces.push(...fragments)
  }
  let region: Region = { pieces }
  if (p.clip !== undefined) {
    const c = clipToRect(port, region, p.clip.min, p.clip.max)
    if (c.isErr()) return c
    region = c.unwrap()
  }
  const webInput: WebInput = {
    cell,
    ...(flip ? { flipped, flips: wholeFlips } : {}),
    diameter,
    nodes: whole,
    invert: p.invert === true,
    lattice: polar
      ? undefined
      : { a, b, shifted: p.lattice !== 'square', angle: p.angle, ...(flip ? { flip } : {}) },
    centre: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2],
  }
  const web = patternWeb(port, webInput)
  return Ok({
    region,
    cells: whole.length + crossing,
    dropped,
    area: areaRegion,
    frame,
    pitch: [a, b],
    webInput,
    ...(web === undefined ? {} : { web }),
    ...(ghosts.length === 0 ? {} : { ghosts: { pieces: ghosts } }),
  })
}

const round = (x: number) => Math.round(x * 1000) / 1000

/** The region opened by `PATTERN_SLIVER / 2`: sharp convex corners rounded, thin parts gone. */
function opening(port: Region2dPort, r: Region): AppResult<Region> {
  return port
    .offset(r, PATTERN_SLIVER / 2)
    .andThen((s) => (s.pieces.length === 0 ? Ok(s) : port.offset(s, -PATTERN_SLIVER / 2)))
}

/**
 * The area (the boundary less the margin) in the face frame: the face rectangle shrunk by the
 * margin (`rect`: P1's box tests apply), or the named boundary placed and offset by the margin.
 */
function areaOf(
  port: Region2dPort,
  p: PatternDefinition,
  resolveCell: (def: Def) => CellResult,
): AppResult<{ region: Region; rect: boolean }> {
  const m = p.margin
  if (p.floor !== undefined) return stackedArea(port, p, p.floor, resolveCell)
  if (p.area === undefined) {
    const lo: Vec2 = [p.boundary.min[0] + m, p.boundary.min[1] + m]
    const hi: Vec2 = [p.boundary.max[0] - m, p.boundary.max[1] - m]
    if (!(hi[0] > lo[0] && hi[1] > lo[1])) return Ok({ region: { pieces: [] }, rect: true })
    return Ok({ region: rectRegion(lo, hi), rect: true })
  }
  const r = resolveCell(p.area.items)
  if (r.isErr()) return Err(r.unwrapErr().prefixIssues('boundary'))
  const s = r.unwrap()
  if (s.kind !== 'region')
    return invalid([
      issue(['boundary'], 'patternBoundaryOpen', 'the boundary must be a closed shape'),
    ])
  const turned = orientRegion(s.region, { rotation: p.area.rotation, mirror: false })
  const tb = boundsOf(turned)!
  const placed = translateRegion(turned, [
    p.area.center[0] - (tb.min[0] + tb.max[0]) / 2,
    p.area.center[1] - (tb.min[1] + tb.max[1]) / 2,
  ])
  if (!(m > 0)) return Ok({ region: placed, rect: false })
  return port.offset(placed, m).map((region) => ({ region, rect: false }))
}

/**
 * P4 (stacking, Q127): the area of a pattern on another one's floor: the lower pattern's region
 * (its cells, or inverted the web between its islands; same face frame) shrunk by the margin,
 * intersected with the boundary shape when one is given.
 */
function stackedArea(
  port: Region2dPort,
  p: PatternDefinition,
  floor: readonly [PatternDefinition],
  resolveCell: (def: Def) => CellResult,
): AppResult<{ region: Region; rect: boolean }> {
  const below = resolveCell(floor)
  if (below.isErr()) return Err(below.unwrapErr().prefixIssues('on'))
  const b = below.unwrap()
  if (b.kind !== 'region' || b.region.pieces.length === 0)
    return Ok({ region: { pieces: [] }, rect: false })
  const shrunk = p.margin > 0 ? port.offset(b.region, p.margin) : Ok(b.region)
  if (shrunk.isErr() || p.area === undefined)
    return shrunk.map((region) => ({ region, rect: false }))
  const own = areaOf(port, { ...p, floor: undefined }, resolveCell)
  if (own.isErr()) return own
  return port
    .intersect(own.unwrap().region, shrunk.unwrap())
    .map((region) => ({ region, rect: false }))
}

/** A lattice node and whether its cell is flipped (P5, `alternate: flip`). */
export interface LatticeNode {
  readonly at: Vec2
  readonly flip: boolean
}

/**
 * Row lattices (square, staggered, hex): nodes over the area's box, one pitch beyond. With
 * `flip` (P5), the node in column i of row j is flipped when i + j is odd (the origin's is not).
 */
function rowNodes(
  origin: Vec2,
  lo: Vec2,
  hi: Vec2,
  a: number,
  b: number,
  p: PatternDefinition,
  flip: boolean,
): LatticeNode[] {
  const shifted = p.lattice !== 'square'
  const cs = cosSin(p.angle)
  const inv: Vec2 = [cs[0], -cs[1]]
  const corners = [lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]].map((c) =>
    rot(inv, [c[0] - origin[0], c[1] - origin[1]]),
  )
  const qx0 = Math.min(...corners.map((c) => c[0]))
  const qx1 = Math.max(...corners.map((c) => c[0]))
  const qy0 = Math.min(...corners.map((c) => c[1]))
  const qy1 = Math.max(...corners.map((c) => c[1]))
  const j0 = Math.floor(qy0 / b) - 1
  const j1 = Math.ceil(qy1 / b) + 1
  const nodes: LatticeNode[] = []
  for (let j = j0; j <= j1; j++) {
    const s = shifted && ((j % 2) + 2) % 2 === 1 ? a / 2 : 0
    const i0 = Math.floor((qx0 - s) / a) - 1
    const i1 = Math.ceil((qx1 - s) / a) + 1
    for (let i = i0; i <= i1; i++) {
      const q = rot(cs, [i * a + s, j * b])
      nodes.push({
        at: [origin[0] + q[0], origin[1] + q[1]],
        flip: flip && (((i + j) % 2) + 2) % 2 === 1,
      })
    }
  }
  return nodes
}

/**
 * Polar nodes (P2): ring 0 is the origin, ring k at radius k·b holds ⌊π / asin(a / 2r)⌋ cells
 * (neighbours a chord of at least `a` apart), each ring starting at `angle`; rings out to the
 * area's farthest corner. With `flip` (P5) every odd cell of a ring is flipped. Exported for the
 * Presets dialog's polar previews (hardening P10), so they draw the layout's own rings.
 */
export function polarNodes(
  origin: Vec2,
  lo: Vec2,
  hi: Vec2,
  a: number,
  b: number,
  angle: number,
  flip: boolean,
): LatticeNode[] {
  const reach = Math.max(
    ...[lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]].map((c) =>
      Math.hypot(c[0] - origin[0], c[1] - origin[1]),
    ),
  )
  const nodes: LatticeNode[] = [{ at: [origin[0], origin[1]], flip: false }]
  const start = (angle * Math.PI) / 180
  // more rings than cells could fit is a pitch far too small: patternTooMany stops it
  const rings = Math.min(Math.ceil(reach / b) + 1, PATTERN_CELLS_MAX * 4)
  for (let k = 1; k <= rings; k++) {
    const r = k * b
    const n = a >= 2 * r ? 1 : Math.max(1, Math.floor(Math.PI / Math.asin(a / (2 * r)) + 1e-9))
    for (let i = 0; i < n; i++) {
      const t = start + (2 * Math.PI * i) / n
      nodes.push({
        at: [origin[0] + r * Math.cos(t), origin[1] + r * Math.sin(t)],
        flip: flip && i % 2 === 1,
      })
    }
    if (nodes.length > PATTERN_CELLS_MAX * 8) break
  }
  return nodes
}

/**
 * A bucket grid of the area's boundary elements by their boxes: a cell box that meets none of
 * them lies wholly inside or outside the area (one point test decides).
 */
class EdgeIndex {
  private readonly boxes: Bounds2[]
  private readonly grid = new Map<string, number[]>()
  private readonly size: number
  constructor(elements: readonly Element[]) {
    this.boxes = elements.map((e) => chainBounds([e])!)
    const all = chainBounds([...elements])!
    const span = Math.max(all.max[0] - all.min[0], all.max[1] - all.min[1], 1)
    this.size = span / Math.max(1, Math.ceil(Math.sqrt(elements.length)))
    this.boxes.forEach((bx, i) => {
      for (const k of this.keys(bx)) {
        const list = this.grid.get(k)
        if (list === undefined) this.grid.set(k, [i])
        else list.push(i)
      }
    })
  }
  private *keys(b: Bounds2): Generator<string> {
    const s = this.size
    for (let x = Math.floor(b.min[0] / s); x <= Math.floor(b.max[0] / s); x++)
      for (let y = Math.floor(b.min[1] / s); y <= Math.floor(b.max[1] / s); y++) yield `${x},${y}`
  }
  touches(b: Bounds2): boolean {
    const eps = 1e-6
    for (const k of this.keys(b))
      for (const i of this.grid.get(k) ?? []) {
        const e = this.boxes[i]!
        if (
          e.min[0] <= b.max[0] + eps &&
          e.max[0] >= b.min[0] - eps &&
          e.min[1] <= b.max[1] + eps &&
          e.max[1] >= b.min[1] - eps
        )
          return true
      }
    return false
  }
}

/** The piece of `pieces` whose outer loop holds `p` (holes ignored); -1 for none. */
function holder(pieces: readonly RegionPiece[], p: Vec2): number {
  for (let i = 0; i < pieces.length; i++) {
    const o = pieces[i]!.outer
    if (regionContains({ pieces: [{ outer: o, holes: [] }] }, p)) return i
  }
  return -1
}

/**
 * Inverted (P2): the area minus the cells. The clipped fragments are subtracted (few booleans)
 * and, with `round`, the result opened (`opening`); then each whole cell's outer loop goes in as
 * a hole of the piece holding it (no fold), and the cell's own holes become pieces.
 */
function invertCells(
  port: Region2dPort,
  area: Region,
  cellAt: (flipped: boolean) => Region,
  whole: readonly Vec2[],
  flips: readonly boolean[],
  fragments: readonly RegionPiece[],
  round: boolean,
): AppResult<RegionPiece[]> {
  let base = area
  if (fragments.length > 0) {
    const d = port.difference(area, { pieces: fragments })
    if (d.isErr()) return Err(d.unwrapErr())
    base = d.unwrap()
  }
  if (round) {
    const o = opening(port, base)
    if (o.isErr()) return Err(o.unwrapErr())
    base = o.unwrap()
  }
  const out = base.pieces.map((p) => ({ outer: p.outer, holes: [...p.holes] }))
  const extra: RegionPiece[] = []
  const boxes = out.map((p) => chainBounds(p.outer.elements)!)
  for (const [k0, n] of whole.entries()) {
    for (const piece of translateRegion(cellAt(flips[k0]!), [n[0] + 0, n[1] + 0]).pieces) {
      const at = piece.outer.elements[0]!.a
      const near = out.map((_, i) => i).filter((i) => !disjoint(boxes[i]!, at, at))
      const k = holder(
        near.map((i) => out[i]!),
        at,
      )
      if (k < 0) continue
      out[near[k]!]!.holes.push(reverseLoop(piece.outer))
      for (const h of piece.holes) extra.push({ outer: reverseLoop(h), holes: [] })
    }
  }
  return Ok([...out, ...extra])
}

/**
 * The region cut by the rectangle `lo`–`hi` (a split piece's cell, P2): pieces inside are kept,
 * pieces outside dropped; a crossing piece's outer loop is intersected, its holes inside the
 * rectangle go back in as holes, crossing holes are subtracted.
 */
export function clipToRect(
  port: Region2dPort,
  region: Region,
  lo: Vec2,
  hi: Vec2,
): AppResult<Region> {
  const rect = rectRegion(lo, hi)
  const out: RegionPiece[] = []
  for (const piece of region.pieces) {
    const pb = chainBounds(piece.outer.elements)!
    if (inside(pb, lo, hi)) {
      out.push(piece)
      continue
    }
    if (disjoint(pb, lo, hi)) continue
    const cut = port.intersect({ pieces: [{ outer: piece.outer, holes: [] }] }, rect)
    if (cut.isErr()) return Err(cut.unwrapErr())
    let pieces = cut.unwrap().pieces
    const inner: Loop[] = []
    const crossing: RegionPiece[] = []
    for (const h of piece.holes) {
      const hb = chainBounds(h.elements)!
      if (inside(hb, lo, hi)) inner.push(h)
      else if (!disjoint(hb, lo, hi)) crossing.push({ outer: reverseLoop(h), holes: [] })
    }
    if (crossing.length > 0) {
      const d = port.difference({ pieces }, { pieces: crossing })
      if (d.isErr()) return Err(d.unwrapErr())
      pieces = d.unwrap().pieces
    }
    const mutable = pieces.map((p) => ({ outer: p.outer, holes: [...p.holes] }))
    for (const h of inner) {
      const k = holder(mutable, h.elements[0]!.a)
      if (k >= 0) mutable[k]!.holes.push(h)
    }
    out.push(...mutable)
  }
  return Ok({ pieces: out })
}

/**
 * Whether the cell overlaps (or comes within `PATTERN_MIN_WEB` of) a neighbour: every lattice
 * pair at which the cells' boxes overlap is measured with the port (the cell grown by the web
 * against the moved cell). Translation invariance makes one cell enough (P5, flip: one of each
 * orientation, `cells` = [cell, flipped]; both have one box).
 */
function cellsOverlap(
  port: Region2dPort,
  cells: readonly [Region, Region],
  ex: number,
  ey: number,
  l: { a: number; b: number; shifted: boolean; angle: 0; flip: boolean },
): AppResult<boolean> {
  const nj = Math.ceil((ey + PATTERN_MIN_WEB) / l.b)
  const ni = Math.ceil((ex + PATTERN_MIN_WEB) / l.a) + 1
  const pairs = latticePairs(
    l,
    ni,
    nj,
    (dx, dy) => Math.abs(dx) < ex + PATTERN_MIN_WEB && Math.abs(dy) < ey + PATTERN_MIN_WEB,
  )
  if (pairs.length === 0) return Ok(false)
  if (pairs.length > OVERLAP_CHECKS_MAX * (l.flip ? 4 : 1)) return Ok(true)
  return closePair(port, cells, PATTERN_MIN_WEB, pairs)
}

/** Whether some pair of cells comes within `web` (the pair's first cell grown by it). */
function closePair(
  port: Region2dPort,
  cells: readonly [Region, Region],
  web: number,
  pairs: readonly LatticePair[],
): AppResult<boolean> {
  const grown: [Region | undefined, Region | undefined] = [undefined, undefined]
  for (const d of pairs) {
    let g = grown[d.from]
    if (g === undefined) {
      const r = port.offset(cells[d.from], -web)
      if (r.isErr()) return Err(r.unwrapErr())
      g = grown[d.from] = r.unwrap()
    }
    const both = port.intersect(g, translateRegion(cells[d.to], d.off))
    if (both.isErr()) return Err(both.unwrapErr())
    if (both.unwrap().pieces.length > 0 && regionArea(both.unwrap()) > 1e-12) return Ok(true)
  }
  return Ok(false)
}

/** The flip pitches are bisected to this (mm). */
const PITCH_PRECISION = 1e-6

/**
 * P5 (`alternate: flip`): the pitches at which flipped neighbours nest with a web of `gap`, as
 * the triangles of a triangle tiling: along a row (alternating cells) the smallest pitch at which
 * no two cells of the row come within the gap, then between rows the smallest at which no cell
 * of another row does. Each is bisected between 0 and the box rule (cell extent + gap), where the
 * boxes alone keep the gap.
 */
function flipPitches(
  port: Region2dPort,
  cell: Region,
  flipped: Region,
  ex: number,
  ey: number,
  gap: number,
  shifted: boolean,
): AppResult<Vec2> {
  const cells = [cell, flipped] as const
  const tooClose = (a: number, b: number, rows: boolean): AppResult<boolean> => {
    const ni = Math.ceil((ex + gap) / a) + 1
    const nj = rows ? Math.ceil((ey + gap) / b) : 0
    const pairs = latticePairs({ a, b, shifted, angle: 0, flip: true }, ni, nj, (dx, dy) => {
      const near = Math.abs(dx) < ex + gap && Math.abs(dy) < ey + gap
      return near && (rows ? dy !== 0 : dy === 0)
    }).sort((p, q) => Math.hypot(p.off[0], p.off[1]) - Math.hypot(q.off[0], q.off[1]))
    return closePair(port, cells, gap, pairs)
  }
  const bisect = (hi: number, close: (x: number) => AppResult<boolean>): AppResult<number> => {
    let lo = 0
    while (hi - lo > PITCH_PRECISION) {
      const mid = (lo + hi) / 2
      const c = close(mid)
      if (c.isErr()) return c
      if (c.unwrap()) lo = mid
      else hi = mid
    }
    return Ok(hi)
  }
  const a = bisect(ex + gap, (x) => tooClose(x, ey + gap, false))
  if (a.isErr()) return a
  return bisect(ey + gap, (y) => tooClose(a.unwrap(), y, true)).map((b): Vec2 => [a.unwrap(), b])
}
