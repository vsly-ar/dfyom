/**
 * The pocket's slot rule (heatsink presets H1, HS-E, Q201): a piece of a pocket's region that is a
 * straight slot exactly as wide as the tool (a sharp rectangle whose width is the tool's Ø within
 * `SLOT_FIT_TOLERANCE` on each side) is cut once per level along its centre line instead of as a
 * ring (whose return leg is in air). The slot's ends that lie on the stock edge or beyond it are
 * **open**: the centre line runs past the edge as an open pocket's tool centre does (DF61's
 * `openReach`), so the slot opens fully, and the tool steps down there with no ramp; a closed end
 * stops a radius short of it and is entered by a ramp along the centre line. No finishing ring
 * (the walls are as the tool leaves them). Generic: any pocket, not only patterns.
 * Doc: docs/modes/pattern-presets.md#plan, docs/modes/pattern-presets.md#implementation-h1
 *
 * The DFM rest-material check (shape-measure.ts) takes the same slots out first: the centre line
 * leaves nothing in them.
 *
 * Pure. Face frame (the pocket generator's frame).
 */
import type { StockGeometry, Vec2 } from './model'
import type { Region, RegionPiece } from './2d/model'
import { ON_EDGE, openReach } from './open-sides'

/**
 * A slot is the tool's Ø within this on each side: the pocket's `TOOL_FIT_TOLERANCE`
 * (toolpath/pocket.ts; geometry does not import toolpath, a test keeps them equal).
 */
export const SLOT_FIT_TOLERANCE = 0.01

/** One slot's tool-centre line, `a` to `b`, and which of its ends are open (beyond the stock). */
export interface SlotPass {
  readonly a: Vec2
  readonly b: Vec2
  readonly openA: boolean
  readonly openB: boolean
}

/** Angle tolerance of "parallel" and "square" (sine of the angle between the sides). */
const SQUARE = 1e-6

const sub = (p: Vec2, q: Vec2): Vec2 => [p[0] - q[0], p[1] - q[1]]
const len = (v: Vec2) => Math.hypot(v[0], v[1])
const mid = (p: Vec2, q: Vec2): Vec2 => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]

/** The piece's four corners when it is a rectangle of four lines without holes. */
function rectangleCorners(piece: RegionPiece): Vec2[] | undefined {
  if (piece.holes.length > 0) return undefined
  const els = piece.outer.elements
  if (els.length !== 4 || els.some((e) => e.kind !== 'line')) return undefined
  const c = els.map((e) => e.a)
  const sides = c.map((p, i) => sub(c[(i + 1) % 4]!, p))
  for (let i = 0; i < 4; i++) {
    const u = sides[i]!
    const v = sides[(i + 1) % 4]!
    const lu = len(u)
    const lv = len(v)
    if (lu <= 0 || lv <= 0) return undefined
    // adjacent sides square (so opposite sides are parallel)
    if (Math.abs(u[0] * v[0] + u[1] * v[1]) / (lu * lv) > SQUARE) return undefined
  }
  return c
}

/** Whether a point lies on the edge of the face rectangle (within `ON_EDGE`) or beyond it. */
const onOrBeyond = (p: Vec2, face: Pick<StockGeometry, 'length' | 'width'>) =>
  p[0] <= ON_EDGE ||
  p[1] <= ON_EDGE ||
  p[0] >= face.length - ON_EDGE ||
  p[1] >= face.width - ON_EDGE

/**
 * The slot pieces of `region` for a tool of `diameter` (with the pocket's finishing `allowance`,
 * which sets how far past an open end the centre runs), and the rest of the region, unchanged in
 * order. Without `face` every end is closed.
 */
export function slotSplit(
  region: Region,
  diameter: number,
  allowance: number,
  face?: Pick<StockGeometry, 'length' | 'width'>,
): { region: Region; slots: SlotPass[] } {
  const R = diameter / 2
  const rest: RegionPiece[] = []
  const slots: SlotPass[] = []
  for (const piece of region.pieces) {
    const s = slotOf(piece, R, allowance, face)
    if (s === undefined) rest.push(piece)
    else slots.push(s)
  }
  return slots.length === 0 ? { region, slots } : { region: { pieces: rest }, slots }
}

function slotOf(
  piece: RegionPiece,
  R: number,
  allowance: number,
  face: Pick<StockGeometry, 'length' | 'width'> | undefined,
): SlotPass | undefined {
  const c = rectangleCorners(piece)
  if (c === undefined) return undefined
  // the short sides are the slot's ends
  const s0 = len(sub(c[1]!, c[0]!))
  const s1 = len(sub(c[2]!, c[1]!))
  const [e1, e2, width, length] =
    s0 <= s1
      ? [[c[0]!, c[1]!] as const, [c[2]!, c[3]!] as const, s0, s1]
      : [[c[1]!, c[2]!] as const, [c[3]!, c[0]!] as const, s1, s0]
  if (Math.abs(width - 2 * R) > 2 * SLOT_FIT_TOLERANCE + 1e-9 || length <= width) return undefined
  const m1 = mid(e1[0], e1[1])
  const m2 = mid(e2[0], e2[1])
  const d: Vec2 = [(m2[0] - m1[0]) / length, (m2[1] - m1[1]) / length]
  const open = (e: readonly [Vec2, Vec2]) =>
    face !== undefined && onOrBeyond(e[0], face) && onOrBeyond(e[1], face)
  const openA = open(e1)
  const openB = open(e2)
  // open: past the edge as an open pocket's tool centre (r √½ + allowance); closed: R inside
  const past = openReach(R, allowance) - R
  const a: Vec2 = openA
    ? [m1[0] - d[0] * past, m1[1] - d[1] * past]
    : [m1[0] + d[0] * R, m1[1] + d[1] * R]
  const b: Vec2 = openB
    ? [m2[0] + d[0] * past, m2[1] + d[1] * past]
    : [m2[0] - d[0] * R, m2[1] - d[1] * R]
  // a closed slot no longer than the tool is a hole: the rings cut it
  if ((b[0] - a[0]) * d[0] + (b[1] - a[1]) * d[1] <= 1e-9) return undefined
  return { a, b, openA, openB }
}
