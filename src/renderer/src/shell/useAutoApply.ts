// Auto-apply (DF28): the window applies its pending changes by itself after the "Auto-apply after"
// setting's seconds without a new edit. Every change of the pending answer (an edit by anyone,
// an undo) restarts the wait; nothing is due while nothing is pending, an Apply is on its way or
// running, the last Apply failed (no retry loop: the button says so), or the setting is Off. A
// modal dialog open when it is due postpones it by another full wait (its form is not committed
// yet). Doc: docs/architecture/apply.md#auto-apply-df28
import { useEffect, useState } from 'react'
import type { PendingState } from '../state/pending'

/** When the pending changes apply by themselves, for the button's countdown. */
export interface AutoApplyDue {
  /** `Date.now()` time it is due. */
  readonly at: number
  /** The whole wait, ms. */
  readonly durationMs: number
}

const modalOpen = (): boolean =>
  typeof document !== 'undefined' && document.querySelector('[data-modal-dialog]') !== null

/** Whether the state can wait for an auto-apply. */
export function autoApplyArmed(p: PendingState, delaySeconds: number): boolean {
  return (
    delaySeconds > 0 &&
    p.known &&
    p.count > 0 &&
    !p.sending &&
    p.applying.length === 0 &&
    p.error === null
  )
}

export function useAutoApply(
  state: PendingState,
  delaySeconds: number,
  apply: () => void,
): AutoApplyDue | null {
  const armed = autoApplyArmed(state, delaySeconds)
  const durationMs = delaySeconds * 1000
  const [due, setDue] = useState<AutoApplyDue | null>(null)
  // restart on every change of the pending answer (`version`) while armed
  useEffect(() => {
    if (!armed) {
      setDue(null)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const wait = (): void => {
      setDue({ at: Date.now() + durationMs, durationMs })
      timer = setTimeout(() => {
        if (modalOpen()) wait()
        else {
          setDue(null)
          apply()
        }
      }, durationMs)
    }
    wait()
    return () => clearTimeout(timer)
  }, [armed, durationMs, state.version, apply])
  return armed ? due : null
}
