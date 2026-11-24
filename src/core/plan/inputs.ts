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
import { planMaterialBands, planThroughDepths } from './through'
import type { MaterialBand, MaterialCover } from '../geometry/through-depth'
import { hashJson } from './snapshot'
import type { ResolvedStrategy } from './strategy'
import type { KeepOut } from '../toolpath/keep-out'
import { setupWorkholding } from './workholding/setup'

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
   * Through profiles (DF50) and through holes (DF61) over material an earlier setup of the plan
   * cleared from the opposite face: the material each cuts (mm) by design operation id
   * (`planThroughDepths`). Absent or not listed = the stock extent.
   */
  readonly throughDepths?: ReadonlyMap<string, number>
  /**
   * The material earlier cuts of the plan left over the region of a facing, pocket or profile
   * (DF61, `planMaterialBands`): its toolpath skips the passes that lie wholly in air. Absent =
   * the raw stock from the cut's start level to its floor. A pocket's carries its partial
   * coverage too (`MaterialCover.partial`).
   */
  readonly material?: MaterialCover
  /**
   * A drilling's material bands by design operation id (DF61 follow-up): a hole whose whole disc
   * earlier cuts cleared below its `on` level starts its cycle on the material. Absent or not
   * listed = from its `on` level.
   */
  readonly materials?: ReadonlyMap<string, MaterialBand>
  /**
   * The setup's workholding as zones a facing or pocket keeps out of (WH-D, footprints in the
   * WCS); absent for other kinds and setups without obstacles.
   * Doc: docs/modes/workholding.md#keep-out-in-toolpaths
   */
  readonly keepOut?: KeepOut
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
    // the clearance height follows the workholding unless the user set it (WH-C)
    const holding = setupWorkholding(own, plan.stock)
    const setup = {
      id: own.id,
      direction: setupDirection(own),
      rotation: setupRotation(own),
      workOffset: own.workOffset,
      clearanceHeight: holding.clearance,
      retractHeight: length(own.retractHeight),
    }
    const used = plan.dto.snapshots.filter(
      (s) => s.id === op.tool || s.id === plan.dto.design.part.stock || s.id === plan.dto.machine,
    )
    chain = hashJson({
      previous: chain,
      index,
      part,
      // the Z reference (DF69) moves only the exported program, never the toolpath
      planOperation: { ...op, zRef: undefined },
      snapshots: used,
      // workholding enters through the clearance height and region operations' own hash only, so
      // moving a clamp regenerates facings and pockets, not every operation (WH-D)
      setup: {
        ...own,
        operations: undefined,
        workholding: undefined,
        workholdingMargin: undefined,
        clearanceHeightSet: undefined,
        ...(holding.clearanceFrom === undefined ? {} : { clearance: holding.clearance }),
      },
      // strategy defaults depend on the unit system (e.g. overshoot 1 mm vs 0.04")
      units: plan.units,
    })
    const previousPlanOperationId = previous
    previous = op.id
    if (!wanted(op.id)) return
    const e = evaluateOperation(plan, op)
    const through = planThroughDepths(plan, port)
    const throughDepths = new Map<string, number>()
    for (const o of e.ops) {
      const d = through.get(o.id)
      if (d !== undefined) throughDepths.set(o.id, d)
    }
    // facings, pockets and profiles machine one design operation each
    const material =
      e.kind === 'facing' || e.kind === 'pocket' || e.kind === 'profile'
        ? planMaterialBands(plan, port).get(e.ops[0]?.id ?? '')
        : undefined
    const materials = new Map<string, MaterialBand>()
    if (e.kind === 'drilling')
      for (const o of e.ops) {
        const m = planMaterialBands(plan, port).get(o.id)
        if (m !== undefined) materials.set(o.id, m)
      }
    const keepOut: KeepOut | undefined =
      (e.kind === 'facing' || e.kind === 'pocket') && holding.prisms.length > 0
        ? {
            zones: holding.prisms.map((p) => ({
              itemId: p.itemId,
              footprint: p.footprint,
              zMax: p.zMax,
            })),
            margin: holding.margin,
          }
        : undefined
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
      ...(throughDepths.size === 0 ? {} : { throughDepths }),
      ...(material === undefined ? {} : { material }),
      ...(materials.size === 0 ? {} : { materials }),
      ...(previousPlanOperationId === undefined ? {} : { previousPlanOperationId }),
      ...(keepOut === undefined ? {} : { keepOut }),
      // the keep-out joins this operation's hash, not the chain (later operations keep theirs)
      inputHash: keepOut === undefined ? chain : hashJson({ chain, keepOut }),
    })
  })
  return Ok(out)
}
