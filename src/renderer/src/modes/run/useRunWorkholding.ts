// The Run scene's workholding (hardening DF133 RW1) as the scene and the Position panel read it:
// the run's setup (a run job's own setup when it is of the shown plan, else the chosen one), its
// items and work zero, how far the scene can vouch for them (`workholdingTrust`) and the status
// line that says so. `undefined` without a plan (an external gCode file, manual control).
// Doc: docs/modes/run-workholding.md#trust-what-the-guard-knows, #implementation-rw1
import { useMemo } from 'react'
import { setupAlignment } from '../../../../core/plan/alignment'
import type { LoadedPlan } from '../../../../core/plan/plan'
import type { SetupDTO } from '../../../../core/plan/plan.dto'
import { setupWorkholding, type SetupWorkholding } from '../../../../core/plan/workholding/setup'
import { runMessages } from '../../messages/run'
import { useReplica } from '../../shell/ShellContext'
import { loadedPlanOf } from '../plan/model'
import { activeJob } from './machine-state'
import { runSetup } from './plan-info'
import { useRun } from './run-store'
import { workholdingTrust, type WorkholdingTrust } from './run-workholding'

export interface RunWorkholding {
  readonly plan: LoadedPlan
  readonly setup: SetupDTO
  readonly holding: SetupWorkholding
  /** The setup's work zero in the setup frame (DF78). */
  readonly zero: readonly [number, number]
  readonly trust: WorkholdingTrust
  /** The Position panel's status line; absent when there is nothing to say (not connected). */
  readonly line?: string
}

const g = runMessages.guard

/** The status line per state (run-workholding.md § Trust, RW1 wording). */
export const trustLine: Readonly<Record<WorkholdingTrust, string | undefined>> = {
  noItems: g.noItems,
  disconnected: undefined,
  notHomed: g.notHomed,
  zeroUnset: g.zeroUnset,
  trusted: g.trusted,
}

export function useRunWorkholding(): RunWorkholding | undefined {
  const replica = useReplica()
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const chosenSetup = useRun((s) => s.setupId)
  const file = useRun((s) => s.file)
  const doc = replica.status === 'open' ? replica.doc : undefined
  const plan = file === undefined && planId !== undefined ? doc?.plans[planId] : undefined
  const job = activeJob(status)
  const setupId =
    job?.plan !== undefined && job.plan.planId === planId ? job.plan.setupId : chosenSetup
  const base = useMemo(() => {
    if (doc === undefined || plan === undefined) return undefined
    const loaded = loadedPlanOf(doc, plan)
    if (loaded === undefined) return undefined
    const setup = runSetup(plan, setupId)
    const zero = setupAlignment(loaded, setup).zero
    return {
      plan: loaded,
      setup,
      holding: setupWorkholding(setup, loaded.stock),
      zero: [zero[0], zero[1]] as const,
    }
  }, [doc, plan, setupId])
  const trust =
    base === undefined ? undefined : workholdingTrust(status, base.holding.prisms.length > 0)
  return useMemo(() => {
    if (base === undefined || trust === undefined) return undefined
    const line = trustLine[trust]
    return { ...base, trust, ...(line === undefined ? {} : { line }) }
  }, [base, trust])
}
