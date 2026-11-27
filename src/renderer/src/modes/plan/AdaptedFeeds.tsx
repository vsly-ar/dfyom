// The feeds group's "Adapted for <machine>" line (hardening DF139): a recommended preset's values
// lowered to the plan machine, one part per adapted field with its reason; each part's tooltip
// names the limit that set it (on hover and on keyboard focus).
// Doc: docs/architecture/feeds-speeds.md#recommended-presets-on-the-plan-machine-hardening-df139
import { Fragment } from 'react'
import type { AdaptReason } from '../../../../core/feeds-speeds/preset'
import type { FeedField } from '../../../../core/plan/plan.dto'
import type { UnitSystem } from '../../../../core/project/document'
import { planMessages } from '../../messages/plan'
import { Tooltip } from '../../ui'
import { feedQuantity } from './model'
import styles from './Plan.module.css'

const t = planMessages.inspector.adapted

/** One adapted field: the stored value, the value used (canonical) and why. */
export interface AdaptedFeed {
  readonly field: FeedField
  readonly from: number
  readonly to: number
  readonly reason: AdaptReason
}

/** The plan machine's limits the tooltips name (canonical; absent = not set). */
export interface AdaptLimits {
  readonly minSpeed?: number
  readonly maxSpeed?: number
  readonly maxFeedXY?: number
  readonly maxFeedZ?: number
  /** Spindle power (W). */
  readonly power?: number
}

const number = (field: FeedField, v: number, units: UnitSystem): string =>
  feedQuantity(field, v, units)?.source.split(' ')[0] ?? String(v)
const withUnit = (field: FeedField, v: number, units: UnitSystem): string =>
  feedQuantity(field, v, units)?.source ?? String(v)

function tip(a: AdaptedFeed, limits: AdaptLimits, units: UnitSystem): string {
  switch (a.reason) {
    case 'spindleRange':
      return t.tip.spindleRange(
        limits.maxSpeed === undefined
          ? undefined
          : `${Math.round(limits.minSpeed ?? 0)}–${Math.round(limits.maxSpeed)} rpm`,
        a.field === 'feedRate',
      )
    case 'maxFeedRate':
      return t.tip.maxFeedRate(
        limits.maxFeedXY === undefined ? undefined : withUnit('feedRate', limits.maxFeedXY, units),
        a.field === 'spindleSpeed',
      )
    case 'maxFeedRateZ':
      return t.tip.maxFeedRateZ(
        limits.maxFeedZ === undefined ? undefined : withUnit('feedRate', limits.maxFeedZ, units),
      )
    case 'power':
      return t.tip.power(limits.power === undefined ? undefined : `${Math.round(limits.power)} W`)
  }
}

/** Nothing without adapted fields. */
export function AdaptedFeeds({
  machine,
  fields,
  limits,
  units,
}: {
  machine: string | undefined
  fields: readonly AdaptedFeed[]
  limits: AdaptLimits
  units: UnitSystem
}): React.JSX.Element | null {
  if (fields.length === 0) return null
  return (
    <p className={styles['muted']} data-testid="adapted-feeds">
      {t.title(machine)}{' '}
      {fields.map((a, i) => (
        <Fragment key={a.field}>
          {i > 0 ? ' · ' : null}
          <Tooltip content={tip(a, limits, units)}>
            {/* focusable so keyboard users reach the limit; the tooltip describes it */}
            <span tabIndex={0}>
              {`${t.field[a.field]} ${number(a.field, a.from, units)} → ${withUnit(a.field, a.to, units)} (${t.reason[a.reason]})`}
            </span>
          </Tooltip>
        </Fragment>
      ))}
    </p>
  )
}
