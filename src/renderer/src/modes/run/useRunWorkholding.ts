// The Run scene's workholding (hardening DF133 RW1) as the scene, the jog guard and the Position
// panel read it: the run's setup (a run job's own setup when it is of the shown plan, else the
// chosen one), its items and work zero, how far the scene can vouch for them (`workholdingTrust`),
// the tool in the spindle (Q189, RW3: the store's `spindleTool`) and the status line that says
// what the guard does (RW3: the guard's wording; "guard off" in the warning colour; the Z note
// after a tool change, Q190). `undefined` without a plan (an external gCode file, manual control).
// Doc: docs/modes/run-workholding.md#trust-what-the-guard-knows, #implementation-rw1, #implementation-rw3
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
import type { Vec3 } from '../../../../core/toolpath/model'
import { zeroStale } from './run-guard'
import { useRun } from './run-store'
import {
  guardTool,
  workholdingTrust,
  type GuardTool,
  type WorkholdingTrust,
} from './run-workholding'

export interface RunWorkholding {
  readonly plan: LoadedPlan
  readonly setup: SetupDTO
  readonly holding: SetupWorkholding
  /** The setup's work zero in the setup frame (DF78). */
  readonly zero: readonly [number, number]
  readonly trust: WorkholdingTrust
  /** The tool the guard assumes in the spindle (Q189); absent: the setup has no tool. */
  readonly tool?: GuardTool
  /** The Position panel's status line; absent when there is nothing to say (not connected). */
  readonly line?: string
  /** The line is a warning (the guard switched off). */
  readonly warn?: true
  /** RW6: the G54 a setup change to this setup began with, while it is still set (the guard's). */
  readonly staleZero?: Vec3
}

const g = runMessages.guard

/** The status line per state (run-workholding.md § Trust, the guard's wording since RW3). */
export const trustLine: Readonly<Record<WorkholdingTrust, string | undefined>> = {
  noItems: g.noItems,
  disconnected: undefined,
  notHomed: g.notHomed,
  zeroUnset: g.zeroUnset,
  zeroStale: g.zeroStale,
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
  // RW6: after a setup change to this setup, until G54 changes (outlined, the guard off)
  const setupChange = useRun((s) => s.setupChange)
  const changeZero = useRun((s) => s.setupChangeZero)
  const staleZero = base !== undefined && setupChange === base.setup.id ? changeZero : undefined
  const trust =
    base === undefined
      ? undefined
      : workholdingTrust(
          status,
          base.holding.prisms.length > 0,
          zeroStale(status.workZero, staleZero),
        )
  const n = useRun((s) => s.spindleTool)
  const off = useRun((s) => s.guardOff)
  const zUnset = useRun((s) => s.zUnset)
  const tool = useMemo(
    () => (base === undefined ? undefined : guardTool(base.plan, base.setup, n)),
    [base, n],
  )
  return useMemo(() => {
    if (base === undefined || trust === undefined) return undefined
    const head = {
      ...base,
      trust,
      ...(tool === undefined ? {} : { tool }),
      ...(staleZero === undefined ? {} : { staleZero }),
    }
    if (trust === 'trusted' && off) return { ...head, line: g.off, warn: true as const }
    // a setup without a tool: nothing to check with, the RW1 line says so
    const line =
      trust === 'trusted'
        ? tool === undefined
          ? g.unchecked
          : zUnset
            ? `${g.trusted} ${g.zUnset}`
            : g.trusted
        : trustLine[trust]
    return { ...head, ...(line === undefined ? {} : { line }) }
  }, [base, trust, tool, off, zUnset, staleZero])
}
