// The 3D measure's axis lock (dogfood DF20): after the first point, holding Shift locks the line
// to the part-frame axis (X, Y or Z) whose on-screen direction from the first point is closest to
// the pointer's, and the second point is the point of that axis line nearest the pointer ray (or a
// snapped point projected onto it). Pure. Doc: docs/conventions/ui.md#snap-and-measure
import type { Vec3 } from './mesh'

export type AxisName = 'x' | 'y' | 'z'

export const AXES: Readonly<Record<AxisName, Vec3>> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
}

/** The pointer is this close (px) to the first point: no direction yet, no lock. */
const MIN_PX = 2
/**
 * An axis whose screen length (per `probe` length) is below this share of the longest one points
 * (nearly) at the camera: skipped, since perspective turns it into a short radial stroke whose
 * direction says nothing (the Z axis in a Top view).
 */
const MIN_AXIS_SHARE = 0.3

/**
 * The axis whose screen direction from `a` best matches the pointer's (largest |cos|), or null
 * when the pointer sits on `a`. `toPx` projects a part-frame point to screen px; `probe` is a
 * length (mm) along each axis used to find its screen direction.
 */
export function lockAxis(
  a: Vec3,
  pointer: readonly [number, number],
  toPx: (p: Vec3) => readonly [number, number],
  probe = 1,
): AxisName | null {
  const o = toPx(a)
  const px = [pointer[0] - o[0], pointer[1] - o[1]] as const
  const len = Math.hypot(px[0], px[1])
  if (len < MIN_PX) return null
  const screen = (['x', 'y', 'z'] as const).map((name) => {
    const d = AXES[name]
    const t = toPx([a[0] + d[0] * probe, a[1] + d[1] * probe, a[2] + d[2] * probe])
    const s = [t[0] - o[0], t[1] - o[1]] as const
    return { name, s, length: Math.hypot(s[0], s[1]) }
  })
  const longest = Math.max(...screen.map((e) => e.length))
  if (!(longest > 0)) return null
  let best: AxisName | null = null
  let bestCos = -1
  for (const { name, s, length } of screen) {
    if (length < longest * MIN_AXIS_SHARE) continue
    const cos = Math.abs((s[0] * px[0] + s[1] * px[1]) / (length * len))
    if (cos > bestCos) {
      bestCos = cos
      best = name
    }
  }
  return best
}

const dot = (p: Vec3, q: Vec3): number => p[0] * q[0] + p[1] * q[1] + p[2] * q[2]
const along = (a: Vec3, d: Vec3, t: number): Vec3 => [
  a[0] + d[0] * t,
  a[1] + d[1] * t,
  a[2] + d[2] * t,
]

/** The point of the axis line through `a` nearest the ray `origin + s·dir` (a parallel ray: `a`). */
export function closestOnAxis(a: Vec3, axis: AxisName, origin: Vec3, dir: Vec3): Vec3 {
  const d = AXES[axis]
  const w: Vec3 = [a[0] - origin[0], a[1] - origin[1], a[2] - origin[2]]
  const b = dot(d, dir)
  const rr = dot(dir, dir)
  const denom = rr - b * b // |d| = 1
  if (Math.abs(denom) < 1e-12) return [a[0], a[1], a[2]]
  const t = (b * dot(dir, w) - rr * dot(d, w)) / denom
  return along(a, d, t)
}

/** `p` projected onto the axis line through `a`. */
export function projectOnAxis(a: Vec3, axis: AxisName, p: Vec3): Vec3 {
  const d = AXES[axis]
  return along(a, d, dot([p[0] - a[0], p[1] - a[1], p[2] - a[2]], d))
}
