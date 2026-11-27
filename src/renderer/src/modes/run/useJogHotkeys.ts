// Jog hotkeys in Run mode (DF88): the chosen style's keys jog like the pad's buttons – a press
// shorter than the hold delay jogs one step, a key held past it jogs continuously until its
// keyup (jog cancel) – and Escape stops a jog. Active only while connected, without a run job,
// with the jog gate open and the Go to dialog closed (DF128); never while typing or in a dialog
// without a jog pad (`jog-keys.ts`).
// Listens on the window in the capture phase, so a focused control cannot swallow a key.
// Doc: docs/conventions/ui.md#jog-hotkeys
import { useEffect, useRef, useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import { useSettings } from '../../shell/ShellContext'
import { endsPress, jogKeyOf, jogTargetAllowed } from './jog-keys'
import { createJogPress, type JogPressHandlers } from './jog-press'
import { useJogControls, type JogControls } from './JogPad'
import { activeJob, isConnected, runGates } from './machine-state'
import type { JogKeyStyle } from '../../../../shared/settings'
import type { RunStatus } from '../../../../core/run/service'
import { useRun } from './run-store'

/** Whether jog hotkeys may jog now: connected, no run job, the jog gate open. */
export function jogHotkeysActive(status: RunStatus, style: JogKeyStyle): boolean {
  return (
    style !== 'off' &&
    isConnected(status) &&
    activeJob(status) === undefined &&
    runGates(status, { planChosen: false }).jog === null
  )
}

/**
 * The hotkeys over `controls`. `stop` runs on Escape while jogging (no run job); `jogging` says
 * whether the machine jogs now.
 */
export function useJogHotkeyListener(opts: {
  style: JogKeyStyle
  active: boolean
  /** Connected without a run job: Escape may stop a jog. */
  canStop: boolean
  jogging: boolean
  controls: JogControls
}): void {
  const latest = useRef(opts)
  useEffect(() => {
    latest.current = opts
  })
  const [press] = useState(() =>
    createJogPress((): JogPressHandlers => ({
      step: (axis, sign) => latest.current.controls.jog(axis, sign),
      holdStart: (axis, sign) => latest.current.controls.holdStart(axis, sign),
      holdEnd: () => latest.current.controls.holdEnd(),
    })),
  )
  const { active, canStop } = opts

  useEffect(() => {
    if (!canStop) {
      press.abort()
      return
    }
    const onDown = (e: KeyboardEvent) => {
      const o = latest.current
      if (e.key === 'Escape') {
        // not prevented: Escape still closes the top overlay
        press.abort()
        if (o.jogging) o.controls.cancel()
        return
      }
      const pressed = press.active()
      if (pressed !== undefined && e.code === pressed.id) {
        // auto-repeat of the held key: nothing new, and no button press or page scroll
        e.preventDefault()
        return
      }
      if (!o.active || e.repeat) return
      const key = jogKeyOf(e, o.style)
      if (key === undefined || !jogTargetAllowed(e.target, key.code)) return
      e.preventDefault()
      press.press(key.code, key.axis, key.sign)
    }
    const onUp = (e: KeyboardEvent) => {
      const pressed = press.active()
      if (pressed === undefined || !endsPress(e.code, pressed.id, latest.current.style)) return
      // a Space keyup on a focused button would press it
      if (e.code === pressed.id) e.preventDefault()
      press.release(pressed.id)
    }
    const abort = () => press.abort()
    const onHidden = () => {
      if (document.visibilityState === 'hidden') press.abort()
    }
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('blur', abort)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', abort)
      document.removeEventListener('visibilitychange', onHidden)
      press.abort()
    }
  }, [canStop, press])

  // a run starting, an alarm or a disconnect ends a press at once
  useEffect(() => {
    if (!active) press.abort()
  }, [active, press])
}

/** Run mode's jog hotkeys, with the window's jog step and feed (mounted while in Run mode). */
export function JogHotkeys({ doc }: { doc: ProjectDoc | undefined }): null {
  const style = useSettings((s) => s.settings.jogKeys)
  const status = useRun((s) => s.status)
  const controls = useJogControls(doc)
  // DF128: off while the Go to dialog is open, wherever the focus is (run-goto.md#keyboard);
  // Escape still stops a jog
  const goToOpen = useRun((s) => s.goTo !== undefined)
  useJogHotkeyListener({
    style,
    active: !goToOpen && jogHotkeysActive(status, style),
    canStop: isConnected(status) && activeJob(status) === undefined,
    jogging: status.state.startsWith('Jog'),
    controls,
  })
  return null
}
