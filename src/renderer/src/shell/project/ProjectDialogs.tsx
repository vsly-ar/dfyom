// The project file dialogs (task 3.6): new project, the recovery prompt, a foreign lock ("Retry in
// 2 min") and errors.
// Doc: docs/conventions/ui.md#project-files, #confirmations
import { FilePlus, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import type { UnitSystem } from '../../../../core/project/document'
import { projectMessages as m } from '../../messages/project'
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogClose,
  ErrorMessage,
  Field,
  FieldInput,
  SegmentedControl,
} from '../../ui'
import { useShell } from '../ShellContext'
import styles from './Project.module.css'

export function ProjectDialogs(): React.JSX.Element | null {
  const { files } = useShell()
  const dialog = useStore(files, (s) => s.dialog)
  const closeDialog = useStore(files, (s) => s.closeDialog)
  // only the dialog that closes: a confirmation's action may already have opened the next one
  const onOpenChange = (open: boolean) => {
    if (!open && files.getState().dialog === dialog) closeDialog()
  }
  if (dialog === null) return null
  switch (dialog.kind) {
    case 'new':
      return <NewProjectDialog onOpenChange={onOpenChange} />
    case 'recovery':
      return <RecoveryDialog keyName={dialog.key} file={dialog.file} onOpenChange={onOpenChange} />
    case 'locked':
      return <LockedDialog onOpenChange={onOpenChange} />
    case 'error':
      return (
        <Dialog
          open
          onOpenChange={onOpenChange}
          title={m.failed[dialog.title]}
          footer={
            <DialogClose>
              <Button>{m.failed.close}</Button>
            </DialogClose>
          }
        >
          <ErrorMessage error={dialog.error} />
        </Dialog>
      )
  }
}

function NewProjectDialog({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { files } = useShell()
  const busy = useStore(files, (s) => s.busy)
  const [name, setName] = useState<string>(m.newDialog.defaultName)
  const [units, setUnits] = useState<UnitSystem>('mm')
  const valid = name.trim().length > 0
  const submit = () => {
    if (valid && !busy) void files.getState().create(name.trim(), units)
  }
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={m.newDialog.title}
      description={m.newDialog.description}
      footer={
        <>
          <DialogClose>
            <Button>{m.newDialog.cancel}</Button>
          </DialogClose>
          <Button
            variant="primary"
            icon={<FilePlus aria-hidden="true" />}
            disabled={!valid || busy}
            onClick={submit}
          >
            {m.newDialog.create}
          </Button>
        </>
      }
    >
      <form
        className={styles['form']}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Field label={m.newDialog.name}>
          <FieldInput value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className={styles['row']}>
          <span className={styles['caption']} aria-hidden="true">
            {m.newDialog.units}
          </span>
          <SegmentedControl<UnitSystem>
            label={m.newDialog.units}
            options={(['mm', 'inch'] as const).map((u) => ({
              value: u,
              label: m.newDialog.unitNames[u],
            }))}
            value={units}
            onValueChange={setUnits}
          />
        </div>
      </form>
    </Dialog>
  )
}

function RecoveryDialog({
  keyName,
  file,
  onOpenChange,
}: {
  keyName: string
  file: string | null
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { files } = useShell()
  const busy = useStore(files, (s) => s.busy)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  if (confirmDiscard)
    return (
      <ConfirmDialog
        open
        onOpenChange={(o) => {
          if (!o) setConfirmDiscard(false)
        }}
        title={m.recovery.discardTitle}
        description={m.recovery.discardDescription}
        confirmLabel={m.recovery.discard}
        destructive
        onConfirm={() => void files.getState().recover(keyName, 'discard')}
      />
    )
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={m.recovery.title}
      description={m.recovery.description(file)}
      footer={
        <>
          <Button variant="danger" disabled={busy} onClick={() => setConfirmDiscard(true)}>
            {m.recovery.discard}
          </Button>
          <Button
            variant="primary"
            icon={<RotateCcw aria-hidden="true" />}
            disabled={busy}
            onClick={() => void files.getState().recover(keyName, 'restore')}
          >
            {m.recovery.restore}
          </Button>
        </>
      }
    />
  )
}

function LockedDialog({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void
}): React.JSX.Element | null {
  const { files } = useShell()
  const dialog = useStore(files, (s) => s.dialog)
  const busy = useStore(files, (s) => s.busy)
  const retryAt = dialog?.kind === 'locked' ? dialog.retryAt : undefined
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (retryAt === undefined) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [retryAt])
  if (dialog?.kind !== 'locked') return null
  const waiting = retryAt === undefined ? undefined : Math.max(0, Math.ceil((retryAt - now) / 1000))
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={m.locked.title}
      description={m.locked.description}
      footer={
        <>
          <DialogClose>
            <Button>{m.locked.cancel}</Button>
          </DialogClose>
          <Button
            disabled={busy || waiting !== undefined}
            onClick={() => files.getState().retryLocked(true)}
          >
            {waiting === undefined ? m.locked.retryLater : m.locked.waiting(waiting)}
          </Button>
          <Button
            variant="primary"
            icon={<RotateCcw aria-hidden="true" />}
            disabled={busy}
            onClick={() => files.getState().retryLocked(false)}
          >
            {m.locked.retry}
          </Button>
        </>
      }
    >
      <ErrorMessage error={dialog.error} />
    </Dialog>
  )
}
