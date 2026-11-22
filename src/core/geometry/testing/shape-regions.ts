/**
 * Test-only general regions and parts for the shape solids (G1): loops of lines and arcs, the
 * spike S3 generators (scalloped star with islands, a grid of islands) and the two-direction
 * meeting cases of the wall-sliver regression (spikes/prisms/slivers.ts).
 * Doc: docs/architecture/shapes.md#implementation-g1
 */
import { DIRECTION, faceFrame, type Direction } from '../face'
import {
  OVERSHOOT,
  unapplyPlacement,
  type OperationGeometry,
  type StockGeometry,
  type Vec2,
  type Vec3,
} from '../model'
import { arc, line, reverseLoop, type Element, type Loop, type Region } from '../2d/model'
import { numberRegion } from '../2d/place'

const at = (c: Vec2, r: number, t: number): Vec2 => [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]

/** A circle as two half arcs, counter-clockwise, or clockwise (a hole). */
export function circleLoop(c: Vec2, r: number, ccw = true): Loop {
  const p = at(c, r, -Math.PI / 2)
  const q = at(c, r, Math.PI / 2)
  return { elements: [arc(p, q, c, ccw), arc(q, p, c, ccw)] }
}

/** Rectangle `[x0, x1] × [y0, y1]` with corner radius `r` (≥ 0), counter-clockwise or a hole. */
export function roundedRectLoop(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  ccw = true,
): Loop {
  const els: Element[] = []
  const corner = (a: Vec2, b: Vec2, c: Vec2) => {
    if (r > 0) els.push(arc(a, b, c, true))
  }
  els.push(line([x0 + r, y0], [x1 - r, y0]))
  corner([x1 - r, y0], [x1, y0 + r], [x1 - r, y0 + r])
  els.push(line([x1, y0 + r], [x1, y1 - r]))
  corner([x1, y1 - r], [x1 - r, y1], [x1 - r, y1 - r])
  els.push(line([x1 - r, y1], [x0 + r, y1]))
  corner([x0 + r, y1], [x0, y1 - r], [x0 + r, y1 - r])
  els.push(line([x0, y1 - r], [x0, y0 + r]))
  corner([x0, y0 + r], [x0 + r, y0], [x0 + r, y0 + r])
  const loop = { elements: els }
  return ccw ? loop : reverseLoop(loop)
}

/** Scalloped star round `c`: `k` sectors of a line on radius `R` and a concave arc notch. */
export function scallopLoop(c: Vec2, R: number, k: number): Loop {
  const out: Element[] = []
  const sector = (2 * Math.PI) / k
  for (let i = 0; i < k; i++) {
    const t0 = i * sector
    const a = at(c, R, t0)
    const b = at(c, R, t0 + sector / 2)
    const next = i === k - 1 ? at(c, R, 0) : at(c, R, t0 + sector)
    out.push(line(a, b))
    const half = Math.hypot(next[0] - b[0], next[1] - b[1]) / 2
    const mid: Vec2 = [(b[0] + next[0]) / 2, (b[1] + next[1]) / 2]
    const d = Math.hypot(mid[0] - c[0], mid[1] - c[1])
    const u: Vec2 = [(mid[0] - c[0]) / d, (mid[1] - c[1]) / d]
    const off = Math.sqrt(3) * half
    out.push(arc(b, next, [mid[0] + u[0] * off, mid[1] + u[1] * off], false))
  }
  return { elements: out }
}

/** Spike S3 "star": a scalloped outer loop (≈ `n` elements) and two circular islands, numbered. */
export function starRegion(n: number, c: Vec2 = [100, 60], R = 50): Region {
  const k = Math.max(3, Math.round((n - 4) / 2))
  return numberRegion({
    pieces: [
      {
        outer: scallopLoop(c, R, k),
        holes: [
          circleLoop([c[0] - R / 3, c[1]], R / 8, false),
          circleLoop([c[0] + R / 3, c[1]], R / 8, false),
        ],
      },
    ],
  })
}

/** Spike S3 "islands": a rounded rectangle and a grid of rounded-square islands (≈ `n` elements). */
export function islandsRegion(n: number, x0 = 10, y0 = 10, x1 = 190, y1 = 110): Region {
  const count = Math.max(1, Math.round((n - 8) / 8))
  const cols = Math.ceil(Math.sqrt((count * (x1 - x0)) / (y1 - y0)))
  const rows = Math.ceil(count / cols)
  const cw = (x1 - x0) / cols
  const ch = (y1 - y0) / rows
  const s = Math.min(cw, ch) * 0.5
  const holes: Loop[] = []
  for (let i = 0; i < count; i++) {
    const cx = x0 + cw * ((i % cols) + 0.5)
    const cy = y0 + ch * (Math.floor(i / cols) + 0.5)
    holes.push(roundedRectLoop(cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2, s / 5, false))
  }
  return numberRegion({ pieces: [{ outer: roundedRectLoop(x0, y0, x1, y1, 5), holes }] })
}

/** A pocket of a general region given in its face frame (absolute: `center` [0, 0]). */
export function regionPocket(
  id: string,
  region: Region,
  depth: number,
  direction?: Direction,
  onZ = 0,
): OperationGeometry {
  return {
    kind: 'pocket',
    id,
    ...(direction === undefined || direction === '+z' ? {} : { direction }),
    onZ,
    shape: { center: [0, 0], contour: { kind: 'region', region } },
    depth,
    floorRadius: 0,
  }
}

// ── two directions meeting on a plane (wall-sliver regression, G2 folded into G1) ─────────────

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

/** Rectangle `[x0, x1] × [y0, y1]` with corner `k` (0 = (x0, y0), then CCW) rounded by `r`. */
function rectOneRound(x0: number, y0: number, x1: number, y1: number, k: number, r: number): Loop {
  const c: Vec2[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
  const into: Vec2[] = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ]
  const out: Element[] = []
  for (let j = 0; j < 4; j++) {
    const i = (k + j) % 4
    const p = c[i]!
    const n = c[(i + 1) % 4]!
    const edge: Vec2 = [Math.sign(n[0] - p[0]), Math.sign(n[1] - p[1])]
    const from: Vec2 = j === 0 ? [p[0] + edge[0] * r, p[1] + edge[1] * r] : p
    const last = j === 3
    const to: Vec2 = last ? [n[0] - edge[0] * r, n[1] - edge[1] * r] : n
    out.push(line(from, to))
    if (last) {
      const d = into[k]!
      out.push(arc(to, out[0]!.a, [n[0] + d[0] * r, n[1] + d[1] * r], true))
    }
  }
  return { elements: out }
}

/** The two pockets of a meet case (general regions), each in its own face frame. */
export function meetPockets(m: MeetCase): OperationGeometry[] {
  const info = DIRECTION[m.side]
  const s = axisIndex(info.u)
  const t = axisIndex(info.n)
  const size = [m.stock.length, m.stock.width]
  const face = info.sign > 0 ? size[t]! : 0
  const inner = face - info.sign * m.reach
  const outer = face + info.sign * OVERSHOOT
  const lo = Math.min(inner, outer)
  const hi = Math.max(inner, outer)
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
  const top = rectOneRound(x0, y0, x1, y1, corner, 5)
  const frame = faceFrame(m.side, m.stock)
  const local = (sv: number, z: number): Vec3 => {
    const q = [0, 0, z]
    q[s] = sv
    q[t] = face
    return unapplyPlacement(frame, [q[0]!, q[1]!, q[2]!])
  }
  const q0 = local(m.b, -m.depth)
  const q1 = local(m.c, OVERSHOOT)
  const far = local(m.c, -m.depth)
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
  const side = rectOneRound(u0, v0, u1, v1, k, 3)
  const region = (l: Loop): Region => numberRegion({ pieces: [{ outer: l, holes: [] }] })
  return [
    regionPocket('top', region(top), m.depth),
    regionPocket('side', region(side), m.reach, m.side),
  ]
}

/** Triangles of a part mesh lying in the shared plane `s = b` (should be none). */
export function trianglesInPlane(
  positions: Float32Array,
  indices: Uint32Array,
  m: MeetCase,
): number {
  const s = axisIndex(DIRECTION[m.side].u)
  let plane = 0
  for (let t = 0; t < indices.length / 3; t++) {
    let all = true
    for (let k = 0; k < 3; k++)
      if (Math.abs(positions[3 * indices[3 * t + k]! + s]! - m.b) >= 1e-3) all = false
    if (all) plane++
  }
  return plane
}

/** Deterministic PRNG (mulberry32). */
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
  return {
    stock,
    side,
    a: pick(8, along * 0.3),
    b: pick(along * 0.4, along * 0.55),
    c: pick(along * 0.65, along - 8),
    depth: pick(2, stock.thickness * 0.6),
    reach: pick(10, across * 0.6),
  }
}
