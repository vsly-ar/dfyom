// The machine form, shared by the Library window's editor (`full`: adds acceleration, motion
// planning `$11`/`$12`, steps per mm and notes)
// and the quick "New machine…" dialog (`quick`: the v0.1 fields). GRBL controller and manual tool
// change are fixed values (library.md#machine). Doc: docs/conventions/ui-library-window.md#layout, L4
import { RIGIDITY_PRESETS } from '../../../core/library/machine.dto'
import type { QuantityDTO } from '../../../core/quantity/quantity.dto'
import type { QuantityKind } from '../../../core/quantity/units'
import { libraryMessages } from '../messages/library'
import { Field, SegmentedControl, Select, type FieldIconName } from '../ui'
import { AXES, type Axis, type MachineDraft, type QDto } from './form'
import { FixedField, Group, NameField, NotesField, QuantityField, type FormProps } from './fields'
import styles from './LibraryForm.module.css'

const m = libraryMessages.machine
const g = libraryMessages.window.groups
const AXIS_ICON: Record<Axis, FieldIconName> = { x: 'length', y: 'width', z: 'depth' }

/** Every field key of the machine form (issue mapping). */
export const MACHINE_FIELDS: readonly string[] = [
  'name',
  ...AXES.map((a) => `travel.${a}`),
  ...AXES.map((a) => `maxFeedRate.${a}`),
  ...AXES.map((a) => `acceleration.${a}`),
  'junctionDeviation',
  'arcTolerance',
  ...AXES.map((a) => `stepsPerMm.${a}`),
  'spindle.maxSpeed',
  'spindle.minSpeed',
  'spindle.power',
  'rigidity',
  'travel',
  'maxFeedRate',
  'acceleration',
  'stepsPerMm',
  'spindle',
  'programUnits',
  'notes',
]

function Choice({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div className={styles['choice']}>
      <span className={styles['caption']} aria-hidden="true">
        {caption}
      </span>
      {children}
    </div>
  )
}

export function MachineFields({
  values,
  onChange,
  units,
  messages,
  variant,
}: FormProps<MachineDraft>): React.JSX.Element {
  const full = variant === 'full'
  const set = (patch: Partial<MachineDraft>) => onChange({ ...values, ...patch })
  const spindle = (patch: Partial<MachineDraft['spindle']>) =>
    set({ spindle: { ...values.spindle, ...patch } })
  const q = <K extends QuantityKind>(
    field: string,
    label: string,
    kind: K,
    value: QuantityDTO | undefined,
    icon: FieldIconName,
    onValue: (v: QDto<K> | undefined) => void,
    opts: { optional?: boolean; note?: string } = {},
  ) => (
    <QuantityField
      key={field}
      field={field}
      label={label}
      kind={kind}
      value={value}
      units={units}
      icon={icon}
      messages={messages}
      note={opts.note}
      optional={opts.optional ?? false}
      onChange={onValue}
    />
  )
  const axes = (
    field: 'travel' | 'maxFeedRate',
    kind: QuantityKind,
    label: (a: string) => string,
  ) =>
    AXES.map((a) =>
      q(`${field}.${a}`, label(a.toUpperCase()), kind, values[field][a], AXIS_ICON[a], (v) => {
        if (v !== undefined) set({ [field]: { ...values[field], [a]: v } })
      }),
    )

  /** An optional all-or-none group of three scalar axes (acceleration, steps per mm). */
  const scalarAxes = (
    field: 'acceleration' | 'stepsPerMm',
    title: string,
    label: (axis: string) => string,
    note: string,
  ) => (
    <Group title={title}>
      {AXES.map((a, i) =>
        q(
          `${field}.${a}`,
          label(a.toUpperCase()),
          'scalar',
          values[field]?.[a],
          AXIS_ICON[a],
          (v) => set({ [field]: { ...values[field], [a]: v } }),
          i === 0 ? { optional: true, note } : { optional: true },
        ),
      )}
      {messages(field).map((e) => (
        <p key={e.id} role="alert" className={styles['groupError']}>
          {e.text}
        </p>
      ))}
    </Group>
  )

  const fixed = full ? (
    <Group title={g.controller}>
      <FixedField label={m.controller} value={m.controllerValue} />
      <FixedField label={m.toolChanger} value={m.toolChangerValue} />
    </Group>
  ) : null

  return (
    <>
      <NameField
        value={values.name}
        messages={messages('name')}
        onChange={(name) => set({ name })}
      />
      <Group title={m.travel}>{axes('travel', 'length', m.travelAxis)}</Group>
      <Group title={m.maxFeed}>{axes('maxFeedRate', 'feedRate', m.maxFeedAxis)}</Group>
      {full
        ? scalarAxes('acceleration', m.acceleration, m.accelerationAxis, m.accelerationNote)
        : null}
      {full ? (
        <Group title={m.motion}>
          {q(
            'junctionDeviation',
            m.junctionDeviation,
            'length',
            values.junctionDeviation,
            'corner',
            (junctionDeviation) => set({ junctionDeviation }),
            { optional: true, note: m.junctionDeviationNote },
          )}
          {q(
            'arcTolerance',
            m.arcTolerance,
            'length',
            values.arcTolerance,
            'arcTolerance',
            (arcTolerance) => set({ arcTolerance }),
            { optional: true, note: m.arcToleranceNote },
          )}
        </Group>
      ) : null}
      <Group title={m.spindle}>
        <Choice caption={m.control}>
          <SegmentedControl<'manual' | 'gcode'>
            label={m.control}
            options={[
              { value: 'manual', label: m.controls.manual },
              { value: 'gcode', label: m.controls.gcode },
            ]}
            value={values.spindle.control}
            onValueChange={(control) => spindle({ control })}
          />
        </Choice>
        {q(
          'spindle.maxSpeed',
          m.maxSpeed,
          'spindleSpeed',
          values.spindle.maxSpeed,
          'spindle',
          (v) => {
            if (v !== undefined) spindle({ maxSpeed: v })
          },
        )}
        {q(
          'spindle.minSpeed',
          m.minSpeed,
          'spindleSpeed',
          values.spindle.minSpeed,
          'spindle',
          (minSpeed) => spindle({ minSpeed }),
          { optional: true, note: m.minSpeedNote },
        )}
        {q(
          'spindle.power',
          m.power,
          'power',
          values.spindle.power,
          'tool',
          (power) => spindle({ power }),
          { optional: true, note: m.powerNote },
        )}
      </Group>
      <Field label={m.rigidity} messages={messages('rigidity')}>
        <Select
          options={RIGIDITY_PRESETS.map((r) => ({ value: r, label: m.rigidities[r] }))}
          value={values.rigidity ?? 'extrusion'}
          onValueChange={(rigidity) => set({ rigidity })}
        />
      </Field>
      <Choice caption={m.programUnits}>
        <SegmentedControl<'mm' | 'in'>
          label={m.programUnits}
          options={[
            { value: 'mm', label: m.units.mm },
            { value: 'in', label: m.units.in },
          ]}
          value={values.programUnits}
          onValueChange={(programUnits) => set({ programUnits })}
        />
      </Choice>
      {full ? scalarAxes('stepsPerMm', m.stepsPerMm, m.stepsPerMmAxis, m.stepsPerMmNote) : null}
      {fixed}
      {full ? (
        <Group title={g.notes}>
          <NotesField
            value={values.notes}
            messages={messages('notes')}
            onChange={(notes) => set({ notes })}
          />
        </Group>
      ) : null}
    </>
  )
}
