// JogPad: step jogs per axis (44 px run controls), the step in the project's units, and "Stop jog"
// (jog cancel). Jogs are relative (`run.machine.jog { by }`); GRBL caps the feed at the axis'
// max rate. Used in the navigator and in the tool-change dialog.
// Doc: docs/conventions/ui.md#run-mode-safety-ui, docs/modes/run-v0.1.md#commands-and-queries
import type { UnitSystem } from '../../../../core/project/document'
import { runMessages } from '../../messages/run'
import { Button, SegmentedControl } from '../../ui'
import { JOG_STEPS, stepToMm } from './machine-state'
import type { Axis } from './run-store'
import styles from './Run.module.css'

const m = runMessages.navigator

/** Jog feeds (mm/min): XY and Z. GRBL limits them to the machine's max rates ($110–$112). */
export const JOG_FEED = { xy: 2000, z: 500 } as const

export interface JogPadProps {
  units: UnitSystem
  step: string
  onStep: (step: string) => void
  onJog: (axis: Axis, mm: number, feed: number) => void
  onCancel: () => void
  /** Why jogging is not possible now (shown under the pad), or null. */
  disabledReason: string | null
  /** Only the Z buttons (tool change: raise and lower). */
  zOnly?: boolean
  /** id of the reason text, for `aria-describedby`. */
  reasonId: string
}

export function JogPad({
  units,
  step,
  onStep,
  onJog,
  onCancel,
  disabledReason,
  zOnly = false,
  reasonId,
}: JogPadProps): React.JSX.Element {
  const disabled = disabledReason !== null
  const steps = JOG_STEPS[units]
  const current = steps.includes(step) ? step : steps[2]!
  const jog = (axis: Axis, sign: 1 | -1) =>
    onJog(axis, sign * stepToMm(current, units), axis === 'z' ? JOG_FEED.z : JOG_FEED.xy)
  const button = (axis: Axis, sign: 1 | -1, area: string) => {
    const dir = sign > 0 ? '+' : '−'
    return (
      <Button
        key={`${axis}${sign}`}
        size="lg"
        className={styles[area]}
        aria-label={m.jogButton(axis.toUpperCase(), dir)}
        disabled={disabled}
        {...(disabled ? { 'aria-describedby': reasonId } : {})}
        onClick={() => jog(axis, sign)}
      >
        {axis.toUpperCase()}
        {dir}
      </Button>
    )
  }
  return (
    <div className={styles['jog']}>
      <SegmentedControl
        label={m.step}
        size="sm"
        className={styles['jogSteps']}
        options={steps.map((s) => ({ value: s, label: `${s} ${units === 'inch' ? 'in' : 'mm'}` }))}
        value={current}
        onValueChange={onStep}
      />
      <div className={styles['jogPad']} data-z-only={zOnly ? '' : undefined}>
        {zOnly
          ? null
          : [
              button('y', 1, 'yPlus'),
              button('x', -1, 'xMinus'),
              button('x', 1, 'xPlus'),
              button('y', -1, 'yMinus'),
            ]}
        {button('z', 1, 'zPlus')}
        {button('z', -1, 'zMinus')}
      </div>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>
        {m.cancelJog}
      </Button>
      {disabledReason !== null ? (
        <p id={reasonId} className={styles['why']}>
          {disabledReason}
        </p>
      ) : null}
    </div>
  )
}
