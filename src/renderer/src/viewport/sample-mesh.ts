// A hand-built sample part for the gallery and tests (the renderer has no geometry kernel):
// stock 100 × 60 × 20 with pocket1 (40 × 25 × 8, cornerRadius 4) and two flat drills Ø6 × 12,
// labelled with the real surface ids (design.md). Same layout as `PartEvaluation`: vertices
// split at surface boundaries, outward-facing triangles (counter-clockwise seen from outside).
import type { SurfaceId } from '../../../core/geometry/model'
import type { Box, Vec3, ViewportMesh } from './mesh'

class MeshBuilder {
  private readonly positions: number[] = []
  private readonly indices: number[] = []
  private readonly triangleSurface: number[] = []
  private readonly surfaces: SurfaceId[] = []
  /** Vertex index per surface and position key: vertices are shared within a surface only. */
  private readonly vertices = new Map<string, number>()

  private vertex(surface: number, p: Vec3): number {
    const key = `${surface}:${p.map((x) => x.toFixed(6)).join(',')}`
    let i = this.vertices.get(key)
    if (i === undefined) {
      i = this.positions.length / 3
      this.positions.push(...p)
      this.vertices.set(key, i)
    }
    return i
  }

  private surface(id: SurfaceId): number {
    const i = this.surfaces.indexOf(id)
    return i >= 0 ? i : this.surfaces.push(id) - 1
  }

  tri(id: SurfaceId, a: Vec3, b: Vec3, c: Vec3): void {
    const s = this.surface(id)
    this.indices.push(this.vertex(s, a), this.vertex(s, b), this.vertex(s, c))
    this.triangleSurface.push(s)
  }

  /** a, b, c, d counter-clockwise seen from outside. */
  quad(id: SurfaceId, a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
    this.tri(id, a, b, c)
    this.tri(id, a, c, d)
  }

  /** Inward-facing wall (a hole's side) between z0 > z1 along a counter-clockwise loop. */
  wall(
    id: (k: number) => SurfaceId,
    loop: readonly (readonly [number, number])[],
    z0: number,
    z1: number,
  ): void {
    for (let k = 0; k < loop.length; k++) {
      const [x0, y0] = loop[k]!
      const [x1, y1] = loop[(k + 1) % loop.length]!
      this.quad(id(k), [x0, y0, z0], [x1, y1, z0], [x1, y1, z1], [x0, y0, z1])
    }
  }

  /** Upward-facing fan over a convex counter-clockwise loop. */
  floor(id: SurfaceId, loop: readonly (readonly [number, number])[], z: number): void {
    const cx = loop.reduce((s, p) => s + p[0], 0) / loop.length
    const cy = loop.reduce((s, p) => s + p[1], 0) / loop.length
    for (let k = 0; k < loop.length; k++) {
      const [x0, y0] = loop[k]!
      const [x1, y1] = loop[(k + 1) % loop.length]!
      this.tri(id, [cx, cy, z], [x0, y0, z], [x1, y1, z])
    }
  }

  build(): ViewportMesh {
    return {
      positions: new Float32Array(this.positions),
      indices: new Uint32Array(this.indices),
      triangleSurface: new Uint32Array(this.triangleSurface),
      surfaces: [...this.surfaces],
    }
  }
}

export const SAMPLE_STOCK: Box = { min: [0, 0, -20], max: [100, 60, 0] }

const L = 100
const W = 60
const T = 20
const POCKET = { x0: 30, x1: 70, y0: 17.5, y1: 42.5, r: 4, depth: 8 }
const DRILLS = [
  { id: 'drill1', c: [15, 30], r: 3, depth: 12 },
  { id: 'drill2', c: [85, 30], r: 3, depth: 12 },
] as const
/**
 * Half side of the square of top surface around each drill (holds the hole's ring). The grid's
 * breakpoints stay outside these squares and the pocket's straight edges, so the top surface has
 * no T-junctions (they would show as feature edges).
 */
const DRILL_CELL = 5
const ARC_SEGMENTS = 8
const HOLE_SEGMENTS = 32

/** Rounded-rectangle loop, counter-clockwise, with the index of the wall or corner of each edge. */
function pocketLoop(): { points: [number, number][]; edge: SurfaceId[] } {
  const { x0, x1, y0, y1, r } = POCKET
  // Corner centres from bottom-left, counter-clockwise; corner[i] precedes wall[i].
  const centres: [number, number][] = [
    [x0 + r, y0 + r],
    [x1 - r, y0 + r],
    [x1 - r, y1 - r],
    [x0 + r, y1 - r],
  ]
  const points: [number, number][] = []
  const edge: SurfaceId[] = []
  centres.forEach(([cx, cy], i) => {
    const a0 = Math.PI + (i * Math.PI) / 2
    for (let j = 0; j <= ARC_SEGMENTS; j++) {
      const a = a0 + (j / ARC_SEGMENTS) * (Math.PI / 2)
      points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
      edge.push(j < ARC_SEGMENTS ? `pocket1.corner[${i}]` : `pocket1.wall[${i}]`)
    }
  })
  return { points, edge }
}

function circle(c: readonly [number, number], r: number): [number, number][] {
  return Array.from({ length: HOLE_SEGMENTS }, (_, i) => {
    const a = (i / HOLE_SEGMENTS) * 2 * Math.PI
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]
  })
}

/** Builds the sample part. */
export function sampleMesh(): ViewportMesh {
  const m = new MeshBuilder()
  const { x0, x1, y0, y1, depth } = POCKET
  const inPocket = (x: number, y: number): boolean => x > x0 && x < x1 && y > y0 && y < y1
  const inDrillCell = (x: number, y: number): boolean =>
    DRILLS.some((d) => Math.abs(x - d.c[0]) < DRILL_CELL && Math.abs(y - d.c[1]) < DRILL_CELL)

  // stock.top: a grid of cells around the pocket and the drill cells.
  const xs = [
    ...new Set([
      0,
      L,
      x0,
      x1,
      x0 + POCKET.r,
      x1 - POCKET.r,
      ...DRILLS.flatMap((d) => [d.c[0] - DRILL_CELL, d.c[0] + DRILL_CELL]),
    ]),
  ].sort((a, b) => a - b)
  const ys = [
    ...new Set([
      0,
      W,
      y0,
      y1,
      y0 + POCKET.r,
      y1 - POCKET.r,
      ...DRILLS.flatMap((d) => [d.c[1] - DRILL_CELL, d.c[1] + DRILL_CELL]),
    ]),
  ].sort((a, b) => a - b)
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const [a, b, c, d] = [xs[i]!, xs[i + 1]!, ys[j]!, ys[j + 1]!]
      if (inPocket((a + b) / 2, (c + d) / 2) || inDrillCell((a + b) / 2, (c + d) / 2)) continue
      m.quad('stock.top', [a, c, 0], [b, c, 0], [b, d, 0], [a, d, 0])
    }
  }
  // stock.top between the pocket's rounded corners and its bounding rectangle.
  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
  const loop = pocketLoop()
  corners.forEach((k, i) => {
    for (let j = 0; j < ARC_SEGMENTS; j++) {
      const p = loop.points[i * (ARC_SEGMENTS + 1) + j]!
      const q = loop.points[i * (ARC_SEGMENTS + 1) + j + 1]!
      m.tri('stock.top', [p[0], p[1], 0], [k[0], k[1], 0], [q[0], q[1], 0])
    }
  })
  // stock.top around each drill: per side of its square, a triangle to the circle point facing
  // the side's middle and a fan from each corner over the arc points of its half side.
  const q = HOLE_SEGMENTS / 4
  for (const d of DRILLS) {
    const hole = circle(d.c, d.r)
    const at = (i: number): [number, number] => hole[(i + HOLE_SEGMENTS) % HOLE_SEGMENTS]!
    const corner = (i: number): [number, number, number] => {
      const [x, y] = at(i)
      const s = DRILL_CELL / Math.max(Math.abs(x - d.c[0]), Math.abs(y - d.c[1]))
      return [d.c[0] + (x - d.c[0]) * s, d.c[1] + (y - d.c[1]) * s, 0]
    }
    for (let side = 0; side < 4; side++) {
      const mid = side * q
      const k0 = corner(mid - q / 2)
      const k1 = corner(mid + q / 2)
      m.tri('stock.top', k0, k1, [...at(mid), 0])
      for (let k = mid; k < mid + q / 2; k++)
        m.tri('stock.top', k1, [...at(k + 1), 0], [...at(k), 0])
      for (let k = mid - q / 2; k < mid; k++)
        m.tri('stock.top', k0, [...at(k + 1), 0], [...at(k), 0])
    }
    m.wall(() => `${d.id}.wall`, hole, 0, -d.depth)
    m.floor(`${d.id}.bottom`, hole, -d.depth)
  }
  // pocket1
  m.wall((k) => loop.edge[k]!, loop.points, 0, -depth)
  m.floor('pocket1.floor', loop.points, -depth)

  // stock sides and bottom
  m.quad('stock.side[0]', [0, 0, -T], [L, 0, -T], [L, 0, 0], [0, 0, 0])
  m.quad('stock.side[1]', [L, 0, -T], [L, W, -T], [L, W, 0], [L, 0, 0])
  m.quad('stock.side[2]', [L, W, -T], [0, W, -T], [0, W, 0], [L, W, 0])
  m.quad('stock.side[3]', [0, W, -T], [0, 0, -T], [0, 0, 0], [0, W, 0])
  m.quad('stock.bottom', [0, 0, -T], [0, W, -T], [L, W, -T], [L, 0, -T])
  return m.build()
}

/** Horizontal surfaces a sample `on` field may pick (stock top, pocket floor, drill bottoms). */
export const SAMPLE_PICK_ELIGIBLE: ReadonlySet<SurfaceId> = new Set([
  'stock.top',
  'pocket1.floor',
  'drill1.bottom',
  'drill2.bottom',
])

/** Analytic volume of the sample part (mm³; polygonal holes, as built). */
export function sampleVolume(): number {
  const { points } = pocketLoop()
  const area = (pts: readonly (readonly [number, number])[]): number =>
    pts.reduce((s, p, i) => {
      const q = pts[(i + 1) % pts.length]!
      return s + (p[0] * q[1] - q[0] * p[1]) / 2
    }, 0)
  return (
    L * W * T -
    area(points) * POCKET.depth -
    DRILLS.reduce((s, d) => s + area(circle(d.c, d.r)) * d.depth, 0)
  )
}
