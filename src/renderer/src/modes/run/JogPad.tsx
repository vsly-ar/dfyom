// JogPad (DF88): the step picker, the jog feed slider, the X/Y cross and Z column (44 px run
// controls) and "Stop jog". A press shorter than the hold delay jogs one step; a press held past
// it jogs continuously to the travel edge until released (jog cancel, `0x85`); a click never
// starts a continuous jog (`jog-press.ts`). Every other end of a press (pointer cancel, blur, the
// window losing focus or hiding, the pad turning disabled, unmounting) drops it or cancels the
// continuous jog. The same pad in the navigator and the tool-change and setup-change dialogs,
// all fed by `useJogControls`. DF133 RW3: every jog goes through the workholding guard (the run
// store); the pad's reserved notice line says where a jog stopped and offers "Jog past once".
// Doc: docs/conventions/ui.md#jog-position-and-probing-df88, docs/modes/run-machine.md#machine-readiness-m3,
// docs/modes/run-workholding.md#jogs
import { useEffect, useId, useRef, useState } from 'react'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import { runMessages } from '../../messages/run'
import { NO_MACHINE_KEY, type JogKeyStyle } from '../../../../shared/settings'
import { useSettings } from '../../shell/ShellContext'
import { Button, Slider, Tooltip } from '../../ui'
import { useLibraryItems } from '../plan/usePlan'
import { jogKeyHint, keyLayout } from './jog-keys'
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
import { guardActive, guardNoticeText } from './run-guard'
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
  /**
   * DF140: the jog hotkey style (the app setting): the buttons' key badges and tooltips, and the
   * 2-row key layout for the videogame and arrow-key styles. Absent: no keys shown.
   */
  readonly keys?: JogKeyStyle
  /**
   * DF133 RW3: the workholding guard while it is on (the notice line is reserved then): its
   * notice and "Jog past once" (offered after a stop). Absent: no guard, no line.
   */
  guard?: { readonly notice: string | undefined; readonly pastOnce: (() => void) | undefined }
}

/** The jog limits and key of the chosen plan's machine, or the manual-control machine. */
export function useMachineJog(doc: ProjectDoc | undefined): MachineJog {
  const planId = useRun((s) => s.planId)
  const machineId = useRun((s) => s.machineId)
  const machines = useLibraryItems('machine')
  const plan = planId === undefined || planId === NO_PLAN ? undefined : doc?.plans[planId]
  return machineJog(plan, machines, machineId)
}

/**
 * The window's jog step and feed and its jog actions. Both are remembered in the app settings per
 * library machine (`jogFeed`, `jogStep`), under `*` while no machine is known (hardening DF140,
 * docs/conventions/ui.md#jog-pad-df140), so they come back after a restart.
 */
export function useJogControls(doc: ProjectDoc | undefined): JogControls {
  const store = useRunStore()
  const units = useRunUnits(doc)
  const windowStep = useRun((s) => s.jogStep)
  const windowCustom = useRun((s) => s.jogCustom)
  const windowFeed = useRun((s) => s.jogFeed)
  const feeds = useSettings((s) => s.settings.jogFeed)
  const steps = useSettings((s) => s.settings.jogStep)
  const update = useSettings((s) => s.update)
  const keys = useSettings((s) => s.settings.jogKeys)
  const machine = useMachineJog(doc)
  const key = machine.key ?? NO_MACHINE_KEY
  const feedRange = jogFeedRange(units, machine.maxFeed)
  const stored = feeds[key] ?? windowFeed
  const feed = clampJogFeed(stored ?? JOG_FEED_DEFAULT, feedRange)
  const storedStep = steps[key]
  const step = storedStep?.step ?? windowStep
  const custom = storedStep === undefined ? windowCustom : storedStep.custom
  const feedOf = (axis: Axis) =>
    axis === 'z' && machine.maxZ !== undefined ? Math.min(feed, machine.maxZ) : feed
  const a = store.getState()
  const stepMm = jogStepMm(step, units)
  const notice = useRun((s) => s.guardNotice)
  const on = useRun((s) => guardActive(s.status, s.guardSetup, s.guardOff))
  const stopped = notice?.kind === 'stopped' || notice?.kind === 'blocked'
  return {
    units,
    keys,
    step: stepMm,
    custom,
    feed,
    feedRange,
    setStep: (mm) => {
      a.setJogStep(mm)
      update({ jogStep: { [key]: { step: mm, ...(custom === undefined ? {} : { custom }) } } })
    },
    setCustom: (mm) => {
      a.setJogCustom(mm)
      update({ jogStep: { [key]: { step: mm, custom: mm } } })
    },
    setFeed: (f) => {
      a.setJogFeed(f)
      update({ jogFeed: { [key]: f } })
    },
    jog: (axis, sign) => void a.jog(axis, sign * stepMm, feedOf(axis)),
    holdStart: (axis, sign) => void a.jogHoldStart(axis, sign, feedOf(axis)),
    holdEnd: a.jogHoldEnd,
    cancel: () => void a.jogCancel(),
    ...(on || notice?.kind === 'pastOnce'
      ? {
          guard: {
            notice: notice === undefined ? undefined : guardNoticeText(notice, units),
            pastOnce: stopped ? a.jogPastOnce : undefined,
          },
        }
      : {}),
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
    const name = m.jogButton(axis.toUpperCase(), dir)
    // DF140: the hotkey in the tooltip (every style), a key cap for a single key
    const key = jogKeyHint(controls.keys ?? 'off', axis, sign)
    const jogButton = (
      <Button
        size="lg"
        className={styles[area]}
        aria-label={name}
        aria-describedby={describedBy}
        {...(key === undefined ? {} : { 'aria-keyshortcuts': key.aria })}
        data-jog-dir={id}
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
        {key?.badge === undefined ? null : (
          <span className={styles['jogKey']} aria-hidden="true" data-jog-key="">
            {key.badge}
          </span>
        )}
      </Button>
    )
    return (
      <Tooltip key={id} content={name} {...(key === undefined ? {} : { shortcut: key.text })}>
        {jogButton}
      </Tooltip>
    )
  }

  const feed = dragFeed ?? controls.feed
  const feedText = `${formatFeed(feed, units)} ${runMessages.dro.feedUnits[units]}`
  return (
    // DF140: a pointer press leaves no focus on a pad button (direction, step, Stop jog, Jog past
    // once), so the next jog key (Space: Z+) jogs instead of pressing that button again; a button
    // reached with Tab keeps its focus, and Enter/Space press it (docs/conventions/ui.md#jog-pad-df140)
    <div className={styles['jog']} data-jog-pad="" onClick={dropPointerFocus}>
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
      <div
        className={styles['jogPad']}
        data-z-only={zOnly ? '' : undefined}
        data-layout={keyLayout(controls.keys) ? 'keys' : undefined}
      >
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
      {controls.guard === undefined ? null : (
        <GuardNoticeLine notice={controls.guard.notice} onPastOnce={controls.guard.pastOnce} />
      )}
      {disabledReason !== null && reasonShown ? (
        <p id={reasonId} className={styles['why']}>
          {disabledReason}
        </p>
      ) : null}
    </div>
  )
}

/**
 * DF140: after a pointer click (`detail` > 0) on a button inside the jog pad, the button gives up
 * the focus; a keyboard click (`detail` 0: Enter, Space, a screen reader) keeps it.
 */
export function dropPointerFocus(e: React.MouseEvent): void {
  if (e.detail === 0 || !(e.target instanceof Element)) return
  const button = e.target.closest('button')
  if (button !== null && e.currentTarget.contains(button)) button.blur()
}

/**
 * DF133 RW3: the guard's notice line under the pad (reserved height while the guard is on, DF34:
 * nothing moves): "Stopped 2 mm from Toe clamp 2 (collet nut)." and "Jog past once" (Q186: a
 * deliberate click, no hotkey).
 */
export function GuardNoticeLine({
  notice,
  onPastOnce,
}: {
  notice: string | undefined
  onPastOnce: (() => void) | undefined
}): React.JSX.Element {
  const g = runMessages.guard
  const hintId = useId()
  return (
    <div className={styles['guardNotice']} data-guard-notice="">
      <p role="status" className={styles['guardNoticeText']}>
        {notice ?? ''}
      </p>
      {onPastOnce === undefined ? null : (
        <>
          <Button size="sm" onClick={onPastOnce} aria-describedby={hintId}>
            {g.pastOnce}
          </Button>
          <span id={hintId} hidden>
            {g.pastOnceHint}
          </span>
        </>
      )}
    </div>
  )
}
