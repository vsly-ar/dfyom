// The run Stop: the one StopControl wired to the run store's stop (job.abort with a run job; jog
// cancel or homing reset without one). The machine toolbar and every run dialog render this, so
// keyboard and screen-reader users reach Stop without closing a modal first; the stop logic lives
// only in run-store.ts. Doc: docs/conventions/ui.md#run-mode-safety-ui
import type { ReactNode } from 'react'
import { runMessages } from '../../messages/run'
import { StopControl } from '../../ui'
import { useRunStore } from './run-store'
import styles from './Run.module.css'

export function RunStop(): React.JSX.Element {
  const store = useRunStore()
  return (
    <StopControl label={runMessages.controls.stop} onStop={() => void store.getState().stop()} />
  )
}

/**
 * Footer of a run dialog: Stop first (start edge, first in the footer's tab order), the dialog's
 * own actions at the end edge. Stop is never the initial focus; each dialog focuses a safe choice.
 */
export function RunDialogFooter({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className={styles['dialogFooter']}>
      <RunStop />
      <span className={styles['dialogActions']}>{children}</span>
    </div>
  )
}
