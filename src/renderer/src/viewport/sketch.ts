// Sketch primitives (v0.4 U2): a small drawing language for dimensioned-looking pictures made from
// entered values – the hole and chamfer sections now, the Field info views' `sketch` view later.
// Pure data in model units (mm, y down: depth grows downwards), rendered by SketchView with one
// uniform scale. A producer (holeSection) knows the values; SketchView knows only primitives and
// the highlighted part, never Field or an inspector.
// Doc: docs/conventions/ui.md#section-illustration

export type SketchPoint = readonly [number, number]

/**
 * How a line is drawn: outline, the face, a break, a fastener silhouette, a centre line. A break
 * is only for a drawing split to show a far part at scale; stock that just runs on beyond the
 * drawing fades out instead (`fade`, D45).
 */
export type SketchLineStyle = 'edge' | 'break' | 'silhouette' | 'axis'

export type SketchPrimitive =
  /** Cut material: a closed polygon filled with the quiet hatch, no outline of its own. */
  | { readonly kind: 'material'; readonly points: readonly SketchPoint[] }
  /**
   * Where the stock runs on beyond the drawing (D45, instead of a break line): everything drawn
   * before it in the band x0…x1 fades from fully visible at `from` to the background at `to`
   * (y values; `to` > `from` fades downwards). Measures, drawn last, stay on top.
   */
  | {
      readonly kind: 'fade'
      readonly x0: number
      readonly x1: number
      readonly from: number
      readonly to: number
    }
  /** A polyline (closed when `closed`). */
  | {
      readonly kind: 'line'
      readonly style: SketchLineStyle
      readonly points: readonly SketchPoint[]
      readonly closed?: boolean
    }
  /**
   * The measured part of one value (a field): invisible until highlighted (amber with its value in
   * a chip), hovered (`--vp-hover`) or invalid (`--danger` with the error marker, always shown).
   * Its paths are also the pointer target for hovering and clicking the part.
   */
  | {
      readonly kind: 'measure'
      readonly part: string
      readonly paths: readonly (readonly SketchPoint[])[]
      /** The chip's text ("Ø 3.4 mm") and where it sits (beside this point, on `side`). */
      readonly value: string
      readonly chip: SketchPoint
      readonly side: 'left' | 'right' | 'above' | 'below'
      readonly invalid?: boolean
    }

export interface SketchBounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

export interface Sketch {
  readonly bounds: SketchBounds
  /** In drawing order (material first, measures last). */
  readonly primitives: readonly SketchPrimitive[]
  /** The image's accessible name, built from the values. */
  readonly label: string
}

/** Screen px = (ox + x·scale, oy + y·scale): one uniform scale, centred in the box. */
export interface SketchFit {
  readonly scale: number
  readonly ox: number
  readonly oy: number
}

/** The uniform scale that fits `bounds` into `width` × `height` px with `pad` px around. */
export function fitSketch(
  bounds: SketchBounds,
  width: number,
  height: number,
  pad: number,
): SketchFit {
  const bw = Math.max(bounds.maxX - bounds.minX, 1e-9)
  const bh = Math.max(bounds.maxY - bounds.minY, 1e-9)
  const scale = Math.max(Math.min((width - 2 * pad) / bw, (height - 2 * pad) / bh), 1e-6)
  return {
    scale,
    ox: (width - bw * scale) / 2 - bounds.minX * scale,
    oy: (height - bh * scale) / 2 - bounds.minY * scale,
  }
}

const r1 = (v: number) => Math.round(v * 10) / 10

/** SVG path data of points in screen px (rounded to 0.1 px, so morphs compare equal shapes). */
export function sketchPath(fit: SketchFit, points: readonly SketchPoint[], closed = false): string {
  if (points.length === 0) return ''
  const xy = points.map(([x, y]) => `${r1(fit.ox + x * fit.scale)} ${r1(fit.oy + y * fit.scale)}`)
  return `M${xy.join('L')}${closed ? 'Z' : ''}`
}

export const toPx = (fit: SketchFit, [x, y]: SketchPoint): SketchPoint => [
  fit.ox + x * fit.scale,
  fit.oy + y * fit.scale,
]
