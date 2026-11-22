// "New tool…": a dialog with the quick tool fields (ToolFields `quick`, shared with the Library
// window's editor, L4) that adds the tool with `library.tool.add` and hands its id to `onAdded`
// (plan mode assigns it to the plan operation; design mode locks the operation's tool field). The
// core validates; its issues show at their field, the rest above the fields.
// Doc: docs/conventions/ui-library-window.md#context-links, docs/conventions/ui.md#plan-mode-task-37
import { useState, type ReactElement } from 'react'
import type { OperationKind } from '../../../core/design/part.dto'
import type { UnitSystem } from '../../../core/project/document'
import type { AppErrorData } from '../../../shared/errors/app-error'
import { libraryMessages } from '../messages/library'
import { useCall } from '../shell/hooks'
import { Icon, Button, Dialog, DialogClose } from '../ui'
import { commandInput, defaultToolValues, type ToolDraft, type ToolPrefill } from './form'
import { LibraryFormBody, useLibraryForm } from './LibraryForm'
import { TOOL_FIELDS, ToolFields } from './ToolFields'
import styles from './LibraryForm.module.css'

const m = libraryMessages.tool

export function NewToolDialog({
  units,
  operationKind,
  prefill,
  onAdded,
  disabled = false,
  description = m.description,
  trigger,
  open: controlled,
  onOpenChange,
}: {
  units: UnitSystem
  /** The plan operation's kind: a drilling suggests a drill. */
  operationKind?: OperationKind | undefined
  /** The generalized tool a design operation asks for (type, diameter, corner radius). */
  prefill?: ToolPrefill | undefined
  /** Called with the new tool's library id; an error it returns is shown in the form. */
  onAdded: (toolLibraryItemId: string) => Promise<AppErrorData | undefined>
  disabled?: boolean
  description?: string
  /** The opening control; default a small "New tool…" button. `null`: opened by `open` only. */
  trigger?: ReactElement | null
  /** Controlled open state (the tool field's list item, the DFM fix). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const call = useCall()
  const initial = () => defaultToolValues(units, operationKind, prefill)
  const [values, setValues] = useState<ToolDraft>(initial)
  const [autoName, setAutoName] = useState(true)
  const f = useLibraryForm(TOOL_FIELDS)
  const isOpen = controlled ?? f.open

  const open = (o: boolean) => {
    if (o) {
      setValues(initial())
      setAutoName(true)
    }
    f.setOpen(o)
    onOpenChange?.(o)
  }
  // opened from outside: start from the defaults (and no old error) once per opening
  const [seen, setSeen] = useState(false)
  if (controlled === true && !seen) {
    setSeen(true)
    setValues(initial())
    setAutoName(true)
    f.setOpen(true)
  } else if (controlled !== true && seen) setSeen(false)

  const submit = () =>
    f.submit(async () => {
      const added = await call('library.tool.add', commandInput(values, { units, autoName }))
      if (!added.ok) return added.error
      const e = await onAdded((added.value as { id: string }).id)
      if (e === undefined) onOpenChange?.(false)
      return e
    })

  const defaultTrigger = (
    <Button size="sm" icon={<Icon name="add" />} disabled={disabled}>
      {m.open}
    </Button>
  )

  const dialog = (
    <Dialog
      title={m.title}
      description={description}
      open={isOpen}
      onOpenChange={open}
      {...(trigger === null ? {} : { trigger: trigger ?? defaultTrigger })}
      footer={
        <>
          <DialogClose>
            <Button variant="ghost">{libraryMessages.cancel}</Button>
          </DialogClose>
          <Button
            variant="primary"
            icon={<Icon name="add" />}
            disabled={f.busy}
            onClick={() => void submit()}
          >
            {m.add}
          </Button>
        </>
      }
    >
      <LibraryFormBody form={f}>
        <ToolFields
          values={values}
          onChange={setValues}
          units={units}
          messages={f.messages}
          variant="quick"
          autoName={autoName}
          onNameTyped={() => setAutoName(false)}
        />
      </LibraryFormBody>
    </Dialog>
  )
  return trigger === null ? dialog : <div className={styles['actions']}>{dialog}</div>
}
