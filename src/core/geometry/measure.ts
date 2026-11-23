/**
 * Point measures shared by the viewport's measure tool and the headless `design.measure` (hardening
 * A6): the distance with its per-axis components, and the angle at a vertex. Pure.
 * Doc: docs/conventions/ui.md#snap-and-measure,
 * docs/architecture/llm-api.md#a6-designmeasure-headless-snap-and-measure
 */

/** Distance and per-axis components (b − a) of two points of the same dimension. */
export function measureBetween(
  a: readonly number[],
  b: readonly number[],
): { distance: number; deltas: number[] } {
  const deltas = a.map((v, i) => (b[i] ?? 0) - v)
  return { distance: Math.hypot(...deltas), deltas }
}

/**
 * The angle (degrees, 0–180) at `b` between the directions to `a` and to `c`; undefined when `a`
 * or `c` coincides with `b` (no direction).
 */
export function angleAt(
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
): number | undefined {
  const u = measureBetween(b, a)
  const v = measureBetween(b, c)
  if (!(u.distance > 0 && v.distance > 0)) return undefined
  let dot = 0
  for (let i = 0; i < u.deltas.length; i++) dot += u.deltas[i]! * (v.deltas[i] ?? 0)
  const cos = Math.max(-1, Math.min(1, dot / (u.distance * v.distance)))
  return (Math.acos(cos) * 180) / Math.PI
}
