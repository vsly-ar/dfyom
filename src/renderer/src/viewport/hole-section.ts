// The hole inspector's section illustration (v0.4 U2), pure: the cut through the hole axis at true
// proportions, drawn from the entered values – face, the stock below it (to its bottom for a
// through hole, else cut by a break line under the deepest point), the bore, the counterbore step
// or the countersink cone, the drill point, and with a fastener the screw's head and shank as a
// dashed silhouette (a picture of the fit, not geometry). One measured part per size field, for
// SketchView to highlight. Values are mm (resolved quantities); `units` only formats the chips and
// the accessible name.
// Doc: docs/conventions/ui.md#section-illustration, docs/modes/design-v0.4.md#hole-feature
import type { UnitSystem } from '../../../core/project/document'
import type { Sketch, SketchPoint, SketchPrimitive } from './sketch'

export type HoleSectionType = 'simple' | 'counterbore' | 'countersink'
export type HoleSectionBottom = 'through' | 'flat' | 'drillPoint'

/** The hole fields that have a measured part in the drawing. */
export type HoleSectionPart =
  'diameter' | 'depth' | 'cbDiameter' | 'cbDepth' | 'csDiameter' | 'csAngle' | 'headSink'

export const HOLE_SECTION_PARTS: readonly HoleSectionPart[] = [
  'diameter',
  'depth',
  'cbDiameter',
  'cbDepth',
  'csDiameter',
  'csAngle',
  'headSink',
]

/** The chosen screw, from the fastener table (mm, degrees). */
export interface HoleSectionFastener {
  readonly size: string
  /** Thread Ø d. */
  readonly nominal: number
  /** Socket head (ISO 4762): Ø dk, height k. */
  readonly socketHead: { readonly diameter: number; readonly height: number }
  /** Countersunk head: Ø dk, included angle. */
  readonly countersunkHead: { readonly diameter: number; readonly angle: number }
}

export interface HoleSectionValues {
  readonly type: HoleSectionType
  readonly purpose: 'clearance' | 'tapDrill'
  readonly diameter: number
  readonly bottom: HoleSectionBottom
  /** Blind holes: from the face to full diameter. */
  readonly depth?: number | undefined
  readonly cbDiameter?: number | undefined
  readonly cbDepth?: number | undefined
  readonly csDiameter?: number | undefined
  /** Included angle, degrees. */
  readonly csAngle?: number | undefined
  readonly headSink: number
  /** Material below the face along the axis (stock extent from the hole's face), if known. */
  readonly stockDepth?: number | undefined
  readonly fastener?: HoleSectionFastener | undefined
  /** Fields whose entered value is invalid: their parts are drawn in danger. */
  readonly invalid?: readonly string[] | undefined
}

/** A drill point's included angle (the drilling default, design.md#drilling). */
const POINT_ANGLE = 118
const rad = (deg: number) => (deg * Math.PI) / 180

/** A length for chips and the label: "3.4 mm", `0.134"` (trailing zeros dropped). */
export function sketchLength(mm: number, units: UnitSystem): string {
  if (units === 'inch') return `${+(mm / 25.4).toFixed(4)}"`
  return `${+mm.toFixed(3)} mm`
}

const ok = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v)

export function holeSection(values: HoleSectionValues, units: UnitSystem): Sketch {
  const L = (mm: number) => sketchLength(mm, units)
  const invalid = new Set(values.invalid ?? [])
  const r = Math.max(values.diameter, 1e-3) / 2

  // ── the mouth (right half, from the face down) ──
  const mouth: SketchPoint[] = []
  let boreTop = 0
  let outer = r
  const cb =
    values.type === 'counterbore' && ok(values.cbDiameter) && ok(values.cbDepth)
      ? { R: Math.max(values.cbDiameter / 2, r), depth: Math.max(values.cbDepth, 0) }
      : undefined
  const angle = ok(values.csAngle) ? Math.min(Math.max(values.csAngle, 1), 179) : 90
  const cs =
    values.type === 'countersink' && ok(values.csDiameter)
      ? { R: Math.max(values.csDiameter / 2, r) }
      : undefined
  if (cb !== undefined) {
    mouth.push([cb.R, 0], [cb.R, cb.depth], [r, cb.depth])
    boreTop = cb.depth
    outer = cb.R
  } else if (cs !== undefined) {
    const h = (cs.R - r) / Math.tan(rad(angle / 2))
    mouth.push([cs.R, 0], [r, h])
    boreTop = h
    outer = cs.R
  } else mouth.push([r, 0])

  // ── bore and bottom ──
  const through = values.bottom === 'through' || !ok(values.depth)
  const depth = through ? undefined : Math.max(values.depth!, boreTop)
  const tip = values.bottom === 'drillPoint' ? r / Math.tan(rad(POINT_ANGLE / 2)) : 0
  const deepest = depth === undefined ? undefined : depth + tip
  const stock = ok(values.stockDepth) && values.stockDepth > boreTop ? values.stockDepth : undefined
  // through: to the stock's bottom; blind: a break line under the deepest point (or the stock
  // bottom when it is that close)
  let bottomY: number
  let broken: boolean
  if (deepest === undefined) {
    bottomY = stock ?? boreTop + Math.max(4 * r, boreTop, 2)
    broken = stock === undefined
  } else {
    const below = deepest + Math.max(r, deepest * 0.35)
    broken = stock === undefined || stock > deepest + Math.max(r, deepest * 0.35) * 1.5
    bottomY = broken ? below : stock!
  }
  const right: SketchPoint[] = [...mouth]
  if (depth === undefined) right.push([r, bottomY])
  else {
    right.push([r, depth])
    right.push([0, depth + tip])
  }

  // ── the screw (head seat and silhouette) ──
  const f = values.fastener
  /** Top of the drawn head (y); undefined without a head. */
  let headTop: number | undefined
  /** How far the head's top sits below the face (negative: above); undefined without a head. */
  let sink: number | undefined
  const silhouette: SketchPoint[][] = []
  if (f !== undefined) {
    const d2 = f.nominal / 2
    let seat = 0
    if (values.purpose === 'tapDrill') {
      // the screw comes through the mating part: only its thread shows in the tapped hole
    } else if (values.type === 'countersink' && cs !== undefined) {
      const dk2 = f.countersunkHead.diameter / 2
      // the head's top edge where the cone is as wide as the head
      headTop = Math.max(cs.R - dk2, 0) / Math.tan(rad(angle / 2))
      sink = headTop
      const hh = Math.max(dk2 - d2, 0) / Math.tan(rad(f.countersunkHead.angle / 2))
      seat = headTop + hh
      silhouette.push([
        [-dk2, headTop],
        [dk2, headTop],
        [d2, seat],
        [-d2, seat],
        [-dk2, headTop],
      ])
    } else {
      const dk2 = f.socketHead.diameter / 2
      seat = cb !== undefined ? cb.depth : 0
      headTop = seat - f.socketHead.height
      sink = cb !== undefined ? headTop : 0
      silhouette.push([
        [-dk2, headTop],
        [dk2, headTop],
        [dk2, seat],
        [-dk2, seat],
        [-dk2, headTop],
      ])
    }
    const end = depth === undefined ? bottomY : Math.max(seat, depth - 0.15 * (depth - seat))
    silhouette.push([
      [-d2, seat],
      [-d2, end],
      [d2, end],
      [d2, seat],
    ])
  }

  // ── material and outline ──
  const top = Math.min(0, headTop ?? 0)
  const height = bottomY - top
  const W = Math.max(outer * 1.7, outer + height * 0.9)
  const mirror = (pts: readonly SketchPoint[]) => pts.map(([x, y]): SketchPoint => [0 - x || 0, y])
  const primitives: SketchPrimitive[] = []
  const zig = height * 0.06
  const breakLine: SketchPoint[] = [
    [W, bottomY],
    [W * 0.55 + zig, bottomY],
    [W * 0.55, bottomY - zig],
    [W * 0.55 - zig, bottomY + zig],
    [W * 0.55 - 2 * zig, bottomY],
    [-W, bottomY],
  ]
  const bottomEdge: SketchPoint[] = broken
    ? breakLine
    : [
        [W, bottomY],
        [-W, bottomY],
      ]
  if (depth === undefined) {
    // two pieces either side of the bore
    const piece = (side: 1 | -1): SketchPoint[] => {
      const half = side === 1 ? right : mirror(right)
      const edge = bottomEdge.filter(([x]) => side * x >= r).map(([x, y]): SketchPoint => [x, y])
      return [[side * W, 0], ...half, ...(side === 1 ? edge.reverse() : edge), [side * W, bottomY]]
    }
    primitives.push({ kind: 'material', points: piece(1) })
    primitives.push({ kind: 'material', points: piece(-1) })
    primitives.push({ kind: 'line', style: 'edge', points: right })
    primitives.push({ kind: 'line', style: 'edge', points: mirror(right) })
    for (const side of [1, -1] as const) {
      const kept = bottomEdge.filter(([x]) => side * x >= r)
      const clip: SketchPoint = [side * r, bottomY]
      primitives.push({
        kind: 'line',
        style: broken ? 'break' : 'edge',
        points: side === 1 ? [...kept, clip] : [clip, ...kept],
      })
    }
  } else {
    // one piece under and around the bore
    const profile = [...mirror(right), ...right.slice(0, -1).toReversed()]
    primitives.push({
      kind: 'material',
      points: [[-W, 0], ...profile, [W, 0], ...bottomEdge],
    })
    primitives.push({ kind: 'line', style: 'edge', points: profile })
    primitives.push({ kind: 'line', style: broken ? 'break' : 'edge', points: bottomEdge })
  }
  // the face, either side of the mouth
  primitives.push({
    kind: 'line',
    style: 'edge',
    points: [
      [-W, 0],
      [-outer, 0],
    ],
  })
  primitives.push({
    kind: 'line',
    style: 'edge',
    points: [
      [outer, 0],
      [W, 0],
    ],
  })
  primitives.push({
    kind: 'line',
    style: 'axis',
    points: [
      [0, top - height * 0.06],
      [0, bottomY + height * 0.04],
    ],
  })
  for (const s of silhouette) primitives.push({ kind: 'line', style: 'silhouette', points: s })

  // ── measured parts ──
  const measure = (
    part: HoleSectionPart,
    paths: SketchPoint[][],
    value: string,
    chip: SketchPoint,
    side: 'left' | 'right' | 'above' | 'below',
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
  const boreEnd = depth ?? bottomY
  const yd = boreTop + (boreEnd - boreTop) * 0.55
  measure(
    'diameter',
    [
      [
        [-r, yd],
        [r, yd],
      ],
    ],
    `Ø ${L(values.diameter)}`,
    [outer + (W - outer) * 0.15, yd],
    'right',
  )
  if (depth !== undefined)
    measure(
      'depth',
      [
        [
          [-outer - (W - outer) * 0.2, 0],
          [-outer - (W - outer) * 0.2, depth],
        ],
      ],
      L(depth),
      [-outer - (W - outer) * 0.2, depth / 2],
      'left',
    )
  if (cb !== undefined) {
    const y = cb.depth / 2
    measure(
      'cbDiameter',
      [
        [
          [-cb.R, y],
          [cb.R, y],
        ],
      ],
      `Ø ${L(values.cbDiameter!)}`,
      [0, 0],
      'above',
    )
    measure(
      'cbDepth',
      [
        [
          [cb.R, 0],
          [cb.R, cb.depth],
        ],
      ],
      L(values.cbDepth!),
      [cb.R, y],
      'right',
    )
  }
  if (cs !== undefined) {
    measure(
      'csDiameter',
      [
        [
          [-cs.R, 0],
          [cs.R, 0],
        ],
      ],
      `Ø ${L(values.csDiameter!)}`,
      [0, 0],
      'above',
    )
    measure(
      'csAngle',
      [mouth, mirror(mouth)],
      `${+angle.toFixed(2)}°`,
      [cs.R, boreTop / 2],
      'right',
    )
  }
  if (sink !== undefined && sink > 1e-6)
    measure(
      'headSink',
      [
        [
          [0, 0],
          [0, sink],
        ],
      ],
      L(sink),
      [0, 0],
      'above',
    )

  return {
    bounds: { minX: -W, minY: top, maxX: W, maxY: bottomY },
    primitives,
    label: sectionLabel(values, sink, L),
  }
}

/** "Section: Ø 3.4 mm through; counterbore Ø 6.5 mm, 3.2 mm deep; M3 head 0.2 mm below the face." */
function sectionLabel(
  v: HoleSectionValues,
  sink: number | undefined,
  L: (mm: number) => string,
): string {
  const bottoms = { flat: 'flat bottom', drillPoint: 'drill point' } as const
  const parts = [
    v.bottom === 'through' || !ok(v.depth)
      ? `Ø ${L(v.diameter)} through`
      : `Ø ${L(v.diameter)}, ${L(v.depth)} deep, ${bottoms[v.bottom]}`,
  ]
  if (v.type === 'counterbore' && ok(v.cbDiameter) && ok(v.cbDepth))
    parts.push(`counterbore Ø ${L(v.cbDiameter)}, ${L(v.cbDepth)} deep`)
  if (v.type === 'countersink' && ok(v.csDiameter))
    parts.push(`countersink Ø ${L(v.csDiameter)}, ${+(v.csAngle ?? 90).toFixed(2)}°`)
  if (v.fastener !== undefined) {
    const size = v.fastener.size
    if (v.purpose === 'tapDrill') parts.push(`${size} tap drill`)
    else if (sink === undefined || Math.abs(sink) < 1e-6) parts.push(`${size} head on the face`)
    else if (sink > 0) parts.push(`${size} head ${L(sink)} below the face`)
    else parts.push(`${size} head ${L(-sink)} above the face`)
  }
  return `Section: ${parts.join('; ')}.`
}
