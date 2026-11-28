// A Line's geometry mode (DF147 SL2, engraved-patterns.md § Simple Line): Straight / Arc / Shape
// read from its paths, and the `paths` args the inspector sends: the default line across the face's
// middle, Straight ↔ Arc keeping the ends, and the "Parallel to an edge" helper. Pure, so the
// component test and the add flow share it.
// Doc: docs/modes/engraved-patterns.md#implementation-sl1sl2
import type { OperationDTO } from '../../../../core/design/part.dto'
import type { UnitSystem } from '../../../../core/project/document'
import { quantityOf } from './model'

type LineDTO = Extract<OperationDTO, { kind: 'line' }>
export type LineGeometryMode = 'straight' | 'arc' | 'shape'
/** The face edge a parallel line keeps its distance from (face frame: front is v = 0). */
export type FaceEdge = 'front' | 'back' | 'left' | 'right'
export const FACE_EDGES: readonly FaceEdge[] = ['front', 'back', 'left', 'right']

type Mm = readonly [number, number]

export const geometryModeOf = (op: LineDTO): LineGeometryMode => {
  const p = op.paths[0]
  return p !== undefined && 'segment' in p
    ? 'straight'
    : p !== undefined && 'arc' in p
      ? 'arc'
      : 'shape'
}

/** A length source in the unit system, to 0.001 mm / 0.0001". */
export const lengthText = (mm: number, units: UnitSystem): string =>
  units === 'mm' ? `${+mm.toFixed(3)} mm` : `${+(mm / 25.4).toFixed(4)}"`

const point = (p: Mm, units: UnitSystem) => [lengthText(p[0], units), lengthText(p[1], units)]

/** A Straight path's args from two points (mm). */
export function segmentArgs(start: Mm, end: Mm, units: UnitSystem): Record<string, unknown> {
  return { segment: { start: point(start, units), end: point(end, units) } }
}

/** The default new Line (and Shape → Straight): straight across the face's middle along u. */
export function lineAcross(
  face: { readonly length: number; readonly width: number },
  units: UnitSystem,
): Record<string, unknown> {
  return segmentArgs([0, face.width / 2], [face.length, face.width / 2], units)
}

/** "Parallel to an edge": a straight line across the whole face `distance` mm from `edge`. */
export function parallelToEdge(
  edge: FaceEdge,
  distance: number,
  face: { readonly length: number; readonly width: number },
  units: UnitSystem,
): Record<string, unknown> {
  const { length: L, width: W } = face
  switch (edge) {
    case 'front':
      return segmentArgs([0, distance], [L, distance], units)
    case 'back':
      return segmentArgs([0, W - distance], [L, W - distance], units)
    case 'left':
      return segmentArgs([distance, 0], [distance, W], units)
    case 'right':
      return segmentArgs([L - distance, 0], [L - distance, W], units)
  }
}

/** The args of a path's point as entered (`start`, `through`, `end`), keeping its sources. */
function sources(q: readonly [{ source: string }, { source: string }]): string[] {
  return [q[0].source, q[1].source]
}

/** A point's value (mm), or undefined while it does not evaluate. */
function mmOf(q: readonly [unknown, unknown]): Mm | undefined {
  const u = quantityOf(q[0] as Parameters<typeof quantityOf>[0])?.canonical
  const v = quantityOf(q[1] as Parameters<typeof quantityOf>[0])?.canonical
  return u === undefined || v === undefined ? undefined : [u, v]
}

/**
 * The `paths` arg for a switch between Straight and Arc, keeping the ends as entered: an arc
 * bulges to the left of start → end by a quarter of the chord; a straight line drops `through`.
 * Undefined for Shape (Convert to shape) or when the ends do not evaluate.
 */
export function pathsForMode(
  op: LineDTO,
  mode: 'straight' | 'arc',
  units: UnitSystem,
): Record<string, unknown>[] | undefined {
  const p = op.paths[0]
  if (p === undefined || !('segment' in p || 'arc' in p)) return undefined
  const ends = 'segment' in p ? p.segment : p.arc
  if (mode === 'straight')
    return [{ segment: { start: sources(ends.start), end: sources(ends.end) } }]
  if ('arc' in p) return undefined
  const a = mmOf(ends.start)
  const b = mmOf(ends.end)
  if (a === undefined || b === undefined) return undefined
  const mid: Mm = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  // left of start → end: the chord turned a quarter counter-clockwise, a quarter as long
  const through: Mm = [mid[0] - (b[1] - a[1]) / 4, mid[1] + (b[0] - a[0]) / 4]
  return [
    {
      arc: { start: sources(ends.start), through: point(through, units), end: sources(ends.end) },
    },
  ]
}

/** A Straight path's length (mm), undefined while its ends do not evaluate. */
export function segmentLength(op: LineDTO): number | undefined {
  const p = op.paths[0]
  if (p === undefined || !('segment' in p)) return undefined
  const a = mmOf(p.segment.start)
  const b = mmOf(p.segment.end)
  return a === undefined || b === undefined ? undefined : Math.hypot(b[0] - a[0], b[1] - a[1])
}

/** An Arc path's three points (mm), undefined while one does not evaluate. */
export function arcPoints(op: LineDTO): [Mm, Mm, Mm] | undefined {
  const p = op.paths[0]
  if (p === undefined || !('arc' in p)) return undefined
  const a = mmOf(p.arc.start)
  const t = mmOf(p.arc.through)
  const b = mmOf(p.arc.end)
  return a === undefined || t === undefined || b === undefined ? undefined : [a, t, b]
}

/** Where "Distance from edge" measures to (hardening DF156): the line's centre or the part's wall. */
export type DistanceTo = 'centreline' | 'wall'

/** The direction `parallelToEdge` draws along (front/back: +u, left/right: +v). */
const EDGE_RUN: Record<FaceEdge, Mm> = {
  front: [1, 0],
  back: [1, 0],
  left: [0, 1],
  right: [0, 1],
}
/** From a parallel line toward its edge. */
const TOWARD_EDGE: Record<FaceEdge, Mm> = {
  front: [0, -1],
  back: [0, 1],
  left: [-1, 0],
  right: [1, 0],
}

/**
 * Hardening DF156: a Straight line `distance` from `edge` placed by the **part's wall**: the
 * centreline moves half the slot (`slot` mm wide) toward the offcut, so the kept side (`kept`, a
 * one-sided chamfer's `edgeSide` along the current segment) keeps `distance` up to the wall. The
 * new segment runs the way the current one does, so `kept` still names the same side. Undefined
 * while the current segment does not evaluate.
 */
export function parallelToWall(
  op: LineDTO,
  edge: FaceEdge,
  distance: number,
  slot: number,
  kept: 'left' | 'right',
  face: { readonly length: number; readonly width: number },
  units: UnitSystem,
): Record<string, unknown> | undefined {
  const p = op.paths[0]
  if (p === undefined || !('segment' in p)) return undefined
  const a = mmOf(p.segment.start)
  const b = mmOf(p.segment.end)
  if (a === undefined || b === undefined) return undefined
  const d: Mm = [b[0] - a[0], b[1] - a[1]]
  // the kept side's normal: left of start → end is the direction turned counter-clockwise
  const n: Mm = kept === 'left' ? [-d[1], d[0]] : [d[1], -d[0]]
  const t = TOWARD_EDGE[edge]
  const partAtEdge = n[0] * t[0] + n[1] * t[1] > 0
  const centre = partAtEdge ? distance + slot / 2 : distance - slot / 2
  const placed = parallelToEdge(edge, centre, face, units) as {
    segment: { start: string[]; end: string[] }
  }
  const run = EDGE_RUN[edge]
  const reversed = d[0] * run[0] + d[1] * run[1] < 0
  return reversed ? { segment: { start: placed.segment.end, end: placed.segment.start } } : placed
}
