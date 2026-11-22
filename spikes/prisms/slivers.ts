/**
 * Spike S3: where a top pocket and a side pocket meet. Two removals abut on a plane `s = b`
 * perpendicular to both faces and share the floor level and the inner bound: with exact
 * placement the plane disappears from the part; any triangle left in it is a membrane or a step
 * (float32 wall/floor mismatch, docs/plans/v0.2.md known issues). Report: spikes/prisms/results.md.
 */
import { DIRECTION, faceFrame, type Direction } from '../../src/core/geometry/face'
import {
  OVERSHOOT,
  unapplyPlacement,
  type StockGeometry,
  type Vec2,
  type Vec3,
} from '../../src/core/geometry/model'
import type { SolidMesh } from '../../src/core/geometry/solid-port'
import type { ShapePocket } from './evaluate'
import type { Element, Loop } from './region'

/**
 * Counter-clockwise rectangle `[x0, x1] × [y0, y1]` with corner `k` (0 = (x0, y0), then CCW)
 * rounded by `r` (> 0): 4 lines + 1 arc.
 */
export function rectOneRound(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  k: number,
  r: number,
): Loop {
  const c: Vec2[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
  const dirs: Vec2[] = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ] // into the rectangle from each corner
  const out: Element[] = []
  // start at the end of corner k's arc, walk CCW
  for (let j = 0; j < 4; j++) {
    const i = (k + j) % 4
    const p = c[i]!
    const n = c[(i + 1) % 4]!
    const edge: Vec2 = [Math.sign(n[0] - p[0]), Math.sign(n[1] - p[1])]
    const from: Vec2 = j === 0 ? [p[0] + edge[0] * r, p[1] + edge[1] * r] : p
    const isLast = j === 3
    const into: Vec2 = isLast ? [n[0] - edge[0] * r, n[1] - edge[1] * r] : n
    out.push({ kind: 'line', a: from, b: into })
    if (isLast) {
      const d = dirs[k]!
      const centre: Vec2 = [n[0] + d[0] * r, n[1] + d[1] * r]
      out.push({ kind: 'arc', a: into, b: out[0]!.a, centre, ccw: true })
    }
  }
  return out
}

export interface MeetCase {
  readonly stock: StockGeometry
  readonly side: Exclude<Direction, '+z' | '-z'>
  /** Shared axis (the side's `u` axis): the top pocket covers `[a, b]`, the side pocket `[b, c]`. */
  readonly a: number
  readonly b: number
  readonly c: number
  /** Depth below the top face, shared by both. */
  readonly depth: number
  /** How far the cut reaches into the stock from the side face, shared by both. */
  readonly reach: number
}

const axisIndex = (v: Vec3): number => v.findIndex((x) => x !== 0)

/** The two pockets of a meet case, each built in its own face frame. */
export function meetPockets(m: MeetCase): ShapePocket[] {
  const info = DIRECTION[m.side]
  const s = axisIndex(info.u) // shared axis in the part frame (0 = x, 1 = y)
  const t = axisIndex(info.n) // the side's normal axis
  const size = [m.stock.length, m.stock.width]
  // the side face sits at t = 0 (normal −) or t = size (normal +)
  const face = info.sign > 0 ? size[t]! : 0
  const inner = face - info.sign * m.reach
  const outer = face + info.sign * OVERSHOOT
  const lo = Math.min(inner, outer)
  const hi = Math.max(inner, outer)
  // top pocket in part x, y: s ∈ [a, b], t ∈ [lo, hi], rounded at (a, inner)
  const xy = (sv: number, tv: number): Vec2 => (s === 0 ? [sv, tv] : [tv, sv])
  const [x0, y0] = xy(m.a, lo)
  const [x1, y1] = xy(m.b, hi)
  const p = xy(m.a, inner)
  const corner = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].findIndex((q) => q[0] === p[0] && q[1] === p[1])
  const top: ShapePocket = {
    id: 'top',
    direction: '+z',
    region: { loops: [rectOneRound(x0, y0, x1, y1, corner, 5)] },
    depth: m.depth,
  }
  // side pocket: the part-frame box s ∈ [b, c], z ∈ [−depth, OVERSHOOT] seen in its face frame
  const frame = faceFrame(m.side, m.stock)
  const at = (sv: number, z: number): Vec3 => {
    const q = [0, 0, z]
    q[s] = sv
    q[t] = face
    return unapplyPlacement(frame, [q[0]!, q[1]!, q[2]!])
  }
  const q0 = at(m.b, -m.depth)
  const q1 = at(m.c, OVERSHOOT)
  const far = at(m.c, -m.depth)
  const u0 = Math.min(q0[0], q1[0])
  const u1 = Math.max(q0[0], q1[0])
  const v0 = Math.min(q0[1], q1[1])
  const v1 = Math.max(q0[1], q1[1])
  const k = [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ].findIndex((q) => q[0] === far[0] && q[1] === far[1])
  const sidePocket: ShapePocket = {
    id: 'side',
    direction: m.side,
    region: { loops: [rectOneRound(u0, v0, u1, v1, k, 3)] },
    depth: m.reach,
  }
  return [top, sidePocket]
}

export interface Census {
  /** Triangles lying in the shared plane `s = b` (should not exist). */
  readonly plane: number
  /** Triangles with an altitude below 1e-4 mm (anywhere). */
  readonly thin: number
}

export function census(mesh: SolidMesh, m: MeetCase): Census {
  const s = axisIndex(DIRECTION[m.side].u)
  const P = mesh.positions
  let plane = 0
  let thin = 0
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const v = [0, 1, 2].map((k) => mesh.indices[3 * t + k]!)
    if (v.every((i) => Math.abs(P[3 * i + s]! - m.b) < 1e-3)) plane++
    const p = v.map((i): Vec3 => [P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!])
    const e = (a: Vec3, b: Vec3): Vec3 => [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
    const e0 = e(p[0]!, p[1]!)
    const e1 = e(p[0]!, p[2]!)
    const cross: Vec3 = [
      e0[1] * e1[2] - e0[2] * e1[1],
      e0[2] * e1[0] - e0[0] * e1[2],
      e0[0] * e1[1] - e0[1] * e1[0],
    ]
    const longest = Math.max(len(e0), len(e1), len(e(p[1]!, p[2]!)))
    if (longest > 0 && len(cross) / longest < 1e-4) thin++
  }
  return { plane, thin }
}

/** Deterministic PRNG (mulberry32) for the seeded cases. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A seeded meet case with non-dyadic sizes (0.1 mm steps plus a random µm part). */
export function randomMeet(seed: number): MeetCase {
  const r = rng(seed)
  const pick = (lo: number, hi: number) =>
    Math.round((lo + r() * (hi - lo)) * 10) / 10 + Math.round(r() * 1000) / 1e6
  const sides = ['+x', '-x', '+y', '-y'] as const
  const side = sides[Math.floor(r() * 4)]!
  const stock = { length: pick(80, 160), width: pick(60, 120), thickness: pick(15, 30) }
  const along = side === '+y' || side === '-y' ? stock.length : stock.width
  const across = side === '+y' || side === '-y' ? stock.width : stock.length
  const a = pick(8, along * 0.3)
  const b = pick(along * 0.4, along * 0.55)
  const c = pick(along * 0.65, along - 8)
  return {
    stock,
    side,
    a,
    b,
    c,
    depth: pick(2, stock.thickness * 0.6),
    reach: pick(10, across * 0.6),
  }
}
