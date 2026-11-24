/**
 * Compare of the design against its reference (DF60 P4, RT-F): the evaluated part and the placed
 * reference mesh, both in the part frame. A closed reference goes through 3D booleans
 * (`missing = reference − part`, `extra = part − reference`, split into connected pieces, each
 * with its volume, bounds, the largest distance of its vertices to the other surface and the
 * part surfaces it touches); an open one, or one the solid library refuses, through height maps
 * from the faces the design's operations use. Runs in the geometry worker (`reference.compare`);
 * the command (`design.reference.compare`) names the surfaces and operations and ranks the
 * regions. Pure and headless.
 * Doc: docs/modes/reference-tools.md#3-compare
 */
import { z } from 'zod'
import { Err, Ok, type AppResult } from '../../shared/result'
import type { Steps } from '../workers/steps'
import { DIRECTIONS, faceFrame, localStock, type Direction, type StockSize } from '../geometry/face'
import {
  applyPlacement,
  EPSILON_VOLUME,
  unapplyPlacement,
  type OperationGeometry,
  type Vec3,
} from '../geometry/model'
import type { Solid, SolidKernel } from '../geometry/solid-port'
import { arcRadius, regionLoops } from '../geometry/2d/model'
import { MeshBvh } from './mesh-distance'

/** Default threshold: pieces whose `maxDev` is under it are noise (facet chords, rounding), mm. */
export const COMPARE_THRESHOLD_MM = 0.1
/** Default regions in the result. */
export const COMPARE_LIMIT = 10
/** Regions the worker returns at most (the command cuts to `limit`). */
export const COMPARE_PIECES_MAX = 64
/** STL vertices closer than this are one (mm). */
export const COMPARE_WELD_MM = 1e-4
/** Height-map cell (mm), deviation.md's default. */
export const COMPARE_CELL_MM = 0.5
/** Surfaces kept per piece (the command names fewer). */
const SURFACES_MAX = 8

/** The part as the evaluation meshed it (part frame, mm). */
export interface CompareMesh {
  readonly positions: Float32Array
  readonly indices: Uint32Array
  /** Index into the evaluation's `surfaces` per triangle. */
  readonly triangleSurface: Uint32Array
}

export interface CompareOptions {
  readonly threshold: number
  /** For the height maps: the stock and the directions to look from. */
  readonly stock: StockSize
  readonly directions: readonly Direction[]
  readonly cell?: number
}

/** A piece of missing or extra material (part frame, mm). */
export interface ComparePiece {
  readonly kind: 'missing' | 'extra'
  readonly volume: number
  readonly maxDev: number
  /** Where `maxDev` is. */
  readonly at: Vec3
  readonly bounds: readonly [Vec3, Vec3]
  /** Part surfaces it touches, largest area first (index into the evaluation's `surfaces`). */
  readonly surfaces: readonly { readonly index: number; readonly area: number }[]
  /** Its area on the part's surfaces (mm²). */
  readonly partArea: number
}

export interface CompareRaw {
  readonly method: 'boolean' | 'heightmap'
  readonly stats: {
    readonly missingVolume: number
    readonly extraVolume: number
    readonly maxMissing: number
    readonly maxExtra: number
    readonly referenceVolume: number
    readonly partVolume: number
  }
  /** Over the threshold, largest maxDev × volume first; at most `COMPARE_PIECES_MAX`. */
  readonly pieces: readonly ComparePiece[]
  readonly more?: number | undefined
  readonly below: { readonly count: number; readonly volume: number }
  /** Loose pieces of the evaluated part that do not touch the reference (a frame cut free). */
  readonly offcuts?: { readonly count: number; readonly volume: number } | undefined
  /** Why the height maps were used (an open mesh, or the library's refusal). */
  readonly fallback?: string | undefined
}

const vec3 = z.tuple([z.number(), z.number(), z.number()])
export const CompareRawSchema: z.ZodType<CompareRaw> = z.object({
  method: z.enum(['boolean', 'heightmap']),
  stats: z.object({
    missingVolume: z.number(),
    extraVolume: z.number(),
    maxMissing: z.number(),
    maxExtra: z.number(),
    referenceVolume: z.number(),
    partVolume: z.number(),
  }),
  pieces: z.array(
    z.object({
      kind: z.enum(['missing', 'extra']),
      volume: z.number(),
      maxDev: z.number(),
      at: vec3,
      bounds: z.tuple([vec3, vec3]),
      surfaces: z.array(z.object({ index: z.number().int(), area: z.number() })),
      partArea: z.number(),
    }),
  ),
  more: z.number().int().optional(),
  below: z.object({ count: z.number().int(), volume: z.number() }),
  offcuts: z.object({ count: z.number().int(), volume: z.number() }).optional(),
  fallback: z.string().optional(),
})

// ── welding ───────────────────────────────────────────────────────────────────────────────

/** An indexed mesh (float64 positions) with per-triangle labels. */
export interface IndexedMesh {
  readonly positions: Float64Array
  readonly triangles: Uint32Array
  readonly faces: Uint32Array
}

/**
 * Vertices within `eps` (on a grid of that size) joined; triangles that collapse dropped.
 * `corner(t, k)` gives corner k of triangle t; `label(t)` its face label.
 */
export function weld(
  count: number,
  corner: (t: number, k: number, out: number[]) => void,
  label: (t: number) => number,
  eps: number,
): IndexedMesh {
  const ids = new Map<string, number>()
  const pos: number[] = []
  const tris: number[] = []
  const faces: number[] = []
  const p = [0, 0, 0]
  const tri = [0, 0, 0]
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      corner(t, k, p)
      const key = `${Math.round(p[0]! / eps)},${Math.round(p[1]! / eps)},${Math.round(p[2]! / eps)}`
      let id = ids.get(key)
      if (id === undefined) {
        id = pos.length / 3
        ids.set(key, id)
        pos.push(p[0]!, p[1]!, p[2]!)
      }
      tri[k] = id
    }
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue
    tris.push(tri[0]!, tri[1]!, tri[2]!)
    faces.push(label(t))
  }
  return {
    positions: Float64Array.from(pos),
    triangles: Uint32Array.from(tris),
    faces: Uint32Array.from(faces),
  }
}

/** A reference triangle soup (part frame) welded within `COMPARE_WELD_MM`. */
export function weldSoup(soup: Float32Array | Float64Array): IndexedMesh {
  return weld(
    soup.length / 9,
    (t, k, out) => {
      out[0] = soup[9 * t + 3 * k]!
      out[1] = soup[9 * t + 3 * k + 1]!
      out[2] = soup[9 * t + 3 * k + 2]!
    },
    () => 0,
    COMPARE_WELD_MM,
  )
}

/** The evaluated part (vertices split at surface boundaries) welded back into one solid. */
export function weldPart(part: CompareMesh): IndexedMesh {
  const { positions: p, indices: ix } = part
  return weld(
    ix.length / 3,
    (t, k, out) => {
      const v = ix[3 * t + k]!
      out[0] = p[3 * v]!
      out[1] = p[3 * v + 1]!
      out[2] = p[3 * v + 2]!
    },
    (t) => part.triangleSurface[t]!,
    1e-6,
  )
}

/**
 * Closed and consistently oriented: every directed edge has its opposite, once (the welded
 * reference; an open or non-manifold mesh goes to the height maps).
 */
export function isClosed(m: IndexedMesh): boolean {
  const edges = new Map<number, number>()
  const n = m.positions.length / 3
  const ix = m.triangles
  if (ix.length === 0) return false
  for (let t = 0; t < ix.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = ix[t + k]!
      const b = ix[t + ((k + 1) % 3)]!
      const key = a * n + b
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  for (const [key, c] of edges) {
    if (c !== 1) return false
    const a = Math.floor(key / n)
    const b = key - a * n
    if (edges.get(b * n + a) !== 1) return false
  }
  return true
}

/** Column-major 4 × 4 applied to a soup (source units → part frame mm). */
export function transformSoup(soup: Float32Array, m: readonly number[]): Float64Array {
  const out = new Float64Array(soup.length)
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i]!,
      y = soup[i + 1]!,
      z = soup[i + 2]!
    out[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
    out[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
    out[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
  }
  return out
}

// ── regions of a boolean result ──────────────────────────────────────────────────────────

interface MeshOut {
  readonly positions: Float32Array
  readonly indices: Uint32Array
  readonly triangleOriginal: Uint32Array
  readonly triangleFace: Uint32Array
}

/** Union-find over `n` items (path halving). */
function unionFind(n: number): { find(a: number): number; join(a: number, b: number): void } {
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!
      a = parent[a]!
    }
    return a
  }
  return {
    find,
    join: (a, b) => {
      const x = find(a)
      const y = find(b)
      if (x !== y) parent[y] = x
    },
  }
}

/** Connected pieces of a mesh: per triangle its piece, and the piece count. */
export function components(indices: Uint32Array, vertices: number): { of: Int32Array; n: number } {
  const uf = unionFind(vertices)
  for (let t = 0; t < indices.length; t += 3) {
    uf.join(indices[t]!, indices[t + 1]!)
    uf.join(indices[t]!, indices[t + 2]!)
  }
  const label = new Int32Array(vertices).fill(-1)
  const of = new Int32Array(indices.length / 3)
  let n = 0
  for (let t = 0; t < of.length; t++) {
    const r = uf.find(indices[3 * t]!)
    if (label[r] === -1) label[r] = n++
    of[t] = label[r]!
  }
  return { of, n }
}

type Box = [[number, number, number], [number, number, number]]

const emptyBox = (): Box => [
  [Infinity, Infinity, Infinity],
  [-Infinity, -Infinity, -Infinity],
]

function grow(b: Box, p: Float32Array, v: number): void {
  for (let k = 0; k < 3; k++) {
    const x = p[3 * v + k]!
    if (x < b[0][k]!) b[0][k] = x
    if (x > b[1][k]!) b[1][k] = x
  }
}

const diagonal = (b: Box) => Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2])

const inside = (b: Box, x: number, y: number, z: number, by: number) =>
  x >= b[0][0] - by &&
  x <= b[1][0] + by &&
  y >= b[0][1] - by &&
  y <= b[1][1] + by &&
  z >= b[0][2] - by &&
  z <= b[1][2] + by

const contains = (outer: Box, inner: Box, by: number) =>
  inside(outer, inner[0][0], inner[0][1], inner[0][2], by) &&
  inside(outer, inner[1][0], inner[1][1], inner[1][2], by)

/** Samples per triangle edge at most (a large face is sampled coarser; 1-Lipschitz error ≤ h). */
const SAMPLES_MAX = 8

/** Deviating samples of a piece: position, distance, and the triangle grid cell they came from. */
interface Samples {
  readonly xyz: number[]
  readonly dev: number[]
  /** Triangle, grid row and column per sample (grid neighbours are linked). */
  readonly cell: number[]
}

/**
 * The samples of triangle `t` farther than `stop` from `other`, on a barycentric grid of about
 * `h` (its corners included): a large flat face is farthest inside, not at a corner. A query
 * stops as soon as the sample is within `stop`, so only deviating samples cost a full search;
 * `local` (the piece's faces on the other surface, part of it) rules most samples out first.
 */
function deviatingSamples(
  p: Float32Array,
  ix: Uint32Array,
  t: number,
  other: MeshBvh,
  local: MeshBvh | undefined,
  h: number,
  stop: number,
  out: Samples,
): void {
  const a = 3 * ix[3 * t]!,
    b = 3 * ix[3 * t + 1]!,
    c = 3 * ix[3 * t + 2]!
  const edge = Math.max(
    Math.hypot(p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!),
    Math.hypot(p[c]! - p[b]!, p[c + 1]! - p[b + 1]!, p[c + 2]! - p[b + 2]!),
    Math.hypot(p[a]! - p[c]!, p[a + 1]! - p[c + 1]!, p[a + 2]! - p[c + 2]!),
  )
  const n = Math.min(SAMPLES_MAX, Math.max(1, Math.ceil(edge / h)))
  for (let i = 0; i <= n; i++)
    for (let j = 0; i + j <= n; j++) {
      const u = i / n,
        v = j / n,
        w = 1 - u - v
      const x = w * p[a]! + u * p[b]! + v * p[c]!
      const y = w * p[a + 1]! + u * p[b + 1]! + v * p[c + 1]!
      const z = w * p[a + 2]! + u * p[b + 2]! + v * p[c + 2]!
      if (local !== undefined && local.closest(x, y, z, stop).distance <= stop) continue
      const d = other.closest(x, y, z, stop).distance
      if (d <= stop) continue
      out.xyz.push(x, y, z)
      out.dev.push(d)
      out.cell.push(t, i, j)
    }
}

/**
 * Deviating samples joined into regions: grid neighbours on one triangle, and samples of any
 * triangles within `link` of each other (a spatial hash). A long triangle that spans a notch
 * and a rebate along a wall is not one region: its samples between them do not deviate.
 */
function sampleClusters(s: Samples, link: number): number[][] {
  const count = s.dev.length
  const uf = unionFind(count)
  const byCell = new Map<string, number>()
  for (let k = 0; k < count; k++)
    byCell.set(`${s.cell[3 * k]},${s.cell[3 * k + 1]},${s.cell[3 * k + 2]}`, k)
  for (let k = 0; k < count; k++) {
    const t = s.cell[3 * k]!,
      i = s.cell[3 * k + 1]!,
      j = s.cell[3 * k + 2]!
    for (const [di, dj] of [
      [1, 0],
      [0, 1],
      [1, -1],
    ] as const) {
      const o = byCell.get(`${t},${i + di},${j + dj}`)
      if (o !== undefined) uf.join(k, o)
    }
  }
  const hash = new Map<string, number[]>()
  const key = (a: number, b: number, c: number) => `${a},${b},${c}`
  for (let k = 0; k < count; k++) {
    const gx = Math.floor(s.xyz[3 * k]! / link),
      gy = Math.floor(s.xyz[3 * k + 1]! / link),
      gz = Math.floor(s.xyz[3 * k + 2]! / link)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const o of hash.get(key(gx + dx, gy + dy, gz + dz)) ?? [])
            if (
              Math.hypot(
                s.xyz[3 * k]! - s.xyz[3 * o]!,
                s.xyz[3 * k + 1]! - s.xyz[3 * o + 1]!,
                s.xyz[3 * k + 2]! - s.xyz[3 * o + 2]!,
              ) <= link
            )
              uf.join(k, o)
    const own = key(gx, gy, gz)
    const list = hash.get(own)
    if (list === undefined) hash.set(own, [k])
    else list.push(k)
  }
  const groups = new Map<number, number[]>()
  for (let k = 0; k < count; k++) {
    const r = uf.find(k)
    const g = groups.get(r)
    if (g === undefined) groups.set(r, [k])
    else g.push(k)
  }
  return [...groups.values()]
}

interface KindRegions {
  readonly pieces: ComparePiece[]
  readonly below: { count: number; volume: number }
  /** The largest deviation found (exact when over the threshold). */
  readonly max: number
  readonly volume: number
  readonly offcuts: { count: number; volume: number }
}

/**
 * The regions of one kind's boolean result `m`. `own` is the original id of the deviating side
 * (the reference's for missing, the part's for extra), `partId` the part's (its triangles carry
 * surface indices), `other` the surface distances are measured to. A piece is split into
 * regions where its deviating samples (over the threshold) are apart: a thin facet sliver
 * along a wall must not join a notch and a rebate into one region. `boxVolume` gives the
 * volume of this kind's material in a box (a region that is only part of its piece).
 */
function regionsOf(
  kind: 'missing' | 'extra',
  m: MeshOut,
  own: number,
  partId: number,
  other: MeshBvh,
  threshold: number,
  steps: Steps,
  boxVolume: (b: Box) => AppResult<number>,
): AppResult<KindRegions> {
  const { positions: p, indices: ix } = m
  const { of, n } = components(ix, p.length / 3)
  const volume = new Float64Array(n)
  const box: Box[] = []
  const ownTris: number[][] = []
  const partTris: number[][] = []
  /** Per piece its triangles on the other surface (neither own nor, for extra, the part's). */
  const otherTris: number[][] = []
  const touchesOther = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    box.push(emptyBox())
    ownTris.push([])
    partTris.push([])
    otherTris.push([])
  }
  for (let t = 0; t < of.length; t++) {
    const k = of[t]!
    const i0 = ix[3 * t]!,
      i1 = ix[3 * t + 1]!,
      i2 = ix[3 * t + 2]!
    const ax = p[3 * i0]!,
      ay = p[3 * i0 + 1]!,
      az = p[3 * i0 + 2]!
    const bx = p[3 * i1]!,
      by = p[3 * i1 + 1]!,
      bz = p[3 * i1 + 2]!
    const cx = p[3 * i2]!,
      cy = p[3 * i2 + 1]!,
      cz = p[3 * i2 + 2]!
    // signed volume of the tetrahedron with the origin (divergence theorem)
    volume[k] =
      volume[k]! +
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
    grow(box[k]!, p, i0)
    grow(box[k]!, p, i1)
    grow(box[k]!, p, i2)
    const orig = m.triangleOriginal[t]!
    if (orig === partId) partTris[k]!.push(t)
    else touchesOther[k] = 1
    if (orig === own) ownTris[k]!.push(t)
    else otherTris[k]!.push(t)
  }
  const out = {
    pieces: [] as ComparePiece[],
    below: { count: 0, volume: 0 },
    volume: 0,
    offcuts: { count: 0, volume: 0 },
  }
  let max = 0
  for (let k = 0; k < n; k++) {
    const v = Math.abs(volume[k]!)
    // extra material that never meets the reference: a loose piece of the part (a frame cut
    // free by a through profile), not a deviation
    if (kind === 'extra' && touchesOther[k] === 0) {
      out.offcuts.count++
      out.offcuts.volume += v
      continue
    }
    out.volume += v
    const diag = diagonal(box[k]!)
    // a piece cannot be further from the other surface than its own size: noise without a query
    if (v <= EPSILON_VOLUME || diag < threshold) {
      out.below.count++
      out.below.volume += v
      continue
    }
    if (k % 16 === 0) {
      const step = steps.step({ done: k, total: n, label: `Measuring ${kind} material` })
      if (step.isErr()) return Err(step.unwrapErr())
    }
    const h = Math.max(diag / 32, threshold)
    const tris = ownTris[k]!
    const near = otherTris[k]!
    const sub = new Uint32Array(near.length * 3)
    near.forEach((t, i) => sub.set(ix.subarray(3 * t, 3 * t + 3), 3 * i))
    const local = near.length === 0 ? undefined : new MeshBvh(p, sub)
    const samples: Samples = { xyz: [], dev: [], cell: [] }
    for (const t of tris) deviatingSamples(p, ix, t, other, local, h, threshold, samples)
    if (samples.dev.length === 0) {
      out.below.count++
      out.below.volume += v
      continue
    }
    const clusters = sampleClusters(samples, h)
    for (const members of clusters) {
      const b = emptyBox()
      let worst = members[0]!
      for (const i of members) {
        for (let c = 0; c < 3; c++) {
          const x = samples.xyz[3 * i + c]!
          if (x < b[0][c]!) b[0][c] = x
          if (x > b[1][c]!) b[1][c] = x
        }
        if (samples.dev[i]! > samples.dev[worst]!) worst = i
      }
      const dev = samples.dev[worst]!
      if (dev > max) max = dev
      // the region's material lies within its deviation of its own surface: grow the box by it,
      // inside the piece's box
      const by = dev + threshold
      const pb = box[k]!
      for (let c = 0; c < 3; c++) {
        b[0][c] = Math.max(pb[0][c]!, b[0][c]! - by)
        b[1][c] = Math.min(pb[1][c]!, b[1][c]! + by)
      }
      let regionVolume = v
      if (!contains(b, pb, 1e-9)) {
        const bv = boxVolume(b)
        if (bv.isErr()) return Err(bv.unwrapErr())
        regionVolume = Math.min(v, bv.unwrap())
      }
      // the part surfaces bounding the region
      const surfaces = new Map<number, number>()
      let partArea = 0
      for (const t of partTris[k]!) {
        const i0 = 3 * ix[3 * t]!,
          i1 = 3 * ix[3 * t + 1]!,
          i2 = 3 * ix[3 * t + 2]!
        const cx = (p[i0]! + p[i1]! + p[i2]!) / 3
        const cy = (p[i0 + 1]! + p[i1 + 1]! + p[i2 + 1]!) / 3
        const cz = (p[i0 + 2]! + p[i1 + 2]! + p[i2 + 2]!) / 3
        if (!inside(b, cx, cy, cz, 1e-6)) continue
        const ux = p[i1]! - p[i0]!,
          uy = p[i1 + 1]! - p[i0 + 1]!,
          uz = p[i1 + 2]! - p[i0 + 2]!
        const vx = p[i2]! - p[i0]!,
          vy = p[i2 + 1]! - p[i0 + 1]!,
          vz = p[i2 + 2]! - p[i0 + 2]!
        const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
        partArea += area
        const f = m.triangleFace[t]!
        surfaces.set(f, (surfaces.get(f) ?? 0) + area)
      }
      out.pieces.push({
        kind,
        volume: regionVolume,
        maxDev: dev,
        at: [samples.xyz[3 * worst]!, samples.xyz[3 * worst + 1]!, samples.xyz[3 * worst + 2]!],
        bounds: b,
        surfaces: [...surfaces]
          .sort((x, y) => y[1] - x[1])
          .slice(0, SURFACES_MAX)
          .map(([index, area]) => ({ index, area })),
        partArea,
      })
    }
  }
  return Ok({ ...out, max })
}

const score = (x: ComparePiece) => x.maxDev * x.volume

function ranked(pieces: ComparePiece[]): { pieces: ComparePiece[]; more?: number } {
  pieces.sort((a, b) => score(b) - score(a))
  return pieces.length > COMPARE_PIECES_MAX
    ? { pieces: pieces.slice(0, COMPARE_PIECES_MAX), more: pieces.length - COMPARE_PIECES_MAX }
    : { pieces }
}

/** Volume of a closed indexed mesh (divergence theorem). */
function meshVolume(m: IndexedMesh): number {
  let v = 0
  const p = m.positions
  const ix = m.triangles
  for (let t = 0; t < ix.length; t += 3) {
    const a = 3 * ix[t]!,
      b = 3 * ix[t + 1]!,
      c = 3 * ix[t + 2]!
    v +=
      p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
      p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
      p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)
  }
  return v / 6
}

/** A reference with its triangles turned over (an inside-out export). */
function flipped(m: IndexedMesh): IndexedMesh {
  const t = Uint32Array.from(m.triangles)
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i + 1]!
    t[i + 1] = t[i + 2]!
    t[i + 2] = a
  }
  return { ...m, triangles: t }
}

/** A closed box mesh (outward), for the volume of a region's material. */
function boxMesh(b: Box): IndexedMesh {
  const positions = new Float64Array(24)
  for (let i = 0; i < 8; i++) {
    positions[3 * i] = b[i & 1 ? 1 : 0][0]
    positions[3 * i + 1] = b[i & 2 ? 1 : 0][1]
    positions[3 * i + 2] = b[i & 4 ? 1 : 0][2]
  }
  const quads = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ]
  const triangles = new Uint32Array(quads.flatMap(([a, b2, c, d]) => [a!, b2!, c!, a!, c!, d!]))
  return { positions, triangles, faces: new Uint32Array(12) }
}

/**
 * The boolean method: Err (`geometry.evaluation`) when the solid library refuses a mesh (the
 * caller falls back to the height maps). `placed` is the welded reference in the part frame.
 */
export function compareBoolean(
  kernel: SolidKernel,
  placed: IndexedMesh,
  part: CompareMesh,
  threshold: number,
  steps: Steps,
): AppResult<CompareRaw> {
  // an inside-out export (negative volume) would subtract the wrong side
  const reference = meshVolume(placed) < 0 ? flipped(placed) : placed
  const welded = weldPart(part)
  const partBvh = new MeshBvh(welded.positions, welded.triangles)
  const refBvh = new MeshBvh(reference.positions, reference.triangles)
  return kernel.withSolids((s) => {
    const refId = s.reserveOriginalId()
    if (refId.isErr()) return Err(refId.unwrapErr())
    const partId = s.reserveOriginalId()
    if (partId.isErr()) return Err(partId.unwrapErr())
    const ref = s.fromMesh(reference, refId.unwrap())
    if (ref.isErr()) return Err(ref.unwrapErr())
    const whole = s.fromMesh(welded, partId.unwrap())
    if (whole.isErr()) return Err(whole.unwrapErr())
    const step = steps.step({ done: 1, total: 3, label: 'Comparing with the reference' })
    if (step.isErr()) return Err(step.unwrapErr())
    const boxVolume = (solid: Solid) => (b: Box) =>
      s
        .reserveOriginalId()
        .andThen((id) => s.fromMesh(boxMesh(b), id))
        .andThen((x) => s.intersect(solid, x))
        .andThen((x) => s.volume(x))
    const results: KindRegions[] = []
    for (const kind of ['missing', 'extra'] as const) {
      const solid =
        kind === 'missing'
          ? s.subtract(ref.unwrap(), whole.unwrap())
          : s.subtract(whole.unwrap(), ref.unwrap())
      if (solid.isErr()) return Err(solid.unwrapErr())
      const mesh = s.toMesh(solid.unwrap())
      if (mesh.isErr()) return Err(mesh.unwrapErr())
      const r = regionsOf(
        kind,
        mesh.unwrap(),
        kind === 'missing' ? refId.unwrap() : partId.unwrap(),
        partId.unwrap(),
        kind === 'missing' ? partBvh : refBvh,
        threshold,
        steps,
        boxVolume(solid.unwrap()),
      )
      if (r.isErr()) return Err(r.unwrapErr())
      results.push(r.unwrap())
    }
    const rv = s.volume(ref.unwrap())
    if (rv.isErr()) return Err(rv.unwrapErr())
    const pv = s.volume(whole.unwrap())
    if (pv.isErr()) return Err(pv.unwrapErr())
    const [mm, ee] = results as [KindRegions, KindRegions]
    const { pieces, more } = ranked([...mm.pieces, ...ee.pieces])
    return Ok({
      method: 'boolean' as const,
      stats: {
        missingVolume: mm.volume,
        extraVolume: ee.volume,
        maxMissing: mm.max,
        maxExtra: ee.max,
        referenceVolume: rv.unwrap(),
        partVolume: pv.unwrap() - ee.offcuts.volume,
      },
      pieces,
      ...(more === undefined ? {} : { more }),
      below: {
        count: mm.below.count + ee.below.count,
        volume: mm.below.volume + ee.below.volume,
      },
      ...(ee.offcuts.count > 0 ? { offcuts: ee.offcuts } : {}),
    })
  })
}

// ── height maps ───────────────────────────────────────────────────────────────────────────

/** Highest surface per cell seen from the face (w, face frame: 0 = the face, negative inside). */
interface HeightMap {
  readonly nu: number
  readonly nv: number
  readonly h: Float64Array
  /** Triangle per cell (−1: none). */
  readonly tri: Int32Array
}

function heightMap(
  count: number,
  corner: (t: number, k: number, out: number[]) => void,
  toFace: (p: Vec3) => Vec3,
  nu: number,
  nv: number,
  cell: number,
  empty: number,
): HeightMap {
  const h = new Float64Array(nu * nv).fill(empty)
  const tri = new Int32Array(nu * nv).fill(-1)
  const q = [0, 0, 0]
  const a: Vec3[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      corner(t, k, q)
      a[k] = toFace([q[0]!, q[1]!, q[2]!])
    }
    const [p0, p1, p2] = a as [Vec3, Vec3, Vec3]
    const den = (p1[1] - p2[1]) * (p0[0] - p2[0]) + (p2[0] - p1[0]) * (p0[1] - p2[1])
    if (Math.abs(den) < 1e-12) continue // vertical: seen edge-on
    const i0 = Math.max(0, Math.ceil(Math.min(p0[0], p1[0], p2[0]) / cell - 0.5))
    const i1 = Math.min(nu - 1, Math.floor(Math.max(p0[0], p1[0], p2[0]) / cell - 0.5))
    const j0 = Math.max(0, Math.ceil(Math.min(p0[1], p1[1], p2[1]) / cell - 0.5))
    const j1 = Math.min(nv - 1, Math.floor(Math.max(p0[1], p1[1], p2[1]) / cell - 0.5))
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * cell
        const y = (j + 0.5) * cell
        const l0 = ((p1[1] - p2[1]) * (x - p2[0]) + (p2[0] - p1[0]) * (y - p2[1])) / den
        const l1 = ((p2[1] - p0[1]) * (x - p2[0]) + (p0[0] - p2[0]) * (y - p2[1])) / den
        const l2 = 1 - l0 - l1
        if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue
        const w = l0 * p0[2] + l1 * p1[2] + l2 * p2[2]
        const c = j * nu + i
        if (w > h[c]!) {
          h[c] = w
          tri[c] = t
        }
      }
  }
  return { nu, nv, h, tri }
}

/**
 * The height-map method (deviation.md § Height map method, design source): per direction the
 * first surface of the reference and of the part seen from the stock face on a `cell` grid;
 * cells where the reference has material (grown by 1 mm), off the edge band along its vertical
 * walls, deviate by part − reference height (positive = extra). Connected cells of one sign
 * beyond the threshold are a region.
 */
export function compareHeightmap(
  reference: Float64Array,
  part: CompareMesh,
  opts: CompareOptions,
  steps: Steps,
  fallback: string,
): AppResult<CompareRaw> {
  const cell = opts.cell ?? COMPARE_CELL_MM
  const pieces: ComparePiece[] = []
  const below = { count: 0, volume: 0 }
  const stats = {
    missingVolume: 0,
    extraVolume: 0,
    maxMissing: 0,
    maxExtra: 0,
    referenceVolume: 0,
    partVolume: 0,
  }
  const dirs = opts.directions.length > 0 ? [...new Set(opts.directions)] : (['+z'] as const)
  for (const [di, direction] of dirs.entries()) {
    const step = steps.step({ done: di, total: dirs.length, label: 'Comparing height maps' })
    if (step.isErr()) return Err(step.unwrapErr())
    const frame = faceFrame(direction, opts.stock)
    const local = localStock(direction, opts.stock)
    const nu = Math.max(1, Math.ceil(local.length / cell))
    const nv = Math.max(1, Math.ceil(local.width / cell))
    const empty = -local.thickness
    const toFace = (p: Vec3) => unapplyPlacement(frame, p)
    const ref = heightMap(
      reference.length / 9,
      (t, k, out) => {
        out[0] = reference[9 * t + 3 * k]!
        out[1] = reference[9 * t + 3 * k + 1]!
        out[2] = reference[9 * t + 3 * k + 2]!
      },
      toFace,
      nu,
      nv,
      cell,
      empty,
    )
    const pp = part.positions
    const px = part.indices
    const prt = heightMap(
      px.length / 3,
      (t, k, out) => {
        const v = px[3 * t + k]!
        out[0] = pp[3 * v]!
        out[1] = pp[3 * v + 1]!
        out[2] = pp[3 * v + 2]!
      },
      toFace,
      nu,
      nv,
      cell,
      empty,
    )
    const n = nu * nv
    // domain: reference material in the column, grown by 1 mm
    const grow = Math.ceil(1 / cell)
    const inRef = new Uint8Array(n)
    for (let c = 0; c < n; c++) if (ref.tri[c]! >= 0) inRef[c] = 1
    const domain = new Uint8Array(n)
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        if (inRef[j * nu + i] === 0) continue
        for (let dj = -grow; dj <= grow; dj++)
          for (let dk = -grow; dk <= grow; dk++) {
            const jj = j + dj,
              ii = i + dk
            if (jj >= 0 && jj < nv && ii >= 0 && ii < nu) domain[jj * nu + ii] = 1
          }
      }
    const area = cell * cell
    const dev = new Float64Array(n)
    const sign = new Int8Array(n)
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const c = j * nu + i
        if (di === 0) {
          stats.referenceVolume += (ref.h[c]! - empty) * area
          stats.partVolume += (prt.h[c]! - empty) * area
        }
        if (domain[c] === 0) continue
        // edge band: next to a vertical reference wall, where any height map aliases
        let edge = false
        for (const [ii, jj] of [
          [i - 1, j],
          [i + 1, j],
          [i, j - 1],
          [i, j + 1],
        ] as const)
          if (
            ii >= 0 &&
            ii < nu &&
            jj >= 0 &&
            jj < nv &&
            Math.abs(ref.h[jj * nu + ii]! - ref.h[c]!) > opts.threshold
          )
            edge = true
        if (edge) continue
        const d = prt.h[c]! - ref.h[c]!
        dev[c] = d
        if (d < 0) {
          stats.missingVolume += -d * area
          stats.maxMissing = Math.max(stats.maxMissing, -d)
        } else {
          stats.extraVolume += d * area
          stats.maxExtra = Math.max(stats.maxExtra, d)
        }
        if (Math.abs(d) >= opts.threshold) sign[c] = d > 0 ? 1 : -1
        else if (Math.abs(d) > 1e-9) {
          below.count++
          below.volume += Math.abs(d) * area
        }
      }
    // regions: 4-connected cells of one sign
    const seen = new Uint8Array(n)
    for (let s0 = 0; s0 < n; s0++) {
      if (sign[s0] === 0 || seen[s0] === 1) continue
      const sg = sign[s0]!
      const queue = [s0]
      seen[s0] = 1
      let volume = 0
      let maxDev = 0
      let atCell = s0
      let i0 = Infinity,
        i1 = -Infinity,
        j0 = Infinity,
        j1 = -Infinity,
        w0 = Infinity,
        w1 = -Infinity
      const surf = new Map<number, number>()
      while (queue.length > 0) {
        const c = queue.pop()!
        const i = c % nu
        const j = (c - i) / nu
        const d = Math.abs(dev[c]!)
        volume += d * area
        if (d > maxDev) {
          maxDev = d
          atCell = c
        }
        i0 = Math.min(i0, i)
        i1 = Math.max(i1, i)
        j0 = Math.min(j0, j)
        j1 = Math.max(j1, j)
        w0 = Math.min(w0, prt.h[c]!, ref.h[c]!)
        w1 = Math.max(w1, prt.h[c]!, ref.h[c]!)
        const t = prt.tri[c]!
        if (t >= 0) {
          const f = part.triangleSurface[t]!
          surf.set(f, (surf.get(f) ?? 0) + area)
        }
        for (const [ii, jj] of [
          [i - 1, j],
          [i + 1, j],
          [i, j - 1],
          [i, j + 1],
        ] as const) {
          if (ii < 0 || ii >= nu || jj < 0 || jj >= nv) continue
          const cc = jj * nu + ii
          if (seen[cc] === 0 && sign[cc] === sg) {
            seen[cc] = 1
            queue.push(cc)
          }
        }
      }
      const ai = atCell % nu
      const aj = (atCell - ai) / nu
      const at = applyPlacement(frame, [(ai + 0.5) * cell, (aj + 0.5) * cell, prt.h[atCell]!])
      const c0 = applyPlacement(frame, [i0 * cell, j0 * cell, w0])
      const c1 = applyPlacement(frame, [(i1 + 1) * cell, (j1 + 1) * cell, w1])
      let partArea = 0
      for (const a of surf.values()) partArea += a
      pieces.push({
        kind: sg > 0 ? 'extra' : 'missing',
        volume,
        maxDev,
        at,
        bounds: [
          [Math.min(c0[0], c1[0]), Math.min(c0[1], c1[1]), Math.min(c0[2], c1[2])],
          [Math.max(c0[0], c1[0]), Math.max(c0[1], c1[1]), Math.max(c0[2], c1[2])],
        ],
        surfaces: [...surf]
          .sort((x, y) => y[1] - x[1])
          .slice(0, SURFACES_MAX)
          .map(([index, a]) => ({ index, area: a })),
        partArea,
      })
    }
  }
  const { pieces: top, more } = ranked(pieces)
  return Ok({
    method: 'heightmap',
    stats,
    pieces: top,
    ...(more === undefined ? {} : { more }),
    below,
    fallback,
  })
}

/** The directions of the faces the design's operations use (`+z` when there are none). */
export function operationDirections(ops: readonly OperationGeometry[]): Direction[] {
  const used = new Set<Direction>(ops.map((o) => o.direction ?? '+z'))
  if (used.size === 0) used.add('+z')
  return DIRECTIONS.filter((d) => used.has(d))
}

// ── attribution helpers (host side) ─────────────────────────────────────────────────────────

/**
 * The radius of each design corner surface (`<op>.corner[i]` of a rounded rectangle or a
 * shape's arc, `<op>.floorFillet`), for the `cornerRadius` cause.
 */
export function cornerRadii(ops: readonly OperationGeometry[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const op of ops) {
    if (op.kind === 'pocket' && op.floorRadius > 0) out.set(`${op.id}.floorFillet`, op.floorRadius)
    if (op.kind !== 'pocket' && op.kind !== 'profile') continue
    const c = op.shape.contour
    if (c.kind === 'rectangle') {
      if (c.cornerRadius > 0)
        for (let i = 0; i < 8; i++) out.set(`${op.id}.corner[${i}]`, c.cornerRadius)
    } else if (c.kind === 'region') {
      let i = 0
      for (const loop of regionLoops(c.region))
        for (const e of loop.elements) {
          if (e.kind === 'arc') out.set(`${op.id}.corner[${i}]`, arcRadius(e))
          i++
        }
    }
  }
  return out
}

/** Share of a piece's part area on corner surfaces that makes it an intended fillet. */
export const CORNER_SHARE = 0.8

/**
 * `cornerRadius`: the piece lies on the design's corner surfaces (at least `CORNER_SHARE` of its
 * area on the part) and deviates no more than their radius: the fillet the design chose where
 * the reference is sharper.
 */
export function isCornerFillet(
  piece: ComparePiece,
  surfaceId: (index: number) => string | undefined,
  radii: ReadonlyMap<string, number>,
): boolean {
  if (piece.partArea <= 0) return false
  let onCorners = 0
  let radius = 0
  for (const s of piece.surfaces) {
    const id = surfaceId(s.index)
    const r = id === undefined ? undefined : radii.get(id)
    if (r === undefined) continue
    onCorners += s.area
    radius = Math.max(radius, r)
  }
  return onCorners >= CORNER_SHARE * piece.partArea && piece.maxDev <= radius
}
