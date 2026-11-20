// The navigator without a project (every mode): New project, Open project, and the projects with
// unsaved changes from an earlier session (restore or discard, persistence.md#crash-recovery).
// Doc: docs/conventions/ui.md#project-files
import { FilePlus, FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import { projectMessages as m } from '../../messages/project'
import { Button, ConfirmDialog } from '../../ui'
import { useShell } from '../ShellContext'
import styles from './Project.module.css'

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

export function StartPanel(): React.JSX.Element {
  const { files } = useShell()
  const recoverable = useStore(files, (s) => s.recoverable)
  const busy = useStore(files, (s) => s.busy)
  const [discard, setDiscard] = useState<string | undefined>(undefined)
  useEffect(() => {
    void files.getState().refreshRecoverable()
  }, [files])

  return (
    <div className={styles['start']}>
      <h2 className={styles['title']}>{m.start.title}</h2>
      <p className={styles['description']}>{m.start.description}</p>
      <div className={styles['actions']}>
        <Button
          variant="primary"
          icon={<FilePlus aria-hidden="true" />}
          onClick={() => files.getState().newProject()}
        >
          {m.start.new}
        </Button>
        <Button
          icon={<FolderOpen aria-hidden="true" />}
          onClick={() => void files.getState().open()}
        >
          {m.start.open}
        </Button>
      </div>
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
