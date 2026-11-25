// "Part (plan copy)" (task E3b): the design fields of a plan operation's design operations in the
// plan's own part, built from the Design inspector's field components (OperationFields). In a
// settled-design plan each commit is one `plan.design.operation.update` (one undo step); an edited
// operation shows "Edited in plan" and "Revert to design" (`plan.design.operation.revert`). In
// draft the group is read-only with the hint to settle the design; finalized and later read-only.
// Doc: docs/modes/plan-v0.2.md#plan-only-edits-and-the-snapshot-scene,
// docs/conventions/ui.md#design-and-plan-controls-v02
import { useState } from 'react'
import type { PlanDTO, PlanOperationDTO } from '../../../../core/plan/plan.dto'
import type { ProjectDoc } from '../../../../core/project/document'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { planMessages } from '../../messages/plan'
import { useCancelGesture } from '../../shell/hooks'
import { Icon, Button, ErrorMessage, InspectorGroup, StatusChip } from '../../ui'
import {
  OperationFields,
  placeErrors,
  type FieldError,
  type OperationFieldsContext,
} from '../design/OperationFields'
import { allows, editedOperations, planPart } from './model'
import { usePlanCommand } from './plan-store'
import styles from './Plan.module.css'

const m = planMessages
const t = m.inspector.planCopy

export function PlanCopyGroup({
  doc,
  plan,
  op,
}: {
  doc: ProjectDoc
  plan: PlanDTO
  op: PlanOperationDTO
}): React.JSX.Element | null {
  const call = usePlanCommand()
  const cancelGesture = useCancelGesture()
  const [errors, setErrors] = useState<readonly FieldError[]>([])
  const [summary, setSummary] = useState<AppErrorData | undefined>(undefined)
  const part = planPart(doc, plan)
  const ops = op.designOperationIds.flatMap((id) => {
    const o = part.dto.operations.find((d) => d.id === id)
    return o === undefined ? [] : [o]
  })
  if (ops.length === 0) return null
  const canEdit = allows(plan, 'plan.design.operation.update')
  const canRevert = allows(plan, 'plan.design.operation.revert')
  const editedSet = editedOperations(plan)
  const edited = ops.some((o) => editedSet.has(o.id))

  const settle = (r: { ok: true } | { ok: false; error: AppErrorData }, path?: string) => {
    const placed = r.ok ? undefined : placeErrors(r.error, path)
    setErrors(placed?.errors ?? [])
    setSummary(placed?.summary)
  }
  const revert = async () => {
    settle(await call('plan.design.operation.revert', { planId: plan.id, planOperationId: op.id }))
  }

  return (
    <InspectorGroup
      title={t.title}
      meta={edited ? <StatusChip icon={<Icon name="edit" />}>{t.edited}</StatusChip> : undefined}
    >
      {plan.status === 'draft' ? (
        <p className={styles['muted']}>{t.draftHint}</p>
      ) : canEdit ? (
        <p className={styles['muted']}>{t.settledHint}</p>
      ) : null}
      {edited && canRevert ? (
        <Button
          size="sm"
          icon={<Icon name="undo" />}
          className={styles['revert']}
          onClick={() => void revert()}
        >
          {t.revert}
        </Button>
      ) : null}
      {summary ? <ErrorMessage error={summary} message={m.inspector.commandFailed} /> : null}
      {ops.map((o) => {
        const ctx: OperationFieldsContext = {
          part,
          op: o,
          units: part.units,
          warnings: [],
          errors,
          readOnly: !canEdit,
          // the plan scene has no pick mode: references come from the field's list
          pickable: false,
          send: (args, path, gesture) =>
            void call(
              'plan.design.operation.update',
              { planId: plan.id, operationId: o.id, ...args },
              gesture === undefined ? undefined : { gesture },
            ).then((r) => settle(r, path)),
          cancelGesture,
        }
        return (
          <div key={o.id} className={styles['planCopyOperation']}>
            {ops.length > 1 ? <h4 className={styles['groupTitle']}>{o.name}</h4> : null}
            <OperationFields ctx={ctx} level={4} />
          </div>
        )
      })}
    </InspectorGroup>
  )
}
