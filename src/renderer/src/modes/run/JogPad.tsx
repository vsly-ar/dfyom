// JogPad: jogs per axis (44 px run controls) by step or continuously (hold to jog, M3), the step in
// the project's units, and "Stop jog" (jog cancel). Step jogs are relative
// (`run.machine.jog { by }`); a continuous jog runs to the travel edge while a button is held
// (`continuous: true`) and is cancelled on release, blur, the window losing focus, the pad turning
// disabled or unmounting. GRBL caps the feed at the axis' max rate. Used in the navigator and in
// the tool-change and setup-change dialogs.
// Doc: docs/conventions/ui.md#run-mode-safety-ui, docs/modes/run-v0.1.md#commands-and-queries,
// docs/modes/run-machine.md#machine-readiness-m3
import { useEffect } from 'react'
import type { UnitSystem } from '../../../../core/project/document'
import { runMessages } from '../../messages/run'
import { Button, SegmentedControl } from '../../ui'
import { JOG_STEPS, stepToMm, type JogMode } from './machine-state'
import { useRun, useRunStore, type Axis } from './run-store'
import styles from './Run.module.css'

const m = runMessages.navigator

/** Jog feeds (mm/min): XY and Z. GRBL limits them to the machine's max rates ($110–$112). */
export const JOG_FEED = { xy: 2000, z: 500 } as const

/** The window's jog mode and hold handlers from the run store, for a `JogPad`'s props. */
export function useJogMode(): Pick<JogPadProps, 'mode' | 'onMode' | 'onHoldStart' | 'onHoldEnd'> {
  const store = useRunStore()
  const mode = useRun((s) => s.jogMode)
  const a = store.getState()
  return {
    mode,
    onMode: a.setJogMode,
    onHoldStart: (axis, sign, feed) => void a.jogHoldStart(axis, sign, feed),
    onHoldEnd: a.jogHoldEnd,
  }
}

export interface JogPadProps {
  units: UnitSystem
  step: string
  onStep: (step: string) => void
  onJog: (axis: Axis, mm: number, feed: number) => void
  onCancel: () => void
  /** Step (default) or continuous; without `onMode` the pad has no mode choice. */
  mode?: JogMode
  onMode?: (mode: JogMode) => void
  /** Continuous: a button pressed (start a jog to the travel edge) and released (cancel it). */
  onHoldStart?: (axis: Axis, sign: 1 | -1, feed: number) => void
  onHoldEnd?: () => void
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
  units,
  step,
  onStep,
  onJog,
  onCancel,
  mode = 'step',
  onMode,
  onHoldStart,
  onHoldEnd,
  disabledReason,
  zOnly = false,
  reasonId,
  reasonShown = true,
}: JogPadProps): React.JSX.Element {
  const disabled = disabledReason !== null
  const continuous = mode === 'continuous' && onHoldStart !== undefined
  const steps = JOG_STEPS[units]
  const current = steps.includes(step) ? step : steps[2]!
  const feedOf = (axis: Axis) => (axis === 'z' ? JOG_FEED.z : JOG_FEED.xy)
  const jog = (axis: Axis, sign: 1 | -1) =>
    onJog(axis, sign * stepToMm(current, units), feedOf(axis))

  // The store keeps the one held jog of the window: a start while one is held and an end with
  // none held do nothing, so every way a hold can end may call `release`.
  const release = onHoldEnd
  const press = (axis: Axis, sign: 1 | -1) => onHoldStart?.(axis, sign, feedOf(axis))
  // the window losing focus or hiding, the pad turning disabled or leaving continuous mode, and
  // unmounting all end a hold
  useEffect(() => {
    if (release === undefined) return
    if (!continuous || disabled) {
      release()
      return
    }
    const onHidden = () => {
      if (document.visibilityState === 'hidden') release()
    }
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', onHidden)
      release()
    }
  }, [continuous, disabled, release])

  const button = (axis: Axis, sign: 1 | -1, area: string) => {
    const dir = sign > 0 ? '+' : '−'
    const hold = continuous
      ? {
          onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
            if (e.button !== 0) return
            e.currentTarget.setPointerCapture?.(e.pointerId)
            press(axis, sign)
          },
          onPointerUp: () => release?.(),
          onPointerCancel: () => release?.(),
          onLostPointerCapture: () => release?.(),
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key !== ' ' && e.key !== 'Enter') return
            e.preventDefault()
            if (!e.repeat) press(axis, sign)
          },
          onKeyUp: (e: React.KeyboardEvent) => {
            if (e.key === ' ' || e.key === 'Enter') release?.()
          },
          onBlur: () => release?.(),
          // a click is the end of a hold here, not a step
          onClick: (e: React.MouseEvent) => e.preventDefault(),
        }
      : { onClick: () => jog(axis, sign) }
    return (
      <Button
        key={`${axis}${sign}`}
        size="lg"
        className={styles[area]}
        aria-label={m.jogButton(axis.toUpperCase(), dir)}
        disabled={disabled}
        {...(disabled ? { 'aria-describedby': reasonId } : {})}
        {...hold}
      >
        {axis.toUpperCase()}
        {dir}
      </Button>
    )
  }
  return (
    <div className={styles['jog']}>
      {onMode === undefined ? null : (
        <SegmentedControl<JogMode>
          label={m.jogMode}
          size="sm"
          className={styles['jogSteps']}
          options={[
            { value: 'step', label: m.jogModeStep },
            { value: 'continuous', label: m.jogModeContinuous },
          ]}
          value={mode}
          onValueChange={onMode}
        />
      )}
      {continuous ? (
        <p className={styles['holdHint']}>{m.holdHint}</p>
      ) : (
        <SegmentedControl
          label={m.step}
          size="sm"
          className={styles['jogSteps']}
          options={steps.map((s) => ({
            value: s,
            label: `${s} ${units === 'inch' ? 'in' : 'mm'}`,
          }))}
          value={current}
          onValueChange={onStep}
        />
      )}
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
      {disabledReason !== null && reasonShown ? (
        <p id={reasonId} className={styles['why']}>
          {disabledReason}
        </p>
      ) : null}
    </div>
  )
}
