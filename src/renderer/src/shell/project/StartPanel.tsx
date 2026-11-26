// The navigator without a project (Design, Plan): New project, Open project, the recent projects
// (DF114: click opens, a file that is gone is greyed with "Remove from list"), the projects with
// unsaved changes from an earlier session (restore or discard, persistence.md#crash-recovery), and
// "Go to Run": the machine needs no project (DF80, docs/modes/run.md#run-without-a-project-df80).
// Doc: docs/conventions/ui.md#project-files
import { useEffect, useState, type KeyboardEvent } from 'react'
import type { RecentProjectView } from '../../../../shared/preload-api'
import { useStore } from 'zustand'
import { projectMessages as m } from '../../messages/project'
import { Icon, Button, ConfirmDialog } from '../../ui'
import { useShell, useUi } from '../ShellContext'
import styles from './Project.module.css'

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

export function StartPanel(): React.JSX.Element {
  const { files } = useShell()
  const recoverable = useStore(files, (s) => s.recoverable)
  const recent = useStore(files, (s) => s.recent)
  const recentAt = useStore(files, (s) => s.recentAt)
  const busy = useStore(files, (s) => s.busy)
  const setMode = useUi((s) => s.setMode)
  const [discard, setDiscard] = useState<string | undefined>(undefined)
  useEffect(() => {
    void files.getState().refreshRecoverable()
    void files.getState().refreshRecent()
  }, [files])

  return (
    <div className={styles['start']}>
      <h2 className={styles['title']}>{m.start.title}</h2>
      <p className={styles['description']}>{m.start.description}</p>
      <div className={styles['actions']}>
        <Button
          variant="primary"
          icon={<Icon name="file-new" />}
          onClick={() => files.getState().newProject()}
        >
          {m.start.new}
        </Button>
        <Button icon={<Icon name="open" />} onClick={() => void files.getState().open()}>
          {m.start.open}
        </Button>
      </div>
      {recent.length > 0 ? (
        <section className={styles['recent']} aria-labelledby="start-recent">
          <h3 id="start-recent" className={styles['subtitle']}>
            {m.start.recentTitle}
          </h3>
          <ul className={styles['recentList']} onKeyDown={moveFocus}>
            {recent.map((p) => (
              <RecentRow
                key={p.path}
                project={p}
                busy={busy}
                now={recentAt}
                onOpen={() => void files.getState().openFile(p.path)}
                onRemove={() => void files.getState().forgetRecent(p.path)}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {recoverable.length > 0 ? (
        <section className={styles['recover']} aria-labelledby="start-recover">
          <h3 id="start-recover" className={styles['subtitle']}>
            {m.start.recoverTitle}
          </h3>
          <ul className={styles['recoverList']}>
            {recoverable.map((p) => {
              const name = p.filePath === null ? m.start.untitled : baseName(p.filePath)
              return (
                <li key={p.key} className={styles['recoverItem']}>
                  <span className={styles['recoverName']} title={p.filePath ?? undefined}>
                    {name}
                  </span>
                  <Button
                    size="sm"
                    disabled={busy}
                    aria-label={`${m.start.restore} ${name}`}
                    onClick={() => void files.getState().recover(p.key, 'restore')}
                  >
                    {m.start.restore}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    aria-label={`${m.start.discard} ${name}`}
                    onClick={() => setDiscard(p.key)}
                  >
                    {m.start.discard}
                  </Button>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
      <section className={styles['machine']} aria-labelledby="start-machine">
        <h3 id="start-machine" className={styles['subtitle']}>
          {m.start.machineTitle}
        </h3>
        <p className={styles['description']}>{m.start.machineDescription}</p>
        <Button size="sm" icon={<Icon name="arrow-right" />} onClick={() => setMode('run')}>
          {m.start.machineAction}
        </Button>
      </section>
      {discard !== undefined ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setDiscard(undefined)
          }}
          title={m.recovery.discardTitle}
          description={m.recovery.discardDescription}
          confirmLabel={m.recovery.discard}
          destructive
          onConfirm={() => {
            const key = discard
            setDiscard(undefined)
            void files
              .getState()
              .recover(key, 'discard')
              .then(() => files.getState().refreshRecoverable())
          }}
        />
      ) : null}
    </div>
  )
}

/** ↑ / ↓ move between the recent projects' controls (Tab still walks them in order). */
function moveFocus(e: KeyboardEvent<HTMLUListElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const controls = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled')]
  const at = controls.indexOf(document.activeElement as HTMLButtonElement)
  if (at < 0) return
  const next = controls[at + (e.key === 'ArrowDown' ? 1 : -1)]
  if (next === undefined) return
  e.preventDefault()
  next.focus()
}

function RecentRow({
  project: p,
  busy,
  now,
  onOpen,
  onRemove,
}: {
  project: RecentProjectView
  busy: boolean
  now: number
  onOpen: () => void
  onRemove: () => void
}): React.JSX.Element {
  const when = (
    <span className={styles['recentWhen']} title={m.start.recentWhenTitle(p.openedAt)}>
      {m.start.recentWhen(p.openedAt, now)}
    </span>
  )
  if (p.missing)
    return (
      <li className={styles['recentItem']} data-missing="">
        <div className={styles['recentMissing']} title={p.path}>
          <span className={styles['recentName']}>{p.name}</span>
          <Button
            size="sm"
            variant="ghost"
            aria-label={m.start.recentRemoveLabel(p.name)}
            onClick={onRemove}
          >
            {m.start.recentRemove}
          </Button>
          <span className={styles['recentMissingLine']}>
            <span className={styles['recentNote']}>{m.start.recentMissing} ·</span>
            <span className={styles['recentFolder']}>
              <span dir="ltr">{p.folder}</span>
            </span>
          </span>
        </div>
      </li>
    )
  return (
    <li className={styles['recentItem']}>
      <button
        type="button"
        className={styles['recentRow']}
        title={p.path}
        aria-label={m.start.recentOpen(p.name, p.folder)}
        disabled={busy}
        onClick={onOpen}
      >
        <span className={styles['recentName']}>{p.name}</span>
        {when}
        <span className={styles['recentFolder']}>
          <span dir="ltr">{p.folder}</span>
        </span>
      </button>
    </li>
  )
}
