// MachineStateBadge: every machine state has a label and a shape, so none depends on hue alone.
// Running is amber with a dot circling the edge; tool change is blue with a turning swap icon and a
// light band sweeping across; under reduced motion both are static. Needs homing (GRBL's start-up
// lock) is neutral with a house in the hold colour, not the red alarm (DF46). Safety tokens only.
// Doc: docs/conventions/ui.md#run-mode-safety-ui (decision 20); the live state wiring is task 3.12.
import type { ReactNode } from 'react'
import { useReducedMotion } from '../motion'
import styles from './MachineStateBadge.module.css'

/** `needsHoming`: GRBL's start-up lock (Alarm, no alarm code, not homed; DF46), not an error. */
export type MachineState =
  'offline' | 'idle' | 'moving' | 'hold' | 'action' | 'needsHoming' | 'alarm'

const DEFAULT_LABEL: Record<MachineState, string> = {
  offline: 'Not connected',
  idle: 'Idle',
  moving: 'Running',
  hold: 'Feed hold',
  action: 'Tool change',
  needsHoming: 'Needs homing',
  alarm: 'Alarm',
}

const SHAPES: Record<MachineState, ReactNode> = {
  offline: <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />,
  idle: <circle cx="6" cy="6" r="4.5" fill="currentColor" />,
  moving: <path d="M3.5 2l6.5 4-6.5 4z" fill="currentColor" />,
  hold: (
    <>
      <rect x="2.5" y="2" width="2.5" height="8" rx=".5" fill="currentColor" />
      <rect x="7" y="2" width="2.5" height="8" rx=".5" fill="currentColor" />
    </>
  ),
  action: (
    <>
      <path
        d="M2.2 5A4 4 0 0 1 9.4 3.4M9.8 7A4 4 0 0 1 2.6 8.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M9.9 1.6v2.2H7.7M2.1 10.4V8.2h2.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  needsHoming: (
    <path
      d="M1.5 6.2 6 2l4.5 4.2M3 5v5h6V5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  alarm: (
    <>
      <path d="M4 1h4l3 3v4l-3 3H4L1 8V4z" fill="currentColor" />
      <path
        d="M6 3.5v3M6 8.2v.3"
        stroke="var(--safety-alarm)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </>
  ),
}

export interface MachineStateBadgeProps {
  state: MachineState
  /** Replaces the default label, e.g. "Jogging", "Paused (M0)", "Alarm 2: soft limit". */
  label?: string
  /** Layout only; appended to the wrapper's class. */
  className?: string | undefined
}

export function MachineStateBadge({
  state,
  label,
  className,
}: MachineStateBadgeProps): React.JSX.Element {
  const reduced = useReducedMotion()
  return (
    <span
      data-state={state}
      data-motion={reduced ? 'reduce' : 'full'}
      className={[styles['badge'], className].filter(Boolean).join(' ')}
    >
      <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false" className={styles['shape']}>
        {SHAPES[state]}
      </svg>
      {label ?? DEFAULT_LABEL[state]}
      {state === 'moving' ? (
        <svg className={styles['orbit']} aria-hidden="true" focusable="false" data-part="orbit">
          <rect className={styles['track']} pathLength={1} />
          {reduced ? null : <rect className={styles['dot']} pathLength={1} data-part="orbit-dot" />}
        </svg>
      ) : null}
    </span>
  )
}
