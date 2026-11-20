// What run mode reads from the replica's plans: runnable plans, and a plan's machine copy and tools
// in machining order (pre-flight). Pure. Doc: docs/modes/run-v0.1.md#run-job (decision 5)
import type { PlanDTO } from '../../../../core/plan/plan.dto'
import type { ProjectDoc } from '../../../../core/project/document'

/** Plans that may run on the virtual machine: every status but `archived` (decision 5). */
export function runnablePlans(doc: ProjectDoc): PlanDTO[] {
  return Object.values(doc.plans).filter((p) => p.status !== 'archived')
}

const snapshotName = (plan: PlanDTO, id: string | undefined): string | undefined => {
  if (id === undefined) return undefined
  const s = plan.snapshots.find((x) => x.id === id)
  const name = (s?.values as { name?: unknown } | undefined)?.name
  return typeof name === 'string' ? name : undefined
}

export interface PlanRunInfo {
  readonly name: string
  readonly machine: string | undefined
  /** Tool names in machining order, a tool repeated only when it comes back after another. */
  readonly tools: readonly string[]
  /** Plan operation ids in machining order (toolpath playback). */
  readonly operations: readonly string[]
}

export function planRunInfo(plan: PlanDTO): PlanRunInfo {
  const ops = plan.setups.flatMap((s) => s.operations)
  const tools: string[] = []
  for (const op of ops) {
    const name = snapshotName(plan, op.tool)
    if (name !== undefined && tools.at(-1) !== name) tools.push(name)
  }
  return {
    name: plan.name,
    machine: snapshotName(plan, plan.machine),
    tools,
    operations: ops.map((o) => o.id),
  }
}
