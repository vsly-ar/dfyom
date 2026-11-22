// Test-only: the v0.4 exit part (task X0), a lid for the v0.3 enclosure. Layout constants, the
// tools the plan uses and the expected hole / cone / slot positions, for the X1/X2 flows and their
// geometry check. Not app code; headless (no Node imports).
// Docs: docs/plans/v0.4.md#exit-criteria, docs/conventions/testing.md#fixtures
//
// Frame: the lid's top face, millimetres from the board's centre (u = part +X, v = part +Y, the
// back wall up), so the layout reads as the criteria write it. `onBoard` gives face coordinates.
import type { Vec2 } from '../geometry/model'
import { chainLength, chainPointAt } from '../geometry/2d/measure'
import type { Loop } from '../geometry/2d/model'
import { fromStartPoint, translatePath } from '../geometry/2d/place'
import { resolveTabs } from '../geometry/tab-hold'
import { importSvg } from '../import/svg'
import { fastenerRows, type FastenerRow } from './fastener/data'

/**
 * The board: 6 mm plywood, the v0.3 board's length, 15 mm wider (D40): along X the outline nearly
 * fills it, so the slot runs off the left and right sides and the tabs must move off them (TB1);
 * along Y the slot stays on the board (mm).
 */
export const LID_STOCK = {
  length: 255,
  width: 200,
  thickness: 6,
  materialClass: 'sheetGood',
} as const

/** The board's centre in the top face's frame (mm). */
export const LID_CENTRE: Vec2 = [LID_STOCK.length / 2, LID_STOCK.width / 2]

/** A layout point (from the centre) in the top face's frame. */
export const onBoard = (p: Vec2): Vec2 => [LID_CENTRE[0] + p[0], LID_CENTRE[1] + p[1]]

/**
 * The SVG page of `enclosure-sections.svg` (mm). Its centre is the STL's centre; X1 places it on
 * the board's centre as v0.3 did (`centreOf` in exit-criteria.v03.fixture.ts).
 */
const PAGE: Vec2 = [250, 178]

/**
 * Tools of the lid's plan (library items X1 adds; v0.4 docs: chamfer mills 90° × 6/12 mm,
 * design-v0.4.md#chamfer-mill-tool-type). Three distinct tools, so three tool changes:
 * - `Flat 6` cuts the outline profile (slot width = 6, the profile default);
 * - `Flat 3` cuts the cutout, the vents and the counterbores, and bores the Ø 3.4 / 4.5
 *   clearance holes helically (fit: d/2 < DC < d, design-v0.2.md#fit-when-a-tool-can-make-the-operation);
 * - `Chamfer 90 × 12` plunges the countersinks (DC ≥ csDiameter, tip ≤ the hole, plan-v0.4.md).
 */
export const LID_TOOLS = {
  profile: { name: 'Flat 6', type: 'flatEndMill', diameter: 6 },
  mill: { name: 'Flat 3', type: 'flatEndMill', diameter: 3 },
  chamfer: {
    name: 'Chamfer 90 × 12',
    type: 'chamferMill',
    diameter: 12,
    angle: 90,
    tipDiameter: 0,
  },
} as const

/** The outline profile: outside, slot = the profile tool, six tabs (D40: two land on the free ends and relocate) (profile defaults 6 × 2). */
export const LID_PROFILE = {
  side: 'outside',
  slotWidth: LID_TOOLS.profile.diameter,
  tabs: { count: 6, width: 6, thickness: 2 },
} as const

/** How far a filled-in screw head sits below the face (design-v0.4.md, `headSink` default). */
export const HEAD_SINK = 0.2

/** A fastener table row (`design.fastener.list` reads the same table). */
export function fastener(size: string): FastenerRow {
  const row = fastenerRows({ standard: 'isoMetric', size })[0]
  if (row === undefined) throw new Error(`no fastener ${size}`)
  return row
}

/** Sizes a hole feature fills in from its fastener (design-v0.4.md#parameters, `normal` fit). */
export function countersinkSizes(size: string) {
  const r = fastener(size)
  const diameter = r.clearance.normal
  const csDiameter = r.countersunkHead.diameter + 2 * HEAD_SINK
  const csAngle = r.countersunkHead.angle
  /** Cone depth from the face: (csDiameter − diameter) / 2 / tan(csAngle / 2). */
  const coneDepth = (csDiameter - diameter) / 2 / Math.tan(((csAngle / 2) * Math.PI) / 180)
  return { diameter, csDiameter, csAngle, coneDepth }
}

export function counterboreSizes(size: string) {
  const r = fastener(size)
  return {
    diameter: r.clearance.normal,
    cbDiameter: r.counterbore.diameter,
    cbDepth: r.socketHead.height + HEAD_SINK,
  }
}

/** A clone instance: its stable number (1 = the source) and position (from the centre). */
export interface LidInstance {
  readonly n: number
  readonly at: Vec2
}

/** Four countersunk M3 holes: one hole feature and a Clones `grid` row 2 × 2. */
export const SCREWS = {
  fastener: 'M3',
  type: 'countersink',
  fit: 'normal',
  source: [-88.5, -44.3],
  grid: { columns: 2, rows: 2, spacing: [177, 88.6] },
} as const

/**
 * The Ø 22 through cutout (an inside profile), its edge broken by a standalone chamfer 1.5 mm
 * wide at 90° (1.5 mm × 45°, Ø 25 at the face; X2, sized by width since D45): 1.5 mm of web stays
 * to the M4 counterbores at r 18.
 */
export const CUTOUT = { diameter: 22, centre: [60, 0], chamfer: 25, chamferWidth: 1.5 } as const

/**
 * The bolt circle: a counterbored M3 hole right of the cutout's centre and a Clones `arc` row round
 * that centre (centre at 180° from the source), 360° every 60° → 6 holes. The flow later changes
 * the source to M4 (`BOLT_CIRCLE_EDITED`); both must fit.
 *
 * Radius 18, not the criteria's first 17 (X0 proposal, docs/plans/v0.4.md#7-acceptance): at 17
 * the web between the Ø 22 cutout and a counterbore is 2.75 mm (M3) / 2 mm (M4), less than the
 * Ø 3 tool that cuts both; at 18 it is 3.75 / 3 mm.
 */
export const BOLT_CIRCLE_RADIUS = 18
export const BOLT_CIRCLE = {
  fastener: 'M3',
  type: 'counterbore',
  fit: 'normal',
  source: [CUTOUT.centre[0] + BOLT_CIRCLE_RADIUS, CUTOUT.centre[1]],
  arc: { radius: BOLT_CIRCLE_RADIUS, angle: 180, sweep: 360, step: 60 },
} as const
export const BOLT_CIRCLE_EDITED = 'M4'

/**
 * Vent slots: an obround through pocket 30 × 5 (length along u) and a Clones `offset` row of 6
 * more with step (0, 10); instance 4 skipped (a label area) → slots 1–3 and 5–7.
 */
export const VENTS = {
  length: 30,
  width: 5,
  source: [-60, -30],
  offset: { count: 6, step: [0, 10] },
  skip: [4],
} as const

/**
 * Grid positions, u first. The order of a `grid` row's cells is F5's to fix; the expected set
 * (`EXPECTED.screws`) is what X1 checks.
 */
export function gridInstances(source: Vec2, g: typeof SCREWS.grid): LidInstance[] {
  const out: LidInstance[] = []
  for (let j = 0; j < g.rows; j++)
    for (let i = 0; i < g.columns; i++)
      out.push({
        n: out.length + 1,
        at: [source[0] + i * g.spacing[0], source[1] + j * g.spacing[1]],
      })
  return out
}

/** An `arc` row (features.md#properties): a full circle never repeats its start. */
export function arcInstances(source: Vec2, a: typeof BOLT_CIRCLE.arc): LidInstance[] {
  const rad = (d: number) => (d * Math.PI) / 180
  const centre: Vec2 = [
    source[0] + a.radius * Math.cos(rad(a.angle)),
    source[1] + a.radius * Math.sin(rad(a.angle)),
  ]
  const start = Math.atan2(source[1] - centre[1], source[0] - centre[0])
  const steps = Math.abs(a.sweep) === 360 ? 360 / a.step - 1 : Math.floor(a.sweep / a.step)
  const out: LidInstance[] = [{ n: 1, at: source }]
  for (let k = 1; k <= steps; k++) {
    const t = start + rad(k * a.step)
    out.push({
      n: k + 1,
      at: [centre[0] + a.radius * Math.cos(t), centre[1] + a.radius * Math.sin(t)],
    })
  }
  return out
}

/** An `offset` row with skips: numbers stay stable (D30 C2), skipped ones make no clone. */
export function offsetInstances(
  source: Vec2,
  o: typeof VENTS.offset,
  skip: readonly number[],
): LidInstance[] {
  const out: LidInstance[] = []
  for (let k = 0; k <= o.count; k++) {
    const n = k + 1
    if (!skip.includes(n))
      out.push({ n, at: [source[0] + k * o.step[0], source[1] + k * o.step[1]] })
  }
  return out
}

/** 18 · sin 60°. */
const H = 15.588457268119894

/** The expected positions (from the centre) X1's geometry check compares within 0.01 mm. */
export const EXPECTED = {
  /** Countersunk M3: over the base's four blind holes. */
  screws: [
    [-88.5, -44.3],
    [88.5, -44.3],
    [-88.5, 44.3],
    [88.5, 44.3],
  ],
  cutout: [60, 0],
  /** Counterbored M3, instances 1–6 counter-clockwise from the source at 0°. */
  boltCircle: [
    [78, 0],
    [69, H],
    [51, H],
    [42, 0],
    [51, -H],
    [69, -H],
  ],
  /** Slot centres by instance number (4 skipped). */
  vents: [
    { n: 1, at: [-60, -30] },
    { n: 2, at: [-60, -20] },
    { n: 3, at: [-60, -10] },
    { n: 5, at: [-60, 10] },
    { n: 6, at: [-60, 20] },
    { n: 7, at: [-60, 30] },
  ],
} as const

/**
 * The outline loop of `enclosure-sections.svg` in the layout frame: the imported shape (mm page,
 * y up) with the page centre moved to the origin, re-chained from its start point (lowest v,
 * then u; design-v0.3.md#tabs-on-shapes).
 */
export function lidOutline(svg: string): Loop {
  const shape = importSvg(svg)
    .unwrap()
    .shapes.find((s) => s.name === 'outline')
  const item = shape?.items[0]
  if (item?.kind !== 'loop') throw new Error('no outline loop')
  return fromStartPoint(translatePath(item.loop, [-PAGE[0] / 2, -PAGE[1] / 2]))
}

/**
 * Tab centres by the v0.3 rule (`tabs.count`, design-v0.3.md#tabs-on-shapes: evenly spaced, the
 * first half a spacing after the start point), then moved off the free sides of the board (TB1,
 * design-v0.4.md#tabs-relocate-off-free-sides-tb1). Distances along the loop and points (layout
 * frame); `nominal` the v0.3 rule's distances.
 */
export function lidTabs(outline: Loop): { s: number; at: Vec2; nominal: number }[] {
  const n = LID_PROFILE.tabs.count
  const length = chainLength(outline)
  const nominal = Array.from({ length: n }, (_, k) => ((k + 0.5) * length) / n)
  // the hold test runs in the face frame: the outline placed on the board's centre
  const r = resolveTabs(
    {
      chain: translatePath(outline, LID_CENTRE),
      side: LID_PROFILE.side,
      slotWidth: LID_PROFILE.slotWidth,
      width: LID_PROFILE.tabs.width,
      stock: LID_STOCK,
    },
    nominal,
    false,
  )
  return r.centres.map((s, k) => ({
    s,
    at: chainPointAt(outline, s, true).unwrap().point,
    nominal: nominal[k]!,
  }))
}
