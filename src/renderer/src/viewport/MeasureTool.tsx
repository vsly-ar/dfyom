// The measure tool's pieces (task U3): the distance between two picked points with its components,
// the flat view's dimension line (ticks at both ends, small end circles) and the distance chip
// whose tooltip gives ΔX, ΔY (and ΔZ in 3D). Nothing is stored. The 3D viewport draws its own line
// in the scene and reuses the chip.
// Doc: docs/conventions/ui.md#snap-and-measure
import type { UnitSystem } from '../../../core/project/document'
import { snapMessages } from '../messages/snap'
import { Tooltip } from '../ui'
import styles from './SnapGlyph.module.css'

const mm = snapMessages.measure

/** Distance and per-axis components (b − a) of two points of the same dimension. */
export function measureBetween(
  a: readonly number[],
  b: readonly number[],
): { distance: number; deltas: number[] } {
  const deltas = a.map((v, i) => (b[i] ?? 0) - v)
  return { distance: Math.hypot(...deltas), deltas }
}

/** The dimension line between two screen points: the line, end ticks across it, end circles. */
export function Dimension2d({
  a,
  b,
}: {
  a: readonly [number, number]
  b: readonly [number, number] | null
}): React.JSX.Element {
  const tick = 6
  let d = ''
  if (b !== null) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const nx = (-(b[1] - a[1]) / len) * tick
    const ny = ((b[0] - a[0]) / len) * tick
    d =
      `M${a[0]} ${a[1]}L${b[0]} ${b[1]}` +
      `M${a[0] - nx} ${a[1] - ny}L${a[0] + nx} ${a[1] + ny}` +
      `M${b[0] - nx} ${b[1] - ny}L${b[0] + nx} ${b[1] + ny}`
  }
  return (
    <g className={styles['dimension']} data-testid="measure-dimension">
      {d ? <path d={d} /> : null}
      <circle cx={a[0]} cy={a[1]} r={2.5} />
      {b !== null ? <circle cx={b[0]} cy={b[1]} r={2.5} /> : null}
    </g>
  )
}

/**
 * The distance chip at screen point `at`; its tooltip lists the components along the axes. With
 * `inline` (the 3D viewport, whose drei `Html` overlays render outside the app's providers, so no
 * Tooltip there) the components are a second, muted line of the chip instead.
 */
export function MeasureChip({
  at,
  distance,
  parts,
  units,
  inline = false,
}: {
  at: readonly [number, number]
  distance: number
  /** Axis name and component (mm), e.g. `[['x', 12], ['y', 5]]`. */
  parts: readonly (readonly [string, number])[]
  units: UnitSystem
  inline?: boolean
}): React.JSX.Element {
  if (inline)
    return (
      <span
        className={styles['dimensionChip']}
        style={{ transform: `translate(${at[0]}px, ${at[1]}px) translate(-50%, -100%)` }}
        data-testid="measure-chip"
      >
        {mm.chip(distance, units)}
        <span className={styles['dimensionDeltas']}>{mm.deltas(parts, units)}</span>
      </span>
    )
  return (
    <Tooltip content={mm.deltas(parts, units)} side="top">
      <span
        className={styles['dimensionChip']}
        style={{ transform: `translate(${at[0]}px, ${at[1]}px) translate(-50%, -50%)` }}
        data-testid="measure-chip"
        tabIndex={-1}
      >
        {mm.chip(distance, units)}
      </span>
    </Tooltip>
  )
}
