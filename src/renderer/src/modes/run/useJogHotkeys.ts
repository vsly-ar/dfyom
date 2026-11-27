// Jog hotkeys in Run mode (DF88): the chosen style's keys jog like the pad's buttons – a press
// shorter than the hold delay jogs one step, a key held past it jogs continuously until its
// keyup (jog cancel) – and Escape stops a jog. Active only while connected, without a run job,
// with the jog gate open and the Go to dialog closed (DF128); never while typing or in a dialog
// without a jog pad (`jog-keys.ts`). DF128 GT2: `G` opens the Go to dialog (`useGoToHotkey`).
// Listens on the window in the capture phase, so a focused control cannot swallow a key.
// Doc: docs/conventions/ui.md#jog-hotkeys
import { useEffect, useRef, useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import { useSettings } from '../../shell/ShellContext'
import { endsPress, jogKeyOf, jogTargetAllowed } from './jog-keys'
import { createJogPress, type JogPressHandlers } from './jog-press'
import { useJogControls, type JogControls } from './JogPad'
import { isEditableTarget } from '../../shell/shortcuts'
import { activeJob, goToOpenGate, isConnected, runGates } from './machine-state'
import type { JogKeyStyle } from '../../../../shared/settings'
import type { RunStatus } from '../../../../core/run/service'
import { useRun, useRunStore } from './run-store'
import { useJogGuardSync } from './useJogGuardSync'

/**
 * DF128 GT2 (Q157): whether a `G` key press opens the Go to dialog: the plain key (no modifier,
 * no repeat), focus not in a text field, no dialog, alert or menu open, the dialog not open yet
 * and the DRO buttons' gate open (connected, homed, no run job). Pure but for the DOM query.
 */
export function goToKeyOpens(
  e: Pick<
    KeyboardEvent,
    'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'target'
  >,
  status: RunStatus,
  open: boolean,
): boolean {
  if (e.key.toLowerCase() !== 'g' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false
  if (e.repeat || open || isEditableTarget(e.target)) return false
  if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null)
    return false
  return goToOpenGate(status) === null
}

/** `G` opens the Go to dialog in the work frame with X focused (run-goto.md#keyboard). */
export function useGoToHotkey(): void {
  const store = useRunStore()
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const s = store.getState()
      if (!goToKeyOpens(e, s.status, s.goTo !== undefined)) return
      e.preventDefault()
      s.openGoTo({ frame: 'work', axis: 'x' })
    }
    window.addEventListener('keydown', onDown)
    return () => window.removeEventListener('keydown', onDown)
  }, [store])
}

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

/**
 * Run mode's jog hotkeys, with the window's jog step and feed (mounted while in Run mode); also
 * keeps the jog guard's setup current (DF133 RW3). No key bypasses the guard.
 */
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
  useGoToHotkey()
  useJogGuardSync()
  return null
}
