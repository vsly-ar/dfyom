/**
 * Dowels on split levels (split parts 4b-1): the glue faces between pieces at each level, the
 * region a dowel hole stays clear in (no removal within its depth above or below the level), the
 * placement helper (stored positions, placed once), the holes as generated drillings in both
 * pieces, and the dowel findings (`dowelNear`, `dowelFit`). Pure; the 2D port does the booleans.
 * Doc: docs/modes/split-parts.md#implementation-4b
 */
import { Err, Ok, type AppResult } from '../../../shared/result'
import type { Region2dPort } from '../../geometry/2d/port'
import { EMPTY_REGION, regionLoops, type Bounds2, type Region } from '../../geometry/2d/model'
import { orientRegion, translateRegion } from '../../geometry/2d/place'
import type { DfmWarning, Vec2 } from '../../geometry/model'
import { STOCK_FACE } from '../../geometry/face'
import { DOWEL_DEFAULT, DOWEL_SIZES, DOWEL_WALL_MIN, dowelDepthDefault, dowelHole } from '../dowel'
import type { OperationDTO, SplitDTO } from '../part.dto'
import { toGeometryInput } from '../geometry-input'
import type { LoadedPart } from '../load'
import { EPS, regionBounds, splitLayout, splitNumbers, type Cell, type Layout } from './layout'
import { removals, type Removal } from './removals'

const mmOf = (q: { exact: { num: string; den: string } }) =>
  Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))

/** Each piece keeps this much (mm) below a hole's floor: the depth is capped to the blank. */
export const DOWEL_FLOOR_MIN = 1
/** The placement's extra wall (mm), so rounded positions keep `DOWEL_WALL_MIN`. */
const PLACE_SLACK = 0.05
/** Candidates: on the clear region's boundary every this many mm, and a grid inside it. */
const BOUNDARY_STEP = 2
const GRID_STEP = 5
/** One hole per this much (mm) of the glue face's width + depth, within these counts. */
const HOLES_PER = 150
const HOLES_MIN = 2
const HOLES_MAX = 8

/** A split's dowels in mm; undefined = butt levels. */
export interface DowelNumbers {
  readonly diameter: number
  /** Hole Ø: dowel + fit. */
  readonly hole: number
  readonly depth: number
  readonly holes: readonly { readonly level: number; readonly at: Vec2 }[]
}

export function dowelNumbers(split: SplitDTO): DowelNumbers | undefined {
  const d = split.joint.dowels
  if (d === undefined) return undefined
  const diameter = mmOf(d.diameter)
  return {
    diameter,
    hole: dowelHole(diameter),
    depth: mmOf(d.depth),
    holes: d.holes.map((h) => ({ level: h.level, at: [mmOf(h.at[0]), mmOf(h.at[1])] as Vec2 })),
  }
}

/** The glue face between two pieces at a level: one per column of cells the lines make. */
export interface GlueFace {
  /** Index into `split.levels` as stored. */
  readonly level: number
  readonly z: number
  readonly lower: Cell
  readonly upper: Cell
  /** The footprint inside the column (part frame). */
  readonly region: Region
  readonly bounds: Bounds2
}

/** Every glue face of the split's levels (both pieces present). */
export function glueFaces(layout: Layout, split: SplitDTO): GlueFace[] {
  const out: GlueFace[] = []
  split.levels.forEach((q, level) => {
    const z = mmOf(q)
    for (const lower of layout.cells) {
      if (Math.abs(lower.band.zt - z) > EPS) continue
      const upper = layout.cells.find(
        (c) => c.ix === lower.ix && c.iy === lower.iy && Math.abs(c.band.zb - z) <= EPS,
      )
      if (upper === undefined) continue
      out.push({ level, z, lower, upper, region: lower.region, bounds: lower.bounds })
    }
  })
  return out
}

/** The hole depth in a piece of band height `height` (capped to keep its floor). */
export const cappedDepth = (depth: number, height: number): number =>
  Math.max(0, Math.min(depth, height - DOWEL_FLOOR_MIN))

/** A face-frame region of a −z removal in the part frame: (x, y) → (x, W − y). */
function mirroredY(r: Region, W: number): Region {
  return translateRegion(orientRegion(r, { rotation: 180, mirror: true }), [0, W])
}

/**
 * Where material is solid over the hole depth above and below the face's level: the column's
 * footprint minus every removal prism reaching into that range (an outside step intersects; a
 * facing in it leaves nothing). Part frame.
 */
export function clearRegion(
  port: Region2dPort,
  face: GlueFace,
  rs: readonly Removal[],
  W: number,
  depth: number,
): AppResult<Region> {
  const lo = face.z - cappedDepth(depth, face.lower.band.zt - face.lower.band.zb)
  const hi = face.z + cappedDepth(depth, face.upper.band.zt - face.upper.band.zb)
  let region = face.region
  for (const r of rs) {
    if (!(r.zlo < hi - EPS && r.zhi > lo + EPS)) continue
    if (r.mode === 'all') return Ok(EMPTY_REGION)
    if (r.region === undefined) continue
    const n = port.normalise(regionLoops(r.dir === '+z' ? r.region : mirroredY(r.region, W)))
    if (n.isErr()) return Err(n.unwrapErr().withContext('clearRegion', { operation: r.id }))
    const next =
      r.mode === 'in' ? port.difference(region, n.unwrap()) : port.intersect(region, n.unwrap())
    if (next.isErr()) return Err(next.unwrapErr().withContext('clearRegion', { operation: r.id }))
    region = next.unwrap()
  }
  return Ok(region)
}

/** Candidate centres: on the region's boundary every 2 mm and on a 5 mm grid inside it. */
function candidates(port: Region2dPort, region: Region): Vec2[] {
  const out: Vec2[] = []
  for (const loop of regionLoops(region)) {
    const len = port.length(loop)
    const n = Math.max(1, Math.ceil(len / BOUNDARY_STEP))
    for (let i = 0; i < n; i++) {
      const p = port.pointAt(loop, (i * len) / n, true)
      if (p.isOk()) out.push([p.unwrap().point[0], p.unwrap().point[1]])
    }
  }
  const b = regionBounds(region)
  if (b !== undefined)
    for (let x = b.min[0] + GRID_STEP / 2; x < b.max[0]; x += GRID_STEP)
      for (let y = b.min[1] + GRID_STEP / 2; y < b.max[1]; y += GRID_STEP)
        if (port.contains(region, [x, y])) out.push([x, y])
  return out
}

/** `n` points spread farthest-first: from the farthest from `centre`, then from every pick. */
function farthest(cands: readonly Vec2[], n: number, centre: Vec2): Vec2[] {
  if (cands.length === 0) return []
  const d2 = (a: Vec2, b: Vec2) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
  let first = 0
  cands.forEach((c, i) => {
    if (d2(c, centre) > d2(cands[first]!, centre) + 1e-9) first = i
  })
  const picks: Vec2[] = [cands[first]!]
  const near = cands.map((c) => d2(c, cands[first]!))
  while (picks.length < n) {
    let best = -1
    near.forEach((d, i) => {
      if (d > 1e-6 && (best < 0 || d > near[best]! + 1e-9)) best = i
    })
    if (best < 0) break
    const p = cands[best]!
    picks.push(p)
    cands.forEach((c, i) => (near[i] = Math.min(near[i]!, d2(c, p))))
  }
  return picks
}

/** How much of the face the region spans: the smaller of its X and Y shares (0–1). */
function span(region: Region, face: Bounds2): number {
  const b = regionBounds(region)
  if (b === undefined) return 0
  const sx = (b.max[0] - b.min[0]) / Math.max(EPS, face.max[0] - face.min[0])
  const sy = (b.max[1] - b.min[1]) / Math.max(EPS, face.max[1] - face.min[1])
  return Math.min(sx, sy)
}

/** Holes placed on one face for a dowel Ø: positions and how well they span the face. */
interface Placement {
  readonly at: Vec2[]
  readonly span: number
}

function placeOnFace(
  port: Region2dPort,
  clear: Region,
  face: GlueFace,
  diameter: number,
): AppResult<Placement> {
  const r = dowelHole(diameter) / 2
  let best: { region: Region; span: number } | undefined
  // one dowel Ø of wall where that still spans half the face, else the thinnest wall
  for (const wall of [Math.max(diameter, DOWEL_WALL_MIN), DOWEL_WALL_MIN]) {
    const eroded = port.offset(clear, r + wall + PLACE_SLACK)
    if (eroded.isErr()) return Err(eroded.unwrapErr().withContext('placeDowels'))
    const s = span(eroded.unwrap(), face.bounds)
    if (best === undefined || s > best.span + EPS) best = { region: eroded.unwrap(), span: s }
    if (s >= 0.5) break
  }
  const region = best!.region
  if (regionLoops(region).length === 0) return Ok({ at: [], span: 0 })
  const fb = face.bounds
  const n = Math.min(
    HOLES_MAX,
    Math.max(HOLES_MIN, Math.ceil((fb.max[0] - fb.min[0] + (fb.max[1] - fb.min[1])) / HOLES_PER)),
  )
  const centre: Vec2 = [(fb.min[0] + fb.max[0]) / 2, (fb.min[1] + fb.max[1]) / 2]
  const round = (v: number) => Math.round(v * 100) / 100
  const at = farthest(candidates(port, region), n, centre).map(
    (p) => [round(p[0]), round(p[1])] as Vec2,
  )
  return Ok({ at, span: best!.span })
}

/** What the placement helper decided: the dowel Ø and the holes it added, per level. */
export interface PlacedDowels {
  readonly diameter: number
  readonly holes: readonly { readonly level: number; readonly at: Vec2 }[]
}

/**
 * Places holes on every level that has none in `given` (faces of the same level each get their
 * own). Without a `diameter` the sizes are tried from 6 mm down: the first whose holes span at
 * least half of every face wins, else the one spanning most. `depth` undefined = the default for
 * each size tried.
 */
export function placeDowels(
  port: Region2dPort,
  layout: Layout,
  split: SplitDTO,
  rs: readonly Removal[],
  W: number,
  given: readonly { readonly level: number }[],
  diameter: number | undefined,
  depth: number | undefined,
): AppResult<PlacedDowels> {
  const faces = glueFaces(layout, split).filter((f) => !given.some((h) => h.level === f.level))
  const sizes =
    diameter !== undefined ? [diameter] : DOWEL_SIZES.filter((d) => d <= DOWEL_DEFAULT).reverse()
  let best: (PlacedDowels & { readonly score: number }) | undefined
  for (const d of sizes) {
    const holes: { level: number; at: Vec2 }[] = []
    let score = Infinity
    for (const face of faces) {
      const clear = clearRegion(port, face, rs, W, depth ?? dowelDepthDefault(d))
      if (clear.isErr()) return clear
      const placed = placeOnFace(port, clear.unwrap(), face, d)
      if (placed.isErr()) return placed
      const p = placed.unwrap()
      score = Math.min(score, p.at.length >= HOLES_MIN ? p.span : -1)
      for (const at of p.at) holes.push({ level: face.level, at })
    }
    if (best === undefined || score > best.score + EPS) best = { diameter: d, holes, score }
    if (score >= 0.5) break
  }
  return Ok({ diameter: best?.diameter ?? diameter ?? DOWEL_DEFAULT, holes: best?.holes ?? [] })
}

// ── the holes in a piece ──────────────────────────────────────────────────────────────────

/** The generated id of hole k (1-based): the same in both pieces. */
export const dowelOperationId = (splitId: string, k: number): string => `${splitId}_dowel${k}`

/** The face (and side) of a hole: the glue face whose column holds its centre. */
function faceOf(
  port: Region2dPort,
  faces: readonly GlueFace[],
  hole: { readonly level: number; readonly at: Vec2 },
): GlueFace | undefined {
  return faces.find((f) => f.level === hole.level && port.contains(f.region, hole.at))
}

/**
 * The dowel holes of one piece as drillings in its frame: from its top for the level at its top,
 * from its bottom (a −z drilling, its plan's flip) for the level at its bottom; the depth capped
 * to the blank. `length` makes the piece's length records.
 */
export function dowelOperations(
  port: Region2dPort,
  layout: Layout,
  split: SplitDTO,
  cell: Cell,
  offset: readonly [number, number, number],
  blankWidth: number,
  length: (mm: number) => Extract<OperationDTO, { kind: 'drilling' }>['diameter'],
): OperationDTO[] {
  const d = dowelNumbers(split)
  if (d === undefined) return []
  const faces = glueFaces(layout, split)
  const height = cell.band.zt - cell.band.zb
  const out: OperationDTO[] = []
  d.holes.forEach((hole, i) => {
    const face = faceOf(port, faces, hole)
    if (face === undefined) return
    const top = face.lower === cell
    if (!top && face.upper !== cell) return
    const x = hole.at[0] + offset[0]
    const y = hole.at[1] + offset[1]
    out.push({
      kind: 'drilling',
      id: dowelOperationId(split.id, i + 1),
      name: `Dowel hole ${i + 1}`,
      on: STOCK_FACE[top ? '+z' : '-z'],
      center: [length(x), length(top ? y : blankWidth - y)],
      diameter: length(d.hole),
      bottom: 'flat',
      depth: length(cappedDepth(d.depth, height)),
    })
  })
  return out
}

// ── findings ──────────────────────────────────────────────────────────────────────────────

export type DowelFinding = (
  rule: 'dowelNear' | 'dowelFit',
  message: string,
  params: Record<string, number | string | readonly number[]>,
) => DfmWarning

const fmt = (mm: number) => +mm.toFixed(2)

/**
 * `dowelNear` (a hole's wall to the clear region's edge under 1.5 mm, or it breaks in) and
 * `dowelFit` (a glue face with fewer than 2 holes, a hole on no glue face, a capped depth).
 */
export function dowelFindings(
  port: Region2dPort,
  layout: Layout,
  split: SplitDTO,
  rs: readonly Removal[],
  W: number,
  pieceName: (n: number) => string,
  finding: DowelFinding,
): DfmWarning[] {
  const d = dowelNumbers(split)
  if (d === undefined) return []
  const out: DfmWarning[] = []
  const faces = glueFaces(layout, split)
  const r = d.hole / 2
  const levelText = (level: number) => `level ${fmt(mmOf(split.levels[level]!))}`
  d.holes.forEach((hole, i) => {
    if (faceOf(port, faces, hole) === undefined)
      out.push(
        finding(
          'dowelFit',
          `Dowel hole ${i + 1} at X ${fmt(hole.at[0])} Y ${fmt(hole.at[1])} is on no glue face of ${hole.level < split.levels.length ? levelText(hole.level) : 'its level'}: it is left out`,
          { reason: 'outside', hole: i + 1, level: hole.level },
        ),
      )
  })
  for (const face of faces) {
    const pair = `${pieceName(face.lower.n)} and ${pieceName(face.upper.n)}`
    const mine = d.holes.flatMap((h, i) =>
      h.level === face.level && port.contains(face.region, h.at) ? [{ ...h, k: i + 1 }] : [],
    )
    if (mine.length < HOLES_MIN)
      out.push(
        finding(
          'dowelFit',
          `The glue face at ${levelText(face.level)} between ${pair} has ${mine.length} dowel${mine.length === 1 ? '' : 's'}: 2 or more keep the pieces from turning`,
          {
            reason: 'count',
            level: face.level,
            count: mine.length,
            pieces: [face.lower.n, face.upper.n],
          },
        ),
      )
    const heights = [face.lower, face.upper].map((c) => c.band.zt - c.band.zb)
    if (heights.some((h) => cappedDepth(d.depth, h) < d.depth - EPS))
      out.push(
        finding(
          'dowelFit',
          `The dowel holes at ${levelText(face.level)} are ${fmt(d.depth)} mm deep, more than ${pair} hold: cut to ${fmt(Math.min(...heights.map((h) => cappedDepth(d.depth, h))))} mm`,
          { reason: 'depth', level: face.level, depth: d.depth },
        ),
      )
    if (mine.length === 0) continue
    const clear = clearRegion(port, face, rs, W, d.depth)
    if (clear.isErr()) continue
    const loops = regionLoops(clear.unwrap())
    for (const h of mine) {
      const inside = loops.length > 0 && port.contains(clear.unwrap(), h.at)
      const dist = port.distance(loops, h.at)?.distance ?? 0
      const wall = inside ? dist - r : -dist - r
      if (wall < DOWEL_WALL_MIN - 1e-6)
        out.push(
          finding(
            'dowelNear',
            wall <= 0
              ? `Dowel hole ${h.k} at X ${fmt(h.at[0])} Y ${fmt(h.at[1])} breaks into a feature or out of the glue face at ${levelText(face.level)}`
              : `Dowel hole ${h.k} at X ${fmt(h.at[0])} Y ${fmt(h.at[1])} leaves ${fmt(wall)} mm of wall (< ${DOWEL_WALL_MIN} mm) to an edge or a feature`,
            { hole: h.k, level: face.level, wall: fmt(wall), limit: DOWEL_WALL_MIN },
          ),
        )
    }
  }
  return out
}

export { HOLES_MIN as DOWELS_PER_FACE_MIN }

/** The layout and removals of a loaded source part for a split (what placement needs). */
export function splitGeometry(
  loaded: LoadedPart,
  split: SplitDTO,
  port: Region2dPort,
): AppResult<{ readonly layout: Layout; readonly removals: Removal[]; readonly W: number }> {
  const input = toGeometryInput(loaded.part, loaded.stock, port)
  if (input.isErr()) return Err(input.unwrapErr().withContext('splitGeometry'))
  const geometry = input.unwrap().operations
  const stock = {
    length: loaded.stock.length.canonical,
    width: loaded.stock.width.canonical,
    thickness: loaded.stock.thickness.canonical,
  }
  const layout = splitLayout(port, splitNumbers(split), stock, loaded.part.operations, geometry)
  if (layout.isErr()) return Err(layout.unwrapErr().withContext('splitGeometry'))
  return Ok({
    layout: layout.unwrap(),
    removals: removals(loaded, geometry, layout.unwrap().footprint.outline),
    W: stock.width,
  })
}

/**
 * The split with its dowels completed for `design.split.set`: every level without a given hole
 * placed, the dowel Ø chosen when not given (`given.diameter` undefined) and the depth defaulted
 * for it (`given.depth` undefined). `length` makes the stored lengths.
 */
export function completeDowels(
  loaded: LoadedPart,
  split: SplitDTO,
  port: Region2dPort,
  given: { readonly diameter: number | undefined; readonly depth: number | undefined },
  length: (mm: number) => SplitDTO['margin'],
): AppResult<SplitDTO> {
  const d = split.joint.dowels
  if (d === undefined) return Ok(split)
  const missing = split.levels.some((_, level) => !d.holes.some((h) => h.level === level))
  let diameter = given.diameter
  let holes = d.holes
  if (missing) {
    const geo = splitGeometry(loaded, split, port)
    if (geo.isErr()) return geo
    const { layout, removals: rs, W } = geo.unwrap()
    const placed = placeDowels(port, layout, split, rs, W, d.holes, diameter, given.depth)
    if (placed.isErr()) return placed
    diameter = placed.unwrap().diameter
    holes = [
      ...d.holes,
      ...placed.unwrap().holes.map((h) => ({
        level: h.level,
        at: [length(h.at[0]), length(h.at[1])] as [SplitDTO['margin'], SplitDTO['margin']],
      })),
    ]
  }
  const dia = diameter ?? DOWEL_DEFAULT
  return Ok({
    ...split,
    joint: {
      ...split.joint,
      dowels: {
        diameter: given.diameter === undefined ? length(dia) : d.diameter,
        depth: given.depth === undefined ? length(dowelDepthDefault(dia)) : d.depth,
        holes,
      },
    },
  })
}
