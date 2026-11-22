// Toolpaths as line segments for the viewport, and run playback: which segments the tool has
// done, found by following the tool position (`wpos`) forward along the path. Pure. Toolpaths
// are mm in the setup WCS; for an unrotated top setup that is the part frame (Z0 = stock top,
// docs/modes/plan-v0.1.md), other setups are placed on the part by the setup's frame (`placeBox`,
// the run layer's group matrix; task E2). Doc: docs/conventions/ui.md#viewport-task-35 (run scene)
import { applyPlacement, type Placement } from '../../../core/geometry/model'
import type { Toolpath, Vec3 } from '../../../core/toolpath/model'
import type { Box } from './mesh'

export interface ToolpathLines {
  /** Segment endpoints: 6 floats per segment. */
  readonly positions: Float32Array
  /** Per segment: `SEGMENT.feed`, `.rapid` or `.plunge` (a feed straight down, task 3.7). */
  readonly kind: Uint8Array
  readonly segments: number
}

/** Segment kinds of `ToolpathLines.kind`: drawn `--vp-feed`, `--vp-rapid`, `--vp-plunge`. */
export const SEGMENT = { feed: 0, rapid: 1, plunge: 2 } as const

/** Arcs are drawn as chords of at most this angle (chord error r·(1 − cos 1.5°) ≈ 0.03 % of r). */
const ARC_STEP_RAD = (3 * Math.PI) / 180

/**
 * Flattens toolpaths (in machining order) into segments; drill cycles go down and up once. A feed
 * straight down (no XY motion) is a plunge.
 */
export function toolpathLines(toolpaths: readonly Toolpath[]): ToolpathLines {
  const pos: number[] = []
  const kind: number[] = []
  let at: Vec3 | undefined
  const seg = (to: Vec3, isRapid: boolean) => {
    if (at !== undefined) {
      pos.push(at[0], at[1], at[2], to[0], to[1], to[2])
      const down = to[2] < at[2] && to[0] === at[0] && to[1] === at[1]
      kind.push(isRapid ? SEGMENT.rapid : down ? SEGMENT.plunge : SEGMENT.feed)
    }
    at = to
  }
  for (const tp of toolpaths)
    for (const pass of tp.passes)
      for (const mv of pass.moves) {
        switch (mv.kind) {
          case 'rapid':
            seg(mv.to, true)
            break
          case 'line':
            seg(mv.to, false)
            break
          case 'arc': {
            const from = at ?? mv.to
            const [cx, cy] = mv.center
            const a0 = Math.atan2(from[1] - cy, from[0] - cx)
            let a1 = Math.atan2(mv.to[1] - cy, mv.to[0] - cx)
            if (mv.cw && a1 >= a0) a1 -= 2 * Math.PI
            if (!mv.cw && a1 <= a0) a1 += 2 * Math.PI
            const r = Math.hypot(from[0] - cx, from[1] - cy)
            const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / ARC_STEP_RAD))
            for (let i = 1; i < n; i++) {
              const t = i / n
              const a = a0 + (a1 - a0) * t
              seg(
                [cx + r * Math.cos(a), cy + r * Math.sin(a), from[2] + (mv.to[2] - from[2]) * t],
                false,
              )
            }
            seg(mv.to, false)
            break
          }
          case 'drill': {
            const top: Vec3 = [mv.at[0], mv.at[1], mv.retract]
            seg(top, true)
            seg([mv.at[0], mv.at[1], mv.bottom], false)
            seg(top, true)
            break
          }
        }
      }
  return { positions: new Float32Array(pos), kind: Uint8Array.from(kind), segments: kind.length }
}

export function linesBounds(lines: ToolpathLines): Box | undefined {
  if (lines.segments === 0) return undefined
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  const p = lines.positions
  for (let i = 0; i < p.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, p[i + k]!)
      max[k] = Math.max(max[k]!, p[i + k]!)
    }
  return { min, max }
}

/** The box around `box` placed by `frame` (WCS → part frame); `box` itself without a frame. */
export function placeBox(box: Box | undefined, frame: Placement | undefined): Box | undefined {
  if (box === undefined || frame === undefined) return box
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const x of [box.min[0], box.max[0]])
    for (const y of [box.min[1], box.max[1]])
      for (const z of [box.min[2], box.max[2]]) {
        const q = applyPlacement(frame, [x, y, z])
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, q[k]!)
          max[k] = Math.max(max[k]!, q[k]!)
        }
      }
  return { min, max }
}

/** Distance from `q` to segment `i`. */
function distanceToSegment(lines: ToolpathLines, i: number, q: readonly number[]): number {
  const p = lines.positions
  const o = 6 * i
  const ax = p[o]!
  const ay = p[o + 1]!
  const az = p[o + 2]!
  const dx = p[o + 3]! - ax
  const dy = p[o + 4]! - ay
  const dz = p[o + 5]! - az
  const len2 = dx * dx + dy * dy + dz * dz
  const t =
    len2 === 0
      ? 0
      : Math.min(1, Math.max(0, ((q[0]! - ax) * dx + (q[1]! - ay) * dy + (q[2]! - az) * dz) / len2))
  return Math.hypot(ax + t * dx - q[0]!, ay + t * dy - q[1]!, az + t * dz - q[2]!)
}

/** Status reports have 3 decimals; arc chords deviate a little more on large radii. */
export const PLAYBACK_TOLERANCE_MM = 0.1

/**
 * The segment the tool is on, searching forward from `from` (never back: the path revisits XY
 * positions at other depths, and rapids retrace). Segments before the result are done. A position
 * on no later segment (a tool change, the post's own moves) keeps `from`.
 */
export function advancePlayback(
  lines: ToolpathLines,
  from: number,
  tool: readonly number[],
  tolerance = PLAYBACK_TOLERANCE_MM,
): number {
  for (let i = Math.max(0, from); i < lines.segments; i++)
    if (distanceToSegment(lines, i, tool) <= tolerance) return i
  return from
}
