// The open toe clamp's front view in the setup inspector (design review R12, Q131), pure: the
// stock edge (hatched, its top at Z0), the strap resting on it and on the heel at its outer end,
// the stud with its nut (the clamp's top), at true proportions from the item's values, for
// SketchView. One measured part per field the view shows: Grip (strap end to the stock edge, over
// the strap), Reach (the stock edge to the strap's outer end) and Top above Z0 (beside the heel).
// Width and the position along the edge are across this view: no part.
// Values are mm; `units` only formats the chips and the accessible name.
// Doc: docs/conventions/ui.md#workholding, docs/conventions/ui.md#section-illustration
import type { UnitSystem } from '../../../../core/project/document'
import { sketchLength } from '../../viewport/hole-section'
import type { Sketch, SketchPoint, SketchPrimitive } from '../../viewport/sketch'

/** The toe clamp fields with a measured part in the view. */
export type ClampSectionPart = 'grip' | 'reach' | 'top'

export interface ClampSectionValues {
  readonly grip: number
  readonly reach: number
  readonly top: number
  /** The stock's thickness in the setup (mm): where the table is. */
  readonly stockThickness: number
  /** Fields whose value is refused: drawn in `--danger` with the error marker. */
  readonly invalid?: readonly ClampSectionPart[]
}

const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback)

export function clampSection(values: ClampSectionValues, units: UnitSystem): Sketch {
  const L = (mm: number) => sketchLength(mm, units)
  const invalid = new Set(values.invalid ?? [])
  // a drawing for any value typed: negative or zero sizes draw as small ones
  const g = Math.max(finite(values.grip, 0), 0)
  const r = Math.max(finite(values.reach, 1), 1)
  const t = Math.max(finite(values.top, 1), 1)
  const T = Math.max(finite(values.stockThickness, 10), 1)
  const span = g + r
  // the strap rests on the stock (Z0) and on the heel; the nut on the stud is the clamp's top
  const strap = Math.min(Math.max(t * 0.4, Math.min(1, t)), 10, t)
  const heel = Math.min(Math.max(r * 0.18, 2), 8, r)
  const stud = Math.max(r * 0.45, Math.min(r - heel - 1, 2))
  const nut = Math.max(Math.min(span * 0.06, 4), 1)
  // the stock runs on to the left beyond the grip; a thick stock fades out under the clamp
  // instead of making the view tall
  const left = -(g + Math.max(8, span * 0.3))
  const deep = Math.max(0.6 * t + 6, 10)
  const bottom = Math.min(T, deep)
  const cut = T > deep
  const right = r + Math.max(6, span * 0.08)
  const above = -t - Math.max(4, span * 0.07)

  const primitives: SketchPrimitive[] = []
  const line = (points: SketchPoint[], closed = false) =>
    primitives.push({ kind: 'line', style: 'edge', points, ...(closed ? { closed } : {}) })

  // the stock: hatched, its top (Z0) and the edge the clamp holds
  primitives.push({
    kind: 'material',
    points: [
      [left, 0],
      [0, 0],
      [0, bottom],
      [left, bottom],
    ],
  })
  line([
    [left, 0],
    [0, 0],
    [0, bottom],
  ])
  // the table under the stock and the heel
  if (!cut)
    line([
      [left, bottom],
      [right, bottom],
    ])
  // the strap over the edge, the heel under its outer end, the stud and its nut
  line(
    [
      [-g, -strap],
      [r, -strap],
      [r, 0],
      [-g, 0],
    ],
    true,
  )
  line(
    [
      [r - heel, 0],
      [r - heel, bottom],
      [r, bottom],
      [r, 0],
    ],
    true,
  )
  primitives.push({
    kind: 'line',
    style: 'axis',
    points: [
      [stud, -t - 1],
      [stud, bottom],
    ],
  })
  if (t - strap > 0.5)
    line(
      [
        [stud - nut, -t],
        [stud + nut, -t],
        [stud + nut, -strap],
        [stud - nut, -strap],
      ],
      true,
    )
  if (cut) primitives.push({ kind: 'fade', x0: left, x1: right, from: bottom * 0.6, to: bottom })

  // the measured parts: grip and reach as one chain over the clamp, top beside the heel
  const measure = (
    part: ClampSectionPart,
    paths: SketchPoint[][],
    value: string,
    chip: SketchPoint,
    side: 'above' | 'left',
  ) =>
    primitives.push({
      kind: 'measure',
      part,
      paths,
      value,
      chip,
      side,
      ...(invalid.has(part) ? { invalid: true } : {}),
    })
  measure(
    'grip',
    [
      [
        [-g, above],
        [0, above],
      ],
      [
        [-g, -strap],
        [-g, above - 1],
      ],
      [
        [0, 0],
        [0, above - 1],
      ],
    ],
    L(values.grip),
    [-g / 2, above],
    'above',
  )
  measure(
    'reach',
    [
      [
        [0, above],
        [r, above],
      ],
      [
        [0, 0],
        [0, above - 1],
      ],
      [
        [r, -strap],
        [r, above - 1],
      ],
    ],
    L(values.reach),
    [r / 2, above],
    'above',
  )
  const tx = r + Math.max(3, span * 0.05)
  measure(
    'top',
    [
      [
        [tx, 0],
        [tx, -t],
      ],
      [
        [stud + nut, -t],
        [tx + 1, -t],
      ],
      [
        [r, 0],
        [tx + 1, 0],
      ],
    ],
    L(values.top),
    [tx, -t / 2],
    'left',
  )

  return {
    // room above the chain for its value chips
    bounds: { minX: left, minY: above - 0.35 * (bottom - above), maxX: right, maxY: bottom },
    primitives,
    label: `Front view of the toe clamp: grip ${L(values.grip)} on the stock, reach ${L(values.reach)} past the edge, top ${L(values.top)} above Z0.`,
  }
}
