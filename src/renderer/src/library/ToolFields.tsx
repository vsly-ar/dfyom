// The tool form, shared by the Library window's editor (`full`: every field of library.md#tool in
// the groups Geometry with the tool drawing, Presets, and Details collapsed: material, coating,
// notes, DF1) and the quick "New tool…" dialog (`quick`: the fields v0.1 needs). Per-type fields
// show for their type only (corner radius for a bull nose, point angle for a drill). Doc: docs/conventions/ui-library-window.md#layout, L4
import { useState } from 'react'
import { TOOL_MATERIALS, TOOL_TYPES, type ToolMaterial } from '../../../core/library/tool.dto'
import type { QuantityDTO } from '../../../core/quantity/quantity.dto'
import { libraryMessages } from '../messages/library'
import { Field, FieldInput, Select } from '../ui'
import { followDraft, toolName, withToolType, type ToolDraft } from './form'
import { Focusable, Group, NameField, NotesField, QuantityField, type FormProps } from './fields'
import { PresetTable } from './PresetTable'
import { ToolDrawing, type ToolDimension } from './ToolDrawing'
import styles from './LibraryForm.module.css'

const m = libraryMessages.tool
const NO_MATERIAL = 'none'

/** Every field key of the tool form (issue mapping, focus on the first invalid one). */
export const TOOL_FIELDS: readonly string[] = [
  'name',
  'type',
  'diameter',
  'cornerRadius',
  'fluteLength',
  'overallLength',
  'stickout',
  'shankDiameter',
  'fluteCount',
  'pointAngle',
  'angle',
  'tipDiameter',
  'toolMaterial',
  'coating',
  'presets',
  'notes',
]

/** The full form's collapsed Details group (DF1): secondary fields, the cutting geometry stays open. */
const DETAIL_FIELDS: readonly string[] = ['toolMaterial', 'coating', 'notes']

const DIMENSIONS: ReadonlySet<string> = new Set([
  'diameter',
  'cornerRadius',
  'fluteLength',
  'overallLength',
  'stickout',
  'shankDiameter',
  'pointAngle',
  'angle',
  'tipDiameter',
])

export function ToolFields({
  values,
  onChange,
  units,
  messages,
  variant,
  autoName = false,
  onNameTyped,
  detailsOpen: detailsOpenProp,
  onDetailsOpenChange,
}: FormProps<ToolDraft> & {
  /** The name follows type and diameter (`toolName`) until the user types one. */
  autoName?: boolean
  onNameTyped?: () => void
  /** The Details group is open (`full`; the window keeps it across items, DF1); else local. */
  detailsOpen?: boolean
  onDetailsOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const full = variant === 'full'
  const [detailsLocal, setDetailsLocal] = useState(false)
  const detailsOpen = detailsOpenProp ?? detailsLocal
  const setDetailsOpen = onDetailsOpenChange ?? setDetailsLocal
  const detailsInvalid = DETAIL_FIELDS.some((f) => messages(f).some((x) => x.severity === 'error'))
  const detailsSummary =
    [
      values.toolMaterial === undefined ? undefined : m.materials[values.toolMaterial],
      values.coating,
    ]
      .filter((x) => x !== undefined && x !== '')
      .join(' · ') || undefined
  const chamfer = values.type === 'chamferMill'
  const [focused, setFocused] = useState<ToolDimension | undefined>(undefined)
  // recommended presets follow every change of the tool (library.md#recommended-presets)
  const set = (patch: Partial<ToolDraft>) => onChange(followDraft({ ...values, ...patch }, units))
  const onFocusField = full
    ? (f: string | undefined) =>
        setFocused(f !== undefined && DIMENSIONS.has(f) ? (f as ToolDimension) : undefined)
    : undefined
  const quantity = (
    field: keyof ToolDraft & string,
    kind: 'length' | 'scalar' | 'angle',
    icon: Parameters<typeof QuantityField>[0]['icon'],
    opts: { optional?: boolean; note?: string; placeholder?: string } = {},
  ) => (
    <QuantityField
      field={field}
      label={m[field as keyof typeof m] as string}
      kind={kind}
      value={values[field] as QuantityDTO | undefined}
      units={units}
      icon={icon}
      messages={messages}
      note={opts.note}
      optional={opts.optional ?? false}
      placeholder={opts.placeholder}
      onChange={(v) => set({ [field]: v })}
      onFocusField={onFocusField}
    />
  )

  const geometry = (
    <>
      <Focusable field="type" onFocusField={onFocusField}>
        <Field label={m.type} messages={messages('type')}>
          {/* one type for chamfer mills and V-bits (H-F): "V-bit" in its hint (task U4) */}
          <Select
            options={TOOL_TYPES.map((t) => ({
              value: t,
              label: m.types[t],
              ...(t === 'chamferMill' ? { description: m.chamferHint } : {}),
            }))}
            value={values.type}
            onValueChange={(type) =>
              onChange(followDraft(withToolType(values, type, units), units))
            }
          />
        </Field>
      </Focusable>
      {quantity('diameter', 'length', 'width')}
      {values.type === 'bullNoseEndMill' ? quantity('cornerRadius', 'length', 'corner') : null}
      {chamfer ? quantity('angle', 'angle', 'chamfer') : null}
      {chamfer
        ? quantity('tipDiameter', 'length', 'width', {
            optional: true,
            placeholder: m.tipPointed,
          })
        : null}
      {quantity('fluteLength', 'length', 'depth')}
      {quantity('overallLength', 'length', 'length')}
      {full
        ? quantity('stickout', 'length', 'depth', { optional: true, note: m.stickoutNote })
        : null}
      {full
        ? quantity('shankDiameter', 'length', 'width', { optional: true, note: m.shankNote })
        : null}
      {quantity('fluteCount', 'scalar', 'tool')}
      {values.type === 'drill' ? quantity('pointAngle', 'angle', 'chamfer') : null}
    </>
  )

  const material = (
    <Field label={m.toolMaterial} messages={messages('toolMaterial')}>
      <Select<string>
        options={[
          ...(full ? [{ value: NO_MATERIAL, label: m.noMaterial }] : []),
          ...TOOL_MATERIALS.map((t) => ({ value: t, label: m.materials[t] })),
        ]}
        value={values.toolMaterial ?? NO_MATERIAL}
        onValueChange={(v) =>
          set({ toolMaterial: v === NO_MATERIAL ? undefined : (v as ToolMaterial) })
        }
      />
    </Field>
  )

  const name = (
    <NameField
      value={autoName && values.name === '' ? toolName(values) : values.name}
      messages={messages('name')}
      onChange={(n) => {
        onNameTyped?.()
        set({ name: n })
      }}
    />
  )

  if (!full)
    return (
      <>
        {name}
        <div className={styles['group']}>{geometry}</div>
        {material}
      </>
    )

  return (
    <>
      {name}
      <Group
        title={libraryMessages.window.groups.geometry}
        aside={<ToolDrawing type={values.type} focused={focused} />}
      >
        {geometry}
      </Group>
      <Group title={libraryMessages.window.groups.presets}>
        <PresetTable
          presets={values.presets}
          tool={values}
          units={units}
          messages={messages}
          onChange={(presets) => set({ presets })}
        />
      </Group>
      <Group
        title={libraryMessages.window.groups.details}
        collapsible={{
          // a field inside with an issue opens it: Save focuses the first invalid field
          open: detailsOpen || detailsInvalid,
          onOpenChange: (open) => setDetailsOpen(open),
          summary: detailsSummary,
        }}
      >
        {material}
        <Field
          label={m.coating}
          messages={[
            ...messages('coating'),
            { id: 'coating-hint', severity: 'note', text: m.coatingHint },
          ]}
        >
          <FieldInput
            value={values.coating ?? ''}
            maxLength={60}
            onChange={(e) => set({ coating: e.target.value === '' ? undefined : e.target.value })}
          />
        </Field>
        <NotesField
          value={values.notes}
          messages={messages('notes')}
          onChange={(notes) => set({ notes })}
        />
      </Group>
    </>
  )
}
