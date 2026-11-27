// The face-frame axis label at an arrow's tip (hardening DF127): "u" alone, or with the part axis
// it lies along and its sign, "u (−X)", "v (+Z)", when the axis is parallel to one (uppercase
// axes and the true minus sign, as the inspector's `axisText`).
// Doc: docs/modes/design-v0.2.md (Scene in the face frame)
import type { Vec3 } from './mesh'

/** Parallel when the angle to a part axis is under 0.25°. */
const PARALLEL_COS = Math.cos((0.25 * Math.PI) / 180)

/** `name` with the part axis `dir` runs along ("u (−X)"), or `name` alone when it runs along none. */
export function frameAxisLabel(name: string, dir: Vec3): string {
  const len = Math.hypot(dir[0], dir[1], dir[2])
  if (!(len > 0)) return name
  for (let i = 0; i < 3; i++) {
    const c = dir[i]! / len
    if (Math.abs(c) >= PARALLEL_COS) return `${name} (${c > 0 ? '+' : '−'}${'XYZ'[i]})`
  }
  return name
}
