// The machine form, shared by the Library window's editor (`full`: adds acceleration, motion
// planning `$11`/`$12`, steps per mm and notes, in three tabs Machine / Motion / Spindle, DF110)
// and the quick "New machine…" dialog (`quick`: the v0.1 fields and the Z height of DF68, no tabs).
// GRBL controller and manual tool change are fixed values (library.md#machine).
// Docs: docs/conventions/ui-library-window.md#layout, L4;
// docs/conventions/inspector-layout.md#per-inspector-target-layout
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
  Tabs,
  type FieldIconName,
  type FieldMessage,
  type StepKind,
} from '../ui'
import { AXES, type Axis, type MachineDraft, type QDto } from './form'
import { FixedField, NameField, NotesGroup, QuantityField, type FormProps } from './fields'
import styles from './LibraryForm.module.css'

const m = libraryMessages.machine

const g = libraryMessages.window.groups
const tabs = libraryMessages.window.machineTabs
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

type MachineTab = 'machine' | 'motion' | 'spindle'

/** The full form's tab of a field key (its first path segment): a problem marks the tab. */
function tabOf(field: string): MachineTab {
  const head = field.split('.')[0]
  if (head === 'spindle') return 'spindle'
  if (
    head === 'maxFeedRate' ||
    head === 'acceleration' ||
    head === 'junctionDeviation' ||
    head === 'arcTolerance' ||
    head === 'stepsPerMm'
  )
    return 'motion'
  return 'machine'
}

/** The worst problem among the tab's fields (the name sits above the tabs). */
function tabSeverity(
  tab: MachineTab,
  messages: (field: string) => FieldMessage[],
): 'error' | 'warning' | undefined {
  const all = MACHINE_FIELDS.filter((f) => f !== 'name' && tabOf(f) === tab).flatMap(messages)
  if (all.some((x) => x.severity === 'error' || x.severity === 'hard')) return 'error'
  if (all.some((x) => x.severity === 'soft')) return 'warning'
  return undefined
}

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
    stepKind: StepKind,
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
      stepKind={stepKind}
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
      q(
        `${field}.${a}`,
        field === 'travel' ? 'xy' : 'feed',
        label(a.toUpperCase()),
        kind,
        values[field][a],
        AXIS_ICON[a],
        (v) => {
          if (v !== undefined) set({ [field]: { ...values[field], [a]: v } })
        },
      ),
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
          'machine',
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

  const name = (
    <NameField value={values.name} messages={messages('name')} onChange={(name) => set({ name })} />
  )
  const travel = (
    <InspectorGroup title={m.travel}>{axes('travel', 'length', m.travelAxis)}</InspectorGroup>
  )
  const maxFeed = (
    <InspectorGroup title={m.maxFeed}>
      {axes('maxFeedRate', 'feedRate', m.maxFeedAxis)}
    </InspectorGroup>
  )
  // DF68: the Z headroom estimate's distances, in both variants (a safety check)
  const zHeight = (
    <InspectorGroup title={m.zHeight}>
      {q(
        'noseToTable',
        'depth',
        m.noseToTable,
        'length',
        values.noseToTable,
        'clearance',
        (noseToTable) => set({ noseToTable }),
        { optional: true, info: m.noseToTableNote },
      )}
      {q(
        'spoilboardThickness',
        'depth',
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
        'depth',
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
        'depth',
        m.probePlateThickness,
        'length',
        values.probePlateThickness,
        'depth',
        (probePlateThickness) => set({ probePlateThickness }),
        { optional: true, info: m.probePlateThicknessNote },
      )}
    </InspectorGroup>
  )
  const spindleGroup = (
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
        'rpm',
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
        'rpm',
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
            'rpm',
            m.controllerMinSpeed,
            'spindleSpeed',
            values.spindle.controllerMinSpeed,
            'spindle',
            (controllerMinSpeed) => spindle({ controllerMinSpeed }),
            { optional: true, info: m.controllerRangeNote },
          )}
          {q(
            'spindle.controllerMaxSpeed',
            'rpm',
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
        'rpm',
        m.power,
        'power',
        values.spindle.power,
        'tool',
        (power) => spindle({ power }),
        { optional: true, info: m.powerNote },
      )}
    </InspectorGroup>
  )
  const rigidity = (
    <Field label={m.rigidity} messages={messages('rigidity')}>
      <Select
        options={RIGIDITY_PRESETS.map((r) => ({ value: r, label: m.rigidities[r] }))}
        value={values.rigidity ?? 'extrusion'}
        onValueChange={(rigidity) => set({ rigidity })}
      />
    </Field>
  )
  const programUnits = (
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
  )

  // the quick "New machine…" dialog: the v0.1 fields in one column, as before
  if (!full)
    return (
      <>
        {name}
        {travel}
        {maxFeed}
        {zHeight}
        {spindleGroup}
        {rigidity}
        {programUnits}
      </>
    )

  // the Library window: Machine (frame, travel, heights, homing, controller, notes) / Motion
  // (feeds, acceleration, motion planning, drive) / Spindle (DF110)
  const machineTab = (
    <div className={styles['tabBody']}>
      {rigidity}
      {travel}
      {zHeight}
      <InspectorGroup title={m.homing}>
        <Field label={m.homingCorner} messages={messages('homingCorner')} info={m.homingCornerNote}>
          <Select
            options={HOMING_CORNERS.map((c) => ({ value: c, label: m.homingCorners[c] }))}
            value={values.homingCorner ?? 'backRight'}
            onValueChange={(homingCorner) => set({ homingCorner })}
          />
        </Field>
        {q(
          'pullOff',
          'depth',
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
      <InspectorGroup title={g.controller}>
        <FixedField label={m.controller} value={m.controllerValue} />
        <FixedField label={m.toolChanger} value={m.toolChangerValue} />
        {programUnits}
      </InspectorGroup>
      <NotesGroup
        kind="machine"
        value={values.notes}
        messages={messages('notes')}
        onChange={(notes) => set({ notes })}
      />
    </div>
  )
  const motionTab = (
    <div className={styles['tabBody']}>
      {maxFeed}
      {scalarAxes('acceleration', m.acceleration, m.accelerationAxis, m.accelerationNote)}
      <InspectorGroup title={m.motion}>
        {q(
          'junctionDeviation',
          'tolerance',
          m.junctionDeviation,
          'length',
          values.junctionDeviation,
          'corner',
          (junctionDeviation) => set({ junctionDeviation }),
          { optional: true, info: m.junctionDeviationNote },
        )}
        {q(
          'arcTolerance',
          'tolerance',
          m.arcTolerance,
          'length',
          values.arcTolerance,
          'arcTolerance',
          (arcTolerance) => set({ arcTolerance }),
          { optional: true, info: m.arcToleranceNote },
        )}
      </InspectorGroup>
      {scalarAxes('stepsPerMm', m.stepsPerMm, m.stepsPerMmAxis, m.stepsPerMmNote)}
    </div>
  )
  return (
    <>
      {name}
      <Tabs<MachineTab>
        label={tabs.label}
        rememberKey="library.machine"
        sticky
        items={[
          {
            value: 'machine',
            label: tabs.machine,
            content: machineTab,
            severity: tabSeverity('machine', messages),
          },
          {
            value: 'motion',
            label: tabs.motion,
            content: motionTab,
            severity: tabSeverity('motion', messages),
          },
          {
            value: 'spindle',
            label: tabs.spindle,
            content: <div className={styles['tabBody']}>{spindleGroup}</div>,
            severity: tabSeverity('spindle', messages),
          },
        ]}
      />
    </>
  )
}
