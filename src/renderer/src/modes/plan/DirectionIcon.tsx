// A setup's direction as an icon (v0.2 task F6): the stock in a fixed isometric view of the part
// frame (top, front and right faces seen), with the face that points up to the spindle shaded.
// Faces turned away from the view (bottom, back, left) shade through the unfilled near faces,
// with the three hidden edges dashed. Neutral (`currentColor`), always next to the face's name.
// Doc: docs/conventions/ui.md#design-and-plan-controls-v02 (setup panel)
import type { Direction } from '../../../../core/geometry/face'

type P3 = readonly [number, number, number]

/** Stock proportions of the icon: a slab, longer than wide, so the faces read apart. */
const L = 1.5
const W = 1
const T = 0.55

/** Isometric projection from front-right-top (screen x right, y down). */
const project = ([x, y, z]: P3): readonly [number, number] => [
  (x + y) * Math.SQRT1_2,
  -(-x + y + 2 * z) / Math.sqrt(6),
]

const corner = (x: 0 | 1, y: 0 | 1, z: 0 | 1): P3 => [x * L, y * W, z === 1 ? 0 : -T]

/** The four corners of each face, in order around it. */
const FACES: Readonly<Record<Direction, readonly P3[]>> = {
  '+z': [corner(0, 0, 1), corner(1, 0, 1), corner(1, 1, 1), corner(0, 1, 1)],
  '-z': [corner(0, 0, 0), corner(1, 0, 0), corner(1, 1, 0), corner(0, 1, 0)],
  '-y': [corner(0, 0, 0), corner(1, 0, 0), corner(1, 0, 1), corner(0, 0, 1)],
  '+x': [corner(1, 0, 0), corner(1, 1, 0), corner(1, 1, 1), corner(1, 0, 1)],
  '+y': [corner(0, 1, 0), corner(1, 1, 0), corner(1, 1, 1), corner(0, 1, 1)],
  '-x': [corner(0, 0, 0), corner(0, 1, 0), corner(0, 1, 1), corner(0, 0, 1)],
}

const NEAR: ReadonlySet<Direction> = new Set(['+z', '-y', '+x'])

const pts = (ps: readonly P3[]) =>
  ps
    .map(project)
    .map(([a, b]) => `${a.toFixed(3)},${b.toFixed(3)}`)
    .join(' ')

const all = Object.values(FACES).flat().map(project)
const PAD = 0.12
const minX = Math.min(...all.map((p) => p[0])) - PAD
const minY = Math.min(...all.map((p) => p[1])) - PAD
const VIEW = `${minX.toFixed(3)} ${minY.toFixed(3)} ${(Math.max(...all.map((p) => p[0])) + PAD - minX).toFixed(3)} ${(Math.max(...all.map((p) => p[1])) + PAD - minY).toFixed(3)}`

/** The hidden corner (back, left, bottom) and its three edges. */
const HIDDEN = corner(0, 1, 0)
const HIDDEN_EDGES: readonly P3[] = [corner(1, 1, 0), corner(0, 0, 0), corner(0, 1, 1)]

export function DirectionIcon({
  direction,
  className,
}: {
  direction: Direction
  className?: string | undefined
}): React.JSX.Element {
  const near = NEAR.has(direction)
  return (
    <svg
      className={className}
      viewBox={VIEW}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      data-direction={direction}
    >
      <polygon
        points={pts(FACES[direction])}
        fill="currentColor"
        fillOpacity={near ? 0.5 : 0.28}
        stroke="none"
      />
      {HIDDEN_EDGES.map((p, i) => (
        <polyline
          key={i}
          points={pts([HIDDEN, p])}
          strokeWidth={0.08}
          strokeDasharray="0.12 0.1"
          strokeOpacity={0.7}
        />
      ))}
      {[...NEAR].map((d) => (
        <polygon key={d} points={pts(FACES[d])} strokeWidth={0.12} />
      ))}
    </svg>
  )
}
