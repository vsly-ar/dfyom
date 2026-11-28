// Hardening DF143: "Finalize and start" in the real-machine pre-flight: a draft (or settled) plan
// is finalized through `plan.status.set` (draft → settledDesign → finalized, the plan's own
// transitions), then the pre-flight continues its checks and starts once they pass; any refusal
// (the settings check, the soft limits, the check failing) leaves the dialog open with its reason.
// Doc: docs/modes/run-machine.md#pre-flight-on-a-real-machine
import { useEffect, useState } from 'react'
import type { PlanDTO } from '../../../../core/plan/plan.dto'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { useCall } from '../../shell/hooks'

export interface FinalizeAndStart {
  /** The plan can be finalized from here (a draft or settled plan). */
  readonly offered: boolean
  /** Finalizing, or waiting for the checks to start. */
  readonly busy: boolean
  readonly error: AppErrorData | undefined
  run(): Promise<void>
}

export function useFinalizeAndStart(opts: {
  readonly open: boolean
  readonly plan: PlanDTO | undefined
  /** The pre-flight may start now. */
  readonly startable: boolean
  /** A refusal that finalizing does not end (a reason is shown, or the check failed). */
  readonly blocked: boolean
  readonly start: () => void
}): FinalizeAndStart {
  const { open, plan, startable, blocked, start } = opts
  const call = useCall()
  const [phase, setPhase] = useState<'idle' | 'finalizing' | 'waiting'>('idle')
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  useEffect(() => {
    if (open) return
    setPhase('idle')
    setError(undefined)
  }, [open])
  const finalized = plan?.status === 'finalized'
  useEffect(() => {
    // the plan's new status arrives with the replica: decide only once it shows
    if (phase !== 'waiting' || !finalized) return
    if (startable) {
      setPhase('idle')
      start()
    } else if (blocked) setPhase('idle')
  }, [phase, finalized, startable, blocked, start])
  const offered = plan !== undefined && (plan.status === 'draft' || plan.status === 'settledDesign')
  return {
    offered,
    busy: phase !== 'idle',
    error,
    async run() {
      if (plan === undefined || !offered || phase !== 'idle') return
      setError(undefined)
      setPhase('finalizing')
      const steps = plan.status === 'draft' ? ['settledDesign', 'finalized'] : ['finalized']
      for (const status of steps) {
        const r = await call('plan.status.set', { planId: plan.id, status })
        if (!r.ok) {
          setError(r.error)
          setPhase('idle')
          return
        }
      }
      setPhase('waiting')
    },
  }
}
