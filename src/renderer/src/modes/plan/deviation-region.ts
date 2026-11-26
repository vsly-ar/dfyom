// A deviation region's box in the part frame (U4 follow-up): the result's bounds (face frame
// [u, v], cell edges) and depths below the face, turned by the stock face's frame, for the Plan
// viewport's marker; and the box the camera frames (at least `FOCUS_MIN_MM` on each side). Pure.
// Doc: docs/modes/deviation.md#region-marker-u4-follow-up
import {
  faceFrame,
  stockFaceDirection,
  toPartFrame,
  type StockSize,
} from '../../../../core/geometry/face'
import type { Box, Vec3 } from '../../viewport'
import type { DeviationRegionView } from './plan-store'

/** The framed box is grown to at least this on each side (mm): a one-cell region is not filled. */
export const FOCUS_MIN_MM = 10

/** The region's box (part frame); undefined for a face that is not a stock face. */
export function regionBox(
  region: Pick<DeviationRegionView, 'face' | 'bounds' | 'depthRange'>,
  stock: StockSize,
): Box | undefined {
  const direction = stockFaceDirection(region.face)
  if (direction === undefined) return undefined
  const frame = faceFrame(direction, stock)
  const [[u0, v0], [u1, v1]] = region.bounds
  const [d0, d1] = region.depthRange
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const u of [u0, u1])
    for (const v of [v0, v1])
      for (const w of [-d0, -d1]) {
        const p: Vec3 = toPartFrame(frame, [u, v, w])
        for (let i = 0; i < 3; i++) {
          min[i] = Math.min(min[i]!, p[i]!)
          max[i] = Math.max(max[i]!, p[i]!)
        }
      }
  return { min, max }
}

/** `box` grown about its centre to at least `FOCUS_MIN_MM` on each side. */
export function focusBox(box: Box, least = FOCUS_MIN_MM): Box {
  const grow = (i: number) => Math.max(0, least - (box.max[i]! - box.min[i]!)) / 2
  return {
    min: [box.min[0] - grow(0), box.min[1] - grow(1), box.min[2] - grow(2)],
    max: [box.max[0] + grow(0), box.max[1] + grow(1), box.max[2] + grow(2)],
  }
}
