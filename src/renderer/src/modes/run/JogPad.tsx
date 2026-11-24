// JogPad (DF88): the step picker, the jog feed slider, the X/Y cross and Z column (44 px run
// controls) and "Stop jog". A press shorter than the hold delay jogs one step; a press held past
// it jogs continuously to the travel edge until released (jog cancel, `0x85`); a click never
// starts a continuous jog (`jog-press.ts`). Every other end of a press (pointer cancel, blur, the
// window losing focus or hiding, the pad turning disabled, unmounting) drops it or cancels the
// continuous jog. The same pad in the navigator and the tool-change and setup-change dialogs,
// all fed by `useJogControls`.
// Doc: docs/conventions/ui.md#jog-position-and-probing-df88, docs/modes/run-machine.md#machine-readiness-m3
import { useEffect, useId, useRef, useState } from 'react'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import { runMessages } from '../../messages/run'
import { useSettings } from '../../shell/ShellContext'
import { Button, Slider } from '../../ui'
import { useLibraryItems } from '../plan/usePlan'
import { createJogPress, type JogPressHandlers } from './jog-press'
import { JogStepPicker } from './JogStepPicker'
import {
  clampJogFeed,
  formatFeed,
  jogFeedRange,
  jogStepMm,
  JOG_FEED_DEFAULT,
  type JogFeedRange,
} from './machine-state'
import { machineJog, type MachineJog } from './plan-info'
import { NO_PLAN, useRun, useRunStore, useRunUnits, type Axis } from './run-store'
import styles from './Run.module.css'

const m = runMessages.navigator

/** Feeds (mm/min) of the touch-off moves (DF69): XY and Z. GRBL caps them at $110–$112. */
export const JOG_FEED = { xy: 2000, z: 500 } as const

/** What a jog pad and the jog hotkeys work with: the window's step and feed, and the jogs. */
export interface JogControls {
  readonly units: UnitSystem
  /** The step (mm). */
  readonly step: number
  /** The step picker's custom value (mm). */
  readonly custom: number | undefined
  /** The jog feed (mm/min) for X and Y. */
  readonly feed: number
  readonly feedRange: JogFeedRange
  setStep(stepMm: number): void
  setCustom(stepMm: number): void
  setFeed(feed: number): void
  /** One step jog. */
  jog(axis: Axis, sign: 1 | -1): void
  /** A continuous jog to the travel edge; `holdEnd` cancels it. */
  holdStart(axis: Axis, sign: 1 | -1): void
  holdEnd(): void
  /** "Stop jog": jog cancel. */
  cancel(): void
}

/** The jog limits and key of the chosen plan's machine, or the manual-control machine. */
export function useMachineJog(doc: ProjectDoc | undefined): MachineJog {
  const planId = useRun((s) => s.planId)
  const machineId = useRun((s) => s.machineId)
  const machines = useLibraryItems('machine')
  const plan = planId === undefined || planId === NO_PLAN ? undefined : doc?.plans[planId]
  return machineJog(plan, machines, machineId)
}

/** The window's jog step and feed (the feed remembered per machine) and its jog actions. */
export function useJogControls(doc: ProjectDoc | undefined): JogControls {
  const store = useRunStore()
  const units = useRunUnits(doc)
  const step = useRun((s) => s.jogStep)
  const custom = useRun((s) => s.jogCustom)
  const windowFeed = useRun((s) => s.jogFeed)
  const feeds = useSettings((s) => s.settings.jogFeed)
  const update = useSettings((s) => s.update)
  const machine = useMachineJog(doc)
  const feedRange = jogFeedRange(units, machine.maxFeed)
  const stored = (machine.key === undefined ? undefined : feeds[machine.key]) ?? windowFeed
  const feed = clampJogFeed(stored ?? JOG_FEED_DEFAULT, feedRange)
  const feedOf = (axis: Axis) =>
    axis === 'z' && machine.maxZ !== undefined ? Math.min(feed, machine.maxZ) : feed
  const a = store.getState()
  const stepMm = jogStepMm(step, units)
  return {
    units,
    step: stepMm,
    custom,
    feed,
    feedRange,
    setStep: a.setJogStep,
    setCustom: a.setJogCustom,
    setFeed: (f) => {
      a.setJogFeed(f)
      if (machine.key !== undefined) update({ jogFeed: { [machine.key]: f } })
    },
    jog: (axis, sign) => void a.jog(axis, sign * stepMm, feedOf(axis)),
    holdStart: (axis, sign) => void a.jogHoldStart(axis, sign, feedOf(axis)),
    holdEnd: a.jogHoldEnd,
    cancel: () => void a.jogCancel(),
  }
}

export interface JogPadProps {
  controls: JogControls
  /** Why jogging is not possible now (shown under the pad unless `reasonShown` is false), or null. */
  disabledReason: string | null
  /** Only the Z buttons (tool change: raise and lower). */
  zOnly?: boolean
  /** id of the reason text, for `aria-describedby`. */
  reasonId: string
  /** false: the reason is shown elsewhere (the navigator's notice) under `reasonId`. */
  reasonShown?: boolean
}

export function JogPad({
  controls,
  disabledReason,
  zOnly = false,
  reasonId,
  reasonShown = true,
}: JogPadProps): React.JSX.Element {
  const disabled = disabledReason !== null
  const { units } = controls
  const hintId = useId()
  const [holding, setHolding] = useState<string | undefined>(undefined)
  // the slider's value while dragging; committed at the end of a drag or key press
  const [dragFeed, setDragFeed] = useState<number | undefined>(undefined)
  const latest = useRef(controls)
  useEffect(() => {
    latest.current = controls
  })
  const [press] = useState(() => {
    const handlers = (): JogPressHandlers => ({
      step: (axis, sign) => latest.current.jog(axis, sign),
      holdStart: (axis, sign) => {
        setHolding(p.active()?.id)
        latest.current.holdStart(axis, sign)
      },
      holdEnd: () => {
        setHolding(undefined)
        latest.current.holdEnd()
      },
    })
    const p = createJogPress(handlers)
    return p
  })

  // the window losing focus or hiding, the pad turning disabled, and unmounting end a press
  useEffect(() => {
    if (disabled) {
      press.abort()
      return
    }
    const abort = () => press.abort()
    const onHidden = () => {
      if (document.visibilityState === 'hidden') press.abort()
    }
    window.addEventListener('blur', abort)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('blur', abort)
      document.removeEventListener('visibilitychange', onHidden)
      press.abort()
    }
  }, [disabled, press])

  const button = (axis: Axis, sign: 1 | -1, area: string) => {
    const dir = sign > 0 ? '+' : '−'
    const id = `${axis}${dir}`
    const mine = () => press.active()?.id === id
    const describedBy = disabled ? `${hintId} ${reasonId}` : hintId
    return (
      <Button
        key={id}
        size="lg"
        className={styles[area]}
        aria-label={m.jogButton(axis.toUpperCase(), dir)}
        aria-describedby={describedBy}
        disabled={disabled}
        data-holding={holding === id ? '' : undefined}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture?.(e.pointerId)
          press.press(id, axis, sign)
        }}
        onPointerUp={() => press.release(id)}
        onPointerCancel={() => {
          if (mine()) press.abort()
        }}
        onLostPointerCapture={() => {
          if (mine()) press.abort()
        }}
        onKeyDown={(e) => {
          if (e.key !== ' ' && e.key !== 'Enter') return
          e.preventDefault()
          if (!e.repeat) press.press(id, axis, sign)
        }}
        onKeyUp={(e) => {
          if (e.key !== ' ' && e.key !== 'Enter') return
          e.preventDefault()
          press.release(id)
        }}
        onBlur={() => {
          if (mine()) press.abort()
        }}
        // a click without a press (a screen reader's activation) is one step
        onClick={(e) => {
          if (e.detail === 0 && press.active() === undefined) controls.jog(axis, sign)
        }}
      >
        <span className={styles['jogAxis']}>{axis.toUpperCase()}</span>
        <span className={styles['jogDir']}>{dir}</span>
      </Button>
    )
  }

  const feed = dragFeed ?? controls.feed
  const feedText = `${formatFeed(feed, units)} ${runMessages.dro.feedUnits[units]}`
  return (
    <div className={styles['jog']} data-jog-pad="">
      <JogStepPicker
        units={units}
        step={controls.step}
        custom={controls.custom}
        onStep={controls.setStep}
        onCustom={controls.setCustom}
      />
      <div className={styles['jogFeed']}>
        <div className={styles['jogFeedHead']}>
          <span aria-hidden="true">{m.jogFeed}</span>
          <span className={styles['jogFeedValue']} aria-hidden="true">
            {feedText}
          </span>
        </div>
        <Slider
          label={m.jogFeed}
          min={controls.feedRange.min}
          max={controls.feedRange.max}
          step={controls.feedRange.step}
          value={feed}
          valueText={() => feedText}
          onValueChange={setDragFeed}
          onValueCommit={(v) => {
            setDragFeed(undefined)
            controls.setFeed(v)
          }}
        />
      </div>
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
      <div className={styles['jogFoot']}>
        {/* the default look: bordered when enabled, dimmed when disabled (DF46) */}
        <Button size="sm" disabled={disabled} onClick={controls.cancel}>
          {m.cancelJog}
        </Button>
        <p id={hintId} className={styles['jogHint']}>
          {m.jogHint}
        </p>
      </div>
      {disabledReason !== null && reasonShown ? (
        <p id={reasonId} className={styles['why']}>
          {disabledReason}
        </p>
      ) : null}
    </div>
  )
}
