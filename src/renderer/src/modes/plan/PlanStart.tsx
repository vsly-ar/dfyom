// Plan mode without a plan (DF29): "Plan the part" as a card over the 3D view, the part visible
// around it, with "Create plan" in its footer (`plan.create` with the first library machine) and,
// with an empty machine library, "New machine…" above it. A non-modal dialog: the view around it
// still orbits, the toolbar and panels stay usable, and nothing closes it but a plan. The
// navigator says where to look. Doc: docs/conventions/ui.md#plan-mode-task-37 (Plan start, DF29)
import { useId, useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { NewMachineDialog } from '../../library/NewMachineDialog'
import { planMessages } from '../../messages/plan'
import { Button, ErrorMessage, Icon } from '../../ui'
import { usePlanCommand } from './plan-store'
import styles from './Plan.module.css'
import { useChosenPlan, useLibraryItems } from './usePlan'

const m = planMessages.empty

/** The card while plan mode shows a part without any plan; nothing otherwise. */
export function PlanStartOverlay({
  doc,
  insetRight = 0,
}: {
  doc: ProjectDoc
  /** Px covered by the narrow window's inspector overlay: the card centres in the rest. */
  insetRight?: number
}): React.JSX.Element | null {
  const [plan] = useChosenPlan(doc)
  const part = Object.values(doc.parts)[0]
  if (plan !== undefined || part === undefined) return null
  return <PlanStartCard doc={doc} partId={part.id} insetRight={insetRight} />
}

function PlanStartCard({
  doc,
  partId,
  insetRight,
}: {
  doc: ProjectDoc
  partId: string
  insetRight: number
}): React.JSX.Element {
  const [, choose] = useChosenPlan(doc)
  const call = usePlanCommand()
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const [machinesAdded, setMachinesAdded] = useState(0)
  const machines = useLibraryItems('machine', machinesAdded)
  const titleId = useId()
  const descriptionId = useId()

  const create = async () => {
    const machine = machines?.[0]
    const r = await call('plan.create', {
      partId,
      ...(machine === undefined ? {} : { machineLibraryItemId: machine.id }),
    })
    setError(r.ok ? undefined : r.error)
    if (r.ok) choose((r.value as { planId: string }).planId)
  }

  return (
    <div
      className={styles['startLayer']}
      style={insetRight > 0 ? { right: insetRight } : undefined}
    >
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={styles['startCard']}
      >
        <div className={styles['startBody']}>
          <span className={styles['startIcon']} aria-hidden="true">
            <Icon name="toolpath" />
          </span>
          <h2 id={titleId} className={styles['startTitle']}>
            {m.title}
          </h2>
          <p id={descriptionId} className={styles['startText']}>
            {m.description}
          </p>
          {machines?.length === 0 ? (
            <div className={styles['startMachine']}>
              <p className={styles['why']}>{planMessages.machine.empty}</p>
              <NewMachineDialog
                units={doc.unitSystem}
                onAdded={async () => {
                  setMachinesAdded((n) => n + 1)
                  return undefined
                }}
              />
            </div>
          ) : null}
          {error ? <ErrorMessage error={error} /> : null}
        </div>
        <div className={styles['startFooter']}>
          <Button variant="primary" icon={<Icon name="add" />} onClick={() => void create()}>
            {m.action}
          </Button>
        </div>
      </div>
    </div>
  )
}
