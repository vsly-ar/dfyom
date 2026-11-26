// The workholding form of the Library window's editor (WL3, workholding-library.md § Library
// window tab): Name, the fixed device type, the **Device** group with the type's library sizes
// beside the device drawing and the "Default for toe clamps" switch at its end, **Range** (toe
// clamp grip, vise max opening; closed with its summary while empty) and **Details** (stud or
// thread, notes; closed). Steps follow inspector-layout.md S1: lengths `xy`, heights `depth`,
// head Ø `small`. A built-in shows every field read-only (duplicate it to change the sizes).
// Docs: docs/modes/workholding-library.md#library-window-tab, docs/conventions/inspector-layout.md
import { useId, useState } from 'react'
import { BASE_TYPES, SURFACE_TYPES } from '../../../core/library/workholding.dto'
import type { QuantityDTO } from '../../../core/quantity/quantity.dto'
import { libraryMessages } from '../messages/library'
import {
  Checkbox,
  Field,
  FieldInput,
  InspectorGroup,
  Select,
  Switch,
  type FieldIconName,
  type StepKind,
} from '../ui'
import { quantityText, type WorkholdingDraft } from './form'
import {
  FixedField,
  Focusable,
  NameField,
  NotesField,
  QuantityField,
  WithAside,
  type FormProps,
} from './fields'
import { dimensionOf, WorkholdingDrawing, type DeviceDimension } from './WorkholdingDrawing'
import styles from './LibraryWindow.module.css'

const m = libraryMessages.workholding
const g = libraryMessages.window.groups

type SizeField =
  | 'width'
  | 'length'
  | 'top'
  | 'gripMin'
  | 'gripMax'
  | 'jawWidth'
  | 'jawThickness'
  | 'jawHeight'
  | 'maxOpening'
  | 'headDiameter'
  | 'headHeight'
  | 'height'
  | 'thickness'

/** Adjust steps per size (inspector-layout.md § Step kinds): lengths `xy`, heights `depth`. */
const STEP: Record<SizeField, StepKind> = {
  width: 'xy',
  length: 'xy',
  top: 'depth',
  gripMin: 'xy',
  gripMax: 'xy',
  jawWidth: 'xy',
  jawThickness: 'xy',
  jawHeight: 'depth',
  maxOpening: 'xy',
  headDiameter: 'small',
  headHeight: 'depth',
  height: 'depth',
  thickness: 'depth',
}

/** Every field key of the workholding form (issue mapping, focus on the first invalid one). */
export const WORKHOLDING_FIELDS: readonly string[] = [
  'name',
  'type',
  'width',
  'length',
  'top',
  'gripMin',
  'gripMax',
  'stud',
  'jawWidth',
  'jawThickness',
  'jawHeight',
  'maxOpening',
  'soft',
  'headDiameter',
  'headHeight',
  'thread',
  'height',
  'baseType',
  'sacrificial',
  'thickness',
  'surfaceType',
  'default',
  'notes',
]

/** The Default switch: the draft's flag (a user item) or the built-in's effective default. */
export interface DefaultSwitch {
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (on: boolean) => void
}

export function WorkholdingFields({
  values,
  onChange,
  units,
  messages,
  readOnly = false,
  defaultSwitch,
}: FormProps<WorkholdingDraft> & {
  readOnly?: boolean
  defaultSwitch: DefaultSwitch
}): React.JSX.Element {
  const set = (patch: Partial<WorkholdingDraft>) => onChange({ ...values, ...patch })
  const [focused, setFocused] = useState<DeviceDimension | undefined>(undefined)
  const onFocusField = (f: string | undefined) => setFocused(dimensionOf(f))
  const hintId = useId()
  const type = values.type

  const size = (
    field: SizeField,
    label: string,
    icon: FieldIconName,
    opts: { optional?: boolean; info?: string; placeholder?: string } = {},
  ) => (
    <QuantityField
      key={field}
      field={field}
      label={label}
      kind="length"
      value={values[field] as QuantityDTO | undefined}
      units={units}
      icon={icon}
      messages={messages}
      stepKind={STEP[field]}
      info={opts.info}
      optional={opts.optional ?? false}
      placeholder={opts.placeholder}
      readOnly={readOnly}
      onChange={(v) => set({ [field]: v })}
      onFocusField={onFocusField}
    />
  )

  const device = () => {
    switch (type) {
      case 'toeClamp':
        return [
          size('width', m.width, 'width'),
          size('length', m.length, 'length'),
          size('top', m.top, 'clearance', { info: m.topInfo }),
        ]
      case 'vise':
        return [
          size('jawWidth', m.jawWidth, 'width'),
          size('jawThickness', m.jawThickness, 'slotWidth'),
          size('jawHeight', m.jawHeight, 'depth', { optional: true, info: m.jawHeightInfo }),
          <Checkbox
            key="soft"
            label={m.soft}
            checked={values.soft === true}
            disabled={readOnly}
            onCheckedChange={(c) => set({ soft: c === true })}
          />,
        ]
      case 'screw':
        return [
          size('headDiameter', m.headDiameter, 'diameter'),
          size('headHeight', m.headHeight, 'headSink', { info: m.headHeightInfo }),
        ]
      case 'block':
        return [
          size('length', m.blockLength, 'length'),
          size('width', m.blockWidth, 'width'),
          size('height', m.blockHeight, 'depth'),
        ]
      case 'base':
        return [
          <Field key="baseType" label={m.baseType} messages={messages('baseType')}>
            <Select
              options={BASE_TYPES.map((t) => ({ value: t, label: m.baseTypes[t] }))}
              value={values.baseType ?? 'spoilboard'}
              disabled={readOnly}
              onValueChange={(baseType) => set({ baseType })}
            />
          </Field>,
          <div key="sacrificial" className={styles['presetFollow']}>
            <Checkbox
              label={m.sacrificial}
              checked={values.sacrificial === true}
              disabled={readOnly}
              aria-describedby={`${hintId}-sacrificial`}
              onCheckedChange={(c) => set({ sacrificial: c === true })}
            />
            <span id={`${hintId}-sacrificial`} className={styles['presetFollowNote']}>
              {m.sacrificialHint}
            </span>
          </div>,
          size('thickness', m.thickness, 'stock-thickness', {
            optional: true,
            info: m.thicknessInfo,
          }),
        ]
      case 'surface':
        return [
          <Field key="surfaceType" label={m.surfaceType} messages={messages('surfaceType')}>
            <Select
              options={SURFACE_TYPES.map((t) => ({ value: t, label: m.surfaceTypes[t] }))}
              value={values.surfaceType ?? 'tape'}
              disabled={readOnly}
              onValueChange={(surfaceType) => set({ surfaceType })}
            />
          </Field>,
        ]
    }
  }

  // Range: the toe clamp's grip, the vise's max opening; closed with its summary while empty
  const rangeFields =
    type === 'toeClamp'
      ? [
          size('gripMin', m.gripMin, 'width', { optional: true, info: m.gripInfo }),
          size('gripMax', m.gripMax, 'width', { optional: true }),
        ]
      : type === 'vise'
        ? [
            size('maxOpening', m.maxOpening, 'slotWidth', {
              optional: true,
              info: m.maxOpeningInfo,
            }),
          ]
        : null
  const rangeSummary =
    type === 'toeClamp'
      ? values.gripMin === undefined && values.gripMax === undefined
        ? m.rangeEmpty
        : `${values.gripMin === undefined ? '–' : quantityText(values.gripMin)}–${values.gripMax === undefined ? '–' : quantityText(values.gripMax)}`
      : values.maxOpening === undefined
        ? m.rangeEmpty
        : quantityText(values.maxOpening)
  const rangeKeys = type === 'toeClamp' ? ['gripMin', 'gripMax'] : ['maxOpening']
  const rangeProblem = rangeKeys.some((k) => messages(k).some((x) => x.severity === 'error'))
  const rangeEmpty = rangeSummary === m.rangeEmpty

  // Details: the stud or thread (display only) and the notes
  const text = type === 'toeClamp' ? 'stud' : type === 'screw' ? 'thread' : undefined
  const detailsProblem = [text ?? '', 'notes'].some((k) =>
    messages(k).some((x) => x.severity === 'error'),
  )
  const detailsSummary =
    [
      text === undefined ? undefined : values[text],
      libraryMessages.window.notesSummary(values.notes),
    ]
      .filter((x) => x !== undefined && x !== '')
      .join(' · ') || undefined

  return (
    <>
      <NameField
        value={values.name}
        messages={messages('name')}
        readOnly={readOnly}
        onChange={(name) => set({ name })}
      />
      <FixedField label={m.type} value={m.types[type]} />
      <InspectorGroup title={g.device}>
        <WithAside aside={<WorkholdingDrawing values={values} focused={focused} />}>
          {device()}
          <Focusable field="default" onFocusField={onFocusField}>
            <div className={styles['presetFollow']}>
              <Switch
                label={m.defaultFor(type)}
                checked={defaultSwitch.checked}
                disabled={defaultSwitch.disabled}
                aria-describedby={`${hintId}-default`}
                onCheckedChange={defaultSwitch.onChange}
              />
              <span id={`${hintId}-default`} className={styles['presetFollowNote']}>
                {m.defaultHint(type)}
              </span>
            </div>
          </Focusable>
        </WithAside>
      </InspectorGroup>
      {rangeFields === null ? null : (
        <InspectorGroup
          title={g.range}
          collapsible
          defaultOpen={!rangeEmpty}
          forceOpen={rangeProblem}
          summary={rangeSummary}
          severity={rangeProblem ? 'error' : undefined}
        >
          {rangeFields}
        </InspectorGroup>
      )}
      <InspectorGroup
        title={libraryMessages.window.groups.details}
        collapsible
        forceOpen={detailsProblem}
        summary={detailsSummary}
        severity={detailsProblem ? 'error' : undefined}
      >
        {text === undefined ? null : (
          <Field
            label={text === 'stud' ? m.stud : m.thread}
            messages={messages(text)}
            info={text === 'stud' ? m.studInfo : m.threadInfo}
            readOnly={readOnly}
          >
            <FieldInput
              value={values[text] ?? ''}
              maxLength={20}
              readOnly={readOnly}
              onChange={(e) => set({ [text]: e.target.value === '' ? undefined : e.target.value })}
            />
          </Field>
        )}
        <NotesField
          value={values.notes}
          messages={messages('notes')}
          readOnly={readOnly}
          onChange={(notes) => set({ notes })}
        />
      </InspectorGroup>
    </>
  )
}
