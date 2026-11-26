// Engraving previews (engraved-patterns.md E3): a motif's lines as SVG path data in its frame (y
// flipped to screen), one path per line with its stroke opacity from its level (darker = deeper),
// for the Presets dialog's cards and the inspector's motif thumbnail.
// Doc: docs/modes/engraved-patterns.md#presets
import { presetLines, type MotifLine } from '../../../../core/design/engraving/presets'
import { engravingPreset } from '../../../../core/design/engraving/presets'
import type { Element } from '../../../../core/geometry/2d/model'

export interface ThumbLine {
  readonly d: string
  /** 0.35..1: the line's deepest level, so light lines read light. */
  readonly opacity: number
}

export interface MotifThumb {
  readonly w: number
  readonly h: number
  readonly lines: readonly ThumbLine[]
}

const r = (v: number) => Math.round(v * 100) / 100

/** One element as SVG path commands from its start (a full circle as two half arcs). */
function elementPath(e: Element, y: (v: number) => number): string {
  if (e.kind === 'line') return `L${r(e.b[0])} ${r(y(e.b[1]))}`
  const rad = Math.hypot(e.a[0] - e.centre[0], e.a[1] - e.centre[1])
  // y flips, so counter-clockwise in the motif frame is clockwise on screen (sweep 0)
  const sweep = e.ccw ? 0 : 1
  if (e.a[0] === e.b[0] && e.a[1] === e.b[1]) {
    const o: [number, number] = [2 * e.centre[0] - e.a[0], 2 * e.centre[1] - e.a[1]]
    return (
      `A${r(rad)} ${r(rad)} 0 0 ${sweep} ${r(o[0])} ${r(y(o[1]))}` +
      `A${r(rad)} ${r(rad)} 0 0 ${sweep} ${r(e.b[0])} ${r(y(e.b[1]))}`
    )
  }
  const a0 = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
  const b0 = Math.atan2(e.b[1] - e.centre[1], e.b[0] - e.centre[0])
  let sweepAngle = e.ccw ? b0 - a0 : a0 - b0
  while (sweepAngle <= 0) sweepAngle += 2 * Math.PI
  const large = sweepAngle > Math.PI ? 1 : 0
  return `A${r(rad)} ${r(rad)} 0 ${large} ${sweep} ${r(e.b[0])} ${r(y(e.b[1]))}`
}

/** The lines of a motif as path data in a `h` high frame (motif y up → screen y down). */
export function motifThumb(lines: readonly MotifLine[], w: number, h: number): MotifThumb {
  const y = (v: number) => h - v
  return {
    w,
    h,
    lines: lines.map((l) => {
      const first = l.elements[0]
      const start = first === undefined ? '' : `M${r(first.a[0])} ${r(y(first.a[1]))}`
      const level = l.levels === undefined ? 1 : Math.max(...l.levels.level)
      return {
        d: start + l.elements.map((e) => elementPath(e, y)).join('') + (l.closed ? 'Z' : ''),
        opacity: Math.round((0.35 + 0.65 * Math.min(Math.max(level, 0), 1)) * 100) / 100,
      }
    }),
  }
}

/** A preset's preview (cached; empty when it does not import). */
const cache = new Map<string, MotifThumb>()
export function presetThumb(id: string): MotifThumb {
  const hit = cache.get(id)
  if (hit !== undefined) return hit
  const preset = engravingPreset(id)
  const lines = presetLines(id)
  const out =
    preset === undefined || lines.isErr()
      ? { w: 1, h: 1, lines: [] }
      : motifThumb(lines.unwrap().lines, preset.size[0], preset.size[1])
  cache.set(id, out)
  return out
}
