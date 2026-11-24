// Click or hold (DF88): one press of a jog button or jog hotkey jogs one step when released
// before the hold delay, or jogs continuously from the delay's end until it is released. A click
// never starts a continuous jog; a press that ends any other way (`abort`: blur, Escape, the pad
// disabled) sends nothing, or cancels the continuous jog it started. One press at a time.
// Doc: docs/conventions/ui.md#jog-position-and-probing-df88
import type { Axis } from './run-store'

/** How long a press must last to become a continuous jog (ms). */
export const HOLD_DELAY_MS = 300

export interface JogPressHandlers {
  /** A click: one step in `sign` direction. */
  step(axis: Axis, sign: 1 | -1): void
  /** The hold delay passed while still pressed: start the continuous jog. */
  holdStart(axis: Axis, sign: 1 | -1): void
  /** The held press ended: cancel the continuous jog (`0x85`). */
  holdEnd(): void
}

export interface JogPress {
  /**
   * A press of the control `id` (a button or key) begins; false when another press is still
   * active (it is ignored).
   */
  press(id: string, axis: Axis, sign: 1 | -1): boolean
  /** The control `id` was released: a step inside the delay, else the hold ends. */
  release(id: string): void
  /** The press ends without a step (and the hold, if any, ends). */
  abort(): void
  /** The active press, if any. */
  active(): { readonly id: string; readonly holding: boolean } | undefined
}

interface Active {
  readonly id: string
  readonly axis: Axis
  readonly sign: 1 | -1
  timer: ReturnType<typeof setTimeout> | undefined
  holding: boolean
}

/** `handlers` is read at each event, so a caller may pass a getter of its latest handlers. */
export function createJogPress(
  handlers: () => JogPressHandlers,
  delayMs: number = HOLD_DELAY_MS,
): JogPress {
  let current: Active | undefined
  const stopTimer = (a: Active) => {
    if (a.timer !== undefined) clearTimeout(a.timer)
    a.timer = undefined
  }
  return {
    press(id, axis, sign) {
      if (current !== undefined) return false
      const a: Active = { id, axis, sign, timer: undefined, holding: false }
      a.timer = setTimeout(() => {
        a.timer = undefined
        if (current !== a) return
        a.holding = true
        handlers().holdStart(axis, sign)
      }, delayMs)
      current = a
      return true
    },
    release(id) {
      const a = current
      if (a === undefined || a.id !== id) return
      current = undefined
      stopTimer(a)
      if (a.holding) handlers().holdEnd()
      else handlers().step(a.axis, a.sign)
    },
    abort() {
      const a = current
      if (a === undefined) return
      current = undefined
      stopTimer(a)
      if (a.holding) handlers().holdEnd()
    },
    active: () =>
      current === undefined ? undefined : { id: current.id, holding: current.holding },
  }
}
