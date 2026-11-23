/**
 * The seam to toolpath generation (tasks 2.9/2.10): everything a generator needs for one plan
 * operation, resolved from the plan's own snapshot and copies, plus the input hash the toolpath
 * cache keys on. Doc: docs/modes/plan-v0.1.md#toolpath-generation-job (seam: "Implementation
 * (task 2.13)" in the same doc).
 *
 * `plan.toolpath.generate` (a `job`, src/core/toolpath/generate.ts) calls `planOperationInputs`
 * on the document it started with, maps each input with `toGeneratorInputs` and runs the
 * generators through the `WorkerPort` (docs/architecture/workers.md#toolpath-cache).
 */
import { fail, Ok, type AppResult, type Option } from '../../shared/result'
import type { Operation, Part } from '../design/operation'
import type { OperationKind } from '../design/part.dto'
import type { Direction } from '../geometry/face'
import type { Region2dPort } from '../geometry/2d/port'
import type { Machine } from '../library/machine'
import type { Stock } from '../library/stock'
import type { Tool } from '../library/tool'
import type { ProjectDoc } from '../project/document'
import { Quantity } from '../quantity/quantity'
import { evaluateOperation, planFindings } from './evaluate'
import type { ResolvedFeeds } from './feeds'
import type { SetupRotation } from './plan.dto'
import { setupDirection, setupRotation } from './setups'
import { loadPlan, setupOf } from './plan'
import { planThroughDepths } from './through'
import { hashJson } from './snapshot'
import type { ResolvedStrategy } from './strategy'

/** One plan operation, ready for a generator. Lengths in mm, feeds in mm/min, speed in rpm. */
export interface PlanOperationInput {
  readonly planId: string
  readonly planOperationId: string
  readonly kind: OperationKind
  /** The design-snapshot operations it machines (drillings may share one). */
  readonly operations: readonly Operation[]
  readonly part: Part
  readonly stock: Stock
  readonly setup: {
    readonly id: string
    /** The part direction up to the spindle; generators get its face frame (task C3). */
    readonly direction: Direction
    /** Quarter turn about machine +Z; turns the toolpaths and moves the work zero (task C3). */
    readonly rotation: SetupRotation
    readonly workOffset: 'G54'
    readonly clearanceHeight: number
    readonly retractHeight: number
  }
  /** The tool copy and its id in the plan's snapshots (`Toolpath.tool`). */
  readonly tool: Tool
  readonly toolSnapshotId: string
  readonly stickout: number
  /** Every applicable field resolved (unresolved ones fail with `plan.check` first). */
  readonly feeds: ResolvedFeeds
  readonly strategy: ResolvedStrategy
  readonly machine: Option<Machine>
  /**
   * A through profile over material an earlier setup of the plan cleared from the opposite face:
   * the material it cuts (mm; DF50, `planThroughDepths`). Absent = the stock extent.
   */
  readonly throughDepth?: number
  /** The operation before it in the machining order (where the tool starts); none for the first. */
  readonly previousPlanOperationId?: string
  /**
   * Hash of every input, chained over the machining order (position and every earlier
   * operation, since an operation starts where the previous one ended), plus the plan's part,
   * plan operation, used copies, setup): a changed
   * input marks a cached toolpath stale.
   */
  readonly inputHash: string
}

/**
 * Inputs of the listed plan operations (all by default), in machining order. Error findings of
 * the plan (`plan.check`, `plan.order`) for those operations fail with their code; with the 2D
 * port these include the part's shape checks (`tabOutside`, …), as `plan.warning.list` shows them.
 */
export function planOperationInputs(
  doc: ProjectDoc,
  planId: string,
  planOperationIds?: readonly string[],
  port?: Region2dPort,
): AppResult<PlanOperationInput[]> {
  const where = 'planOperationInputs'
  const loaded = loadPlan(doc, planId, where)
  if (loaded.isErr()) return loaded
  const plan = loaded.unwrap()
  const wanted = (id: string) => planOperationIds === undefined || planOperationIds.includes(id)
  const errors = planFindings(plan, undefined, port).filter(
    (f) => f.severity === 'error' && (f.planOperationId === undefined || wanted(f.planOperationId)),
  )
  const first = errors[0]
  if (first !== undefined)
    return fail(first.code === 'plan.order' ? 'plan.order' : 'plan.check', first.message, {
      issues: errors.map((f) => ({
        path: [f.planOperationId ?? planId, ...(f.field === undefined ? [] : [f.field])],
        rule: f.rule,
        message: f.message,
        params: f.params,
      })),
      where,
      data: { planId },
    })
  const length = (dto: Parameters<typeof Quantity.fromDTO>[0]) =>
    Quantity.fromDTO(dto).mapOr(0, (q) => q.canonical)
  const out: PlanOperationInput[] = []
  // Chained over the machining order: an operation starts where the previous one ended, so its
  // hash covers its position and everything before it. The whole part (`on` surfaces and
  // formulas depend on other operations) enters by its hash, taken once: hashing it per plan
  // operation made every export quadratic in operations (hardening P4).
  const part = hashJson(plan.dto.design.part)
  let chain = ''
  let previous: string | undefined
  plan.operations.forEach((op, index) => {
    const own = setupOf(plan, op.id)
    const setup = {
      id: own.id,
      direction: setupDirection(own),
      rotation: setupRotation(own),
      workOffset: own.workOffset,
      clearanceHeight: length(own.clearanceHeight),
      retractHeight: length(own.retractHeight),
    }
    const used = plan.dto.snapshots.filter(
      (s) => s.id === op.tool || s.id === plan.dto.design.part.stock || s.id === plan.dto.machine,
    )
    chain = hashJson({
      previous: chain,
      index,
      part,
      planOperation: op,
      snapshots: used,
      setup: { ...own, operations: undefined },
      // strategy defaults depend on the unit system (e.g. overshoot 1 mm vs 0.04")
      units: plan.units,
    })
    const previousPlanOperationId = previous
    previous = op.id
    if (!wanted(op.id)) return
    const e = evaluateOperation(plan, op)
    const throughDepth =
      e.kind === 'profile' ? planThroughDepths(plan, port).get(e.ops[0]?.id ?? '') : undefined
    // no error findings: tool, stickout and feeds are present
    const toolSnapshotId = op.tool!
    out.push({
      planId,
      planOperationId: op.id,
      kind: e.kind,
      operations: e.ops,
      part: plan.part,
      stock: plan.stock,
      setup,
      tool: e.tool.unwrap(),
      toolSnapshotId,
      stickout: e.stickout.unwrap(),
      feeds: e.feeds.unwrap(),
      strategy: e.strategy,
      machine: plan.machine,
      ...(throughDepth === undefined ? {} : { throughDepth }),
      ...(previousPlanOperationId === undefined ? {} : { previousPlanOperationId }),
      inputHash: chain,
    })
  })
  return Ok(out)
}
