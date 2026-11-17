/**
 * Closed-form volumes of v0.1 removals, the analytic oracle for geometry tests
 * (docs/architecture/geometry.md#testing). Written independently of the mesh code.
 */
import { roundedRectArea } from './mesh-oracles'

/**
 * Rounded-rectangle pocket with a floor fillet of radius f (Pappus): the prism minus the
 * retained fillet ring, whose cross-section (f² − πf²/4) has its centroid
 * d = f(10 − 3π) / (3(4 − π)) from both the wall and the floor.
 */
export function pocketVolume(
  length: number,
  width: number,
  cornerRadius: number,
  depth: number,
  floorRadius: number,
): number {
  const f = floorRadius
  const section = f * f * (1 - Math.PI / 4)
  const d = f === 0 ? 0 : (f * (10 - 3 * Math.PI)) / (3 * (4 - Math.PI))
  const path =
    2 * (length - 2 * cornerRadius) +
    2 * (width - 2 * cornerRadius) +
    2 * Math.PI * (cornerRadius - d)
  return roundedRectArea(length, width, cornerRadius) * depth - section * path
}

/** Circular pocket (radius R) with floor fillet f: same Pappus argument around the axis. */
export function circlePocketVolume(radius: number, depth: number, floorRadius: number): number {
  const f = floorRadius
  const section = f * f * (1 - Math.PI / 4)
  const d = f === 0 ? 0 : (f * (10 - 3 * Math.PI)) / (3 * (4 - Math.PI))
  return Math.PI * radius * radius * depth - section * 2 * Math.PI * (radius - d)
}

/** Hole of `diameter` to `depth` (full diameter) plus a drill-point cone of `pointAngle`°. */
export function drillVolume(diameter: number, depth: number, pointAngle?: number): number {
  const r = diameter / 2
  const cylinder = Math.PI * r * r * depth
  if (pointAngle === undefined || pointAngle >= 180) return cylinder
  const h = r / Math.tan(((pointAngle / 2) * Math.PI) / 180)
  return cylinder + (Math.PI * r * r * h) / 3
}
