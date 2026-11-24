// The run inspector's "Overrides" section (M6): feed and spindle in 10 % steps or back to 100 %,
// rapids at 100/50/25 %, the values GRBL reports (`Ov`). A value other than 100 % is marked and
// explained. Doc: docs/modes/run-machine.md#overrides-m6, docs/conventions/ui.md#run-mode-safety-ui
import type { RunStatus } from '../../../../core/run/service'
import { runMessages } from '../../messages/run'
import { Button, SegmentedControl } from '../../ui'
import type { OverrideChange } from './run-store'
import styles from './Run.module.css'

const m = runMessages.overrides
const RAPIDS = ['100', '50', '25'] as const
type Rapid = (typeof RAPIDS)[number]

export function OverridesSection({
  status,
  onChange,
}: {
  status: RunStatus
  onChange: (change: OverrideChange) => void
}): React.JSX.Element {
  const ov = status.overrides
  // a critical alarm waits for a reset: GRBL takes no override then
  const disabled =
    status.alarm !== undefined && (status.alarm.code === 1 || status.alarm.code === 2)
  const changed = ov !== undefined && (ov.feed !== 100 || ov.spindle !== 100 || ov.rapid !== 100)
  const row = (which: 'feed' | 'spindle', label: string) => {
    const value = ov?.[which]
    return (
      <div className={styles['overrideRow']} role="group" aria-label={label}>
        <span className={styles['overrideLabel']}>{label}</span>
        <span
          className={styles['overrideValue']}
          data-changed={value !== undefined && value !== 100 ? '' : undefined}
        >
          {value === undefined ? m.unknown : m.percent(value)}
        </span>
        <span className={styles['overrideButtons']}>
          <Button
            size="sm"
            aria-label={m.minusLabel(label)}
            disabled={disabled}
            onClick={() => onChange({ [which]: '-10' })}
          >
            {m.minus}
          </Button>
          <Button
            size="sm"
            aria-label={m.plusLabel(label)}
            disabled={disabled}
            onClick={() => onChange({ [which]: '+10' })}
          >
            {m.plus}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={m.resetLabel(label)}
            disabled={disabled || value === undefined || value === 100}
            onClick={() => onChange({ [which]: 'reset' })}
          >
            {m.reset}
          </Button>
        </span>
      </div>
    )
  }
  const rapid = String(ov?.rapid ?? 100) as Rapid
  return (
    <section className={styles['section']} aria-label={m.title}>
      <h3 className={styles['sectionTitle']}>{m.title}</h3>
      {row('feed', m.feed)}
      {row('spindle', m.spindle)}
      <div className={`${styles['overrideRow']} ${styles['overrideRapidsRow']}`}>
        <span className={styles['overrideLabel']} aria-hidden="true">
          {m.rapids}
        </span>
        <SegmentedControl<Rapid>
          label={m.rapids}
          size="sm"
          disabled={disabled}
          className={styles['overrideRapids']}
          options={RAPIDS.map((v) => ({ value: v, label: `${v} %` }))}
          value={RAPIDS.includes(rapid) ? rapid : '100'}
          onValueChange={(v) => onChange({ rapid: Number(v) as 100 | 50 | 25 })}
        />
      </div>
      {changed ? <p className={styles['overrideHint']}>{m.hint}</p> : null}
    </section>
  )
}
