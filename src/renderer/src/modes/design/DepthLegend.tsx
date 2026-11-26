// The depth legend under a Line's or an engraved pattern's "From SVG levels" depth fields
// (engraved-patterns.md § Depth legend): a bar from Deepest (level 1, full ink) to Shallowest
// (level 0, faint ink), as the preset thumbnails draw levels, with a tick per level in use and
// the two depths under its ends; a continuous fade (more than a dozen levels) shows its range as
// a band instead of ticks. Neutral ink only (no accent). Read-only; its name says it all for a
// screen reader. Doc: docs/modes/engraved-patterns.md#depth-legend
import type { LegendLevels } from '../../../../core/design/engraving/legend'
import type { UnitSystem } from '../../../../core/project/document'
import { lengthSource } from '../../messages/dfm'
import { lineMessages } from '../../messages/line'
import styles from './Design.module.css'

const t = lineMessages.legend

/** The depth of level `l` between `min` and `max` (mm, E2's mapping). */
const depthOf = (l: number, min: number, max: number) => min + l * (max - min)

export function DepthLegend({
  min,
  max,
  legend,
  units,
}: {
  /** Shallowest and deepest depth (mm). */
  min: number
  max: number
  legend: LegendLevels
  units: UnitSystem
}): React.JSX.Element {
  const L = (mm: number) => lengthSource(Math.round(mm * 1000) / 1000, units)
  // level 1 at the left (deepest), level 0 at the right
  const x = (l: number) => `${(1 - l) * 100}%`
  const label =
    legend.kind === 'ticks'
      ? t.ticks(
          L(max),
          L(min),
          legend.levels.map((l) => L(depthOf(l, min, max))),
        )
      : t.continuous(
          L(max),
          L(min),
          L(depthOf(legend.max, min, max)),
          L(depthOf(legend.min, min, max)),
        )
  return (
    <div className={styles['depthLegend']} role="img" aria-label={label} data-depth-legend>
      <div className={styles['depthLegendBar']}>
        {legend.kind === 'ticks' ? (
          legend.levels.map((l) => (
            <span
              key={l}
              className={styles['depthLegendTick']}
              style={{ left: x(l) }}
              data-level={l}
            />
          ))
        ) : (
          <span
            className={styles['depthLegendBand']}
            style={{ left: x(legend.max), right: `${legend.min * 100}%` }}
          />
        )}
      </div>
      <div className={styles['depthLegendEnds']} aria-hidden>
        <span>{L(max)}</span>
        <span>{L(min)}</span>
      </div>
    </div>
  )
}
