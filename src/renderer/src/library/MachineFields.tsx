// The machine form, shared by the Library window's editor (`full`: adds acceleration, motion
// planning `$11`/`$12`, steps per mm and notes)
// and the quick "New machine…" dialog (`quick`: the v0.1 fields and the Z height of DF68). GRBL controller and manual tool
// change are fixed values (library.md#machine). Doc: docs/conventions/ui-library-window.md#layout, L4
import { HOMING_CORNERS, RIGIDITY_PRESETS } from '../../../core/library/machine.dto'
import type { QuantityDTO } from '../../../core/quantity/quantity.dto'
import type { QuantityKind } from '../../../core/quantity/units'
import { libraryMessages } from '../messages/library'
import {
  Field,
  InspectorGroup,
  SegmentedControl,
  Select,
  Switch,
  type FieldIconName,
  type StepKind,
} from '../ui'
import { AXES, type Axis, type MachineDraft, type QDto } from './form'
import { FixedField, NameField, NotesField, QuantityField, type FormProps } from './fields'
import styles from './LibraryForm.module.css'

const m = libraryMessages.machine

/** Adjust steps per machine field (inspector-layout.md § Step assignment per field). */
function machineStep(field: string): StepKind {
  if (field.startsWith('travel.')) return 'xy'
  if (field.startsWith('maxFeedRate.')) return 'feed'
  if (field.startsWith('acceleration.') || field.startsWith('stepsPerMm.')) return 'machine'
  if (field === 'junctionDeviation' || field === 'arcTolerance') return 'tolerance'
  if (field.startsWith('spindle.')) return 'rpm'
  return 'depth'
}
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
  'spindle.controllerMinSpeed',
  'spindle.controllerMaxSpeed',
  'spindle.power',
  'rigidity',
  'homingCorner',
  'pullOff',
  'softLimits',
  'noseToTable',
  'spoilboardThickness',
  'probePlateSize',
  'probePlateThickness',
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
    opts: { optional?: boolean; info?: string } = {},
  ) => (
    <QuantityField
      key={field}
      field={field}
      stepKind={machineStep(field)}
      label={label}
      kind={kind}
      value={value}
      units={units}
      icon={icon}
      messages={messages}
      info={opts.info}
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
    <InspectorGroup title={title}>
      {AXES.map((a, i) =>
        q(
          `${field}.${a}`,
          label(a.toUpperCase()),
          'scalar',
          values[field]?.[a],
          AXIS_ICON[a],
          (v) => set({ [field]: { ...values[field], [a]: v } }),
          i === 0 ? { optional: true, info: note } : { optional: true },
        ),
      )}
      {messages(field).map((e) => (
        <p key={e.id} role="alert" className={styles['groupError']}>
          {e.text}
        </p>
      ))}
    </InspectorGroup>
  )

  const fixed = full ? (
    <InspectorGroup title={g.controller}>
      <FixedField label={m.controller} value={m.controllerValue} />
      <FixedField label={m.toolChanger} value={m.toolChangerValue} />
    </InspectorGroup>
  ) : null

  return (
    <>
      <NameField
        value={values.name}
        messages={messages('name')}
        onChange={(name) => set({ name })}
      />
      <InspectorGroup title={m.travel}>{axes('travel', 'length', m.travelAxis)}</InspectorGroup>
      <InspectorGroup title={m.maxFeed}>
        {axes('maxFeedRate', 'feedRate', m.maxFeedAxis)}
      </InspectorGroup>
      {/* DF68: the Z headroom estimate's distances, in both variants (a safety check) */}
      <InspectorGroup title={m.zHeight}>
        {q(
          'noseToTable',
          m.noseToTable,
          'length',
          values.noseToTable,
          'clearance',
          (noseToTable) => set({ noseToTable }),
          { optional: true, info: m.noseToTableNote },
        )}
        {q(
          'spoilboardThickness',
          m.spoilboardThickness,
          'length',
          values.spoilboardThickness,
          'depth',
          (spoilboardThickness) => set({ spoilboardThickness }),
          { optional: true, info: m.spoilboardThicknessNote },
        )}
        {/* DF69: room for the touch plate at the Z touch-off spot */}
        {q(
          'probePlateSize',
          m.probePlateSize,
          'length',
          values.probePlateSize,
          'width',
          (probePlateSize) => set({ probePlateSize }),
          { optional: true, info: m.probePlateSizeNote },
        )}
        {/* M4: Run's "Probe Z" sets Z0 at the contact minus the plate thickness */}
        {q(
          'probePlateThickness',
          m.probePlateThickness,
          'length',
          values.probePlateThickness,
          'depth',
          (probePlateThickness) => set({ probePlateThickness }),
          { optional: true, info: m.probePlateThicknessNote },
        )}
      </InspectorGroup>
      {full ? (
        <InspectorGroup title={m.homing}>
          <Field
            label={m.homingCorner}
            messages={messages('homingCorner')}
            info={m.homingCornerNote}
          >
            <Select
              options={HOMING_CORNERS.map((c) => ({ value: c, label: m.homingCorners[c] }))}
              value={values.homingCorner ?? 'backRight'}
              onValueChange={(homingCorner) => set({ homingCorner })}
            />
          </Field>
          {q(
            'pullOff',
            m.pullOff,
            'length',
            values.pullOff,
            'depth',
            (pullOff) => set({ pullOff }),
            { optional: true, info: m.pullOffNote },
          )}
          <Switch
            label={m.softLimits}
            checked={values.softLimits ?? true}
            onCheckedChange={(softLimits) => set({ softLimits })}
          />
        </InspectorGroup>
      ) : null}
      {full
        ? scalarAxes('acceleration', m.acceleration, m.accelerationAxis, m.accelerationNote)
        : null}
      {full ? (
        <InspectorGroup title={m.motion}>
          {q(
            'junctionDeviation',
            m.junctionDeviation,
            'length',
            values.junctionDeviation,
            'corner',
            (junctionDeviation) => set({ junctionDeviation }),
            { optional: true, info: m.junctionDeviationNote },
          )}
          {q(
            'arcTolerance',
            m.arcTolerance,
            'length',
            values.arcTolerance,
            'arcTolerance',
            (arcTolerance) => set({ arcTolerance }),
            { optional: true, info: m.arcToleranceNote },
          )}
        </InspectorGroup>
      ) : null}
      <InspectorGroup title={m.spindle}>
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
          { optional: true, info: m.minSpeedNote },
        )}
        {values.spindle.control === 'gcode' ? (
          <>
            {q(
              'spindle.controllerMinSpeed',
              m.controllerMinSpeed,
              'spindleSpeed',
              values.spindle.controllerMinSpeed,
              'spindle',
              (controllerMinSpeed) => spindle({ controllerMinSpeed }),
              { optional: true, info: m.controllerRangeNote },
            )}
            {q(
              'spindle.controllerMaxSpeed',
              m.controllerMaxSpeed,
              'spindleSpeed',
              values.spindle.controllerMaxSpeed,
              'spindle',
              (controllerMaxSpeed) => spindle({ controllerMaxSpeed }),
              { optional: true },
            )}
          </>
        ) : null}
        {q(
          'spindle.power',
          m.power,
          'power',
          values.spindle.power,
          'tool',
          (power) => spindle({ power }),
          { optional: true, info: m.powerNote },
        )}
      </InspectorGroup>
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
        <InspectorGroup title={g.notes}>
          <NotesField
            value={values.notes}
            messages={messages('notes')}
            onChange={(notes) => set({ notes })}
          />
        </InspectorGroup>
      ) : null}
    </>
  )
}
