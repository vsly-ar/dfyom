// The hole inspector's section illustration (v0.4 U2), pure: the cut through the hole axis at true
// proportions, drawn from the entered values – face, the stock below it (to its bottom for a
// through hole, else fading out under the deepest point, D45), the bore, the counterbore step
// or the countersink cone (its terraces when stepped, F7), the drill point, and with a fastener the screw's head and shank as a
// dashed silhouette (a picture of the fit, not geometry). One measured part per size field, for
// SketchView to highlight. Values are mm (resolved quantities); `units` only formats the chips and
// the accessible name. A slotted hole (H3) is cut along its slot: every wall moves out by half the
// travel, the screw stays at mid-travel, and the travel is a measured part between the end centres.
// Doc: docs/conventions/ui.md#section-illustration, docs/modes/design-v0.4.md#hole-feature,
// docs/modes/hole-slots-and-round-corners.md#implementation-h3
import { chamferTerraces } from '../../../core/geometry/model'
import type { UnitSystem } from '../../../core/project/document'
import type { Sketch, SketchPoint, SketchPrimitive } from './sketch'

export type HoleSectionType = 'simple' | 'counterbore' | 'countersink' | 'recessedCountersink'
export type HoleSectionBottom = 'through' | 'flat' | 'drillPoint'

/** The hole fields that have a measured part in the drawing. */
export type HoleSectionPart =
  | 'diameter'
  | 'depth'
  | 'cbDiameter'
  | 'cbDepth'
  | 'csDiameter'
  | 'csAngle'
  | 'csStepdown'
  | 'headSink'
  | 'slotLength'

export const HOLE_SECTION_PARTS: readonly HoleSectionPart[] = [
  'diameter',
  'depth',
  'cbDiameter',
  'cbDepth',
  'csDiameter',
  'csAngle',
  'csStepdown',
  'headSink',
  'slotLength',
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
  /** Present = a stepped countersink (F7): terraces of at most this height. */
  readonly csStepdown?: number | undefined
  readonly headSink: number
  /** A slotted hole's travel between its end centres (H3); absent or 0 = round. */
  readonly slotLength?: number | undefined
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
  /** Half the slot's travel: the section along the slot moves every wall out by it. */
  const o = ok(values.slotLength) && values.slotLength > 0 ? values.slotLength / 2 : 0

  // ── the mouth (right half, from the face down) ──
  const mouth: SketchPoint[] = []
  let boreTop = 0
  let outer = r
  // a recessed countersink (H1): the recess is drawn as a counterbore, the cone on its floor
  const recessed = values.type === 'recessedCountersink'
  const angle = ok(values.csAngle) ? Math.min(Math.max(values.csAngle, 1), 179) : 90
  const cs =
    (values.type === 'countersink' || recessed) && ok(values.csDiameter)
      ? { R: Math.max(values.csDiameter / 2, r) }
      : undefined
  const cb =
    (values.type === 'counterbore' || recessed) && ok(values.cbDiameter) && ok(values.cbDepth)
      ? {
          R: Math.max(values.cbDiameter / 2, cs?.R ?? r),
          depth: Math.max(values.cbDepth, 0),
        }
      : undefined
  /** Where the cone starts: the face, or a recess floor. */
  const csTop = recessed ? (cb?.depth ?? 0) : 0
  // stepped (F7): the core's terraces, each top step corner on the cone
  const terraces =
    cs !== undefined && ok(values.csStepdown) && values.csStepdown > 0
      ? chamferTerraces(
          { edgeDiameter: 2 * r, diameter: 2 * cs.R, angle },
          // at most 200 steps drawn (a tiny stepdown would only blacken the cone)
          Math.max(values.csStepdown, (cs.R - r) / Math.tan(rad(angle / 2)) / 200),
        )
      : undefined
  if (cb !== undefined && !recessed) {
    mouth.push([cb.R, 0], [cb.R, cb.depth], [r, cb.depth])
    boreTop = cb.depth
    outer = cb.R
  } else if (cs !== undefined) {
    const h = (cs.R - r) / Math.tan(rad(angle / 2))
    if (cb !== undefined) {
      mouth.push([cb.R, 0], [cb.R, csTop])
      outer = cb.R
    } else outer = cs.R
    if (terraces === undefined) mouth.push([cs.R, csTop], [r, csTop + h])
    else {
      terraces.radii.forEach((rk, k) =>
        mouth.push([rk, k * terraces.height], [rk, (k + 1) * terraces.height]),
      )
      mouth.push([r, h])
    }
    boreTop = csTop + h
  } else mouth.push([r, 0])

  // ── bore and bottom ──
  const through = values.bottom === 'through' || !ok(values.depth)
  const depth = through ? undefined : Math.max(values.depth!, boreTop)
  const tip = values.bottom === 'drillPoint' ? r / Math.tan(rad(POINT_ANGLE / 2)) : 0
  const deepest = depth === undefined ? undefined : depth + tip
  const stock = ok(values.stockDepth) && values.stockDepth > boreTop ? values.stockDepth : undefined
  // through: to the stock's bottom; blind: fading out under the deepest point (or the stock
  // bottom when it is that close); `broken` = the stock runs on beyond the drawing
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
  const wall: SketchPoint[] = [...mouth]
  if (depth === undefined) wall.push([r, bottomY])
  else {
    wall.push([r, depth])
    wall.push([0, depth + tip])
  }
  // a slot: the walls at its ends, half the travel out (a slot has no drill point)
  const right = wall.map(([x, y]): SketchPoint => [x === 0 ? 0 : x + o, y])
  outer += o

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
    } else if (cs !== undefined) {
      const dk2 = f.countersunkHead.diameter / 2
      // the head's top edge where the cone is as wide as the head (below a recess, from its floor)
      headTop = csTop + Math.max(cs.R - dk2, 0) / Math.tan(rad(angle / 2))
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
  const bottomEdge: SketchPoint[] = [
    [W, bottomY],
    [-W, bottomY],
  ]
  if (depth === undefined) {
    // two pieces either side of the bore
    const piece = (side: 1 | -1): SketchPoint[] => {
      const half = side === 1 ? right : mirror(right)
      const edge = bottomEdge
        .filter(([x]) => side * x >= r + o)
        .map(([x, y]): SketchPoint => [x, y])
      return [[side * W, 0], ...half, ...(side === 1 ? edge.reverse() : edge), [side * W, bottomY]]
    }
    primitives.push({ kind: 'material', points: piece(1) })
    primitives.push({ kind: 'material', points: piece(-1) })
    primitives.push({ kind: 'line', style: 'edge', points: right })
    primitives.push({ kind: 'line', style: 'edge', points: mirror(right) })
    // the stock's bottom face; running on beyond the drawing, no line: it fades out (below)
    if (!broken)
      for (const side of [1, -1] as const) {
        const kept = bottomEdge.filter(([x]) => side * x >= r + o)
        const clip: SketchPoint = [side * (r + o), bottomY]
        primitives.push({
          kind: 'line',
          style: 'edge',
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
    if (!broken) primitives.push({ kind: 'line', style: 'edge', points: bottomEdge })
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
      [0, bottomY + (broken ? 0 : height * 0.04)],
    ],
  })
  for (const s of silhouette) primitives.push({ kind: 'line', style: 'silhouette', points: s })
  // the stock runs on below the drawing: fade it out instead of a break line (D45), from below the
  // deepest point (a blind hole) or the head's seat (a through hole cut short)
  if (broken) {
    const above = deepest ?? boreTop
    primitives.push({
      kind: 'fade',
      x0: -W,
      x1: W,
      from: above + (bottomY - above) * (deepest === undefined ? 0.4 : 0.2),
      to: bottomY,
    })
  }

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
  // a slot's diameters are measured across its right end, about that end's centre (x = o)
  measure(
    'diameter',
    [
      [
        [o - r, yd],
        [o + r, yd],
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
    const y = recessed ? cb.depth * 0.35 : cb.depth / 2
    measure(
      'cbDiameter',
      [
        [
          [o - cb.R, y],
          [o + cb.R, y],
        ],
      ],
      `Ø ${L(values.cbDiameter!)}`,
      [o, 0],
      'above',
    )
    measure(
      'cbDepth',
      [
        [
          [o + cb.R, 0],
          [o + cb.R, cb.depth],
        ],
      ],
      L(values.cbDepth!),
      [o + cb.R, y],
      'right',
    )
  }
  if (cs !== undefined) {
    // below a recess the cone's rim is on the recess floor, its chip under it in the bore
    measure(
      'csDiameter',
      [
        [
          [o - cs.R, csTop],
          [o + cs.R, csTop],
        ],
      ],
      `Ø ${L(values.csDiameter!)}`,
      [o, csTop],
      cb !== undefined ? 'below' : 'above',
    )
    // the cone itself (stepped: the line through the step corners)
    const flank: SketchPoint[] = [
      [o + cs.R, csTop],
      [o + r, boreTop],
    ]
    measure(
      'csAngle',
      [flank, mirror(flank)],
      `${+angle.toFixed(2)}°`,
      [o + cs.R, (csTop + boreTop) / 2],
      'right',
    )
    if (terraces !== undefined)
      measure(
        'csStepdown',
        [
          [
            [-cs.R, 0],
            [-cs.R, terraces.height],
          ],
        ],
        L(terraces.height),
        [-cs.R, terraces.height / 2],
        'left',
      )
  }
  // the travel: between the end centres, in the bore below the mouth
  if (o > 0) {
    const yt = boreTop + (boreEnd - boreTop) * 0.25
    measure(
      'slotLength',
      [
        [
          [-o, yt],
          [o, yt],
        ],
      ],
      L(2 * o),
      [0, yt],
      'above',
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
    label: sectionLabel(values, sink, L, terraces),
  }
}

/** "Section: Ø 3.4 mm through; counterbore Ø 6.5 mm, 3.2 mm deep; M3 head 0.2 mm below the face." */
function sectionLabel(
  v: HoleSectionValues,
  sink: number | undefined,
  L: (mm: number) => string,
  terraces: { readonly count: number; readonly height: number } | undefined,
): string {
  const bottoms = { flat: 'flat bottom', drillPoint: 'drill point' } as const
  const parts = [
    v.bottom === 'through' || !ok(v.depth)
      ? `Ø ${L(v.diameter)} through`
      : `Ø ${L(v.diameter)}, ${L(v.depth)} deep, ${bottoms[v.bottom]}`,
  ]
  const slot = ok(v.slotLength) && v.slotLength > 0
  if (slot)
    parts[0] = `${parts[0]}, slotted: ${L(v.slotLength!)} travel, ${L(v.slotLength! + v.diameter)} overall`
  if (v.type === 'counterbore' && ok(v.cbDiameter) && ok(v.cbDepth))
    parts.push(`counterbore Ø ${L(v.cbDiameter)}, ${L(v.cbDepth)} deep`)
  if (v.type === 'recessedCountersink' && ok(v.cbDiameter) && ok(v.cbDepth))
    parts.push(`recess Ø ${L(v.cbDiameter)}, ${L(v.cbDepth)} deep`)
  if ((v.type === 'countersink' || v.type === 'recessedCountersink') && ok(v.csDiameter))
    parts.push(
      `countersink Ø ${L(v.csDiameter)}, ${+(v.csAngle ?? 90).toFixed(2)}°` +
        (terraces === undefined
          ? ''
          : `, stepped in ${terraces.count} ${terraces.count === 1 ? 'step' : 'steps'} of ${L(terraces.height)}`),
    )
  if (v.fastener !== undefined) {
    const size = v.fastener.size
    if (v.purpose === 'tapDrill') parts.push(`${size} tap drill`)
    else if (sink === undefined || Math.abs(sink) < 1e-6) parts.push(`${size} head on the face`)
    else if (sink > 0) parts.push(`${size} head ${L(sink)} below the face`)
    else parts.push(`${size} head ${L(-sink)} above the face`)
  }
  return `${slot ? 'Section along the slot' : 'Section'}: ${parts.join('; ')}.`
}
