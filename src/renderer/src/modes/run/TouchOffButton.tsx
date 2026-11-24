// "Move to touch-off spot" with its confirmation, in the tool-change dialog when the tool run's Z
// reference is a surface other than the stock top (DF69) and the machine is not at its spot (the
// operator jogged away to change the tool): up to the clearance height if lower, then X Y.
// Doc: docs/modes/z-reference.md#dfyom-run, docs/conventions/ui.md#run-mode-safety-ui
import { useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import type { ToolChangeInfo } from '../../../../core/run/grbl/sender'
import { runMessages } from '../../messages/run'
import { Button, ConfirmDialog, Icon } from '../../ui'
import { JOG_FEED } from './JogPad'
import { surfaceName, touchOffMoves } from './machine-state'
import { setupClearance } from './plan-info'
import { NO_PLAN, useRun, useRunStore } from './run-store'
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
  const { at, spot, surface } = toolChange
  if (at === undefined || clearance === undefined) return null
  const moves = touchOffMoves(status, at, clearance)
  if (moves.length === 0) return null
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
        onConfirm={() =>
          // recomputed at the confirmation: the machine may have moved meanwhile
          void store.getState().moveTo(
            touchOffMoves(store.getState().status, at, clearance).map((to, i, all) => ({
              to,
              feed: i === 0 && all.length > 1 ? JOG_FEED.z : JOG_FEED.xy,
            })),
          )
        }
      />
    </>
  )
}
