// The operation inspector's Z reference (hardening DF69), for the first plan operation of a tool
// run only: "Z from" (the tool-change row's menu, ToolChanges.tsx) with the run's `plan.zRef`
// findings, and the touch-off spot's X and Y in the project units, the keyboard way to move the
// spot the viewport drags. Entering one commits `plan.operation.update { zRef: { surface?, at } }`
// with the other kept (the stored surface kept); a moved spot offers "Use default spot".
// Doc: docs/conventions/ui.md#design-and-plan-controls-v02, docs/modes/z-reference.md#implementation-notes-df69
import { useState } from 'react'
import type { PlanWarning } from '../../../../core/plan/checks'
import type { PlanDTO, PlanOperationDTO } from '../../../../core/plan/plan.dto'
import type { UnitSystem } from '../../../../core/project/document'
import type { Quantity } from '../../../../core/quantity/quantity'
import { planMessages, sentence } from '../../messages/plan'
import { Field, QuantityInput, type FieldMessage } from '../../ui'
import { defaultUnit } from '../design/model'
import { feedQuantity, findingNames } from './model'
import { fieldMessages } from './fieldMessages'
import { usePlanCommand, usePlanState } from './plan-store'
import { ZRefButton } from './ToolChanges'

const m = planMessages.toolChanges

export function ZRefFields({
  plan,
  op,
  tool,
  units,
  readOnly,
  findings,
}: {
  plan: PlanDTO
  op: PlanOperationDTO
  /** The run's tool name, for the button's accessible name. */
  tool: string
  units: UnitSystem
  readOnly: boolean
  findings: readonly PlanWarning[]
}): React.JSX.Element | null {
  const call = usePlanCommand()
  const run = usePlanState((s) => s.data?.zRefs.find((r) => r.planOperationId === op.id))
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  if (run === undefined) return null
  const z = run.zRef
  const stored = op.zRef
  const surface = stored?.surface === undefined ? {} : { surface: stored.surface }
  const update = async (zRef: object | null) => {
    const r = await call('plan.operation.update', {
      planId: plan.id,
      planOperationId: op.id,
      zRef,
    })
    setRefusal(r.ok ? undefined : m.zRefused(sentence(r.error.message)))
  }
  const commit = (axis: 0 | 1, q: Quantity) => {
    if (z === null) return
    const at = [`${z.at[0]} mm`, `${z.at[1]} mm`]
    at[axis] = q.source
    void update({ ...surface, at })
  }
  const zMessages: FieldMessage[] = [
    ...fieldMessages(findings, 'zRef', units, findingNames(plan)),
    ...(refusal === undefined
      ? []
      : [{ id: 'refused', severity: 'error' as const, text: refusal }]),
  ]
  const moved: FieldMessage[] =
    stored?.at === undefined
      ? []
      : [
          {
            id: 'zRef.at.entered',
            severity: 'note',
            text: m.zSpotMoved,
            ...(readOnly
              ? {}
              : {
                  fix: {
                    label: m.zSpotDefault,
                    onApply: () => void update(stored.surface === undefined ? null : surface),
                  },
                }),
          },
        ]
  const unit = defaultUnit('length', units)
  return (
    <>
      <Field label={m.zFrom} messages={zMessages} readOnly={readOnly} kind="toggle">
        <ZRefButton
          planId={plan.id}
          run={run}
          tool={tool}
          units={units}
          editable={!readOnly}
          storedSurface={stored?.surface}
          onRefused={setRefusal}
        />
      </Field>
      {z === null ? null : (
        <>
          <QuantityInput
            label={m.zSpotX}
            kind="length"
            defaultUnit={unit}
            value={feedQuantity('stepdown', z.at[0], units)}
            readOnly={readOnly}
            messages={moved}
            onCommit={(q) => commit(0, q)}
          />
          <QuantityInput
            label={m.zSpotY}
            kind="length"
            defaultUnit={unit}
            value={feedQuantity('stepdown', z.at[1], units)}
            readOnly={readOnly}
            onCommit={(q) => commit(1, q)}
          />
        </>
      )}
    </>
  )
}
