// What run mode reads from the replica's plans: runnable plans, a plan's setups, and one setup's
// machine copy and tools in machining order (pre-flight), its WCS on the part (run scene) and the
// stock's orientation on the machine (setup-change prompt). One program per setup (task E2). Pure.
// Doc: docs/modes/run-v0.1.md#run-job (decision 5), docs/modes/plan-v0.2.md#setup-change-in-run
import type { Direction } from '../../../../core/geometry/face'
import type { Placement } from '../../../../core/geometry/model'
import { loadPlanDTO } from '../../../../core/plan/plan'
import type { PlanDTO, SetupDTO } from '../../../../core/plan/plan.dto'
import { setupDirection, setupRotation } from '../../../../core/plan/setups'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import { setupFrame, setupOrientation, type SetupOrientation } from '../../../../core/toolpath/wcs'

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

/** The setup run mode works on: the chosen one if the plan has it, else the first. */
export function runSetup(plan: PlanDTO, setupId: string | undefined): SetupDTO {
  return plan.setups.find((s) => s.id === setupId) ?? plan.setups[0]!
}

export interface PlanRunInfo {
  readonly name: string
  readonly machine: string | undefined
  /** The setup whose program runs. */
  readonly setup: { readonly id: string; readonly name: string; readonly direction: Direction }
  /** Every setup of the plan, in machining order. */
  readonly setups: readonly { readonly id: string; readonly name: string }[]
  /** Tool names in machining order, a tool repeated only when it comes back after another. */
  readonly tools: readonly string[]
  /** The setup's plan operation ids in machining order (toolpath playback). */
  readonly operations: readonly string[]
}

export function planRunInfo(plan: PlanDTO, setupId?: string): PlanRunInfo {
  const setup = runSetup(plan, setupId)
  const ops = setup.operations
  const tools: string[] = []
  for (const op of ops) {
    const name = snapshotName(plan, op.tool)
    if (name !== undefined && tools.at(-1) !== name) tools.push(name)
  }
  return {
    name: plan.name,
    machine: snapshotName(plan, plan.machine),
    setup: { id: setup.id, name: setup.name, direction: setupDirection(setup) },
    setups: plan.setups.map((s) => ({ id: s.id, name: s.name })),
    tools,
    operations: ops.map((o) => o.id),
  }
}

/** A setup on the part: its WCS in the part frame and the stock as it sits on the machine. */
export interface SetupPlacement {
  /** WCS → part frame (identity for an unrotated top setup). */
  readonly frame: Placement
  readonly orientation: SetupOrientation
}

/** `undefined` when the plan's stock copy does not load. */
export function setupPlacement(
  plan: PlanDTO,
  setupId: string | undefined,
  units: UnitSystem,
): SetupPlacement | undefined {
  const loaded = loadPlanDTO(plan, units, 'run UI')
  if (loaded.isErr()) return undefined
  const s = loaded.unwrap().stock
  const stock = {
    length: s.length.canonical,
    width: s.width.canonical,
    thickness: s.thickness.canonical,
  }
  const setup = runSetup(plan, setupId)
  const direction = setupDirection(setup)
  const rotation = setupRotation(setup)
  return {
    frame: setupFrame(direction, rotation, stock),
    orientation: setupOrientation(direction, rotation, stock),
  }
}
