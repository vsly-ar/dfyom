// The Shape Editor's flat view (task U1), pure: an orthographic 2D view of the shape frame (mm, y up)
// on screen pixels (y down), fit to bounds, zoomed about the cursor and panned; elements as SVG path
// data in screen space; grid steps and the rounding step of a drag at the current zoom.
// Doc: docs/conventions/ui.md#shape-editor
import { chainBounds, type Bounds2, type Element } from '../../../core/geometry/2d/model'
import type { Vec2 } from '../../../core/geometry/model'
import type { UnitSystem } from '../../../core/project/document'

/** Screen = (ox + x·scale, oy − y·scale). */
export interface FlatView {
  /** Pixels per mm. */
  readonly scale: number
  readonly ox: number
  readonly oy: number
}

export const MIN_SCALE = 0.02
export const MAX_SCALE = 2000

export const toScreen = (v: FlatView, p: Vec2): Vec2 => [
  v.ox + p[0] * v.scale,
  v.oy - p[1] * v.scale,
]
export const toShape = (v: FlatView, s: Vec2): Vec2 => [
  (s[0] - v.ox) / v.scale,
  (v.oy - s[1]) / v.scale,
]

/** The view showing `bounds` centred in `width` × `height` px, with `margin` (fraction) around it. */
export function fitView(
  bounds: Bounds2 | undefined,
  width: number,
  height: number,
  margin = 0.18,
): FlatView {
  const b = bounds ?? { min: [-50, -50], max: [50, 50] }
  const w = Math.max(b.max[0] - b.min[0], 1e-3)
  const h = Math.max(b.max[1] - b.min[1], 1e-3)
  const usable = 1 - 2 * margin
  const scale = clamp(Math.min((width * usable) / w, (height * usable) / h), MIN_SCALE, MAX_SCALE)
  const cx = (b.min[0] + b.max[0]) / 2
  const cy = (b.min[1] + b.max[1]) / 2
  return { scale, ox: width / 2 - cx * scale, oy: height / 2 + cy * scale }
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

/** Zoom by `factor` keeping the shape point under screen point `at` in place. */
export function zoomAt(v: FlatView, factor: number, at: Vec2): FlatView {
  const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE)
  const p = toShape(v, at)
  return { scale, ox: at[0] - p[0] * scale, oy: at[1] + p[1] * scale }
}

export const panBy = (v: FlatView, dx: number, dy: number): FlatView => ({
  ...v,
  ox: v.ox + dx,
  oy: v.oy + dy,
})

const f = (n: number): string => (Math.round(n * 100) / 100).toString()

/**
 * SVG path data of a chain in screen space (`M` once, then `L` / `A`; `Z` when closed). The view
 * flips y, so a counter-clockwise arc is drawn with sweep flag 0; a full circle is two halves.
 */
export function chainPath(v: FlatView, elements: readonly Element[], closed: boolean): string {
  if (elements.length === 0) return ''
  const parts: string[] = []
  const first = toScreen(v, elements[0]!.a)
  parts.push(`M${f(first[0])} ${f(first[1])}`)
  for (const e of elements) {
    const b = toScreen(v, e.b)
    if (e.kind === 'line') {
      parts.push(`L${f(b[0])} ${f(b[1])}`)
      continue
    }
    const r = Math.hypot(e.a[0] - e.centre[0], e.a[1] - e.centre[1]) * v.scale
    const sweep = e.ccw ? 0 : 1
    const full = e.a[0] === e.b[0] && e.a[1] === e.b[1]
    if (full) {
      const opp = toScreen(v, [2 * e.centre[0] - e.a[0], 2 * e.centre[1] - e.a[1]])
      parts.push(`A${f(r)} ${f(r)} 0 0 ${sweep} ${f(opp[0])} ${f(opp[1])}`)
      parts.push(`A${f(r)} ${f(r)} 0 0 ${sweep} ${f(b[0])} ${f(b[1])}`)
      continue
    }
    const a0 = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
    const a1 = Math.atan2(e.b[1] - e.centre[1], e.b[0] - e.centre[0])
    let sweepAngle = e.ccw ? a1 - a0 : a0 - a1
    while (sweepAngle <= 0) sweepAngle += 2 * Math.PI
    const large = sweepAngle > Math.PI ? 1 : 0
    parts.push(`A${f(r)} ${f(r)} 0 ${large} ${sweep} ${f(b[0])} ${f(b[1])}`)
  }
  if (closed) parts.push('Z')
  return parts.join('')
}

/** Grid steps in mm (1-2-5): minor lines at least 10 px apart, major every 5 or 10 minor. */
export function gridSteps(scale: number, units: UnitSystem): { minor: number; major: number } {
  const unit = units === 'mm' ? 1 : 25.4
  const target = 10 / scale / unit // the smallest step ≥ 10 px, in the project unit
  const e = 10 ** Math.floor(Math.log10(target))
  const m = target / e
  const k = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10
  const minor = k * e * unit
  return { minor, major: minor * (k === 2 ? 5 : 10) }
}

/**
 * The rounding of a dragged value at this zoom: the 1-2-5 step nearest one screen pixel, so a
 * drag never writes more digits than the pointer can place (mm; at least 0.001 mm).
 */
export function dragStepMm(scale: number): number {
  const target = 1 / scale
  const e = 10 ** Math.floor(Math.log10(target))
  const m = target / e
  return Math.max(0.001, (m <= 1.5 ? 1 : m <= 3.5 ? 2 : m <= 7.5 ? 5 : 10) * e)
}

// ── placement (task U2: the face-on view) ────────────────────────────────────────────────

/**
 * Where the shape frame lies in the face frame: `face = R·M·p + offset` (M flips x when
 * mirrored, R turns counter-clockwise; design-v0.3.md#placing-a-shape-on-a-face).
 */
export interface ShapePlacement {
  readonly cos: number
  readonly sin: number
  readonly mirror: boolean
  readonly offset: Vec2
}

/** A shape-frame point in the face frame. */
export function placePoint(t: ShapePlacement, p: readonly [number, number]): Vec2 {
  const x = t.mirror ? -p[0] : p[0]
  return [t.cos * x - t.sin * p[1] + t.offset[0], t.sin * x + t.cos * p[1] + t.offset[1]]
}

/** A face-frame point in the shape frame. */
export function unplacePoint(t: ShapePlacement, q: readonly [number, number]): Vec2 {
  const dx = q[0] - t.offset[0]
  const dy = q[1] - t.offset[1]
  const x = t.cos * dx + t.sin * dy
  const y = -t.sin * dx + t.cos * dy
  return [t.mirror ? -x : x, y]
}

/** Elements of a chain mapped into the face frame (a mirror reverses arc senses). */
export function placeElements(t: ShapePlacement, elements: readonly Element[]): Element[] {
  return elements.map((e) =>
    e.kind === 'line'
      ? { ...e, a: placePoint(t, e.a), b: placePoint(t, e.b) }
      : {
          ...e,
          a: placePoint(t, e.a),
          b: placePoint(t, e.b),
          centre: placePoint(t, e.centre),
          ccw: t.mirror ? !e.ccw : e.ccw,
        },
  )
}

/** Bounds of elements placed in the face frame (exact for arcs, as `chainBounds`). */
export const placedBounds = (t: ShapePlacement, elements: readonly Element[]): Bounds2 | undefined =>
  chainBounds(placeElements(t, elements))
