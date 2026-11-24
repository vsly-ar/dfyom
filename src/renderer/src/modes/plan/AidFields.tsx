// Plan operation inspector, alignment aids (hardening DF78 slice 2): an aid's name, its position
// in the setup frame (a mark's spot or line ends, a hole's centre), its size (mark Ø; hole Ø and
// depth into the spoilboard) and Remove. Each commit is one `plan.aid.set` with the changed key;
// lengths are sent as entered (project units). Tool, strategy and feeds stay in their own groups.
// Doc: docs/modes/alignment.md#implementation-slice-2, docs/conventions/ui.md#design-and-plan-controls-v02
import type { AidDTO } from '../../../../core/plan/alignment.dto'
import { AID } from '../../../../core/plan/alignment.dto'
import type { PlanWarning } from '../../../../core/plan/checks'
import type { PlanDTO, PlanOperationDTO } from '../../../../core/plan/plan.dto'
import type { UnitSystem } from '../../../../core/project/document'
import { fieldContext } from '../../../../core/design/operation'
import { Quantity } from '../../../../core/quantity/quantity'
import { lengthSource } from '../../messages/dfm'
import { findingText, planMessages } from '../../messages/plan'
import { useCancelGesture } from '../../shell/hooks'
import { Button, FieldIcon, Icon, QuantityInput, type FieldMessage } from '../../ui'
import { defaultUnit } from '../design/model'
import styles from './Plan.module.css'
import { NameField } from './PlanInspector'

const m = planMessages.aid

type XY = readonly [number, number]

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
  const size = (key: string, label: string, mm: number, hint?: string) => (
    <QuantityInput
      label={label}
      kind="length"
      defaultUnit={unit}
      value={q(mm)}
      readOnly={readOnly}
      messages={hint === undefined ? [] : [{ id: `${key}Hint`, severity: 'note', text: hint }]}
      onCommit={(v) => onSet({ [key]: v.source })}
      onCancelGesture={cancelGesture}
    />
  )
  const setup = plan.setups.find((s) => s.operations.some((o) => o.id === op.id))
  return (
    <section className={styles['group']} aria-label={m.title}>
      <h3 className={styles['groupTitle']}>{m.title}</h3>
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
          {size('markDiameter', m.markDiameter, aid.markDiameter ?? AID.markDiameter, m.markHint)}
        </>
      ) : (
        <>
          {point('at', m.at, aid.at, true)}
          {size('markDiameter', m.markDiameter, aid.markDiameter ?? AID.markDiameter, m.markHint)}
        </>
      )}
      {readOnly ? null : (
        <div className={styles['alignActions']}>
          <Button size="sm" variant="danger" onClick={() => onSet(undefined)}>
            <Icon name="delete" /> {m.remove}
          </Button>
        </div>
      )}
    </section>
  )
}
