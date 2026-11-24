// What the Reference panel's section and levels draw (DF60 P1 follow-ups), pure: the fitted
// loops as segments for the Shape Editor backdrop (face frame, 2D) and, for the Design viewport,
// as lines in the part frame with the sharp inside corners and the hovered level's triangles on
// the ghost. The loops come from the worker (`reference.section` with `fit`); nothing is fitted
// or cut here except filtering the ghost's own triangles for the hover highlight.
// Doc: docs/conventions/ui.md#reference-tools-df60, docs/modes/reference-tools.md#ui
import { levelTriangles, type MeshLevel } from '../../../../core/design/mesh-levels'
import type { FittedLoop } from '../../../../core/design/reference-section'
import {
  faceFrame,
  toPartFrame,
  type Direction,
  type StockSize,
} from '../../../../core/geometry/face'
import type { Vec3 } from '../../../../core/geometry/model'
import { flattenLoop } from '../../../../core/geometry/prism'
import type { ReferenceOverlayView } from '../../viewport/ReferenceOverlay'

/** Chord tolerance of the drawn loops (mm): well under the fit's own 0.01 mm. */
const DRAW_TOLERANCE = 0.002

/** Which loops a filter keeps (the Section row's "Loops" control). */
export type LoopFilter = 'all' | 'outer' | 'holes'

export const keepLoop = (l: FittedLoop, filter: LoopFilter): boolean =>
  !l.open && (filter === 'all' || (filter === 'outer') === (l.role === 'outer'))

/** The loops' points per loop (face frame u, v), closed loops without the repeated start. */
function loopPoints(loops: readonly FittedLoop[]): (readonly (readonly [number, number])[])[] {
  return loops
    .filter((l) => !l.open && l.loop.elements.length > 0)
    .map((l) => flattenLoop(l.loop, 'grow', 0, DRAW_TOLERANCE).points)
}

/**
 * The fitted loops as segments `[u0, v0, u1, v1, …]` (face frame, mm) for the Shape Editor
 * backdrop and snap; undefined when the section has an open chain (an open mesh), so the caller
 * keeps the raw segments, which show every piece.
 */
export function fittedSegments(loops: readonly FittedLoop[] | undefined): Float32Array | undefined {
  if (loops === undefined || loops.some((l) => l.open)) return undefined
  const out: number[] = []
  for (const pts of loopPoints(loops))
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length]!
      out.push(a[0], a[1], b[0], b[1])
    })
  return Float32Array.from(out)
}

/** What the Reference panel publishes for the viewport (ui-store `referenceOverlay`). */
export interface ReferenceOverlayState {
  readonly referenceId: string
  readonly direction: Direction
  /** Below the face (mm). */
  readonly depth: number
  /** The fitted loops shown in the list (face frame), or null while none were read. */
  readonly loops: readonly FittedLoop[] | null
  /** The level row under the pointer or focus. */
  readonly hover: { readonly depth: number; readonly facing: MeshLevel['facing'] } | null
}

/**
 * The overlay in the part frame: loops at the section plane, the sharp inside corners with the
 * plane's axes for their rings, and the hovered level's triangles (source units, drawn with the
 * ghost's `matrix`); `faceMatrix` maps the STL to the face frame (to find those triangles).
 */
export function overlayView(
  state: ReferenceOverlayState,
  stock: StockSize,
  ghost: {
    readonly positions: Float32Array
    readonly matrix: readonly number[]
    readonly faceMatrix: readonly number[]
  },
): ReferenceOverlayView {
  const frame = faceFrame(state.direction, stock)
  const w = -state.depth
  const at = (u: number, v: number): Vec3 => toPartFrame(frame, [u, v, w])
  const lines: number[] = []
  const corners: Vec3[] = []
  for (const l of state.loops ?? []) {
    if (l.open) continue
    for (const s of l.sharp) corners.push(at(s[0], s[1]))
  }
  for (const pts of loopPoints(state.loops ?? []))
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length]!
      lines.push(...at(a[0], a[1]), ...at(b[0], b[1]))
    })
  const highlight =
    state.hover === null
      ? null
      : {
          positions: levelTriangles(
            ghost.positions,
            ghost.faceMatrix,
            state.hover.depth,
            state.hover.facing,
          ),
          matrix: ghost.matrix,
        }
  return {
    lines: Float32Array.from(lines),
    corners,
    axes: { u: frame.u, v: frame.v },
    highlight: highlight === null || highlight.positions.length === 0 ? null : highlight,
  }
}
