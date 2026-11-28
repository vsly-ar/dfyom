// The spindle under the jog pad (v0.5 RV1): the state from the status report ("Off", or
// "12 000 rpm · CW" in the accent while it turns), the speed slider over the machine's
// minSpeed–maxSpeed, "Start spindle" (confirmed; Idle only, its gate's reason as the description)
// (DF143: not for an advanced user) and "Stop spindle" (never confirmed, whenever connected outside a run: in a jog the host cancels
// the jog first). While it turns, a committed speed is sent at once (in a jog through the spindle
// override). A manual spindle or laser mode shows why there is no control.
// Doc: docs/modes/run-machine.md#spindle-while-jogging-rv1
import { useId, useState } from 'react'
import type { RunStatus } from '../../../../core/run/service'
import { runMessages } from '../../messages/run'
import { Button, ConfirmDialog, Slider } from '../../ui'
import { spindleStartGate, spindleStopGate } from './machine-state'
import type { MachineOverrideLimits } from './plan-info'
import styles from './Run.module.css'

const m = runMessages.spindle

/** Slider steps (rpm). */
export const SPINDLE_STEP = 100

/** rpm as the run panels show speeds ("12000", like the overrides' "S 19800 rpm"). */
export const formatRpm = (rpm: number): string => Math.round(rpm).toString()

/** The speed range (rpm) and the default (the middle, rounded to 1000 rpm, inside the range). */
export function spindleRange(machine: MachineOverrideLimits): {
  min: number
  max: number
  initial: number
} {
  const max = machine.maxSpindle ?? 24_000
  const min = Math.min(machine.minSpindle ?? SPINDLE_STEP, max)
  const mid = Math.round((min + max) / 2 / 1000) * 1000
  return { min, max, initial: Math.min(max, Math.max(min, mid)) }
}

export function SpindleControl({
  status,
  machine,
  onSpindle,
  sharedReason = () => '',
  confirmStart = true,
}: {
  status: RunStatus
  machine: MachineOverrideLimits
  onSpindle: (on: boolean, rpm?: number) => Promise<void> | void
  /**
   * The id of a reason the navigator already shows (its notice line), or '': each reason is said
   * once and the buttons point at it (DF34).
   */
  sharedReason?: (text: string) => string
  /** DF143: false for an advanced user: Start spindle starts at once. */
  confirmStart?: boolean
}): React.JSX.Element {
  const range = spindleRange(machine)
  // undefined until chosen: the default follows the machine once its limits have loaded
  const [speed, setSpeed] = useState<number | undefined>(undefined)
  const [drag, setDrag] = useState<number | undefined>(undefined)
  const [confirm, setConfirm] = useState(false)
  const startWhy = useId()
  const stopWhy = useId()
  const turning = status.spindle > 0
  const unavailable =
    machine.spindleControl === 'manual' ? m.manual : status.laserMode === true ? m.laser : undefined
  const shown = Math.min(range.max, Math.max(range.min, drag ?? speed ?? range.initial))
  const startGate = spindleStartGate(status)
  const stopGate = spindleStopGate(status)
  const startShared = startGate === null ? '' : sharedReason(startGate)
  const stopShared = stopGate === null ? '' : sharedReason(stopGate)
  const state = turning ? m.on(formatRpm(status.spindle), status.spindleDirection) : m.off
  return (
    <div className={styles['spindle']} data-spindle="">
      <div className={styles['jogFeedHead']}>
        <span>{m.title}</span>
        <span
          className={styles['spindleState']}
          data-on={turning ? '' : undefined}
          role="status"
          aria-label={`${m.title}: ${state}`}
        >
          {state}
        </span>
      </div>
      {unavailable !== undefined ? (
        <p className={styles['why']}>{unavailable}</p>
      ) : (
        <>
          <Slider
            label={m.speed}
            min={range.min}
            max={range.max}
            step={SPINDLE_STEP}
            value={shown}
            valueText={(v) => m.rpm(formatRpm(v))}
            onValueChange={setDrag}
            onValueCommit={(v) => {
              setDrag(undefined)
              setSpeed(v)
              // while it turns a new speed applies at once: Idle, or a jog of a spindle started
              // here (the host changes it through the spindle override)
              const jogging = status.state.startsWith('Jog') && status.manualSpindle !== undefined
              if (turning && (startGate === null || jogging)) void onSpindle(true, v)
            }}
          />
          <div className={styles['buttons']}>
            <Button
              size="sm"
              disabled={startGate !== null || turning}
              {...(startGate === null
                ? {}
                : { 'aria-describedby': startShared === '' ? startWhy : startShared })}
              onClick={() => (confirmStart ? setConfirm(true) : void onSpindle(true, shown))}
            >
              {m.start}
            </Button>
            <Button
              size="sm"
              disabled={stopGate !== null}
              {...(stopGate === null
                ? {}
                : { 'aria-describedby': stopShared === '' ? stopWhy : stopShared })}
              onClick={() => void onSpindle(false)}
            >
              {m.stop}
            </Button>
          </div>
          {/* reserved: a reason never moves the buttons (DF34) */}
          <p id={startWhy} className={styles['spindleWhy']}>
            {startGate !== null && !turning && startShared === '' ? startGate : ''}
          </p>
          {stopGate === null || stopShared !== '' ? null : (
            <span id={stopWhy} className={styles['srOnly']}>
              {stopGate}
            </span>
          )}
          <ConfirmDialog
            open={confirm}
            onOpenChange={setConfirm}
            title={m.confirm.title}
            description={m.confirm.description(formatRpm(shown))}
            confirmLabel={m.confirm.confirm}
            onConfirm={() => void onSpindle(true, shown)}
          />
        </>
      )}
    </div>
  )
}
