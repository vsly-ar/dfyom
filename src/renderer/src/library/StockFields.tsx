// The stock form of the Library window's editor (library.md#stock): name, the block's length,
// width and thickness, the material name and class, notes. The stock setup in design mode keeps
// its own short form. Doc: docs/conventions/ui-library-window.md#layout
import { MATERIAL_CLASSES } from '../../../core/library/item'
import { libraryMessages } from '../messages/library'
import { Field, FieldInput, Select } from '../ui'
import type { StockDraft } from './form'
import { FixedField, Group, NameField, NotesField, QuantityField, type FormProps } from './fields'

const m = libraryMessages.stock
const g = libraryMessages.window.groups

export const STOCK_FIELDS: readonly string[] = [
  'name',
  'shape',
  'length',
  'width',
  'thickness',
  'material.name',
  'material.class',
  'material',
  'notes',
]

export function StockFields({
  values,
  onChange,
  units,
  messages,
}: FormProps<StockDraft>): React.JSX.Element {
  const set = (patch: Partial<StockDraft>) => onChange({ ...values, ...patch })
  const size = (
    field: 'length' | 'width' | 'thickness',
    icon: 'stock-length' | 'stock-width' | 'stock-thickness',
    note?: string,
  ) => (
    <QuantityField
      field={field}
      label={m[field]}
      kind="length"
      value={values[field]}
      units={units}
      icon={icon}
      messages={messages}
      note={note}
      onChange={(v) => {
        if (v !== undefined) set({ [field]: v })
      }}
    />
  )
  return (
    <>
      <NameField
        value={values.name}
        messages={messages('name')}
        onChange={(name) => set({ name })}
      />
      <Group title={g.size}>
        <FixedField label={m.shape} value={libraryMessages.window.shapes[values.shape]} />
        {size('length', 'stock-length')}
        {size('width', 'stock-width')}
        {size('thickness', 'stock-thickness', m.thicknessNote)}
      </Group>
      <Group title={g.material}>
        <Field label={m.materialName} messages={messages('material.name')}>
          <FieldInput
            value={values.material.name}
            maxLength={120}
            onChange={(e) => set({ material: { ...values.material, name: e.target.value } })}
          />
        </Field>
        <Field label={m.materialClass} messages={messages('material.class')}>
          <Select
            options={MATERIAL_CLASSES.map((c) => ({ value: c, label: libraryMessages.classes[c] }))}
            value={values.material.class}
            onValueChange={(c) => set({ material: { ...values.material, class: c } })}
          />
        </Field>
      </Group>
      <Group title={g.notes}>
        <NotesField
          value={values.notes}
          messages={messages('notes')}
          onChange={(notes) => set({ notes })}
        />
      </Group>
    </>
  )
}
