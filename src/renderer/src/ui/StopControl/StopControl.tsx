// StopControl: the one filled control (decision 19): --safety-stop, label "Stop", 44 px, never
// confirmed, never disabled. It sits above every overlay (--z-safety) and keeps pointer events
// while a modal dialog is open, so no dialog ever hides it from the mouse.
// Doc: docs/conventions/ui.md#run-mode-safety-ui; look: ui-design-system.html (.btn.stop)
import type { Ref } from 'react'
import styles from './StopControl.module.css'

export interface StopControlProps {
  onStop: () => void
  /** Visible label and accessible name. */
  label?: string
  /** Layout only; appended to the button's class. */
  className?: string | undefined
  ref?: Ref<HTMLButtonElement>
}

export function StopControl({
  onStop,
  label = 'Stop',
  className,
  ref,
}: StopControlProps): React.JSX.Element {
  return (
    <button
      ref={ref}
      type="button"
      className={[styles['stop'], className].filter(Boolean).join(' ')}
      onClick={onStop}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" />
      </svg>
      {label}
    </button>
  )
}
