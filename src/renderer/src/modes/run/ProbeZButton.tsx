// "Probe Z" with its confirmation: the Z touch plate (M4), offered in the navigator's work zero
// section, the tool-change dialog and the setup-change prompt. Hidden without a plate thickness.
// Doc: docs/modes/run-machine.md#probing-and-re-zero-m4, docs/conventions/ui.md#run-mode-safety-ui
import { useState } from 'react'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import { runMessages } from '../../messages/run'
import { Button, ConfirmDialog, Icon } from '../../ui'
import { useLibraryItems } from '../plan/usePlan'
import { formatLength } from './machine-state'
import { plateThickness } from './plan-info'
import { NO_PLAN, useRun } from './run-store'
import styles from './Run.module.css'

const m = runMessages.probe

export function ProbeZButton({
  thickness,
  gate,
  reasonId,
  units,
  busy = false,
  onProbe,
  hint = true,
}: {
  /** Plate thickness (mm); undefined: no plate set, nothing shows. */
  thickness: number | undefined
  /** Why probing is not possible now (the work-zero gate), or null. */
  gate: string | null
  /** id of the reason text shown elsewhere, for `aria-describedby`. */
  reasonId: string
  units: UnitSystem
  busy?: boolean
  onProbe: (thickness: number) => void
  /** The line naming the plate under the button. */
  hint?: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (thickness === undefined) return null
  const plate = `${formatLength(thickness, units)} ${runMessages.dro.units[units]}`
  const disabled = gate !== null || busy
  return (
    <>
      <div className={styles['buttons']}>
        <Button
          size="lg"
          icon={<Icon name="probe" />}
          disabled={disabled}
          {...(gate === null ? {} : { 'aria-describedby': reasonId })}
          onClick={() => setOpen(true)}
        >
          {m.button}
        </Button>
      </div>
      {hint ? <p className={styles['hint']}>{m.hint(plate)}</p> : null}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={m.confirmTitle}
        description={m.confirmDescription(plate)}
        confirmLabel={m.confirm}
        onConfirm={() => onProbe(thickness)}
      />
    </>
  )
}

/** The plate thickness (mm) for the chosen plan or manual machine, if one is set. */
export function usePlateThickness(doc: ProjectDoc | undefined): number | undefined {
  const planId = useRun((s) => s.planId)
  const machineId = useRun((s) => s.machineId)
  const machines = useLibraryItems('machine')
  if (planId === undefined || planId === NO_PLAN)
    return plateThickness(undefined, machines, machineId)
  const plan = doc?.plans[planId]
  return plan === undefined ? undefined : plateThickness(plan, machines, machineId)
}
