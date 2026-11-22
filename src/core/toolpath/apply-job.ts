/**
 * `plan.toolpaths`, the apply job that keeps toolpaths current: after an Apply's document phase,
 * every kept-current plan (not archived, toolpaths generated before) whose toolpaths are stale
 * gets a `plan.toolpath.generate { planId }` job; the cache makes it incremental.
 * Doc: docs/architecture/apply.md#apply-jobs
 */
import type { ApplyJob } from '../commands/define'
import { planOperationInputs } from '../plan/inputs'
import { keptCurrent } from '../plan/pending'

export const toolpathApplyJob: ApplyJob = {
  name: 'plan.toolpaths',
  jobs(doc, _pending, ctx) {
    const cache = ctx.services.toolpaths
    if (cache === undefined) return []
    return Object.values(doc.plans).flatMap((plan) => {
      if (!keptCurrent(plan, ctx.services)) return []
      // a plan with error findings has no current toolpaths: plan.warning.list shows why, and a
      // job that fails at once would only be retried by every later Apply
      const inputs = planOperationInputs(doc, plan.id, undefined, ctx.services.region2d)
      if (inputs.isErr()) return []
      if (inputs.unwrap().every((i) => cache.has(i.inputHash))) return []
      return [
        {
          command: 'plan.toolpath.generate',
          args: { planId: plan.id },
          key: `toolpaths:${plan.id}`,
        },
      ]
    })
  },
}
