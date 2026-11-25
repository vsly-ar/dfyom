/**
 * Flat patches of upward surfaces and touch-off spots (hardening DF69): the part of a stock face or
 * a cut floor still at its level after the cuts machined so far, using the 2D coverage model of the
 * material bands (DF61, no in-process stock model), and the touch-off spot on a patch: the centre
 * of its largest inscribed circle after eroding it by the clearance radius, on a grid.
 * Pure; needs the 2D port.
 * Doc: docs/modes/z-reference.md#eligible-surfaces, docs/modes/z-reference.md#touch-off-spot
 */
import { localStock, STOCK_FACE, type Direction } from './face'
import type { Region2dPort } from './2d/port'
import {
  arc,
  arcRadius,
  arcSweep,
  chainBounds,
  regionArea,
  regionLoops,
  type Bounds2,
  type Loop,
  type Region,
} from './2d/model'
import { EPSILON, type OperationGeometry, type StockGeometry, type Vec2 } from './model'
import { chosenLoopsBand, choosesEveryLoop, loopChamferRegion, pocketRegion } from './outline'
import {
  frameMap,
  holeRegion,
  isOpening,
  mapRegion,
  OPPOSITE,
  openingRegion,
  rectangle,
  slotRegion,
} from './through-depth'
import { chamferDepth, isLoopChamfer, loopChamferDepth } from './model'

/** A patch smaller than this (mm²) is gone (boolean slivers). */
const PATCH_AREA = 1e-2

/** A surface that may be a Z reference and its flat patch so far (face frame of its direction). */
export interface FlatSurface {
  /** Surface id: the stock face (`stock.top`) or `<operation id>.floor`. */
  readonly id: string
  /** The design operation that cut it; undefined for a stock face. */
  readonly owner: string | undefined
  readonly direction: Direction
  /** z in the face frame of its direction (the stock face at 0), ≤ 0. */
  readonly level: number
  /** What is still at the level, clipped to the stock face rectangle. */
  readonly patch: Region
}

/** What one cut removes: below `lowest` (face z; −∞ through) over its region. */
interface Cut {
  readonly direction: Direction
  readonly lowest: number
  readonly region: 'face' | Region | undefined
}

/** The material a design operation cuts away, for the patches. */
function cutOf(op: OperationGeometry, stock: StockGeometry, port: Region2dPort): Cut[] {
  const direction = op.direction ?? '+z'
  const face = localStock(direction, stock)
  const clip = (r: Region | undefined) =>
    r === undefined
      ? undefined
      : port.intersect(r, rectangle(face.length, face.width)).mapOr(undefined, (x) => x)
  switch (op.kind) {
    case 'facing':
      return [{ direction, lowest: -op.depth, region: 'face' }]
    case 'pocket':
      return [{ direction, lowest: op.onZ - op.depth, region: clip(pocketRegion(op).region) }]
    case 'drilling':
      return [
        {
          direction,
          // a drill point reaches below the depth: counted to its full depth (only deeper is safe)
          lowest: op.bottom.kind === 'through' ? -Infinity : op.onZ - op.bottom.depth - op.diameter,
          region: holeRegion(op, stock, port),
        },
      ]
    case 'chamfer': {
      if (isLoopChamfer(op)) {
        // a general edge: inside (E1) the air grown by the bevel's width; outside (E2) the band
        // the bevel's width on both sides of the part's loop
        const r = loopChamferRegion(op)
        const grown = port.offset(r, -op.width)
        // E4a: chosen loops only, the band within the width of each
        const band = !choosesEveryLoop(op)
          ? chosenLoopsBand(op, port, op.width)
          : op.edge.side === 'inside'
            ? grown
            : grown.andThen((g) => port.offset(r, op.width).andThen((s) => port.difference(g, s)))
        const region = band.mapOr(undefined, (x) => x)
        return [{ direction, lowest: op.onZ - loopChamferDepth(op), region: clip(region) }]
      }
      const r = op.diameter / 2
      const a: Vec2 = [op.center[0] + r, op.center[1]]
      const disc: Region = {
        pieces: [{ outer: { elements: [arc(a, a, op.center, true)] }, holes: [] }],
      }
      return [{ direction, lowest: op.onZ - chamferDepth(op), region: clip(disc) }]
    }
    case 'profile': {
      const out: Cut[] = [
        {
          direction,
          lowest: op.depth === undefined ? -Infinity : -op.depth,
          region: slotRegion(op, stock, port),
        },
      ]
      // an opening's slug is no surface to touch off on, loose or not
      if (isOpening(op))
        out.push({ direction, lowest: -Infinity, region: openingRegion(op, stock, port) })
      return out
    }
  }
}

/** The floor a facing, pocket or blind profile leaves (pocket: inset by its floor fillet). */
function floorOf(
  op: OperationGeometry,
  stock: StockGeometry,
  port: Region2dPort,
): { level: number; region: Region | undefined } | undefined {
  const direction = op.direction ?? '+z'
  const face = localStock(direction, stock)
  const rect = rectangle(face.length, face.width)
  if (op.kind === 'facing') return { level: -op.depth, region: rect }
  if (op.kind === 'pocket') {
    const own = pocketRegion(op).region
    const flat =
      op.floorRadius > 0 ? port.offset(own, op.floorRadius).mapOr(undefined, (x) => x) : own
    return {
      level: op.onZ - op.depth,
      region:
        flat === undefined ? undefined : port.intersect(flat, rect).mapOr(undefined, (x) => x),
    }
  }
  if (op.kind === 'profile' && op.depth !== undefined)
    return { level: -op.depth, region: slotRegion(op, stock, port) }
  return undefined
}

/**
 * The flat patches of every upward surface while the cuts are applied in machining order
 * (`apply`): the six stock faces from the start, a floor once its operation is applied (when the
 * caller says it is flat). A cut lowers a surface of its own direction where it goes below it, and
 * one of the opposite direction where it reaches up to it (through cuts always); side directions
 * are not counted.
 */
export class FlatPatches {
  private readonly surfaces: FlatSurface[] = []
  private readonly history: Cut[] = []

  constructor(
    private readonly stock: StockGeometry,
    private readonly port: Region2dPort,
    directions: readonly Direction[],
  ) {
    for (const d of new Set(directions)) {
      const face = localStock(d, stock)
      this.surfaces.push({
        id: STOCK_FACE[d],
        owner: undefined,
        direction: d,
        level: 0,
        patch: rectangle(face.length, face.width),
      })
    }
  }

  /** The surfaces of `direction` with a patch left. */
  of(direction: Direction): readonly FlatSurface[] {
    return this.surfaces.filter(
      (s) => s.direction === direction && regionArea(s.patch) > PATCH_AREA,
    )
  }

  /** Applies one cut; `flatFloor`: its floor (facing, pocket, blind profile) becomes a surface. */
  apply(op: OperationGeometry, flatFloor: boolean): void {
    const cuts = cutOf(op, this.stock, this.port)
    for (let i = 0; i < this.surfaces.length; i++) {
      const s = this.surfaces[i]!
      let patch = s.patch
      for (const c of cuts) patch = this.lower(s, patch, c)
      if (patch !== s.patch) this.surfaces[i] = { ...s, patch }
    }
    if (flatFloor) {
      const f = floorOf(op, this.stock, this.port)
      const direction = op.direction ?? '+z'
      if (f !== undefined && f.region !== undefined) {
        const base = { id: `${op.id}.floor`, owner: op.id, direction, level: f.level }
        let patch: Region = f.region
        for (const c of this.history) patch = this.lower({ ...base, patch }, patch, c)
        this.surfaces.push({ ...base, patch })
      }
    }
    this.history.push(...cuts)
  }

  /** `patch` of `s` less what `c` cuts below its level. */
  private lower(s: FlatSurface, patch: Region, c: Cut): Region {
    if (patch.pieces.length === 0) return patch
    let region: 'face' | Region | undefined
    if (c.direction === s.direction) {
      if (!(c.lowest < s.level - EPSILON)) return patch
      region = c.region
    } else if (c.direction === OPPOSITE[s.direction]) {
      const thickness = localStock(s.direction, this.stock).thickness
      // depth below its own face against our level seen from that face
      if (!(-c.lowest >= thickness + s.level - EPSILON)) return patch
      if (c.region === 'face' || c.region === undefined) region = c.region
      else region = mapRegion(c.region, frameMap(c.direction, s.direction, this.stock))
    } else return patch
    if (region === 'face') return { pieces: [] }
    // a cut whose region the port failed on: the patch is no longer known flat
    if (region === undefined) return { pieces: [] }
    return this.port.difference(patch, region).mapOr({ pieces: [] }, (r) => r)
  }
}

/** Maps between the face frame and the setup's WCS (identity for an unrotated setup). */
export interface SpotFrame {
  readonly toWcs: (p: Vec2) => Vec2
  readonly fromWcs: (p: Vec2) => Vec2
}

const IDENTITY: SpotFrame = { toWcs: (p) => p, fromWcs: (p) => p }

/** Distances closer than this (mm) tie: the offsets' arcs and lines are not exact. */
const TIE = 1e-3
/** Coarse lattice size per axis before refinement. */
const COARSE = 40
/** Coarse points refined at most. */
const MAX_SEEDS = 64
/** Lattice points the fallback scans at most (thin patches). */
const MAX_SCAN = 200_000

/** Loops from which the spot search buckets them (patterns: a face with many holes, S8 finding 7). */
const INDEX_MIN_LOOPS = 32

/**
 * `port.contains(region, p) ? distance to the region's loops : −1` with the loops bucketed on a
 * grid over `bounds` (by their boxes, grown by a margin): containment reads the loops of p's
 * bucket only, the distance the buckets ring by ring until the next ring lies farther than the
 * best distance. Same answers as the plain scan, linear in the loops near p instead of all of
 * them (patterns P1: ≈ 2 000 holes took 1.8 s per touch-off spot).
 */
export function spotIndex(
  port: Region2dPort,
  region: Region,
  bounds: Bounds2,
): (p: Vec2) => number {
  const loops = regionLoops(region)
  const w = Math.max(bounds.max[0] - bounds.min[0], EPSILON)
  const h = Math.max(bounds.max[1] - bounds.min[1], EPSILON)
  const n = Math.max(1, Math.min(INDEX_CELLS_MAX, Math.ceil(Math.sqrt(loops.length))))
  const cell = Math.max(w, h) / n
  const nx = Math.ceil(w / cell) + 1
  const ny = Math.ceil(h / cell) + 1
  const at = (x: number, lo: number, m: number) =>
    Math.min(m - 1, Math.max(0, Math.floor((x - lo) / cell)))
  const bucket = (i: number, j: number) => i * ny + j
  const loopIds: number[][] = Array.from({ length: nx * ny }, () => [])
  // a piece per bucket: its outer and the holes reaching the bucket (containment)
  const pieceSets: { outer: Loop; holes: Loop[] }[][] = Array.from({ length: nx * ny }, () => [])
  const spread = (l: Loop, visit: (k: number) => void) => {
    const lb = chainBounds(l.elements)
    if (lb === undefined) return
    const i0 = at(lb.min[0] - INDEX_MARGIN, bounds.min[0], nx)
    const i1 = at(lb.max[0] + INDEX_MARGIN, bounds.min[0], nx)
    const j0 = at(lb.min[1] - INDEX_MARGIN, bounds.min[1], ny)
    const j1 = at(lb.max[1] + INDEX_MARGIN, bounds.min[1], ny)
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) visit(bucket(i, j))
  }
  loops.forEach((l, k) => spread(l, (b) => loopIds[b]!.push(k)))
  for (const piece of region.pieces) {
    const local = new Map<number, { outer: Loop; holes: Loop[] }>()
    spread(piece.outer, (b) => {
      const one = { outer: piece.outer, holes: [] as Loop[] }
      local.set(b, one)
      pieceSets[b]!.push(one)
    })
    for (const hole of piece.holes) spread(hole, (b) => local.get(b)?.holes.push(hole))
  }
  return (p) => {
    const bi = Math.floor((p[0] - bounds.min[0]) / cell)
    const bj = Math.floor((p[1] - bounds.min[1]) / cell)
    if (bi < 0 || bj < 0 || bi >= nx || bj >= ny) return port.contains(region, p) ? 0 : -1
    if (!port.contains({ pieces: pieceSets[bucket(bi, bj)]! }, p)) return -1
    const seen = new Set<number>()
    let best = Infinity
    for (let r = 0; r <= Math.max(nx, ny); r++) {
      const near: Loop[] = []
      for (let i = bi - r; i <= bi + r; i++)
        for (let j = bj - r; j <= bj + r; j++) {
          if (Math.max(Math.abs(i - bi), Math.abs(j - bj)) !== r) continue
          if (i < 0 || j < 0 || i >= nx || j >= ny) continue
          for (const k of loopIds[bucket(i, j)]!)
            if (!seen.has(k)) {
              seen.add(k)
              near.push(loops[k]!)
            }
        }
      if (near.length > 0) best = Math.min(best, port.distance(near, p)?.distance ?? Infinity)
      // a loop not seen yet lies outside these rings: at least r cells from p
      if (best <= r * cell) break
    }
    return Number.isFinite(best) ? best : -1
  }
}

/** Grid cells per axis of the spot index at most. */
const INDEX_CELLS_MAX = 128
/** Loop boxes grow by this (mm) when bucketed: points on a loop find it in their bucket. */
const INDEX_MARGIN = 1e-6

export interface TouchSpot {
  /** WCS position (mm), on the grid. */
  readonly at: Vec2
  /** Distance from `at` to the patch boundary (mm). */
  readonly radius: number
}

/** The patch eroded by `clearance`; undefined when nothing is left. */
export function erodedPatch(
  port: Region2dPort,
  patch: Region,
  clearance: number,
): Region | undefined {
  const r = port.offset(patch, clearance)
  if (r.isErr()) return undefined
  const e = r.unwrap()
  return e.pieces.length === 0 || regionArea(e) <= 0 ? undefined : e
}

/**
 * The touch-off spot: the grid point (multiples of `grid` in the WCS) of the patch eroded by
 * `clearance` farthest from its boundary (≈ the centre of the largest inscribed circle), ties to
 * the one nearest the work zero. Undefined when no grid point lies in the eroded patch.
 */
export function touchOffSpot(
  port: Region2dPort,
  patch: Region,
  clearance: number,
  grid: number,
  frame: SpotFrame = IDENTITY,
): TouchSpot | undefined {
  const eroded = erodedPatch(port, patch, clearance)
  if (eroded === undefined) return undefined
  const loops = regionLoops(eroded)
  const b = chainBounds(loops.flatMap((l) => l.elements))
  if (b === undefined) return undefined
  const corners = [b.min, [b.max[0], b.min[1]], b.max, [b.min[0], b.max[1]]] as Vec2[]
  const w = corners.map((c) => frame.toWcs(c))
  const lo = [Math.min(...w.map((p) => p[0])), Math.min(...w.map((p) => p[1]))]
  const hi = [Math.max(...w.map((p) => p[0])), Math.max(...w.map((p) => p[1]))]
  const k0 = [Math.ceil(lo[0]! / grid - 1e-9), Math.ceil(lo[1]! / grid - 1e-9)] as const
  const k1 = [Math.floor(hi[0]! / grid + 1e-9), Math.floor(hi[1]! / grid + 1e-9)] as const
  const nx = k1[0] - k0[0] + 1
  const ny = k1[1] - k0[1] + 1
  if (nx <= 0 || ny <= 0) return undefined
  const memo = new Map<string, number>()
  const index = loops.length > INDEX_MIN_LOOPS ? spotIndex(port, eroded, b) : undefined
  const score = (i: number, j: number): number => {
    const key = `${i},${j}`
    const known = memo.get(key)
    if (known !== undefined) return known
    const p = frame.fromWcs([i * grid, j * grid])
    let v = -1
    if (index !== undefined) v = index(p)
    else if (port.contains(eroded, p)) v = port.distance(loops, p)?.distance ?? -1
    memo.set(key, v)
    return v
  }
  type Best = { i: number; j: number; v: number }
  // ties (a rectangle's whole middle line): nearest the middle of the patch, then the work zero
  const mid = [(lo[0]! + hi[0]!) / 2 / grid, (lo[1]! + hi[1]!) / 2 / grid]
  const toMid = (a: Best) => Math.hypot(a.i - mid[0]!, a.j - mid[1]!)
  const better = (a: Best, c: Best | undefined): boolean => {
    if (c === undefined) return true
    if (a.v > c.v + TIE) return true
    if (a.v < c.v - TIE) return false
    const m = toMid(a) - toMid(c)
    if (Math.abs(m) > 1e-9) return m < 0
    return Math.hypot(a.i, a.j) < Math.hypot(c.i, c.j)
  }
  const step = Math.max(1, Math.ceil(Math.max(nx, ny) / COARSE))
  const seeds: Best[] = []
  for (let i = k0[0]; i <= k1[0]; i += step)
    for (let j = k0[1]; j <= k1[1]; j += step) {
      const v = score(i, j)
      if (v >= 0) seeds.push({ i, j, v })
    }
  let best: Best | undefined
  if (seeds.length === 0) {
    if (step === 1 || nx * ny > MAX_SCAN) return undefined
    for (let i = k0[0]; i <= k1[0]; i++)
      for (let j = k0[1]; j <= k1[1]; j++) {
        const c = { i, j, v: score(i, j) }
        if (c.v >= 0 && better(c, best)) best = c
      }
  } else {
    seeds.sort((a, c) => (better(a, c) ? -1 : better(c, a) ? 1 : 0))
    // the distance is 1-Lipschitz: the best grid point lies near a seed at most a coarse step
    // (diagonal) below the best seed
    const floor = seeds[0]!.v - step * grid * Math.SQRT2 - TIE
    for (const s of seeds.filter((x) => x.v >= floor).slice(0, MAX_SEEDS)) {
      if (better(s, best)) best = s
      if (step === 1) continue
      for (let i = s.i - step; i <= s.i + step; i++)
        for (let j = s.j - step; j <= s.j + step; j++) {
          if (i < k0[0] || i > k1[0] || j < k0[1] || j > k1[1]) continue
          const c = { i, j, v: score(i, j) }
          if (c.v >= 0 && better(c, best)) best = c
        }
    }
  }
  if (best === undefined) return undefined
  return { at: [best.i * grid + 0, best.j * grid + 0], radius: best.v + clearance }
}

/** Whether the WCS point `at` lies in the patch eroded by `clearance`. */
export function spotFits(
  port: Region2dPort,
  patch: Region,
  clearance: number,
  at: Vec2,
  frame: SpotFrame = IDENTITY,
): boolean {
  const eroded = erodedPatch(port, patch, clearance)
  return eroded !== undefined && port.contains(eroded, frame.fromWcs(at))
}

/** A region piece as polygons: the outer ring and its holes, WCS points (mm). */
export interface PatchPolygon {
  readonly outer: readonly Vec2[]
  readonly holes: readonly (readonly Vec2[])[]
}

/** Chord error of arcs drawn as polygons (mm). */
const CHORD_ERROR = 0.05
/** Chords of a full circle at most. */
const MAX_CHORDS = 64

/** A loop's points (closing point left out), arcs as chords within `CHORD_ERROR`. */
function loopPoints(l: Loop, map: (p: Vec2) => Vec2): Vec2[] {
  const out: Vec2[] = []
  const round = (p: Vec2): Vec2 => {
    const q = map(p)
    return [Math.round(q[0] * 1e3) / 1e3 + 0, Math.round(q[1] * 1e3) / 1e3 + 0]
  }
  for (const e of l.elements) {
    out.push(round(e.a))
    if (e.kind !== 'arc') continue
    const r = arcRadius(e)
    const sweep = arcSweep(e)
    const step = r > CHORD_ERROR ? 2 * Math.acos(1 - CHORD_ERROR / r) : Math.PI
    const n = Math.min(
      Math.ceil((MAX_CHORDS * Math.abs(sweep)) / (2 * Math.PI)),
      Math.max(1, Math.ceil(Math.abs(sweep) / step)),
    )
    const a0 = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
    for (let i = 1; i < n; i++) {
      const t = a0 + (sweep * i) / n
      out.push(round([e.centre[0] + r * Math.cos(t), e.centre[1] + r * Math.sin(t)]))
    }
  }
  return out
}

/**
 * A region as polygons for drawing (the viewport's Z reference highlight, DF69): per piece its
 * outer ring and holes, mapped by `frame.toWcs`, rounded to 0.001 mm.
 */
export function patchPolygons(region: Region, frame: SpotFrame = IDENTITY): PatchPolygon[] {
  return region.pieces.map((p) => ({
    outer: loopPoints(p.outer, frame.toWcs),
    holes: p.holes.map((h) => loopPoints(h, frame.toWcs)),
  }))
}
