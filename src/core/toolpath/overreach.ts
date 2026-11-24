/**
 * Tool reach past the stock (hardening DF59, interim until workholding): how far the tool's
 * circle reaches beyond each side of the stock rectangle in a setup's WCS (X 0…length,
 * Y 0…width as the stock sits on the machine), from the moves below the stock top (Z < 0).
 * Pure, headless. Doc: docs/modes/plan-v0.2.md#tool-reach-past-the-stock-and-clamps-hardening-df59-interim
 */
import type { Move, Toolpath, Vec2, Vec3 } from './model'

/** mm beyond the left (X−), right (X+), front (Y−) and back (Y+) side; ≥ 0, 0 = within. */
export interface Overreach {
  readonly xMin: number
  readonly xMax: number
  readonly yMin: number
  readonly yMax: number
}

export const NO_OVERREACH: Overreach = { xMin: 0, xMax: 0, yMin: 0, yMax: 0 }

/** Below this Z (mm) a point is below the stock top; above it the tool is in the air. */
const BELOW = -1e-6
/** Reaches below this (mm) count as within the outline (float noise). */
const NOISE = 1e-6

/** XY bounds of the tool centre over the moves below the top. */
class Bounds {
  minX = Infinity
  maxX = -Infinity
  minY = Infinity
  maxY = -Infinity
  add(x: number, y: number): void {
    this.minX = Math.min(this.minX, x)
    this.maxX = Math.max(this.maxX, x)
    this.minY = Math.min(this.minY, y)
    this.maxY = Math.max(this.maxY, y)
  }
}

/** The part of a straight move from `a` to `b` below the top: its XY end points. */
function addLine(bounds: Bounds, a: Vec3, b: Vec3): void {
  const aIn = a[2] < BELOW
  const bIn = b[2] < BELOW
  if (!aIn && !bIn) return
  if (aIn) bounds.add(a[0], a[1])
  if (bIn) bounds.add(b[0], b[1])
  if (aIn !== bIn) {
    // the point where the move crosses the top
    const t = (0 - a[2]) / (b[2] - a[2])
    bounds.add(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
  }
}

/** XY bounds of an arc (end points and the circle's extreme points it sweeps over). */
function addArc(bounds: Bounds, a: Vec3, to: Vec3, center: Vec2, cw: boolean): void {
  if (!(a[2] < BELOW) && !(to[2] < BELOW)) return
  bounds.add(a[0], a[1])
  bounds.add(to[0], to[1])
  const r = Math.hypot(a[0] - center[0], a[1] - center[1])
  const start = Math.atan2(a[1] - center[1], a[0] - center[0])
  const end = Math.atan2(to[1] - center[1], to[0] - center[0])
  const full = Math.abs(a[0] - to[0]) < 1e-12 && Math.abs(a[1] - to[1]) < 1e-12
  const tau = 2 * Math.PI
  // counter-clockwise sweep from `from` to `upto`
  const ccw = (from: number, upto: number) => (((upto - from) % tau) + tau) % tau
  const sweep = full ? tau : cw ? ccw(end, start) : ccw(start, end)
  const lo = cw ? end : start
  for (let k = 0; k < 4; k++) {
    const angle = (k * Math.PI) / 2
    if (full || ccw(lo, angle) <= sweep + 1e-12)
      bounds.add(center[0] + r * Math.cos(angle), center[1] + r * Math.sin(angle))
  }
}

function addMove(bounds: Bounds, from: Vec3 | undefined, m: Move): Vec3 {
  switch (m.kind) {
    case 'drill':
      if (m.bottom < BELOW) bounds.add(m.at[0], m.at[1])
      return [m.at[0], m.at[1], m.retract]
    case 'arc':
      if (from !== undefined) addArc(bounds, from, m.to, m.center, m.cw)
      else if (m.to[2] < BELOW) bounds.add(m.to[0], m.to[1])
      return m.to
    case 'rapid':
    case 'line':
      if (from !== undefined) addLine(bounds, from, m.to)
      else if (m.to[2] < BELOW) bounds.add(m.to[0], m.to[1])
      return m.to
  }
}

const past = (x: number) => (x > NOISE ? x : 0)

/**
 * How far a tool of `toolDiameter` (its largest diameter, mm) reaches beyond each side of the
 * stock rectangle `[0, size[0]] × [0, size[1]]` along `toolpath` (in the setup's WCS, Z0 = stock
 * top), counting only the moves below the top.
 */
export function toolpathOverreach(toolpath: Toolpath, toolDiameter: number, size: Vec2): Overreach {
  const bounds = new Bounds()
  let at: Vec3 | undefined
  for (const pass of toolpath.passes) for (const m of pass.moves) at = addMove(bounds, at, m)
  if (bounds.minX === Infinity) return NO_OVERREACH
  const r = toolDiameter / 2
  return {
    xMin: past(r - bounds.minX),
    xMax: past(bounds.maxX + r - size[0]),
    yMin: past(r - bounds.minY),
    yMax: past(bounds.maxY + r - size[1]),
  }
}

/** The per-side maximum: a setup's reach over its plan operations. */
export function maxOverreach(list: readonly Overreach[]): Overreach {
  return list.reduce<Overreach>(
    (a, b) => ({
      xMin: Math.max(a.xMin, b.xMin),
      xMax: Math.max(a.xMax, b.xMax),
      yMin: Math.max(a.yMin, b.yMin),
      yMax: Math.max(a.yMax, b.yMax),
    }),
    NO_OVERREACH,
  )
}

/** Whether the tool reaches past any side. */
export const reachesPastStock = (o: Overreach): boolean =>
  o.xMin > 0 || o.xMax > 0 || o.yMin > 0 || o.yMax > 0
