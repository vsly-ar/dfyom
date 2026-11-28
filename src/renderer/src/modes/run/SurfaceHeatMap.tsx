// The stock surface map as a heat map (v0.5 RV10): one cell per grid point, front row at the
// bottom, coloured on a sequential ramp from the lowest to the highest point; filled (skipped)
// points hatched, unmeasured ones empty, a failed one outlined. A `role="img"` with min, max,
// range and the point count as its text alternative; each cell has its value as a title.
// Doc: docs/modes/run-surface.md#heat-map
import { useId } from 'react'
import {
  filledHeights,
  mapProgress,
  mapRange,
  type HeightMap,
} from '../../../../core/post/height-map'
import type { UnitSystem } from '../../../../core/project/document'
import { runMessages } from '../../messages/run'
import { formatLength } from './machine-state'
import styles from './Run.module.css'

const m = runMessages.surface

/** Max − min over a map's measured heights. */
export function surfaceRange(z: readonly (number | null)[]): number {
  const v = z.filter((x): x is number => x !== null)
  return v.length === 0 ? 0 : Math.max(...v) - Math.min(...v)
}

/** The ramp at `t` (0 lowest … 1 highest): light cool to dark warm, readable in both themes. */
export function rampColour(t: number): string {
  const k = Math.min(1, Math.max(0, t))
  const l = 0.88 - 0.38 * k
  const c = 0.06 + 0.1 * k
  const h = 250 - 200 * k
  return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`
}

export function SurfaceHeatMap({
  map,
  units,
  failed,
  limit,
}: {
  map: HeightMap
  units: UnitSystem
  /** The point that failed (index), outlined. */
  failed?: number | undefined
  /** The follow limit (mm): a range over it is marked. */
  limit?: number | undefined
}): React.JSX.Element {
  const hatch = useId()
  const unit = runMessages.dro.units[units]
  const f = (mm: number) => formatLength(mm, units)
  const filled = filledHeights(map)
  const z = filled.isOk() ? filled.unwrap() : map.z
  const skipped = new Set(map.skipped ?? [])
  const { min, max, range } = mapRange(map)
  const { measured, needed } = mapProgress(map)
  const label = m.heatLabel(f(min), f(max), f(range), unit, measured, needed)
  const over = limit !== undefined && range > limit + 1e-9
  return (
    <figure className={styles['surfaceMap']} data-surface-map="">
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${map.cols} ${map.rows}`}
        preserveAspectRatio="none"
        className={styles['surfaceGrid']}
      >
        <defs>
          <pattern id={hatch} width="0.25" height="0.25" patternUnits="userSpaceOnUse">
            <path d="M0 0.25 L0.25 0" stroke="currentColor" strokeWidth="0.03" />
          </pattern>
        </defs>
        {z.map((v, k) => {
          const c = k % map.cols
          const r = Math.floor(k / map.cols)
          const y = map.rows - 1 - r
          const isFilled = skipped.has(k)
          const title =
            v === null
              ? m.cellMissing(k + 1)
              : isFilled
                ? m.cellFilled(k + 1, f(v), unit)
                : m.cellValue(k + 1, f(v), unit)
          return (
            <g key={k} data-point={k} {...(isFilled ? { 'data-filled': '' } : {})}>
              <title>{title}</title>
              <rect
                x={c + 0.03}
                y={y + 0.03}
                width={0.94}
                height={0.94}
                fill={v === null ? 'none' : rampColour(range > 0 ? (v - min) / range : 0.5)}
                className={v === null ? styles['surfaceCellEmpty'] : undefined}
                {...(failed === k ? { 'data-failed': '' } : {})}
              />
              {isFilled ? (
                <rect
                  x={c + 0.03}
                  y={y + 0.03}
                  width={0.94}
                  height={0.94}
                  fill={`url(#${hatch})`}
                />
              ) : null}
            </g>
          )
        })}
      </svg>
      <figcaption className={styles['hint']}>
        <span className={styles['surfaceLegend']} aria-hidden="true">
          <span style={{ background: rampColour(0) }} />
          {f(min)}
          <span style={{ background: rampColour(1) }} />
          {f(max)} {unit}
        </span>{' '}
        <span data-range="">{m.range(f(range), unit)}</span>
        {' · '}
        {m.points(measured, needed)}
        {skipped.size > 0 ? ` · ${m.filledNote}` : ''}
        {over && limit !== undefined ? (
          <span className={styles['why']} data-over="">
            {' '}
            {m.overLimit(f(range), f(limit), unit)}
          </span>
        ) : null}
      </figcaption>
    </figure>
  )
}
