// StopControl: the one filled control (decision 19): --safety-stop, label "Stop", 44 px, never
// confirmed. Disabled only when there is nothing to stop (DF35): then `aria-disabled` (it stays
// focusable so the reason is read) at offline emphasis, with the reason as its tooltip and
// description. It sits above every overlay (--z-safety) and keeps pointer events while a modal
// dialog is open, so no dialog ever hides it from the mouse.
// Doc: docs/conventions/ui.md#run-mode-safety-ui; look: ui-design-system.html (.btn.stop)
import { useId, type Ref } from 'react'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './StopControl.module.css'

export interface StopControlProps {
  onStop: () => void
  /** Visible label and accessible name. */
  label?: string
  /** Why there is nothing to stop; set = disabled (clicks do nothing). */
  disabledReason?: string | null | undefined
  /** Layout only; appended to the button's class. */
  className?: string | undefined
  ref?: Ref<HTMLButtonElement>
}

export function StopControl({
  onStop,
  label = 'Stop',
  disabledReason,
  className,
  ref,
}: StopControlProps): React.JSX.Element {
  const reasonId = useId()
  const disabled = disabledReason !== undefined && disabledReason !== null
  const button = (
    <button
      ref={ref}
      type="button"
      className={[styles['stop'], className].filter(Boolean).join(' ')}
      aria-disabled={disabled || undefined}
      aria-describedby={disabled ? reasonId : undefined}
      onClick={() => {
        if (!disabled) onStop()
      }}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" />
      </svg>
      {label}
    </button>
  )
  if (!disabled) return button
  return (
    <>
      <Tooltip content={disabledReason}>{button}</Tooltip>
      {/* the description (hidden elements still describe) */}
      <span id={reasonId} hidden>
        {disabledReason}
      </span>
    </>
  )
}
