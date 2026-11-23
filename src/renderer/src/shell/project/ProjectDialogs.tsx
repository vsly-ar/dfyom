// The project file dialogs (task 3.6): new project, the recovery prompt, a foreign lock ("Retry in
// 2 min") and errors.
// Doc: docs/conventions/ui.md#project-files, #confirmations
import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import type { UnitSystem } from '../../../../core/project/document'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { projectMessages as m } from '../../messages/project'
import {
  Icon,
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
    case 'incompatible':
      return (
        <IncompatibleDialog file={dialog.file} error={dialog.error} onOpenChange={onOpenChange} />
      )
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
  // an emptied name falls back to the default rather than disabling Create without a reason
  const submit = () => {
    if (!busy) void files.getState().create(name.trim() || m.newDialog.defaultName, units)
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
            icon={<Icon name="file-new" />}
            disabled={busy}
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
          <FieldInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={m.newDialog.defaultName}
            autoFocus
          />
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
            icon={<Icon name="rotate-ccw" />}
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

/** Pre-alpha reset (hardening B6): the file's data no longer loads. docs/conventions/ui.md#project-files */
function IncompatibleDialog({
  file,
  error,
  onOpenChange,
}: {
  file: string
  error: AppErrorData
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { files } = useShell()
  const busy = useStore(files, (s) => s.busy)
  const [confirm, setConfirm] = useState(false)
  const name = file.split(/[\\/]/).pop() ?? file
  if (confirm)
    return (
      <ConfirmDialog
        open
        onOpenChange={(o) => {
          if (!o) setConfirm(false)
        }}
        title={m.incompatible.confirmTitle(name)}
        description={m.incompatible.confirmDescription}
        confirmLabel={m.incompatible.reset}
        destructive
        onConfirm={() => void files.getState().resetFile(file)}
      />
    )
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={m.incompatible.title}
      description={m.incompatible.description(name)}
      footer={
        <>
          <DialogClose>
            <Button>{m.incompatible.cancel}</Button>
          </DialogClose>
          <Button variant="danger" disabled={busy} onClick={() => setConfirm(true)}>
            {m.incompatible.reset}
          </Button>
        </>
      }
    >
      <ErrorMessage error={error} />
    </Dialog>
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
            icon={<Icon name="rotate-ccw" />}
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
