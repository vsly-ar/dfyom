// Plan operation inspector, alignment aids (hardening DF78 slice 2): an aid's name, its position
// in the setup frame (a mark's spot or line ends, a hole's centre), its size (mark Ø; hole Ø and
// depth into the spoilboard) and Remove. Each commit is one `plan.aid.set` with the changed key;
// lengths are sent as entered (project units). Tool, strategy and feeds stay in their own groups.
// DF83: a mark's depth (by its pointed V-bit's angle; sets the width) and a line's length (moves
// its end along the line); the position can also be dragged in the viewport (aid-drag.ts).
// Doc: docs/modes/alignment.md#implementation-slice-2, docs/conventions/ui.md#design-and-plan-controls-v02
import type { AidDTO } from '../../../../core/plan/alignment.dto'
import { AID } from '../../../../core/plan/alignment.dto'
import { markDepth } from '../../../../core/plan/aids'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import type { PlanWarning } from '../../../../core/plan/checks'
import type { PlanDTO, PlanOperationDTO } from '../../../../core/plan/plan.dto'
import type { UnitSystem } from '../../../../core/project/document'
import { fieldContext } from '../../../../core/design/operation'
import { Quantity } from '../../../../core/quantity/quantity'
import { lengthSource } from '../../messages/dfm'
import { findingText, planMessages } from '../../messages/plan'
import { useCancelGesture } from '../../shell/hooks'
import {
  Button,
  FieldIcon,
  Icon,
  InspectorGroup,
  QuantityInput,
  type FieldMessage,
  type StepKind,
} from '../../ui'
import { defaultUnit, quantityOf } from '../design/model'
import styles from './Plan.module.css'
import { NameField } from './PlanInspector'

const m = planMessages.aid

/** An aid's size fields. */
type AidSizeField = 'diameter' | 'spoilboardDepth' | 'lineLength' | 'markDiameter' | 'markDepth'
/** Adjust steps per aid size (inspector-layout.md § Step assignment per field). */
const AID_STEP: Record<AidSizeField, StepKind> = {
  diameter: 'small',
  spoilboardDepth: 'depth',
  lineLength: 'xy',
  markDiameter: 'small',
  markDepth: 'depth',
}

type XY = readonly [number, number]

/** The included angle (deg) of the op's tool when it is a pointed V-bit (tip Ø 0), else undefined. */
function vBitAngle(plan: PlanDTO, op: PlanOperationDTO): number | undefined {
  const values = plan.snapshots.find((s) => s.id === op.tool)?.values as
    { type?: string; angle?: QuantityDTO; tipDiameter?: QuantityDTO } | undefined
  if (values?.type !== 'chamferMill' || values.angle === undefined) return undefined
  const tip =
    values.tipDiameter === undefined ? 0 : (quantityOf(values.tipDiameter)?.canonical ?? 0)
  return tip > 1e-9 ? undefined : quantityOf(values.angle)?.canonical
}

export function AidFields({
  plan,
  op,
  aid,
  units,
  readOnly,
  findings,
  onSet,
}: {
  plan: PlanDTO
  op: PlanOperationDTO
  aid: AidDTO
  units: UnitSystem
  readOnly: boolean
  findings: readonly PlanWarning[]
  /** `plan.aid.set` with `aid` (undefined removes the aid). */
  onSet: (aid: object | undefined) => void
}): React.JSX.Element {
  const cancelGesture = useCancelGesture()
  const unit = defaultUnit('length', units)
  const q = (mm: number) =>
    Quantity.parse(lengthSource(mm, units), fieldContext('length', units)).unwrap()
  const src = (mm: number) => lengthSource(mm, units)
  const own: FieldMessage[] = findings
    .filter((f) => f.code === 'plan.aid')
    .map((f, i) => ({
      id: `aid-${i}`,
      severity: f.severity === 'error' ? 'error' : 'soft',
      text: findingText(f, units),
    }))
  const point = (key: 'at' | 'from' | 'to' | 'center', label: string, at: XY, notes = false) =>
    ([0, 1] as const).map((k) => (
      <QuantityInput
        key={`${key}${k}`}
        label={`${label} ${k === 0 ? 'X' : 'Y'}`}
        stepKind="xy"
        kind="length"
        defaultUnit={unit}
        value={q(at[k])}
        illustration={<FieldIcon name={k === 0 ? 'positionX' : 'positionY'} />}
        readOnly={readOnly}
        messages={notes && k === 1 ? own : []}
        onCommit={(v) => {
          const next = [src(at[0]), src(at[1])]
          next[k] = v.source
          onSet({ [key]: next })
        }}
        onCancelGesture={cancelGesture}
      />
    ))
  const size = (
    key: AidSizeField,
    label: string,
    mm: number,
    hint?: string,
    commit: (v: Quantity) => void = (v) => onSet({ [key]: v.source }),
  ) => (
    <QuantityInput
      key={key}
      label={label}
      kind="length"
      defaultUnit={unit}
      value={q(mm)}
      readOnly={readOnly}
      stepKind={AID_STEP[key]}
      {...(hint === undefined ? {} : { info: hint })}
      onCommit={commit}
      onCancelGesture={cancelGesture}
    />
  )
  // DF83: the mark's depth by its V-bit (sets the width), or a note to assign one
  const angle = aid.kind === 'witnessMark' ? vBitAngle(plan, op) : undefined
  const width = aid.kind === 'witnessMark' ? (aid.markDiameter ?? AID.markDiameter) : 0
  const depthField =
    angle === undefined ? (
      <p className={styles['muted']}>{m.markDepthNone}</p>
    ) : (
      size(
        'markDepth',
        m.markDepth,
        markDepth(width, angle),
        m.markDepthHint(`${Math.round(angle * 100) / 100}°`),
      )
    )
  const lineLength = (from: XY, to: XY) => {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1])
    return size('lineLength', m.lineLength, len, m.lineLengthHint, (v) => {
      const k = len === 0 ? [1, 0] : [(to[0] - from[0]) / len, (to[1] - from[1]) / len]
      const end = [from[0] + k[0]! * v.canonical, from[1] + k[1]! * v.canonical]
      onSet({ to: [src(end[0]!), src(end[1]!)] })
    })
  }
  const setup = plan.setups.find((s) => s.operations.some((o) => o.id === op.id))
  return (
    <InspectorGroup title={m.title}>
      <p className={styles['muted']}>{m.hint(m.kind[aid.kind] ?? aid.kind, setup?.name ?? '')}</p>
      <NameField
        label={m.name}
        name={aid.name}
        readOnly={readOnly}
        onCommit={(name) => onSet({ name })}
      />
      {aid.kind === 'registrationHole' ? (
        <>
          {point('center', m.center, aid.center, true)}
          {size('diameter', m.diameter, aid.diameter, m.diameterHint)}
          {size(
            'spoilboardDepth',
            m.spoilboardDepth,
            aid.spoilboardDepth ?? AID.spoilboardDepth,
            m.spoilboardDepthHint,
          )}
        </>
      ) : 'from' in aid ? (
        <>
          {point('from', m.from, aid.from, false)}
          {point('to', m.to, aid.to, true)}
          {lineLength(aid.from, aid.to)}
          {size('markDiameter', m.markDiameter, width, m.markHint)}
          {depthField}
        </>
      ) : (
        <>
          {point('at', m.at, aid.at, true)}
          {size('markDiameter', m.markDiameter, width, m.markHint)}
          {depthField}
        </>
      )}
      {readOnly ? null : <p className={styles['muted']}>{m.dragHint}</p>}
      {readOnly ? null : (
        <div className={styles['alignActions']}>
          <Button size="sm" variant="danger" onClick={() => onSet(undefined)}>
            <Icon name="delete" /> {m.remove}
          </Button>
        </div>
      )}
    </InspectorGroup>
  )
}
