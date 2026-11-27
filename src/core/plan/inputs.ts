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
import { roughingIdOf, roughingOwnerId, type Operation, type Part } from '../design/operation'
import { roughingSkin } from '../design/roughing'
import type { OperationKind } from '../design/part.dto'
import type { Direction } from '../geometry/face'
import type { Region2dPort } from '../geometry/2d/port'
import type { Machine } from '../library/machine'
import type { Stock } from '../library/stock'
import type { Tool } from '../library/tool'
import type { ProjectDoc } from '../project/document'
import { Quantity } from '../quantity/quantity'
import { cutTest } from './cut'
import { evaluateOperation, planFindings } from './evaluate'
import { namedPlanMessages } from './labels'
import type { ResolvedFeeds } from './feeds'
import type { SetupRotation } from './plan.dto'
import { setupDirection, setupRotation } from './setups'
import { loadPlan, setupOf, type LoadedPlan } from './plan'
import { planMaterialBands, planThroughDepths } from './through'
import type { MaterialBand, MaterialCover } from '../geometry/through-depth'
import { hashJson } from './snapshot'
import { setupZero } from './alignment'
import type { Vec2 } from '../geometry/model'
import type { ResolvedStrategy } from './strategy'
import type { KeepOut } from '../toolpath/keep-out'
import { setupWorkholding } from './workholding/setup'
import { aidGeometry, type AidGeometry } from './aids'

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
    /**
     * The work zero in the setup frame (mm; alignment phase 1): the toolpaths are shifted by it.
     * Absent = the front-left corner of the up face (byte-identical toolpaths).
     */
    readonly zero?: Vec2
    readonly workOffset: 'G54'
    readonly clearanceHeight: number
    readonly retractHeight: number
  }
  /** The tool copy and its id in the plan's snapshots (`Toolpath.tool`). */
  readonly tool: Tool
  readonly toolSnapshotId: string
  readonly stickout: number
  /** Minimum stickout (mm, DF130, `OperationEvaluation.stickoutNeeded`); not in the hash. */
  readonly stickoutNeeded?: number
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
  /**
   * An alignment aid's geometry in the face frame (S14): a registration hole's centre and Ø (a
   * through drilling), a witness mark's line or spot at its V-bit depth. Absent for every other.
   * Doc: docs/modes/alignment.md#implementation-slice-2
   */
  readonly aid?: AidGeometry
  /**
   * A pocket machined after its roughing pocket (DF108 patterns, DF122 pockets): the roughing's
   * tool radius, corner radius and stock to leave, so the pocket cuts only the rest. Absent
   * without an earlier roughing.
   * Doc: docs/modes/roughing.md#rest-by-the-operation
   */
  readonly restAfter?: RoughingReach
  /**
   * DF122: a roughing pocket's floor margin (mm, > 0): it stops this much above its floor.
   * Absent = 0 (to the floor). Doc: docs/modes/roughing.md#stock-to-leave-wall-and-floor
   */
  readonly roughingFloor?: number
  /**
   * Already cut (DF135, its design operations are marked in Design, docs/modes/cut-state.md):
   * generated (later operations and the links read its removal) but left out of the program.
   * Not in the hash.
   */
  readonly cut?: true
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
 * What a roughing pocket cleared, by its tool and stock to leave (DF122, mm): the generator's
 * `RestAfter` with the floor margin, which becomes `floorDepth` once the pocket's depth is known.
 */
export interface RoughingReach {
  readonly radius: number
  readonly cornerRadius: number
  readonly wall: number
  readonly floor: number
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
  // D4: the failure names the operation ("Pocket 1 (op3): no tool assigned")
  const errors = namedPlanMessages(
    plan.dto,
    planFindings(plan, undefined, port).filter(
      (f) =>
        f.severity === 'error' && (f.planOperationId === undefined || wanted(f.planOperationId)),
    ),
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
  // DF135: the already-cut list only leaves operations out of the program, so their toolpaths
  // (and every later one) stay cached when it changes
  const part = hashJson({
    ...plan.dto.design.part,
    alreadyCut: undefined,
    alreadyCutMarks: undefined,
  })
  const isCut = cutTest(plan.dto.design.part)
  let chain = ''
  let previous: string | undefined
  plan.operations.forEach((op, index) => {
    const own = setupOf(plan, op.id)
    const zero = setupZero(plan, own, port)
    const moved = zero[0] !== 0 || zero[1] !== 0
    // the clearance height follows the workholding unless the user set it (WH-C)
    const holding = setupWorkholding(own, plan.stock)
    const setup = {
      id: own.id,
      direction: setupDirection(own),
      rotation: setupRotation(own),
      ...(moved ? { zero } : {}),
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
      // the links (DF64) change only the exported program, never the toolpaths;
      // S5: the resolved zero, not the points (docs/modes/alignment.md#implementation-slice-1);
      // workholding enters through the clearance height and region operations' own hash only, so
      // moving a clamp regenerates facings and pockets, not every operation (WH-D)
      setup: {
        ...own,
        operations: undefined,
        alignment: undefined,
        zero: moved ? zero : undefined,
        workholding: undefined,
        retraction: undefined,
        clampHeight: undefined,
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
      // DF122 R4: a through roughing profile stops above the material its owner cuts through
      const d = through.get(o.kind === 'profile' && o.roughing === true ? o.roughingOf! : o.id)
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
    const aid =
      op.aid === undefined
        ? undefined
        : aidGeometry(
            plan,
            own,
            op.aid,
            e.strategy.kind === 'chamfer' ? e.strategy.cutDepth : undefined,
          )
    const rests = e.kind === 'pocket' || e.kind === 'profile'
    const restAfter = rests ? roughingBefore(plan, e.ops[0], index) : undefined
    // DF122: a roughing pocket or profile (R4) leaves its margins: the wall as its finishing
    // allowance
    const leave = rests ? roughingLeave(plan, e.ops[0]) : undefined
    const strategy =
      leave !== undefined && (e.strategy.kind === 'pocket' || e.strategy.kind === 'profile')
        ? { ...e.strategy, finishAllowance: leave.wall }
        : e.strategy
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
      ...e.stickoutNeeded.mapOr<{ stickoutNeeded?: number }>({}, (stickoutNeeded) => ({
        stickoutNeeded,
      })),
      feeds: e.feeds.unwrap(),
      strategy,
      machine: plan.machine,
      ...(throughDepths.size === 0 ? {} : { throughDepths }),
      ...(material === undefined ? {} : { material }),
      ...(materials.size === 0 ? {} : { materials }),
      ...(previousPlanOperationId === undefined ? {} : { previousPlanOperationId }),
      ...(isCut(op) ? { cut: true as const } : {}),
      ...(keepOut === undefined ? {} : { keepOut }),
      ...(aid === undefined ? {} : { aid }),
      ...(restAfter === undefined ? {} : { restAfter }),
      ...(leave === undefined || leave.floor <= 0 ? {} : { roughingFloor: leave.floor }),
      // the keep-out joins this operation's hash, not the chain (later operations keep theirs)
      inputHash: keepOut === undefined ? chain : hashJson({ chain, keepOut }),
    })
  })
  return Ok(out)
}

/**
 * What the roughing pocket of pocket `op` cleared (DF108 a pattern's, DF122 a pocket's own), by
 * its tool and stock to leave, when a plan operation before `index` machines it; undefined
 * otherwise (no roughing, or the pocket moved before it: it then clears everything itself).
 */
function roughingBefore(
  plan: LoadedPlan,
  op: Operation | undefined,
  index: number,
): RoughingReach | undefined {
  const id = op === undefined ? undefined : roughingIdOf(op)
  if (id === undefined) return undefined
  const at = plan.operations.findIndex((p) => p.designOperationIds.includes(id))
  if (at < 0 || at >= index) return undefined
  const e = evaluateOperation(plan, plan.operations[at]!)
  const leave = roughingLeave(plan, e.ops[0])
  if (e.tool.isNone() || leave === undefined) return undefined
  const tool = e.tool.unwrap()
  return {
    radius: tool.diameter.canonical / 2,
    cornerRadius:
      tool.type === 'bullNoseEndMill' ? tool.cornerRadius.mapOr(0, (q) => q.canonical) : 0,
    ...leave,
  }
}

/**
 * DF122: a roughing pocket's or profile's (R4) stock to leave (mm): its `leave` margins, the wall
 * by default its owner's resolved finishing allowance (the owner's finishing ring or pass then
 * takes it), the floor 0, a through profile's its skin (`roughingSkin`); undefined when `op` is no
 * roughing operation.
 * Doc: docs/modes/roughing.md#stock-to-leave-wall-and-floor, docs/modes/roughing.md#implementation-r4
 */
export function roughingLeave(
  plan: LoadedPlan,
  op: Operation | undefined,
): { wall: number; floor: number } | undefined {
  if ((op?.kind !== 'pocket' && op?.kind !== 'profile') || op.roughing !== true) return undefined
  const floor =
    op.kind === 'profile' ? roughingSkin(op, plan.units) : (op.leave?.floor?.canonical ?? 0)
  if (op.leave?.wall !== undefined) return { wall: op.leave.wall.canonical, floor }
  const ownerId = roughingOwnerId(op)
  const owner = plan.operations.find(
    (p) => ownerId !== undefined && p.designOperationIds.includes(ownerId),
  )
  const own = plan.operations.find((p) => p.designOperationIds.includes(op.id))
  const s =
    (owner ?? own) === undefined ? undefined : evaluateOperation(plan, (owner ?? own)!).strategy
  return { wall: s?.kind === 'pocket' || s?.kind === 'profile' ? s.finishAllowance : 0, floor }
}
