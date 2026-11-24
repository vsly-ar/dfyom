/**
 * What a run machined, as a hash (hardening DF85): a resume compares the plan as it is now with
 * the plan the stopped run was exported from (docs/modes/run-machine.md#section-resume-m5).
 */
import { hashJson } from '../plan/snapshot'
import type { PlanDTO } from '../plan/plan.dto'

/**
 * Hash of what a setup's program is exported from: the plan's design copy, its library copies,
 * its machine and the setup. Not the plan's name or status (moving it back to Settled design and
 * finalizing it again changes nothing machined), nor the other setups.
 */
export function runPlanHash(plan: PlanDTO, setupId: string): string {
  return hashJson({
    design: plan.design,
    snapshots: plan.snapshots,
    machine: plan.machine ?? null,
    setup: plan.setups.find((s) => s.id === setupId) ?? null,
  })
}
