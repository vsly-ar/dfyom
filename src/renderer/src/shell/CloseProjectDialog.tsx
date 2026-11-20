// Closing a project with its last window: main asks when the close is refused. Unsaved changes
// → ConfirmDialog ("Close without saving"; the changes stay recoverable); another refusal (a run
// is going) → the error. Doc: docs/conventions/ui.md#app-shell, #confirmations
import { useEffect, useState } from 'react'
import type { CallReply, WindowCloseRequest } from '../../../shared/preload-api'
import { shellMessages } from '../messages/shell'
import { Button, ConfirmDialog, Dialog, DialogClose, ErrorMessage } from '../ui'
import { useShell } from './ShellContext'

const m = shellMessages.close

export function CloseProjectDialog(): React.JSX.Element | null {
  const { bridge } = useShell()
  const [request, setRequest] = useState<WindowCloseRequest | undefined>(undefined)
  useEffect(() => bridge.window.onCloseRequest(setRequest), [bridge])

  const onOpenChange = (open: boolean) => {
    if (!open) setRequest(undefined)
  }
  if (request === undefined) return null
  if (request.kind === 'unsavedChanges')
    return (
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title={m.unsavedTitle(request.name)}
        description={m.unsavedDescription}
        confirmLabel={m.confirm}
        onConfirm={() => {
          void bridge.window.close(true).then((r: CallReply) => {
            // a refusal after the confirmation (a run started meanwhile) comes as a new request
            if (r.ok) setRequest(undefined)
          })
        }}
      />
    )
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={m.refusedTitle}
      footer={
        <DialogClose>
          <Button>{m.ok}</Button>
        </DialogClose>
      }
    >
      <ErrorMessage error={request.error} />
    </Dialog>
  )
}
