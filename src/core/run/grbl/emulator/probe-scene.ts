/**
 * The virtual machine's probe scene (v0.5 RV3): what closes the probe input. Targets in machine
 * coordinates (MPos, mm): an infinite plane (the M4 touch plate), boxes (stock, rotated about Z),
 * an XYZ corner plate, a bored hole and a bed height field; the probe is the tool (a cylinder, flat
 * end) or a 3D probe's ball, its tip at the controlled point.
 * Doc: docs/architecture/grbl.md#probe-scene-rv3
 *
 * Pure geometry: `probeClosed()` says whether the probe touches anything at a tip position,
 * `firstChange()` where along a straight move the input first becomes closed (toward) or open
 * (away). Every target in the scene closes the input (a conductive surface with the clip on the
 * bit, or any surface for a 3D probe); a non-conductive stock is simply left out.
 */
import type { Vec3 } from './planner'

/** The probing end of the tool: a flat-end cylinder (the bit) or a ball (a 3D probe's stylus). */
export interface ProbeTip {
  readonly shape: 'cylinder' | 'ball'
  /** mm; 0 = a point (the M4 plate's behaviour). */
  readonly radius: number
}

/** A Gaussian bump of a height field. */
export interface HeightBump {
  readonly x: number
  readonly y: number
  /** mm, may be negative (a dip). */
  readonly height: number
  /** Standard deviation, mm. */
  readonly radius: number
}

export type ProbeTarget =
  /** An infinite horizontal plane, solid below `z` (the M4 touch plate). */
  | { readonly kind: 'plane'; readonly z: number }
  /**
   * A box (the stock: top and four sides), rotated by `angle` degrees (counter-clockwise seen from
   * +Z) about its `min` corner's X/Y; `min`/`max` are the unrotated extents.
   */
  | { readonly kind: 'box'; readonly min: Vec3; readonly max: Vec3; readonly angle?: number }
  /**
   * An XYZ corner plate lying on a stock corner: `corner` is that corner (X, Y of the stock's edges,
   * Z its top); the plate's top is `thickness` above it, its walls stand `wallOffset` (X, Y) out
   * from the stock's edges and hang `lip` (default 10) below the top; `size` square. `facing`: the
   * directions the walls face (default `[-1, -1]`: the stock's X−/Y− corner).
   */
  | {
      readonly kind: 'cornerPlate'
      readonly corner: Vec3
      readonly thickness: number
      readonly size: number
      readonly wallOffset: readonly [number, number]
      readonly lip?: number
      readonly facing?: readonly [-1 | 1, -1 | 1]
    }
  /**
   * A bored hole: an annular wall of inner `radius` and outer `outerRadius` (default radius + 20)
   * from `top` down `depth`, open at the bottom (a through hole in a plate).
   */
  | {
      readonly kind: 'hole'
      readonly centre: readonly [number, number]
      readonly radius: number
      readonly top: number
      readonly depth: number
      readonly outerRadius?: number
    }
  /**
   * A bed or warped stock surface, solid below `h(x, y) = z + tilt·(p − origin) + Σ bumps`
   * (bumps Gaussian); `seededBumps()` makes a deterministic set.
   */
  | {
      readonly kind: 'heightField'
      readonly z: number
      /** mm per mm in X and Y. */
      readonly tilt?: readonly [number, number]
      readonly origin?: readonly [number, number]
      readonly bumps?: readonly HeightBump[]
    }

export interface ProbeScene {
  readonly targets: readonly ProbeTarget[]
}

export const POINT_TIP: ProbeTip = { shape: 'cylinder', radius: 0 }

/** The height field's surface at (x, y). */
export function heightAt(f: Extract<ProbeTarget, { kind: 'heightField' }>, x: number, y: number) {
  const [tx, ty] = f.tilt ?? [0, 0]
  const [ox, oy] = f.origin ?? [0, 0]
  let h = f.z + tx * (x - ox) + ty * (y - oy)
  for (const b of f.bumps ?? []) {
    const d2 = (x - b.x) ** 2 + (y - b.y) ** 2
    h += b.height * Math.exp(-d2 / (2 * b.radius * b.radius))
  }
  return h
}

/** mulberry32: a small seeded generator (deterministic scenes). */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * `count` bumps inside `bounds` ([minX, minY, maxX, maxY]), heights within ±`amplitude`, radii
 * between `radius` / 2 and `radius`; the same seed gives the same bumps.
 */
export function seededBumps(
  seed: number,
  count: number,
  bounds: readonly [number, number, number, number],
  amplitude: number,
  radius: number,
): HeightBump[] {
  const r = random(seed)
  const [x0, y0, x1, y1] = bounds
  return Array.from({ length: count }, () => ({
    x: x0 + r() * (x1 - x0),
    y: y0 + r() * (y1 - y0),
    height: (r() * 2 - 1) * amplitude,
    radius: radius * (0.5 + r() * 0.5),
  }))
}

/** A corner plate as the box it occupies. */
function plateBox(t: Extract<ProbeTarget, { kind: 'cornerPlate' }>): { min: Vec3; max: Vec3 } {
  const [fx, fy] = t.facing ?? [-1, -1]
  const span = (edge: number, f: -1 | 1, offset: number): [number, number] => {
    const wall = edge + f * offset
    return f < 0 ? [wall, wall + t.size] : [wall - t.size, wall]
  }
  const [x0, x1] = span(t.corner[0], fx, t.wallOffset[0])
  const [y0, y1] = span(t.corner[1], fy, t.wallOffset[1])
  return {
    min: [x0, y0, t.corner[2] - (t.lip ?? 10)],
    max: [x1, y1, t.corner[2] + t.thickness],
  }
}

const EPS = 1e-9

/** Distance from `v` to the interval [lo, hi] (0 inside). */
const outside = (v: number, lo: number, hi: number) => (v < lo ? lo - v : v > hi ? v - hi : 0)

function boxClosed(tip: ProbeTip, p: Vec3, min: Vec3, max: Vec3, angle = 0): boolean {
  // into the box's frame: rotate about its min corner by −angle
  const a = (-angle * Math.PI) / 180
  const dx = p[0] - min[0]
  const dy = p[1] - min[1]
  const qx = min[0] + dx * Math.cos(a) - dy * Math.sin(a)
  const qy = min[1] + dx * Math.sin(a) + dy * Math.cos(a)
  const ox = outside(qx, min[0], max[0])
  const oy = outside(qy, min[1], max[1])
  if (tip.shape === 'cylinder') {
    // the tool extends upward from its tip
    return p[2] <= max[2] + EPS && Math.hypot(ox, oy) <= tip.radius + EPS
  }
  const oz = outside(p[2] + tip.radius, min[2], max[2])
  return Math.hypot(ox, oy, oz) <= tip.radius + EPS
}

function holeClosed(tip: ProbeTip, p: Vec3, t: Extract<ProbeTarget, { kind: 'hole' }>): boolean {
  const d = Math.hypot(p[0] - t.centre[0], p[1] - t.centre[1])
  const outer = t.outerRadius ?? t.radius + 20
  if (tip.shape === 'cylinder') {
    return p[2] <= t.top + EPS && d + tip.radius >= t.radius - EPS && d - tip.radius <= outer + EPS
  }
  // a solid of revolution: the distance in the meridian half-plane (ρ, z)
  const or = outside(d, t.radius, outer)
  const oz = outside(p[2] + tip.radius, t.top - t.depth, t.top)
  return Math.hypot(or, oz) <= tip.radius + EPS
}

/** Sample offsets over the tip's disc: the centre and two rings. */
function discSamples(r: number): readonly (readonly [number, number])[] {
  if (r <= 0) return [[0, 0]]
  const out: [number, number][] = [[0, 0]]
  for (const [ring, n] of [
    [0.5, 8],
    [1, 16],
  ] as const) {
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n
      out.push([r * ring * Math.cos(a), r * ring * Math.sin(a)])
    }
  }
  return out
}

function fieldClosed(
  tip: ProbeTip,
  p: Vec3,
  f: Extract<ProbeTarget, { kind: 'heightField' }>,
): boolean {
  for (const [dx, dy] of discSamples(tip.radius)) {
    const h = heightAt(f, p[0] + dx, p[1] + dy)
    // the cylinder's flat end is at the tip; the ball's lower surface rises with the offset
    const bottom =
      tip.shape === 'cylinder'
        ? p[2]
        : p[2] + tip.radius - Math.sqrt(Math.max(0, tip.radius ** 2 - dx * dx - dy * dy))
    if (bottom <= h + EPS) return true
  }
  return false
}

/** Whether the probe with its tip at `p` touches any target of the scene. */
export function probeClosed(scene: ProbeScene, tip: ProbeTip, p: Vec3): boolean {
  return scene.targets.some((t) => {
    switch (t.kind) {
      case 'plane':
        return p[2] <= t.z + EPS
      case 'box':
        return boxClosed(tip, p, t.min, t.max, t.angle)
      case 'cornerPlate': {
        const b = plateBox(t)
        return boxClosed(tip, p, b.min, b.max)
      }
      case 'hole':
        return holeClosed(tip, p, t)
      case 'heightField':
        return fieldClosed(tip, p, t)
    }
  })
}

/** March step along a move (mm): features thinner than this may be missed. */
const STEP = 0.05

/**
 * The first point on the straight move `from` → `to` where the input becomes `closed` (true:
 * toward) or open (false: away), found to 1e-7 mm; undefined when it never does. The input at
 * `from` is assumed to be the other state.
 */
export function firstChange(
  scene: ProbeScene,
  tip: ProbeTip,
  from: Vec3,
  to: Vec3,
  closed: boolean,
): Vec3 | undefined {
  const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
  const len = Math.hypot(d[0], d[1], d[2])
  if (len <= 0) return undefined
  const at = (s: number): Vec3 => [
    from[0] + (d[0] * s) / len,
    from[1] + (d[1] * s) / len,
    from[2] + (d[2] * s) / len,
  ]
  const hit = (s: number) => probeClosed(scene, tip, at(s)) === closed
  const n = Math.ceil(len / STEP)
  let lo = 0
  let hi: number | undefined
  for (let i = 1; i <= n; i++) {
    const s = Math.min(len, i * STEP)
    if (hit(s)) {
      hi = s
      break
    }
    lo = s
  }
  if (hi === undefined) return undefined
  let h: number = hi
  while (h - lo > 1e-7) {
    const mid = (lo + h) / 2
    if (hit(mid)) h = mid
    else lo = mid
  }
  return at(h)
}
