// Plan mode without a plan (DF29): "Plan the part" as a card over the 3D view, the part visible
// around it, with "Create plan" in its footer. Since DF45 the body has a Machine field: a select
// preselected with the last machine used (the `lastMachine` setting) or the only one, and "New
// machine…", which chooses the machine it adds. Without a chosen machine (an empty library, or
// several and none remembered) "Create plan" is disabled with the reason (`plan.create` itself
// takes `machineLibraryItemId` and stays optional for agents). A non-modal dialog: the view around
// it still orbits, the toolbar and panels stay usable, and nothing closes it but a plan. The
// navigator says where to look. Doc: docs/conventions/ui.md#plan-start-df29
import { useId, useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { NewMachineDialog } from '../../library/NewMachineDialog'
import { planMessages } from '../../messages/plan'
import { useShell, useSettings } from '../../shell/ShellContext'
import { Button, ErrorMessage, Field, FieldIcon, Icon, Select } from '../../ui'
import { usePlanCommand } from './plan-store'
import styles from './Plan.module.css'
import { useChosenPlan, useLibraryItems, type LibraryEntry } from './usePlan'

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

/** The preselected machine: the last one used while it is in the library, else the only one. */
export function preselectedMachine(
  machines: readonly LibraryEntry[],
  lastMachine: string | null,
): string | undefined {
  if (lastMachine !== null && machines.some((i) => i.id === lastMachine)) return lastMachine
  return machines.length === 1 ? machines[0]?.id : undefined
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
  const { settings } = useShell()
  const lastMachine = useSettings((s) => s.settings.lastMachine)
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const [machinesAdded, setMachinesAdded] = useState(0)
  const machines = useLibraryItems('machine', machinesAdded)
  /** The user's choice in this card; until one, the preselection. */
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const titleId = useId()
  const descriptionId = useId()
  const whyId = useId()

  const available = machines ?? []
  const machineId =
    picked !== undefined && available.some((i) => i.id === picked)
      ? picked
      : preselectedMachine(available, lastMachine)
  const empty = machines?.length === 0
  const why =
    machines === undefined || machineId !== undefined
      ? undefined
      : empty
        ? planMessages.machine.empty
        : planMessages.machine.choose

  const create = async () => {
    if (machineId === undefined) return
    const r = await call('plan.create', { partId, machineLibraryItemId: machineId })
    setError(r.ok ? undefined : r.error)
    if (!r.ok) return
    settings.getState().update({ lastMachine: machineId })
    choose((r.value as { planId: string }).planId)
  }

  const newMachine = (
    <NewMachineDialog
      units={doc.unitSystem}
      onAdded={async (id) => {
        setPicked(id)
        setMachinesAdded((n) => n + 1)
        return undefined
      }}
    />
  )

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
          {machines === undefined ? null : empty ? (
            <div className={styles['startMachine']}>
              <p id={whyId} className={styles['why']}>
                {why}
              </p>
              {newMachine}
            </div>
          ) : (
            <div className={styles['startMachine']}>
              <Field
                label={planMessages.machine.label}
                kind="toggle"
                illustration={<FieldIcon name="machine" />}
                className={styles['startField']}
              >
                <Select
                  placeholder={planMessages.machine.placeholder}
                  options={available.map((i) => ({ value: i.id, label: i.name }))}
                  {...(machineId === undefined ? {} : { value: machineId })}
                  onValueChange={setPicked}
                />
              </Field>
              {why !== undefined ? (
                <p id={whyId} className={styles['why']}>
                  {why}
                </p>
              ) : null}
              {newMachine}
            </div>
          )}
          {error ? <ErrorMessage error={error} /> : null}
        </div>
        <div className={styles['startFooter']}>
          <Button
            variant="primary"
            icon={<Icon name="add" />}
            disabled={machineId === undefined}
            {...(why === undefined ? {} : { 'aria-describedby': whyId })}
            onClick={() => void create()}
          >
            {m.action}
          </Button>
        </div>
      </div>
    </div>
  )
}
