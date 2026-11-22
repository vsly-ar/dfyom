// "New machine…" in plan mode (the machine section and the empty state before "Create plan"): a
// dialog with the quick machine fields (MachineFields `quick`, shared with the Library window's
// editor, L4) that adds the machine with `library.machine.add` and hands its id to `onAdded`. The
// core validates; its issues show at their field, the rest above the fields.
// Doc: docs/conventions/ui.md#plan-mode-task-37, docs/conventions/ui-library-window.md
import { Cpu, Plus } from 'lucide-react'
import { useState } from 'react'
import type { UnitSystem } from '../../../core/project/document'
import type { AppErrorData } from '../../../shared/errors/app-error'
import { libraryMessages } from '../messages/library'
import { useCall } from '../shell/hooks'
import { Button, Dialog, DialogClose } from '../ui'
import { commandInput, defaultMachineValues, type MachineDraft } from './form'
import { LibraryFormBody, useLibraryForm } from './LibraryForm'
import { MACHINE_FIELDS, MachineFields } from './MachineFields'
import styles from './LibraryForm.module.css'

const m = libraryMessages.machine

export function NewMachineDialog({
  units,
  onAdded,
  disabled = false,
}: {
  units: UnitSystem
  /** Called with the new machine's library id; an error it returns is shown in the form. */
  onAdded: (machineLibraryItemId: string) => Promise<AppErrorData | undefined>
  disabled?: boolean
}): React.JSX.Element {
  const call = useCall()
  const [values, setValues] = useState<MachineDraft>(() => defaultMachineValues(units))
  const f = useLibraryForm(MACHINE_FIELDS)

  const open = (o: boolean) => {
    if (o) setValues(defaultMachineValues(units))
    f.setOpen(o)
  }

  const submit = () =>
    f.submit(async () => {
      const added = await call('library.machine.add', commandInput(values, { units }))
      if (!added.ok) return added.error
      return onAdded((added.value as { id: string }).id)
    })

  return (
    <div className={styles['actions']}>
      <Dialog
        title={m.title}
        description={m.description}
        open={f.open}
        onOpenChange={open}
        trigger={
          <Button size="sm" icon={<Plus aria-hidden="true" />} disabled={disabled}>
            {m.open}
          </Button>
        }
        footer={
          <>
            <DialogClose>
              <Button variant="ghost">{libraryMessages.cancel}</Button>
            </DialogClose>
            <Button
              variant="primary"
              icon={<Cpu aria-hidden="true" />}
              disabled={f.busy}
              onClick={() => void submit()}
            >
              {m.add}
            </Button>
          </>
        }
      >
        <LibraryFormBody form={f}>
          <MachineFields
            values={values}
            onChange={setValues}
            units={units}
            messages={f.messages}
            variant="quick"
          />
        </LibraryFormBody>
      </Dialog>
    </div>
  )
}
