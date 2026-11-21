// "New tool…" in plan mode's tool picker: a dialog with the v0.1 tool fields (library.md#tool:
// type, diameter, corner radius for a bull nose, flute and overall length, flutes, point angle for
// a drill, tool material) that adds the tool with `library.tool.add` and hands its id to
// `onAdded` (the inspector assigns it to the plan operation). The core validates; its issues show
// at their field, the rest above the fields. Doc: docs/conventions/ui.md#plan-mode-task-37
import { Plus, Wrench } from 'lucide-react'
import { useState } from 'react'
import { TOOL_MATERIALS, TOOL_TYPES } from '../../../../core/library/tool.dto'
import type { OperationKind } from '../../../../core/design/part.dto'
import type { UnitSystem } from '../../../../core/project/document'
import type { QuantityKind } from '../../../../core/quantity/units'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { libraryMessages } from '../../messages/library'
import {
  Button,
  Dialog,
  DialogClose,
  Field,
  FieldIcon,
  FieldInput,
  QuantityInput,
  Select,
  type FieldIconName,
} from '../../ui'
import { defaultToolForm, libraryUnit, toolName, toolValues, type ToolForm } from './library-form'
import { LibraryFormBody, useLibraryForm } from './LibraryForm'
import { usePlanCommand } from './plan-store'
import styles from './LibraryForm.module.css'

const m = libraryMessages.tool

type QuantityField =
  'diameter' | 'cornerRadius' | 'fluteLength' | 'overallLength' | 'fluteCount' | 'pointAngle'

const FIELDS: readonly string[] = [
  'name',
  'type',
  'diameter',
  'cornerRadius',
  'fluteLength',
  'overallLength',
  'fluteCount',
  'pointAngle',
  'toolMaterial',
]

export function NewToolDialog({
  units,
  operationKind,
  onAdded,
  disabled = false,
}: {
  units: UnitSystem
  /** The plan operation's kind: a drilling suggests a drill. */
  operationKind?: OperationKind | undefined
  /** Called with the new tool's library id; an error it returns is shown in the form. */
  onAdded: (toolLibraryItemId: string) => Promise<AppErrorData | undefined>
  disabled?: boolean
}): React.JSX.Element {
  const call = usePlanCommand()
  const [form, setForm] = useState<ToolForm>(() => defaultToolForm(units, operationKind))
  const f = useLibraryForm(FIELDS)
  const set = (patch: Partial<ToolForm>) => setForm((s) => ({ ...s, ...patch }))

  const open = (o: boolean) => {
    if (o) setForm(defaultToolForm(units, operationKind))
    f.setOpen(o)
  }

  const submit = () =>
    f.submit(async () => {
      const added = await call('library.tool.add', { values: toolValues(form) })
      if (!added.ok) return added.error
      return onAdded((added.value as { id: string }).id)
    })

  const quantity = (key: QuantityField, kind: QuantityKind, icon: FieldIconName) => (
    <QuantityInput
      label={m[key]}
      kind={kind}
      defaultUnit={libraryUnit(kind, units)}
      value={form[key]}
      illustration={<FieldIcon name={icon} />}
      messages={f.messages(key)}
      onCommit={(v) => set({ [key]: v })}
    />
  )

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
              icon={<Wrench aria-hidden="true" />}
              disabled={f.busy}
              onClick={() => void submit()}
            >
              {m.add}
            </Button>
          </>
        }
      >
        <LibraryFormBody form={f}>
          <Field label={libraryMessages.name} messages={f.messages('name')}>
            <FieldInput
              value={form.name ?? toolName(form)}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <Field label={m.type} messages={f.messages('type')}>
            <Select
              options={TOOL_TYPES.map((t) => ({ value: t, label: m.types[t] }))}
              value={form.type}
              onValueChange={(type) => set({ type })}
            />
          </Field>
          <div className={styles['group']}>
            {quantity('diameter', 'length', 'width')}
            {form.type === 'bullNoseEndMill' ? quantity('cornerRadius', 'length', 'corner') : null}
            {quantity('fluteLength', 'length', 'depth')}
            {quantity('overallLength', 'length', 'length')}
            {quantity('fluteCount', 'scalar', 'tool')}
            {form.type === 'drill' ? quantity('pointAngle', 'angle', 'chamfer') : null}
          </div>
          <Field label={m.toolMaterial} messages={f.messages('toolMaterial')}>
            <Select
              options={TOOL_MATERIALS.map((t) => ({ value: t, label: m.materials[t] }))}
              value={form.toolMaterial}
              onValueChange={(toolMaterial) => set({ toolMaterial })}
            />
          </Field>
        </LibraryFormBody>
      </Dialog>
    </div>
  )
}
