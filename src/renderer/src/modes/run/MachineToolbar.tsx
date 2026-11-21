// The machine group of the main toolbar, in every mode while a connection is open: the machine
// state badge, the "Virtual machine · 10×" chip, Feed hold while streaming, Resume while held, and
// the Stop control (never confirmed, above every overlay). `Escape` holds the feed whenever a job
// streams, wherever the focus is. Also mounts the run dialogs, so waits and failures show in any
// mode. Doc: docs/conventions/ui.md#run-mode-safety-ui
import { Pause, Play } from 'lucide-react'
import { useEffect } from 'react'
import { runMessages } from '../../messages/run'
import { Button, MachineStateBadge, StopControl, Tooltip } from '../../ui'
import { activeJob, machineView } from './machine-state'
import { useRun, useRunStore } from './run-store'
import { RunDialogs } from './RunDialogs'
import styles from './Run.module.css'

const m = runMessages.controls

export function MachineToolbar(): React.JSX.Element {
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const job = activeJob(status)
  const streaming = job?.phase === 'streaming'
  const held = job?.phase === 'held'

  // Escape = feed hold while streaming (decision 11); it also closes the top overlay, so no
  // preventDefault. Capture phase: a focused control cannot swallow it.
  useEffect(() => {
    if (!streaming) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void store.getState().hold()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [streaming, store])

  const view = machineView(status)
  const open = status.connection.state !== 'closed'
  return (
    <>
      {open ? (
        <div className={styles['machine']} role="group" aria-label={runMessages.machineRegion}>
          <span aria-live="polite" className={styles['machineState']}>
            <MachineStateBadge state={view.state} label={view.label} />
          </span>
          {status.connection.target === 'virtual' ? (
            <span className={styles['virtualChip']}>
              {runMessages.virtualChip(runMessages.timeScale(status.connection.timeScale))}
            </span>
          ) : null}
          {streaming ? (
            <Tooltip content={m.feedHold} shortcut={m.feedHoldShortcut}>
              <Button
                size="lg"
                icon={<Pause aria-hidden="true" />}
                aria-keyshortcuts="Escape"
                onClick={() => void store.getState().hold()}
              >
                {m.feedHold}
              </Button>
            </Tooltip>
          ) : null}
          {held ? (
            <Button
              size="lg"
              variant="primary"
              icon={<Play aria-hidden="true" />}
              onClick={() => void store.getState().resume()}
            >
              {m.resume}
            </Button>
          ) : null}
          <StopControl label={m.stop} onStop={() => void store.getState().stop()} />
        </div>
      ) : null}
      <RunDialogs />
    </>
  )
}
