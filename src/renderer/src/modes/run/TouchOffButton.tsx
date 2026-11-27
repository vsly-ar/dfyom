// "Move to touch-off spot" with its confirmation, in the tool-change dialog when the tool run's Z
// reference is a surface other than the stock top (DF69) and the machine is not at its spot (the
// operator jogged away to change the tool): up to the clearance height if lower, then X Y.
// DF133 RW4: the move through the workholding guard with the incoming tool's envelope; a contact is
// a finding in the confirmation with "Go anyway" (reset when the move changes), the button disabled.
// Doc: docs/modes/z-reference.md#dfyom-run, docs/conventions/ui.md#run-mode-safety-ui,
// docs/modes/run-workholding.md#go-to-and-the-touch-off-spot
import { useId, useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import type { ToolChangeInfo } from '../../../../core/run/grbl/sender'
import type { GoToStep, Vec3 } from '../../../../core/run/goto'
import { lengthSource } from '../../messages/dfm'
import { runMessages } from '../../messages/run'
import { Button, ConfirmDialog, Icon } from '../../ui'
import { JOG_FEED } from './JogPad'
import { formatLength, surfaceName, touchOffMoves } from './machine-state'
import { findingText, mayGo, MoveGuardFinding, useGoAnyway, useMoveGuard } from './MoveGuardFinding'
import { setupClearance } from './plan-info'
import { NO_PLAN, useRun, useRunStore, useRunUnits } from './run-store'
import styles from './Run.module.css'

const m = runMessages.touchOff

export function TouchOffButton({
  doc,
  toolChange,
  gate,
  reasonId,
}: {
  doc: ProjectDoc | undefined
  toolChange: ToolChangeInfo
  /** Why jogging is not possible now (the jog gate), or null. */
  gate: string | null
  reasonId: string
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const setupId = useRun((s) => s.setupId)
  const busy = useRun((s) => s.pending.includes('run.machine.jog'))
  const store = useRunStore()
  const plan = planId === undefined || planId === NO_PLAN ? undefined : doc?.plans[planId]
  const clearance = plan === undefined ? undefined : setupClearance(plan, setupId)
  const units = useRunUnits(doc)
  const findingId = useId()
  const { at, spot, surface } = toolChange
  const moves =
    at === undefined || clearance === undefined ? [] : touchOffMoves(status, at, clearance)
  // DF133 RW4: the steps through the guard ("Go anyway" for this very move)
  const from: Vec3 = [status.mpos[0], status.mpos[1], status.mpos[2]]
  const guard = useMoveGuard(from, moves)
  const [anyway, setAnyway] = useGoAnyway(JSON.stringify([from, ...moves]))
  if (at === undefined || clearance === undefined || moves.length === 0) return null
  const steps: GoToStep[] = moves.map((to, i, all) => ({
    to,
    axis: i === 0 && all.length > 1 ? 'z' : 'xy',
  }))
  const wco = [
    status.mpos[0] - status.wpos[0],
    status.mpos[1] - status.wpos[1],
    status.mpos[2] - status.wpos[2],
  ]
  const shown = (mm: number, axis: number) => formatLength(mm - wco[axis]!, units)
  const where = surface === undefined ? '' : surfaceName(surface)
  return (
    <>
      <div className={styles['buttons']}>
        <Button
          size="lg"
          icon={<Icon name="jog" />}
          disabled={gate !== null || busy}
          {...(gate === null ? {} : { 'aria-describedby': reasonId })}
          onClick={() => setOpen(true)}
        >
          {m.button}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={m.confirmTitle}
        description={m.confirmDescription(spot ?? '', where)}
        confirmLabel={m.confirm}
        confirmDisabled={!mayGo(guard, anyway)}
        extra={
          guard.finding === undefined ? undefined : (
            <MoveGuardFinding
              id={findingId}
              text={findingText(guard.finding, from, steps, shown, (mm) => lengthSource(mm, units))}
              guard={guard}
              anyway={anyway}
              onAnyway={setAnyway}
            />
          )
        }
        onConfirm={() =>
          // recomputed at the confirmation: the machine may have moved meanwhile; the store guards
          // it again (DF133 RW4) unless "Go anyway" was ticked
          void store.getState().moveTo(
            touchOffMoves(store.getState().status, at, clearance).map((to, i, all) => ({
              to,
              feed: i === 0 && all.length > 1 ? JOG_FEED.z : JOG_FEED.xy,
            })),
            { anyway },
          )
        }
      />
    </>
  )
}
