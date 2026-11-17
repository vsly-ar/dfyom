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
import type { Machine } from '../library/machine'
import type { Stock } from '../library/stock'
import type { Tool } from '../library/tool'
import type { ProjectDoc } from '../project/document'
import { Quantity } from '../quantity/quantity'
import { evaluateOperation, planFindings } from './evaluate'
import type { ResolvedFeeds } from './feeds'
import { loadPlan } from './plan'
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
 * the plan (`plan.check`, `plan.order`) for those operations fail with their code.
 */
export function planOperationInputs(
  doc: ProjectDoc,
  planId: string,
  planOperationIds?: readonly string[],
): AppResult<PlanOperationInput[]> {
  const where = 'planOperationInputs'
  const loaded = loadPlan(doc, planId, where)
  if (loaded.isErr()) return loaded
  const plan = loaded.unwrap()
  const wanted = (id: string) => planOperationIds === undefined || planOperationIds.includes(id)
  const errors = planFindings(plan).filter(
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
  const setup = {
    id: plan.setup.id,
    workOffset: plan.setup.workOffset,
    clearanceHeight: length(plan.setup.clearanceHeight),
    retractHeight: length(plan.setup.retractHeight),
  }
  const out: PlanOperationInput[] = []
  // Chained over the machining order: an operation starts where the previous one ended, so its
  // hash covers its position and everything before it.
  let chain = ''
  let previous: string | undefined
  plan.setup.operations.forEach((op, index) => {
    const used = plan.dto.snapshots.filter(
      (s) => s.id === op.tool || s.id === plan.dto.design.part.stock || s.id === plan.dto.machine,
    )
    chain = hashJson({
      previous: chain,
      index,
      // the whole part: `on` surfaces and formulas depend on other operations
      part: plan.dto.design.part,
      planOperation: op,
      snapshots: used,
      setup: { ...plan.setup, operations: undefined },
    })
    const previousPlanOperationId = previous
    previous = op.id
    if (!wanted(op.id)) return
    const e = evaluateOperation(plan, op)
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
      ...(previousPlanOperationId === undefined ? {} : { previousPlanOperationId }),
      inputHash: chain,
    })
  })
  return Ok(out)
}
