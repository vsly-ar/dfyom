// "New machine…" in plan mode (the machine section and the empty state before "Create plan"): a
// dialog with the v0.1 machine fields (library.md#machine: name, travel and max feed rate per
// axis, spindle control, max and min speed, power, rigidity, gCode units; GRBL controller and
// manual tool change are fixed) that adds the machine with `library.machine.add` and hands its id
// to `onAdded`. Min speed and power are optional: emptying them unsets them (QuantityInput
// `optional`). The core validates; its issues show at their field, the rest above the fields.
// Doc: docs/conventions/ui.md#plan-mode-task-37
import { Cpu, Plus } from 'lucide-react'
import { useId, useState } from 'react'
import { RIGIDITY_PRESETS } from '../../../../core/library/machine.dto'
import type { UnitSystem } from '../../../../core/project/document'
import type { QuantityKind } from '../../../../core/quantity/units'
import type { Quantity } from '../../../../core/quantity/quantity'
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
  SegmentedControl,
  Select,
  type FieldIconName,
  type QuantityCommitProps,
} from '../../ui'
import {
  AXES,
  defaultMachineForm,
  libraryUnit,
  machineValues,
  type Axis,
  type MachineForm,
} from './library-form'
import { LibraryFormBody, useLibraryForm } from './LibraryForm'
import { usePlanCommand } from './plan-store'
import styles from './LibraryForm.module.css'

const m = libraryMessages.machine

const FIELDS: readonly string[] = [
  'name',
  ...AXES.map((a) => `travel.${a}`),
  ...AXES.map((a) => `maxFeedRate.${a}`),
  'spindle.maxSpeed',
  'spindle.minSpeed',
  'spindle.power',
  'rigidity',
  'travel',
  'maxFeedRate',
  'spindle',
]

const AXIS_ICON: Record<Axis, FieldIconName> = { x: 'length', y: 'width', z: 'depth' }

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} className={styles['group']}>
      <span id={id} className={styles['legend']}>
        {title}
      </span>
      {children}
    </div>
  )
}

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
  const call = usePlanCommand()
  const [form, setForm] = useState<MachineForm>(() => defaultMachineForm(units))
  const f = useLibraryForm(FIELDS)
  const set = (patch: Partial<MachineForm>) => setForm((s) => ({ ...s, ...patch }))

  const open = (o: boolean) => {
    if (o) setForm(defaultMachineForm(units))
    f.setOpen(o)
  }

  const submit = () =>
    f.submit(async () => {
      const added = await call('library.machine.add', { values: machineValues(form), units })
      if (!added.ok) return added.error
      return onAdded((added.value as { id: string }).id)
    })

  const quantity = (
    key: string,
    label: string,
    kind: QuantityKind,
    value: Quantity | undefined,
    icon: FieldIconName,
    commit: QuantityCommitProps,
    note?: string,
  ) => (
    <QuantityInput
      key={key}
      label={label}
      kind={kind}
      defaultUnit={libraryUnit(kind, units)}
      value={value}
      illustration={<FieldIcon name={icon} />}
      messages={[
        ...f.messages(key),
        ...(note === undefined
          ? []
          : [{ id: `${key}-note`, severity: 'note' as const, text: note }]),
      ]}
      {...commit}
    />
  )
  const axes = (
    field: 'travel' | 'maxFeedRate',
    kind: QuantityKind,
    label: (a: string) => string,
  ) =>
    AXES.map((a) =>
      quantity(`${field}.${a}`, label(a.toUpperCase()), kind, form[field][a], AXIS_ICON[a], {
        onCommit: (v: Quantity) => set({ [field]: { ...form[field], [a]: v } }),
      }),
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
          <Field label={libraryMessages.name} messages={f.messages('name')}>
            <FieldInput value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Group title={m.travel}>{axes('travel', 'length', m.travelAxis)}</Group>
          <Group title={m.maxFeed}>{axes('maxFeedRate', 'feedRate', m.maxFeedAxis)}</Group>
          <Group title={m.spindle}>
            <div className={styles['choice']}>
              <span className={styles['caption']} aria-hidden="true">
                {m.control}
              </span>
              <SegmentedControl<'manual' | 'gcode'>
                label={m.control}
                options={[
                  { value: 'manual', label: m.controls.manual },
                  { value: 'gcode', label: m.controls.gcode },
                ]}
                value={form.control}
                onValueChange={(control) => set({ control })}
              />
            </div>
            {quantity('spindle.maxSpeed', m.maxSpeed, 'spindleSpeed', form.maxSpeed, 'feed', {
              onCommit: (v: Quantity) => set({ maxSpeed: v }),
            })}
            {quantity(
              'spindle.minSpeed',
              m.minSpeed,
              'spindleSpeed',
              form.minSpeed,
              'feed',
              { optional: true, onCommit: (v) => set({ minSpeed: v }) },
              m.minSpeedNote,
            )}
            {quantity(
              'spindle.power',
              m.power,
              'power',
              form.power,
              'tool',
              { optional: true, onCommit: (v) => set({ power: v }) },
              m.powerNote,
            )}
          </Group>
          <Field label={m.rigidity} messages={f.messages('rigidity')}>
            <Select
              options={RIGIDITY_PRESETS.map((r) => ({ value: r, label: m.rigidities[r] }))}
              value={form.rigidity}
              onValueChange={(rigidity) => set({ rigidity })}
            />
          </Field>
          <div className={styles['choice']}>
            <span className={styles['caption']} aria-hidden="true">
              {m.programUnits}
            </span>
            <SegmentedControl<'mm' | 'in'>
              label={m.programUnits}
              options={[
                { value: 'mm', label: m.units.mm },
                { value: 'in', label: m.units.in },
              ]}
              value={form.programUnits}
              onValueChange={(programUnits) => set({ programUnits })}
            />
          </div>
        </LibraryFormBody>
      </Dialog>
    </div>
  )
}
