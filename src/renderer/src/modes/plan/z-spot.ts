// Z reference in the plan viewport (hardening DF69): which tool run's reference the viewport shows
// (a previewed run, else the selected operation's run, else the selected setup's first run) and
// where a dragged touch-off spot lands (on the spot grid, inside the flat patch eroded by the
// clearance radius). Pure.
// Doc: docs/modes/z-reference.md#implementation-notes-df69
import type { PlanDTO } from '../../../../core/plan/plan.dto'
import { cutTest } from '../../../../core/plan/cut'
import { toolRuns } from '../../../../core/plan/tool-runs'
import type { ZRefPolygonView } from './plan-store'

type P = readonly [number, number]

/**
 * The first plan operation of the tool run whose Z reference the viewport shows: `preview` when
 * it starts a run of the plan, else the run of the selected plan operation, else the first run of
 * the selected setup; undefined without a selection.
 */
export function shownZRefRun(
  plan: PlanDTO,
  selected: string | null,
  preview: string | undefined,
): string | undefined {
  // DF135: already-cut operations are in no tool run
  const isCut = cutTest(plan.design.part)
  for (const setup of plan.setups) {
    const runs = toolRuns(setup.operations, isCut)
    if (preview !== undefined && runs.some((r) => r.operations[0]?.id === preview)) return preview
  }
  if (selected === null) return undefined
  for (const setup of plan.setups) {
    const runs = toolRuns(setup.operations, isCut)
    if (setup.id === selected) return runs[0]?.operations[0]?.id
    const run = runs.find((r) => r.operations.some((o) => o.id === selected))
    if (run !== undefined) return run.operations[0]?.id
  }
  return undefined
}

/** Whether `p` lies inside the polygons (even-odd over every ring). */
export function insideArea(area: readonly ZRefPolygonView[], p: P): boolean {
  let inside = false
  for (const piece of area)
    for (const ring of [piece.outer, ...piece.holes])
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i]!
        const b = ring[j]!
        if (
          a[1] > p[1] !== b[1] > p[1] &&
          p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
        )
          inside = !inside
      }
  return inside
}

/** The point of the area's boundary nearest `p`. */
function nearestOnBoundary(area: readonly ZRefPolygonView[], p: P): P | undefined {
  let best: P | undefined
  let bestD = Infinity
  for (const piece of area)
    for (const ring of [piece.outer, ...piece.holes])
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j]!
        const b = ring[i]!
        const dx = b[0] - a[0]
        const dy = b[1] - a[1]
        const len = dx * dx + dy * dy
        const t =
          len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len))
        const q: P = [a[0] + t * dx, a[1] + t * dy]
        const d = Math.hypot(q[0] - p[0], q[1] - p[1])
        if (d < bestD) {
          bestD = d
          best = q
        }
      }
  return best
}

/** Whether `p` lies on the area's boundary (within 0.001 mm). */
function onEdge(area: readonly ZRefPolygonView[], p: P): boolean {
  const q = nearestOnBoundary(area, p)
  return q !== undefined && Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-3
}

/** Grid points searched around the nearest candidate (per side). */
const WINDOW = 3

/**
 * Where a spot dragged to `p` (setup WCS, mm) lands: the grid point nearest `p` inside the spot
 * area; near the area's edge when `p` is outside it. Undefined when no grid point of the area is
 * near (a sliver narrower than the grid).
 */
export function snapSpot(p: P, grid: number, area: readonly ZRefPolygonView[]): P | undefined {
  const g = grid > 0 ? grid : 1
  const centre = insideArea(area, p) ? p : nearestOnBoundary(area, p)
  if (centre === undefined) return undefined
  const ci = Math.round(centre[0] / g)
  const cj = Math.round(centre[1] / g)
  let best: P | undefined
  let bestD = Infinity
  for (let i = ci - WINDOW; i <= ci + WINDOW; i++)
    for (let j = cj - WINDOW; j <= cj + WINDOW; j++) {
      const q: P = [round(i * g), round(j * g)]
      // strictly inside: a point on the edge is left to the core's rounding (spotNotFlat)
      if (!insideArea(area, q) || onEdge(area, q)) continue
      const d = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (d < bestD - 1e-9) {
        bestD = d
        best = q
      }
    }
  return best
}

const round = (v: number): number => Math.round(v * 1e3) / 1e3 + 0
