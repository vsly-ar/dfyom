// Setup inspector (v0.2 task F6): a setup selected in the setup panel – its name, the face up to
// the spindle (direction icon and word), the work zero G54 at its part corner, how far the tool
// reaches past the stock (DF59), the rotation about the spindle axis (0/90/180/270°), the safe
// heights (clearance with the clamp note, retract; moved here from the navigator) and the
// machine checks of this setup. Each change is one `plan.setup.update`.
// Read-only (with the plan's reason in the navigator) outside draft and settled design.
// Doc: docs/conventions/ui.md#design-and-plan-controls-v02, docs/modes/plan-v0.2.md#setups-from-face-directions
import { useState } from 'react'
import { DIRECTION_LABEL } from '../../../../core/geometry/face'
import type { PlanWarning } from '../../../../core/plan/checks'
import {
  SETUP_ROTATIONS,
  type PlanDTO,
  type SetupDTO,
  type SetupRotation,
} from '../../../../core/plan/plan.dto'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import type { Overreach } from '../../../../core/toolpath/overreach'
import type { AppErrorData, Issue } from '../../../../shared/errors/app-error'
import { formatHeight, formatReach, planMessages, sentence } from '../../messages/plan'
import { useCancelGesture } from '../../shell/hooks'
import {
  ErrorMessage,
  Field,
  FieldIcon,
  PanelHeader,
  QuantityInput,
  SegmentedControl,
  WarningList,
  type FieldMessage,
} from '../../ui'
import { defaultUnit, quantityOf } from '../design/model'
import { DirectionIcon } from './DirectionIcon'
import {
  allows,
  directionOfSetup,
  planStockSize,
  setupCorner,
  setupOverreach,
  type ToolpathEntry,
} from './model'
import { usePlanCommand } from './plan-store'
import styles from './Plan.module.css'
import { NameField, planWarningLabels, planWarningView } from './PlanInspector'
import { usePlanSelection } from './usePlan'

const m = planMessages.setup

export function SetupInspector({
  doc,
  plan,
  setup,
  warnings,
  toolpaths = {},
}: {
  doc: ProjectDoc
  plan: PlanDTO
  setup: SetupDTO
  warnings: readonly PlanWarning[]
  toolpaths?: Readonly<Record<string, ToolpathEntry>>
}): React.JSX.Element {
  const call = usePlanCommand()
  const [, select] = usePlanSelection()
  const cancelGesture = useCancelGesture()
  const [errors, setErrors] = useState<readonly Issue[]>([])
  const [failed, setFailed] = useState<AppErrorData | undefined>(undefined)
  const units = doc.unitSystem
  const readOnly = !allows(plan, 'plan.setup.update')
  const index = plan.setups.findIndex((s) => s.id === setup.id)
  const direction = directionOfSetup(setup)
  const face = DIRECTION_LABEL[direction]
  const stock = planStockSize(doc, plan)
  // per-setup machine checks carry the setup (plan-v0.2.md#implementation-task-e1)
  const mine = warnings.filter((w) => w.params['setupId'] === setup.id)
  const reach = reachText(setupOverreach(setup, toolpaths), units)
  const clearance = quantityOf(setup.clearanceHeight)
  const clampNote: FieldMessage[] =
    clearance === undefined
      ? []
      : [
          {
            id: 'clampNote',
            severity: 'note',
            text: m.clampNote(formatHeight(clearance.canonical, units)),
          },
        ]

  const update = async (args: object, gesture?: string) => {
    const r = await call(
      'plan.setup.update',
      { planId: plan.id, setupId: setup.id, ...args },
      gesture === undefined ? undefined : { gesture },
    )
    setErrors(r.ok ? [] : r.error.issues)
    setFailed(r.ok || r.error.issues.length > 0 ? undefined : r.error)
  }
  const messages = (key: string): FieldMessage[] =>
    errors
      .filter((i) => i.path[0] === key)
      .map((i, n) => ({ id: `${key}-${n}`, severity: 'error', text: sentence(i.message) }))

  return (
    <div className={styles['inspector']}>
      <PanelHeader title={m.inspector} meta={m.position(index + 1, plan.setups.length)} />
      <div className={styles['fields']}>
        <NameField
          label={m.name}
          name={setup.name}
          readOnly={readOnly}
          onCommit={(name) => void update({ name })}
        />
        {failed ? (
          <ErrorMessage error={failed} message={planMessages.inspector.commandFailed} />
        ) : null}
        <div className={styles['setupFacts']}>
          <DirectionIcon direction={direction} className={styles['dirIconLg']} />
          <dl className={styles['facts']}>
            <dt>{m.direction}</dt>
            <dd>{m.directionValue(face)}</dd>
            {stock !== undefined ? (
              <>
                <dt>{m.workOffset}</dt>
                <dd>{m.workOffsetValue(setupCorner(setup, stock), face)}</dd>
              </>
            ) : null}
            <dt>{m.reach}</dt>
            <dd>{reach}</dd>
          </dl>
        </div>
        <Field
          label={m.rotation}
          kind="toggle"
          illustration={<FieldIcon name="rotation" />}
          readOnly={readOnly}
          messages={[{ id: 'rotationHint', severity: 'note', text: m.rotationHint }]}
        >
          <SegmentedControl<string>
            label={m.rotation}
            options={SETUP_ROTATIONS.map((r) => ({ value: String(r), label: `${r}°` }))}
            value={String(setup.rotation ?? 0)}
            disabled={readOnly}
            onValueChange={(v) => {
              const rotation = Number(v) as SetupRotation
              if (rotation !== (setup.rotation ?? 0)) void update({ rotation })
            }}
          />
        </Field>
        <QuantityInput
          label={m.clearanceHeight}
          kind="length"
          defaultUnit={defaultUnit('length', units)}
          value={quantityOf(setup.clearanceHeight)}
          illustration={<FieldIcon name="clearance" />}
          readOnly={readOnly}
          messages={[...messages('clearanceHeight'), ...clampNote]}
          onCommit={(q, gesture) => void update({ clearanceHeight: q.source }, gesture)}
          onCancelGesture={cancelGesture}
        />
        <QuantityInput
          label={m.retractHeight}
          kind="length"
          defaultUnit={defaultUnit('length', units)}
          value={quantityOf(setup.retractHeight)}
          illustration={<FieldIcon name="retract" />}
          readOnly={readOnly}
          messages={messages('retractHeight')}
          onCommit={(q, gesture) => void update({ retractHeight: q.source }, gesture)}
          onCancelGesture={cancelGesture}
        />
        {mine.length > 0 ? (
          <section aria-label={m.findings} className={styles['warnings']}>
            <h3 className={styles['groupTitle']}>{m.findings}</h3>
            <WarningList
              labels={planWarningLabels}
              items={mine.map((w, i) => planWarningView(w, plan, select, i, units))}
              empty=""
            />
          </section>
        ) : null}
      </div>
    </div>
  )
}

/** The setup's reach past the stock as a sentence (DF59), or why it is not known yet. */
function reachText(reach: Overreach | undefined, units: UnitSystem): string {
  if (reach === undefined) return m.reachUnknown
  const sides = (
    [
      ['left', reach.xMin],
      ['right', reach.xMax],
      ['front', reach.yMin],
      ['back', reach.yMax],
    ] as const
  )
    .filter(([, v]) => v > 0)
    .map(([side, v]) => m.reachSide(side, formatReach(v, units)))
  return sides.length === 0 ? m.reachNone : m.reachValue(sides)
}
