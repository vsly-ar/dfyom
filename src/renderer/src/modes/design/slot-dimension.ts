// The selected slotted Bolt hole's viewport read-out (DF119 H3 follow-up): its centre line and its
// travel as a dimension (dimension line beside the widest outline, extension lines from the end
// centres), on the hole's face in the part frame. Pure, from the loaded part's owned slot pocket.
// Doc: docs/modes/hole-slots-and-round-corners.md#viewport-slot-dimension,
// docs/conventions/ui.md#section-illustration
import { shapeRotation, type Operation } from '../../../../core/design/operation'
import type { SurfaceTable } from '../../../../core/design/surfaces'
import { toPartFrame } from '../../../../core/geometry/face'
import type { Stock } from '../../../../core/library/stock'
import type { Vec3 } from '../../viewport'
import { surfaceFace } from './outline'

/** The centre line runs past each end centre by the slot radius + this (mm). */
export const CENTRE_OVERSHOOT_MM = 1.5
/** The dimension line sits this far beyond half the widest outline (mm). */
export const DIMENSION_GAP_MM = 3
/** Extension lines start this far off the end centres and run this far past the line (mm). */
export const EXTENSION_OFFSET_MM = 0.5
export const EXTENSION_OVERSHOOT_MM = 1.5

/** What the viewport draws of a slotted hole (part frame, mm). */
export interface SlotDimensionOverlay {
  /** The dashed centre line through both end centres, past the slot's ends. */
  readonly centreLine: readonly [Vec3, Vec3]
  /** The dimension line between the two extension lines. */
  readonly dimension: readonly [Vec3, Vec3]
  /** One extension line per end centre, across the dimension line. */
  readonly extensions: readonly (readonly [Vec3, Vec3])[]
  /** The travel (mm): the chip's value. */
  readonly travel: number
}

/**
 * The read-out of hole `holeId` when it is slotted: its owned slot pocket (`<id>_drill`, a
 * rectangle `travel + diameter` long about the hole centre) gives the centre, the travel and the
 * direction; the widest owned pocket (a recess or counterbore) how far out the dimension sits.
 * Null for a round hole or one not expanded.
 */
export function slotDimension(
  holeId: string,
  holeOn: string,
  operations: readonly Operation[],
  stock: Stock,
  table: SurfaceTable,
): SlotDimensionOverlay | null {
  const owned = operations.filter((o) =>
    o.owner.mapOr(false, (w) => w.featureId === holeId && o.kind === 'pocket'),
  )
  const slot = owned.find((o) => o.owner.mapOr(false, (w) => w.role === 'drill'))
  if (slot?.kind !== 'pocket' || slot.shape.kind !== 'rectangle') return null
  const s = slot.shape
  const width = s.width.canonical
  const travel = s.length.canonical - width
  if (!(travel > 0)) return null
  const widest = Math.max(
    width,
    ...owned.map((o) =>
      o.kind === 'pocket' && o.shape.kind !== 'named'
        ? o.shape.kind === 'circle'
          ? o.shape.diameter.canonical
          : o.shape.width.canonical
        : 0,
    ),
  )
  const face = surfaceFace(holeOn, stock, table)
  const a = (shapeRotation(s) * Math.PI) / 180
  const dir: readonly [number, number] = [Math.cos(a), Math.sin(a)]
  const side: readonly [number, number] = [-dir[1], dir[0]]
  const c: readonly [number, number] = [s.center[0].canonical, s.center[1].canonical]
  const at = (along: number, across: number): Vec3 =>
    toPartFrame(face.frame, [
      c[0] + dir[0] * along + side[0] * across,
      c[1] + dir[1] * along + side[1] * across,
      face.w,
    ])
  const half = travel / 2
  const past = width / 2 + CENTRE_OVERSHOOT_MM
  const off = widest / 2 + DIMENSION_GAP_MM
  return {
    centreLine: [at(-half - past, 0), at(half + past, 0)],
    dimension: [at(-half, off), at(half, off)],
    extensions: [-half, half].map(
      (x) => [at(x, EXTENSION_OFFSET_MM), at(x, off + EXTENSION_OVERSHOOT_MM)] as const,
    ),
    travel,
  }
}
