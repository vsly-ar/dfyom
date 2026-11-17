/**
 * Building plan records: create, rebuild from the current design, tool assignment with copy
 * reuse, duplicate. Pure functions over plain DTOs; the commands write the result.
 * Doc: docs/modes/plan-v0.1.md#plans-are-snapshots, docs/modes/plan-v0.1.md#plan-record
 */
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import type { IdGenerator } from '../commands/context'
import { fieldContext, partFromDTO, type Operation, type Part } from '../design/operation'
import { NAME_MAX } from '../library/item'
import type { LibraryItem } from '../library/library-item'
import { deepEqual, takeSnapshot } from '../library/snapshot'
import type { ProjectDoc, UnitSystem } from '../project/document'
import { Quantity } from '../quantity/quantity'
import { defaultOrder, repairOrder } from './order'
import { loadPlanDTO } from './plan'
import { lengthDTO, type LengthDTO, type PlanDTO, type PlanOperationDTO } from './plan.dto'
import { takeDesignSnapshot } from './snapshot'
import { suggestTools } from './suggest'
import { checkPartFits } from './validity'

export interface BuildContext {
  readonly ids: IdGenerator
  /** ISO time for `takenAt` of new copies. */
  readonly now: string
  readonly units: UnitSystem
  /** Readable tool items of the library (empty without a library: no tool is assigned). */
  readonly tools: readonly LibraryItem[]
}

/** Safe heights (docs/modes/plan-v0.1.md#setup-orientation-work-zero-safe-heights). */
const SAFE_HEIGHTS = {
  clearanceHeight: { mm: '10 mm', inch: '0.4"' },
  retractHeight: { mm: '2 mm', inch: '0.08"' },
} as const

export function defaultLength(source: string, units: UnitSystem): LengthDTO {
  return lengthDTO(Quantity.parse(source, fieldContext('length', units)).unwrap())
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Drillings with equal diameter, bottom, depth (and point angle) share one plan operation. */
function drillKey(op: Operation): string | undefined {
  if (op.kind !== 'drilling') return undefined
  const q = (v: Quantity) => v.exact.toString()
  return [q(op.diameter), op.bottom, op.depth.mapOr('-', q), op.pointAngle.mapOr('-', q)].join('|')
}

/** Groups of design operation ids, one per plan operation, in design order. */
export function groupOperations(ops: readonly Operation[]): string[][] {
  const groups: string[][] = []
  const byKey = new Map<string, string[]>()
  for (const op of ops) {
    const key = drillKey(op)
    const existing = key === undefined ? undefined : byKey.get(key)
    if (existing !== undefined) existing.push(op.id)
    else {
      const g = [op.id]
      groups.push(g)
      if (key !== undefined) byKey.set(key, g)
    }
  }
  return groups
}

function newPlanOperation(ids: IdGenerator, designOperationIds: string[]): PlanOperationDTO {
  return { id: ids.next('planOp'), designOperationIds, overrides: {}, strategy: {} }
}

/** Removes tool copies no plan operation references (stock and machine copies stay). */
export function pruneSnapshots(plan: PlanDTO): void {
  const used = new Set(plan.setups.flatMap((s) => s.operations.flatMap((o) => o.tool ?? [])))
  plan.snapshots = plan.snapshots.filter((s) => s.kind !== 'tool' || used.has(s.id))
}

/**
 * Assigns a library tool: reuses a copy with equal values of the same item, else takes a new
 * one; resets `presetName` (docs/modes/plan-v0.1.md#commands-and-queries-v01).
 */
export function assignTool(
  plan: PlanDTO,
  planOperationId: string,
  item: LibraryItem,
  c: Pick<BuildContext, 'ids' | 'now'>,
): AppResult<void> {
  const op = plan.setups[0]?.operations.find((o) => o.id === planOperationId)
  if (op === undefined) return Ok(undefined)
  const values = item.values.toDTO()
  let snap = plan.snapshots.find(
    (s) => s.kind === 'tool' && s.libraryItemId === item.id && deepEqual(s.values, values),
  )
  if (snap === undefined) {
    const taken = takeSnapshot(item, c.ids.next('snapshot'), c.now)
    if (taken.isErr()) return Err(taken.unwrapErr())
    snap = taken.unwrap().toDTO()
    plan.snapshots.push(snap)
  }
  op.tool = snap.id
  delete op.presetName
  pruneSnapshots(plan)
  return Ok(undefined)
}

/** Assigns the first suggestion to each listed plan operation without a tool, in order. */
function suggestAndAssign(
  plan: PlanDTO,
  planOperationIds: readonly string[],
  c: BuildContext,
): AppResult<void> {
  for (const id of planOperationIds) {
    const loaded = loadPlanDTO(plan, c.units, 'plan.suggest')
    if (loaded.isErr()) return Err(loaded.unwrapErr())
    const op = loaded.unwrap().setup.operations.find((o) => o.id === id)
    if (op === undefined || op.tool !== undefined) continue
    const first = suggestTools(loaded.unwrap(), op, c.tools)[0]
    const item = c.tools.find((t) => t.id === first?.toolLibraryItemId)
    if (item === undefined) continue
    const r = assignTool(plan, id, item, c)
    if (r.isErr()) return r
  }
  return Ok(undefined)
}

function partOf(plan: PlanDTO): AppResult<Part> {
  return partFromDTO(plan.design.part)
}

/** A new `draft` plan: design snapshot, one setup, every operation, suggested tools, default order. */
export function createPlan(
  doc: ProjectDoc,
  args: { partId: string; name?: string; machine?: LibraryItem },
  c: BuildContext,
  where: string,
): AppResult<PlanDTO> {
  const taken = takeDesignSnapshot(doc, args.partId, c.now, where)
  if (taken.isErr()) return Err(taken.unwrapErr())
  const { design, stock } = taken.unwrap()
  const part = partFromDTO(design.part)
  if (part.isErr()) return Err(part.unwrapErr().withContext(where))
  const id = c.ids.next('plan')
  const setupId = c.ids.next('setup')
  const plan: PlanDTO = {
    id,
    name: args.name ?? `Plan ${Object.keys(doc.plans).length + 1}`,
    status: 'draft',
    design,
    snapshots: [stock],
    setups: [
      {
        id: setupId,
        name: 'Setup 1',
        workOffset: 'G54',
        clearanceHeight: defaultLength(SAFE_HEIGHTS.clearanceHeight[c.units], c.units),
        retractHeight: defaultLength(SAFE_HEIGHTS.retractHeight[c.units], c.units),
        operations: groupOperations(part.unwrap().operations).map((g) =>
          newPlanOperation(c.ids, g),
        ),
      },
    ],
  }
  if (args.machine !== undefined) {
    const m = takeSnapshot(args.machine, c.ids.next('snapshot'), c.now)
    if (m.isErr()) return Err(m.unwrapErr().withContext(where))
    plan.snapshots.push(m.unwrap().toDTO())
    plan.machine = m.unwrap().id
  }
  const setup = plan.setups[0]!
  const assigned = suggestAndAssign(
    plan,
    setup.operations.map((o) => o.id),
    c,
  )
  if (assigned.isErr()) return Err(assigned.unwrapErr().withContext(where))
  setup.operations = defaultOrder(setup.operations, part.unwrap())
  return Ok(plan)
}

const RANK: Record<Operation['kind'], number> = { facing: 0, drilling: 1, pocket: 2, profile: 3 }

/**
 * The plan with its design snapshot replaced by the current design: plan operations matched by
 * design operation id keep tool, preset, overrides and strategy; ones whose operations are gone
 * are dropped; a drilling group whose holes no longer match splits (the split-off ones keep the
 * settings); new design operations get new plan operations with a suggested tool, placed by
 * the default group order; then the whole order is repaired so every `on` dependency holds. The
 * rebuilt part must fit the plan's own stock copy (else `model.invariant`, the plan unchanged).
 * Plan-only edits are discarded (the command checks the flag).
 */
export function rebuildPlan(
  current: PlanDTO,
  doc: ProjectDoc,
  c: BuildContext,
  where: string,
): AppResult<PlanDTO> {
  const taken = takeDesignSnapshot(doc, current.design.partId, c.now, where)
  if (taken.isErr()) return Err(taken.unwrapErr())
  const { design, stock } = taken.unwrap()
  const plan = copy(current)
  const oldStock = plan.design.part.stock
  plan.design = design
  if (design.part.stock !== oldStock)
    plan.snapshots = [stock, ...plan.snapshots.filter((s) => s.id !== oldStock)]
  const part = partOf(plan)
  if (part.isErr()) return Err(part.unwrapErr().withContext(where))
  const ops = part.unwrap().operations
  const byId = new Map(ops.map((o) => [o.id, o]))
  const setup = plan.setups[0]!
  const kept: PlanOperationDTO[] = []
  for (const p of setup.operations) {
    const ids = p.designOperationIds.filter((id) => byId.has(id))
    if (ids.length === 0) continue
    const groups = groupOperations(ids.map((id) => byId.get(id)!))
    kept.push({ ...p, designOperationIds: groups[0]! })
    for (const g of groups.slice(1))
      kept.push({ ...copy(p), id: c.ids.next('planOp'), designOperationIds: g })
  }
  const covered = new Set(kept.flatMap((p) => p.designOperationIds))
  const fresh = groupOperations(ops.filter((o) => !covered.has(o.id))).map((g) =>
    newPlanOperation(c.ids, g),
  )
  const rank = (p: PlanOperationDTO) => RANK[byId.get(p.designOperationIds[0]!)!.kind]
  const owner = new Map<string, string>()
  for (const p of kept) for (const d of p.designOperationIds) owner.set(d, p.id)
  const list = [...kept]
  for (const p of fresh) {
    for (const d of p.designOperationIds) owner.set(d, p.id)
    // after the last operation of an earlier or equal group, and after its `on` dependencies
    let at = 0
    list.forEach((q, i) => {
      if (rank(q) <= rank(p)) at = i + 1
    })
    for (const d of p.designOperationIds) {
      const o = byId.get(d)
      const on = o?.kind === 'pocket' || o?.kind === 'drilling' ? o.on.split('.')[0] : undefined
      const dep = on === undefined ? -1 : list.findIndex((q) => q.id === owner.get(on))
      at = Math.max(at, dep + 1)
    }
    list.splice(at, 0, p)
  }
  setup.operations = repairOrder(list, part.unwrap())
  pruneSnapshots(plan)
  // the design fits the design's stock; the plan's own stock copy may differ
  const stockCopy = plan.snapshots.find((x) => x.id === plan.design.part.stock)
  if (stockCopy === undefined)
    return fail('input.malformed', `plan ${plan.id}: the stock copy is missing`, { where })
  const fits = checkPartFits(plan.design.part, stockCopy, where)
  if (fits.isErr()) return Err(fits.unwrapErr().withContext(where, { planId: plan.id }))
  const assigned = suggestAndAssign(
    plan,
    fresh.map((p) => p.id),
    c,
  )
  if (assigned.isErr()) return Err(assigned.unwrapErr().withContext(where))
  return Ok(plan)
}

/** Deep copy with a new id; status `settledDesign` (docs/modes/plan-v0.1.md#plan-status). */
export function duplicatePlan(source: PlanDTO, id: string, name: string | undefined): PlanDTO {
  const { statusBeforeArchive: _, ...rest } = copy(source)
  const copyName = `${source.name.slice(0, NAME_MAX - ' (copy)'.length)} (copy)`
  return { ...rest, id, name: name ?? copyName, status: 'settledDesign' }
}
