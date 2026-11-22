// The chamfer's section illustration (v0.4 task U4): a pure function of the entered values that
// returns drawing primitives – the cut through the edge's axis at true proportions: the face, the
// cut material in a quiet hatch, the edge's bore with its cone at the mouth, a break line where
// the stock or a deep bore is cut short, and one measured part per field (diameter, angle, depth,
// edge) that the renderer draws amber while its field has focus. Model units mm, y down from the
// face. Drawn by SketchView (U2's sketch primitives), as the hole section.
// Doc: docs/conventions/ui.md#section-illustration, #chamfer-inspector
import type { UnitSystem } from '../../../core/project/document'
import { chamferMessages } from '../messages/chamfer'
import { lengthSource } from '../messages/dfm'
import type { Sketch, SketchPoint, SketchPrimitive } from './sketch'

/** A measured part of the chamfer section: one per field. */
export type ChamferPart = 'diameter' | 'angle' | 'depth' | 'edgeOf'

export interface ChamferSectionValues {
  /** mm */
  readonly diameter: number
  /** Included angle, degrees. */
  readonly angle: number
  /** The edge's diameter, mm. */
  readonly edgeDiameter: number
  /** The edge's depth below the face, mm (a through hole: to the far stock face). */
  readonly edgeDepth: number
  readonly through: boolean
  readonly edgeName: string
  /** Parts drawn in `--danger` (a field's error, a hard finding at it). */
  readonly invalid?: ReadonlySet<string>
}

/** Depth of the cone below the face (mm), as core `chamferDepth`. */
export function coneDepth(v: Pick<ChamferSectionValues, 'diameter' | 'edgeDiameter' | 'angle'>) {
  return (v.diameter - v.edgeDiameter) / 2 / Math.tan(((v.angle / 2) * Math.PI) / 180)
}

const mirror = (pts: readonly SketchPoint[]): SketchPoint[] => pts.map(([x, y]) => [-x, y])

/** A zigzag break line from x0 to x1 at y (two teeth per side, height relative to the drawing). */
function breakLine(x0: number, x1: number, y: number, tooth: number): SketchPoint[] {
  const n = 4
  const pts: SketchPoint[] = [[x0, y]]
  for (let i = 1; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / n
    pts.push([x, y + (i % 2 === 0 ? 0 : i % 4 === 1 ? -tooth : tooth)])
  }
  pts.push([x1, y])
  return pts
}

/**
 * The section of a chamfer on a round edge. A cone that reaches the edge's floor is cut there
 * (that is what `dfm.chamferTooDeep` warns of). A deep edge is drawn to about three cone depths
 * and cut by a break line, so the cone stays readable at ~120 px.
 */
export function chamferSection(v: ChamferSectionValues, units: UnitSystem): Sketch {
  const L = (mm: number) => lengthSource(mm, units)
  const R = Math.max(v.diameter / 2, 1e-6)
  const e = Math.min(Math.max(v.edgeDiameter / 2, 0), R)
  const tanHalf = Math.tan(((v.angle / 2) * Math.PI) / 180)
  const c = Math.max(coneDepth(v), 0)
  const h = Number.isFinite(v.edgeDepth) && v.edgeDepth > 0 ? v.edgeDepth : Infinity
  const S = R + Math.max(0.6 * R, 1.5)
  const cap = Math.max(3 * c, 0.8 * R)
  const cut = c > h // the cone reaches the floor (or the far face)
  const rc = cut ? Math.max(R - h * tanHalf, 0) : e
  const yc = cut ? h : c
  // how the bore ends: at the far face, at its floor (stock below cut by a break), or cut short
  const shape: 'through' | 'floor' | 'cutShort' =
    v.through && h <= 1.5 * cap ? 'through' : !v.through && h <= cap ? 'floor' : 'cutShort'
  const boreEnd = shape === 'cutShort' ? cap : h
  const bottom = shape === 'floor' ? h + Math.max(0.35 * R, c, 0.5) : boreEnd
  const tooth = Math.max(0.06 * S, 0.05)

  const contour: SketchPoint[] = [[R, 0], [rc, yc], ...(cut ? [] : [[e, boreEnd] as const])]
  const left: SketchPoint[] = [[-S, 0], ...mirror(contour), [-S, cut ? yc : boreEnd]]
  const primitives: SketchPrimitive[] = [
    { kind: 'material', points: left },
    { kind: 'material', points: mirror(left) },
    ...(shape === 'floor'
      ? [
          {
            kind: 'material' as const,
            points: [
              [-S, h],
              [S, h],
              [S, bottom],
              [-S, bottom],
            ] as const,
          },
        ]
      : []),
    {
      kind: 'line',
      style: 'edge',
      points: [
        [-S, 0],
        [-R, 0],
      ],
    },
    {
      kind: 'line',
      style: 'edge',
      points: [
        [R, 0],
        [S, 0],
      ],
    },
    { kind: 'line', style: 'edge', points: mirror(contour) },
    { kind: 'line', style: 'edge', points: contour },
  ]
  if (shape === 'floor')
    primitives.push(
      {
        kind: 'line',
        style: 'edge',
        points: [
          [-rc, h],
          [rc, h],
        ],
      },
      { kind: 'line', style: 'break', points: breakLine(-S, S, bottom, tooth) },
    )
  else if (shape === 'through')
    primitives.push(
      {
        kind: 'line',
        style: 'edge',
        points: [
          [-S, h],
          [-rc, h],
        ],
      },
      {
        kind: 'line',
        style: 'edge',
        points: [
          [rc, h],
          [S, h],
        ],
      },
    )
  else
    primitives.push(
      { kind: 'line', style: 'break', points: breakLine(-S, -e, bottom, tooth) },
      { kind: 'line', style: 'break', points: breakLine(e, S, bottom, tooth) },
    )
  primitives.push({
    kind: 'line',
    style: 'axis',
    points: [
      [0, -0.12 * S],
      [0, bottom + 0.08 * S],
    ],
  })

  const bad = (part: ChamferPart) => (v.invalid?.has(part) === true ? { invalid: true } : {})
  const wall = (x: number): SketchPoint[] => [
    [x, yc],
    [x, boreEnd],
  ]
  primitives.push(
    {
      kind: 'measure',
      part: 'diameter',
      paths: [
        [
          [-R, 0],
          [R, 0],
        ],
      ],
      value: `Ø ${L(v.diameter)}`,
      chip: [0, 0],
      side: 'above',
      ...bad('diameter'),
    },
    {
      kind: 'measure',
      part: 'angle',
      paths: [mirror(contour.slice(0, 2)), contour.slice(0, 2)],
      value: `${Number(v.angle.toFixed(2))}°`,
      chip: [(R + rc) / 2, yc / 2],
      side: 'right',
      ...bad('angle'),
    },
    {
      kind: 'measure',
      part: 'depth',
      paths: [
        [
          [rc, 0],
          [rc, yc],
        ],
      ],
      value: L(c),
      chip: [R, yc / 2],
      side: 'right',
      ...bad('depth'),
    },
    {
      kind: 'measure',
      part: 'edgeOf',
      paths: cut
        ? [
            [
              [-rc, h],
              [rc, h],
            ],
          ]
        : [mirror(wall(e)), wall(e)],
      value: `Ø ${L(v.edgeDiameter)}`,
      chip: cut ? [0, h] : [e, (yc + boreEnd) / 2],
      side: cut ? 'below' : 'right',
      ...bad('edgeOf'),
    },
  )

  return {
    bounds: { minX: -S, minY: -0.2 * S, maxX: S, maxY: bottom + 0.1 * S },
    primitives,
    label: chamferMessages.sectionLabel({
      diameter: L(v.diameter),
      angle: `${Number(v.angle.toFixed(2))}°`,
      depth: L(c),
      edgeName: v.edgeName,
      edgeDiameter: L(v.edgeDiameter),
      edgeBottom: v.through
        ? chamferMessages.edgeThrough
        : chamferMessages.edgeDeep(Number.isFinite(h) ? L(h) : '–'),
    }),
  }
}
