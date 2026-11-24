// What run mode reads from the replica's plans: runnable plans, a plan's setups, and one setup's
// machine copy and tools in machining order (pre-flight), its WCS on the part (run scene) and the
// stock's orientation on the machine (setup-change prompt), with the setup's work zero (DF78, N7).
// One program per setup (task E2). Pure.
// Doc: docs/modes/run-v0.1.md#run-job (decision 5), docs/modes/plan-v0.2.md#setup-change-in-run
import type { Direction } from '../../../../core/geometry/face'
import type { Placement, Vec2 } from '../../../../core/geometry/model'
import { setupAlignment } from '../../../../core/plan/alignment'
import { planOpLabel } from '../../../../core/plan/labels'
import { loadPlanDTO } from '../../../../core/plan/plan'
import { QuantityDtoSchema } from '../../../../core/quantity/quantity.dto'
import { Quantity } from '../../../../core/quantity/quantity'
import type { PlanDTO, SetupDTO } from '../../../../core/plan/plan.dto'
import { setupDirection, setupRotation } from '../../../../core/plan/setups'
import { setupWorkholding } from '../../../../core/plan/workholding/setup'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import { runPlanHash } from '../../../../core/run/plan-hash'
import type { RunStatus } from '../../../../core/run/service'
import {
  setupFrame,
  setupOrientation,
  setupZeroCorner,
  type SetupOrientation,
} from '../../../../core/toolpath/wcs'

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

/** An operation start a stopped run may resume at (M5): the program's label and tool. */
export interface ResumePoint {
  readonly planOperationId: string
  /** The operation's label comment in the program. */
  readonly label: string
  /** Tool number as in the program (by first use in the setup) and the tool's name. */
  readonly tool: number
  readonly toolName: string
}

/** The setup's operations in machining order, as "Resume at" offers them (run-machine.md#section-resume-m5). */
export function resumePoints(plan: PlanDTO, setupId: string | undefined): ResumePoint[] {
  const numbers = new Map<string, number>()
  return runSetup(plan, setupId).operations.map((op) => {
    const key = op.tool ?? ''
    const n = numbers.get(key) ?? numbers.size + 1
    numbers.set(key, n)
    return {
      planOperationId: op.id,
      label: planOpLabel(plan.design.part, op),
      tool: n,
      toolName: snapshotName(plan, op.tool) ?? '–',
    }
  })
}

/** "Resume from…" is offered after a stopped or failed run of this plan and setup (M5). */
export function canResume(
  lastRun: RunStatus['lastRun'],
  plan: PlanDTO | undefined,
  setupId: string | undefined,
): boolean {
  return (
    lastRun !== undefined &&
    plan !== undefined &&
    lastRun.outcome !== 'done' &&
    lastRun.planId === plan.id &&
    lastRun.setupId === runSetup(plan, setupId).id
  )
}

/** A setup on the part: its WCS in the part frame and the stock as it sits on the machine. */
export interface SetupPlacement {
  /** WCS → part frame (identity for an unrotated top setup), its origin at the work zero. */
  readonly frame: Placement
  readonly orientation: SetupOrientation
  /** DF78 (N7): the work zero in the setup frame (mm from the front-left corner of the top). */
  readonly zero: Vec2
  /** The alignment point the zero is on, by name; absent = an offset or the corner. */
  readonly zeroPoint?: string
  /** The part corner at the work zero, e.g. "back left" (M7). */
  readonly corner: string
  /**
   * DF78: the setup's alignment points in cycle order, at their expected position in the setup
   * frame (mm from the front-left corner of the top); a point whose source is missing is left out.
   */
  readonly points: readonly {
    readonly id: string
    readonly name: string
    readonly n: number
    readonly at: Vec2
  }[]
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
  const a = setupAlignment(loaded.unwrap(), setup)
  const point = a.points.find((p) => p.id === a.zeroPoint)
  return {
    frame: setupFrame(direction, rotation, stock, a.zero),
    orientation: setupOrientation(direction, rotation, stock),
    zero: a.zero,
    ...(point === undefined ? {} : { zeroPoint: point.name }),
    corner: setupZeroCorner(direction, rotation, stock),
    points: a.points.flatMap((p, i) =>
      p.frame === undefined
        ? []
        : [{ id: p.id, name: p.name, n: i + 1, at: [p.frame[0], p.frame[1]] as const }],
    ),
  }
}

/**
 * The setup's clearance height (mm above the stock top) as its program uses it (it follows the
 * workholding, docs/modes/workholding.md#links-and-safe-heights), if it reads.
 */
export function setupClearance(plan: PlanDTO, setupId: string | undefined): number | undefined {
  const setup = runSetup(plan, setupId)
  const loaded = loadPlanDTO(plan, 'mm', 'run UI')
  if (loaded.isOk()) return setupWorkholding(setup, loaded.unwrap().stock).clearance
  const q = Quantity.fromDTO(setup.clearanceHeight)
  return q.isOk() && q.unwrap().kind === 'length' ? q.unwrap().canonical : undefined
}

/** A `probePlateThickness` in mm, if the values carry a valid one. */
function plateOf(values: unknown): number | undefined {
  const dto = QuantityDtoSchema.safeParse(
    (values as { probePlateThickness?: unknown } | undefined)?.probePlateThickness,
  )
  if (!dto.success) return undefined
  const q = Quantity.fromDTO(dto.data)
  return q.isOk() && q.unwrap().kind === 'length' && q.unwrap().canonical > 0
    ? q.unwrap().canonical
    : undefined
}

/**
 * The touch plate thickness (mm) for a probe (docs/modes/run-machine.md#probing-and-re-zero-m4):
 * the plan's machine copy, else the library machine it was copied from; without a plan the chosen
 * library machine. Undefined: no plate set (no probe control).
 */
export function plateThickness(
  plan: PlanDTO | undefined,
  machines: readonly { readonly id: string; readonly [field: string]: unknown }[] | undefined,
  machineId: string | undefined,
): number | undefined {
  const lib = (id: string | undefined) => plateOf(machines?.find((x) => x.id === id))
  if (plan === undefined) return lib(machineId)
  const copy = plan.snapshots.find((x) => x.id === plan.machine)
  if (copy === undefined) return undefined
  return plateOf(copy.values) ?? lib(copy.libraryItemId)
}

/** What the machine profile puts on the overrides (DF85, docs/modes/run-machine.md#overrides-m6). */
export interface MachineOverrideLimits {
  /** mm/min: the lower of the X and Y max feed rates (the axes a cut mostly moves). */
  readonly maxFeed?: number
  /** rpm. */
  readonly maxSpindle?: number
  /** `manual`: the spindle speed is set by hand, there is no spindle override. */
  readonly spindleControl?: 'gcode' | 'manual'
}

/** A quantity DTO's canonical value of `kind`, if positive. */
function positive(dto: unknown, kind: string): number | undefined {
  const parsed = QuantityDtoSchema.safeParse(dto)
  if (!parsed.success) return undefined
  const q = Quantity.fromDTO(parsed.data)
  return q.isOk() && q.unwrap().kind === kind && q.unwrap().canonical > 0
    ? q.unwrap().canonical
    : undefined
}

function limitsOf(values: unknown): MachineOverrideLimits | undefined {
  if (values === null || typeof values !== 'object') return undefined
  const v = values as {
    maxFeedRate?: { x?: unknown; y?: unknown }
    spindle?: { control?: unknown; maxSpeed?: unknown }
  }
  const xy = [positive(v.maxFeedRate?.x, 'feedRate'), positive(v.maxFeedRate?.y, 'feedRate')]
  const feeds = xy.filter((x): x is number => x !== undefined)
  const maxSpindle = positive(v.spindle?.maxSpeed, 'spindleSpeed')
  const control = v.spindle?.control
  return {
    ...(feeds.length === 0 ? {} : { maxFeed: Math.min(...feeds) }),
    ...(maxSpindle === undefined ? {} : { maxSpindle }),
    ...(control === 'gcode' || control === 'manual' ? { spindleControl: control } : {}),
  }
}

/**
 * The override limits of the plan's machine copy, else of the chosen library machine (without a
 * plan); empty when neither is known.
 */
export function machineOverrideLimits(
  plan: PlanDTO | undefined,
  machines: readonly { readonly id: string; readonly [field: string]: unknown }[] | undefined,
  machineId: string | undefined,
): MachineOverrideLimits {
  if (plan === undefined) return limitsOf(machines?.find((x) => x.id === machineId)) ?? {}
  const copy = plan.snapshots.find((x) => x.id === plan.machine)
  return (
    limitsOf(copy?.values) ?? limitsOf(machines?.find((x) => x.id === copy?.libraryItemId)) ?? {}
  )
}

/**
 * How the plan changed since the run that stopped (DF85,
 * docs/modes/run-machine.md#section-resume-m5): `changed` when what the setup's program is
 * exported from differs, `removed` when the stopped operation is no longer in the setup,
 * `reordered` when the operations the stopped run had are in another order now.
 */
export function resumeChanges(
  lastRun: RunStatus['lastRun'],
  plan: PlanDTO,
  setupId: string | undefined,
): { changed: boolean; removed: boolean; reordered: boolean } {
  const setup = runSetup(plan, setupId)
  const ids = setup.operations.map((o) => o.id)
  const changed =
    lastRun?.planHash !== undefined && lastRun.planHash !== runPlanHash(plan, setup.id)
  const removed = lastRun?.planOperationId !== undefined && !ids.includes(lastRun.planOperationId)
  const before = (lastRun?.operations ?? []).filter((id) => ids.includes(id))
  const now = ids.filter((id) => before.includes(id))
  const reordered = before.some((id, i) => now[i] !== id)
  return { changed, removed, reordered }
}
