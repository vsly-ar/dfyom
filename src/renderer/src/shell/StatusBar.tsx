// Status bar: save state, jobs, unit system, agent connection. Evaluation status and the warning
// count join with the design UI (3.6). Doc: docs/conventions/ui.md#app-shell
import { shellMessages } from '../messages/shell'
import { isDirty } from '../state/replica'
import { JobIndicator } from '../ui'
import { AgentIndicator } from './AgentIndicator'
import styles from './AppShell.module.css'
import { useAgentSessions, useJobs } from './hooks'
import { useReplica, useUi } from './ShellContext'

const m = shellMessages.status

export function StatusBar(): React.JSX.Element {
  const replica = useReplica()
  const jobs = useJobs()
  const sessions = useAgentSessions()
  const openSettings = useUi((s) => s.setSettingsOpen)
  const open = replica.status === 'open' ? replica : undefined
  const save =
    open === undefined
      ? m.noProject
      : open.file === null
        ? m.untitled
        : isDirty(open)
          ? m.unsaved
          : m.saved
  return (
    <>
      <span className={styles['statusItem']} data-tone={open && isDirty(open) ? 'dirty' : 'clean'}>
        {save}
      </span>
      <JobIndicator
        jobs={jobs.jobs}
        onPause={jobs.pause}
        onResume={jobs.resume}
        onCancel={jobs.cancel}
      />
      <span className={styles['statusSpacer']} />
      {open ? (
        <span className={styles['statusItem']}>
          <span className={styles['srOnly']}>{m.unitsLabel(open.doc.unitSystem)}</span>
          <span aria-hidden="true">{m.units[open.doc.unitSystem]}</span>
        </span>
      ) : null}
      <span aria-live="polite" className={styles['statusLive']}>
        <AgentIndicator sessions={sessions} onOpenSettings={() => openSettings(true)} />
      </span>
    </>
  )
}
