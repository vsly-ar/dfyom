// The run inspector's "Overrides" section (M6, sliders DF85): feed and spindle each with a slider
// over the controller's override range (GRBL 10–200 %), capped by the machine's max feed and
// spindle speed for the programmed F and S, the spindle floored at its minimum speed (DF86
// follow-up), "−10 %"/"+10 %" buttons, arrow keys for 1 % and
// "Reset" to 100 %; rapids at 100/50/25 %. The values are the ones GRBL reports (`Ov`), next to
// the resulting F and S while a run streams. A slider drag is debounced and one target is in
// flight at a time; a value other than 100 % is marked and explained.
// Doc: docs/modes/run-machine.md#overrides-m6, docs/conventions/ui.md#run-mode-safety-ui
import { useEffect, useId, useRef, useState } from 'react'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import {
  overrideCap,
  overrideLimits,
  type OverrideKind,
  type OverrideLimits,
} from '../../../../core/run/override'
import type { RunStatus } from '../../../../core/run/service'
import { runMessages } from '../../messages/run'
import { Button, InspectorGroup, SegmentedControl, Slider } from '../../ui'
import { useLibraryItems } from '../plan/usePlan'
import { formatFeed } from './machine-state'
import { machineOverrideLimits, type MachineOverrideLimits } from './plan-info'
import { NO_PLAN, useRun, type OverrideChange } from './run-store'
import styles from './Run.module.css'

const m = runMessages.overrides
const RAPIDS = ['100', '50', '25'] as const
type Rapid = (typeof RAPIDS)[number]

/** Quiet time of a slider drag before its value is sent (ms); the release sends at once. */
export const OVERRIDE_DEBOUNCE_MS = 150

/** The override limits of the chosen plan's machine, or the manual-control machine (DF85). */
export function useMachineOverrideLimits(doc: ProjectDoc | undefined): MachineOverrideLimits {
  const planId = useRun((s) => s.planId)
  const machineId = useRun((s) => s.machineId)
  const machines = useLibraryItems('machine')
  const plan = planId === undefined || planId === NO_PLAN ? undefined : doc?.plans[planId]
  return machineOverrideLimits(plan, machines, machineId)
}

export function OverridesSection({
  status,
  onChange,
  machine = {},
  units = 'mm',
  controller = overrideLimits('grbl'),
}: {
  status: RunStatus
  onChange: (change: OverrideChange) => Promise<void> | void
  machine?: MachineOverrideLimits
  units?: UnitSystem
  /** The connected controller's override limits (data, per controller kind). */
  controller?: OverrideLimits
}): React.JSX.Element {
  const ov = status.overrides
  // a critical alarm waits for a reset: GRBL takes no override then
  const disabled =
    status.alarm !== undefined && (status.alarm.code === 1 || status.alarm.code === 2)
  const changed = ov !== undefined && (ov.feed !== 100 || ov.spindle !== 100 || ov.rapid !== 100)
  const programmed = status.job?.programmed
  const noSpindle =
    machine.spindleControl === 'manual'
      ? m.noSpindleManual
      : status.laserMode === true
        ? m.noSpindleLaser
        : undefined
  const rapid = String(ov?.rapid ?? 100) as Rapid
  return (
    <InspectorGroup title={m.title}>
      <OverrideRow
        which="feed"
        label={m.feed}
        value={ov?.feed}
        range={controller.feed}
        programmed={programmed?.feed}
        machineMax={machine.maxFeed}
        disabled={disabled}
        units={units}
        onChange={onChange}
      />
      <OverrideRow
        which="spindle"
        label={m.spindle}
        value={ov?.spindle}
        range={controller.spindle}
        programmed={programmed?.spindle}
        machineMax={machine.maxSpindle}
        machineMin={machine.minSpindle}
        disabled={disabled}
        units={units}
        onChange={onChange}
        {...(noSpindle === undefined ? {} : { unavailable: noSpindle })}
      />
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
          onValueChange={(v) => void onChange({ rapid: Number(v) as 100 | 50 | 25 })}
        />
      </div>
      {changed ? <p className={styles['overrideHint']}>{m.hint}</p> : null}
    </InspectorGroup>
  )
}

function OverrideRow({
  which,
  label,
  value,
  range,
  programmed,
  machineMax,
  machineMin,
  disabled,
  unavailable,
  units,
  onChange,
}: {
  which: OverrideKind
  label: string
  /** As GRBL reports it; undefined before the first `Ov`. */
  value: number | undefined
  range: { min: number; max: number }
  programmed: number | undefined
  machineMax: number | undefined
  /** The spindle's usable minimum speed (rpm): the floor of the spindle override. */
  machineMin?: number | undefined
  disabled: boolean
  /** Why this override does not exist on the machine. */
  unavailable?: string
  units: UnitSystem
  onChange: (change: OverrideChange) => Promise<void> | void
}): React.JSX.Element {
  const reasonId = useId()
  const cap = overrideCap(range, programmed, machineMax, machineMin)
  // the target being dragged or sent; the reported value shows once nothing is pending
  const [draft, setDraft] = useState<number | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // `last`: the target sent last (a key press commits before its change event re-arms the
  // debounce, which then must not send the same target again)
  const flight = useRef<{ busy: boolean; next: number | undefined; last: number | undefined }>({
    busy: false,
    next: undefined,
    last: undefined,
  })
  useEffect(() => () => clearTimeout(timer.current), [])
  const off = disabled || unavailable !== undefined

  /** One target in flight at a time; the latest one waiting goes next. */
  const send = async (target: OverrideChange[OverrideKind]): Promise<void> => {
    const f = flight.current
    if (f.busy) {
      if (typeof target === 'number') f.next = target
      return
    }
    f.busy = true
    f.last = typeof target === 'number' ? target : undefined
    try {
      await onChange({ [which]: target })
      while (f.next !== undefined) {
        const next = f.next
        f.next = undefined
        if (next === f.last) continue
        f.last = next
        await onChange({ [which]: next })
      }
    } finally {
      f.busy = false
      setDraft(undefined)
    }
  }
  const sendNow = (target: number) => {
    clearTimeout(timer.current)
    setDraft(target)
    void send(target)
  }

  const shown = draft ?? value
  const pct = shown ?? 100
  const effective =
    programmed === undefined
      ? undefined
      : which === 'feed'
        ? programmed > 0
          ? m.effectiveFeed(
              formatFeed((programmed * pct) / 100, units),
              runMessages.dro.feedUnits[units],
            )
          : undefined
        : programmed > 0
          ? m.effectiveSpindle((programmed * pct) / 100)
          : m.spindleOff
  const capReason =
    cap.by === 'machine' && machineMax !== undefined
      ? which === 'feed'
        ? m.capFeed(cap.max, formatFeed(machineMax, units), runMessages.dro.feedUnits[units])
        : m.capSpindle(cap.max, machineMax)
      : undefined
  const floorReason =
    cap.floorBy === 'machine' && machineMin !== undefined
      ? m.floorSpindle(cap.min, machineMin)
      : undefined
  const reasons = [floorReason, capReason].filter((x) => x !== undefined)
  const reason = unavailable ?? (reasons.length === 0 ? undefined : reasons.join(' '))
  // ±10 %: GRBL's own coarse step unless the machine cap or floor ends the range first (a value
  // below the floor, e.g. set before the run, goes up to the floor at once)
  const step = (dir: 1 | -1) => {
    // a step ends a pending drag: its debounced target would follow and undo the step
    clearTimeout(timer.current)
    const v = value ?? 100
    if (dir > 0 && cap.by === 'machine' && v + 10 > cap.max) return sendNow(cap.max)
    if (cap.floorBy === 'machine' && v + dir * 10 < cap.min) return sendNow(cap.min)
    void send(dir > 0 ? '+10' : '-10')
  }
  return (
    <div className={styles['overrideItem']} role="group" aria-label={label}>
      <div className={styles['overrideHead']}>
        <span className={styles['overrideLabel']}>{label}</span>
        <span
          className={styles['overrideValue']}
          data-changed={shown !== undefined && shown !== 100 ? '' : undefined}
        >
          {shown === undefined ? m.unknown : m.percent(shown)}
        </span>
        <span className={styles['overrideEffective']}>{effective ?? ''}</span>
        <Button
          size="sm"
          variant="ghost"
          aria-label={m.resetLabel(label)}
          disabled={off || value === undefined || value === 100}
          onClick={() => {
            clearTimeout(timer.current)
            setDraft(100)
            void send('reset')
          }}
        >
          {m.reset}
        </Button>
      </div>
      <div className={styles['overrideControl']}>
        <Button
          size="sm"
          aria-label={m.minusLabel(label)}
          disabled={
            off ||
            (value !== undefined &&
              (cap.floorBy === 'machine' ? value <= cap.min : value - 10 < range.min))
          }
          onClick={() => step(-1)}
        >
          {m.minus}
        </Button>
        <Slider
          label={m.sliderLabel(label)}
          min={range.min}
          max={range.max}
          value={pct}
          limit={cap.max}
          floor={cap.min}
          marks={[100]}
          disabled={off}
          valueText={(v) => m.valueText(v, effective)}
          aria-describedby={reason === undefined ? undefined : reasonId}
          onValueChange={(v) => {
            setDraft(v)
            clearTimeout(timer.current)
            timer.current = setTimeout(() => {
              if (v !== flight.current.last || flight.current.busy) void send(v)
            }, OVERRIDE_DEBOUNCE_MS)
          }}
          onValueCommit={sendNow}
        />
        <Button
          size="sm"
          aria-label={m.plusLabel(label)}
          disabled={off || (value !== undefined && value >= cap.max)}
          onClick={() => step(1)}
        >
          {m.plus}
        </Button>
      </div>
      {reason === undefined ? null : (
        <p id={reasonId} className={styles['overrideReason']}>
          {reason}
        </p>
      )}
    </div>
  )
}
