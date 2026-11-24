// Dragging an alignment aid in the plan viewport (hardening DF83): its anchor (a hole's centre, a
// spot mark's point, a line mark's start; the whole line moves with it), where a drag lands (a
// 0.1 mm grid; a registration hole within 1.5 mm of a flip axis snaps onto it) and the
// `plan.aid.set` args of the drop. Positions in the setup frame (from the front-left corner of
// the up face, as the aid inspector's fields). Pure.
// Doc: docs/modes/alignment.md#implementation-df83
import type { AidDTO } from '../../../../core/plan/alignment.dto'

type P = readonly [number, number]

/** Grid a dragged aid lands on (mm). */
export const AID_GRID = 0.1
/** A dragged hole this close to a flip axis (mm) lands on it. */
export const AXIS_SNAP = 1.5

/** The point a drag moves: a hole's centre, a spot's point, a line's start. */
export function aidAnchor(aid: AidDTO): P {
  if (aid.kind === 'registrationHole') return aid.center
  return 'from' in aid ? aid.from : aid.at
}

const grid = (v: number) => Math.round(v / AID_GRID) * AID_GRID
const clean = (v: number) => Math.round(v * 1e6) / 1e6 || 0

/** The foot of `p` on the line through `a` and `b`, and the distance to it. */
function onLine(p: P, a: P, b: P): { foot: P; distance: number } {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  if (l2 === 0) return { foot: a, distance: Math.hypot(p[0] - a[0], p[1] - a[1]) }
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2
  const foot: P = [a[0] + t * dx, a[1] + t * dy]
  return { foot, distance: Math.hypot(p[0] - foot[0], p[1] - foot[1]) }
}

/** Where a drag of `aid` to `point` lands, and how far it is off the nearest flip axis (holes). */
export function snapAid(
  aid: AidDTO,
  point: P,
  axes: readonly { readonly from: P; readonly to: P }[],
): { at: P; offAxis?: number } {
  const at: P = [clean(grid(point[0])), clean(grid(point[1]))]
  if (aid.kind !== 'registrationHole' || axes.length === 0) return { at }
  const near = axes
    .map((x) => onLine(point, x.from, x.to))
    .sort((a, b) => a.distance - b.distance)[0]!
  if (near.distance <= AXIS_SNAP)
    return { at: [clean(near.foot[0]), clean(near.foot[1])], offAxis: 0 }
  return { at, offAxis: onLine(at, ...nearestAxis(axes, at)).distance }
}

function nearestAxis(axes: readonly { readonly from: P; readonly to: P }[], p: P): [P, P] {
  const best = axes
    .map((x) => ({ x, d: onLine(p, x.from, x.to).distance }))
    .sort((a, b) => a.d - b.d)[0]!.x
  return [best.from, best.to]
}

/** The aid moved so its anchor is at `to`: `plan.aid.set`'s `aid` arg (mm, as entered). */
export function movedAidArgs(aid: AidDTO, to: P): Record<string, [string, string]> {
  const mm = (p: P): [string, string] => [`${clean(p[0])} mm`, `${clean(p[1])} mm`]
  if (aid.kind === 'registrationHole') return { center: mm(to) }
  if (!('from' in aid)) return { at: mm(to) }
  const d: P = [to[0] - aid.from[0], to[1] - aid.from[1]]
  return { from: mm(to), to: mm([aid.to[0] + d[0], aid.to[1] + d[1]]) }
}
