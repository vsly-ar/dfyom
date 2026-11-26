/**
 * Building plan records: create, rebuild from the current design, tool assignment with copy
 * reuse, duplicate. Pure functions over plain DTOs; the commands write the result.
 * Doc: docs/modes/plan-v0.1.md#plans-are-snapshots, docs/modes/plan-v0.1.md#plan-record
 */
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import type { IdGenerator } from '../commands/context'
import {
  circularEdgeDiameter,
  fieldContext,
  partFromDTO,
  type Operation,
  type Part,
} from '../design/operation'
import { enabledPart } from '../design/disabled'
import type { PartDTO } from '../design/part.dto'
import { designToolToDTO } from '../design/tool'
import { stableJson } from '../project/layout'
import { NAME_MAX } from '../library/item'
import type { LibraryItem } from '../library/library-item'
import { deepEqual, takeSnapshot, type SnapshotDTO } from '../library/snapshot'
import type { ProjectDoc, UnitSystem } from '../project/document'
import { Quantity } from '../quantity/quantity'
import type { Direction } from '../geometry/face'
import type { Region2dPort } from '../geometry/2d/port'
import {
  edgeDependencies,
  keepWithEdge,
  onDependencies,
  operationDirections,
  placeByTool,
  repairOrder,
  surfaceDirection,
} from './order'
import { findPlanOperation, loadPlanDTO, type PlanLoadCache } from './plan'
import {
  lengthDTO,
  type LengthDTO,
  type ParkedOperationDTO,
  type PlanDTO,
  type PlanOperationDTO,
  type SetupDTO,
} from './plan.dto'
import { defaultSetupIndex, deriveSetups, newSetup, setupDirection } from './setups'
import { takeDesignSnapshot } from './snapshot'
import { designToolField, sameDesignToolField } from './design-tool'
import { resolveTool } from './tool-resolution'
import { isAid } from './aids'
import { checkPartFits, sameValue } from './validity'

export interface BuildContext {
  readonly ids: IdGenerator
  /** ISO time for `takenAt` of new copies. */
  readonly now: string
  readonly units: UnitSystem
  /** Readable tool items of the library (empty without a library: no tool is assigned). */
  readonly tools: readonly LibraryItem[]
  /**
   * The 2D port (`services.region2d`): tool resolution and the part check then run the checks of
   * general shapes (width, `tabOutside`, …) as `plan.warning.list` does (v0.3 T3).
   */
  readonly region2d?: Region2dPort
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

/**
 * Drillings of one face direction with equal diameter, bottom, depth (and point angle) and an
 * equal design tool field share one plan operation (a plan operation lies in one setup and has
 * one tool, docs/modes/plan-v0.2.md#tool-resolution-from-the-design-tool-field).
 */
function drillKey(op: Operation, direction: Direction): string | undefined {
  if (op.kind !== 'drilling') return undefined
  const q = (v: Quantity) => v.exact.toString()
  const depth = op.depth.mapOr('-', q)
  const tool = op.tool.mapOr('-', (t) => stableJson(designToolToDTO(t)))
  return [
    direction,
    q(op.diameter),
    op.bottom,
    depth,
    op.pointAngle.mapOr('-', q),
    tool,
    op.toolLocked ? 'locked' : 'auto',
  ].join('|')
}

/**
 * Chamfers of one face direction with equal angle, width and edge diameter and an equal design
 * tool field share one plan operation, as equal holes do (plan-v0.4.md P-B): the generator cuts
 * them in nearest-neighbour order with one tool. `all` finds the edge.
 */
function chamferKey(
  op: Operation,
  direction: Direction,
  byId: ReadonlyMap<string, Operation>,
): string | undefined {
  if (op.kind !== 'chamfer') return undefined
  const edge = byId.get(op.edgeOf)
  const edgeDiameter = circularEdgeDiameter(edge)
  // not a round edge: the plan reports it; never grouped
  if (edgeDiameter === undefined) return undefined
  const q = (v: Quantity) => v.exact.toString()
  return [
    'chamfer',
    direction,
    q(op.angle),
    q(op.width),
    q(edgeDiameter),
    op.tool.mapOr('-', (t) => stableJson(designToolToDTO(t))),
    op.toolLocked ? 'locked' : 'auto',
  ].join('|')
}

/** Groups of design operation ids, one per plan operation, in design order (`all`: the part's). */
export function groupOperations(
  ops: readonly Operation[],
  all: readonly Operation[] = ops,
): string[][] {
  const byId = new Map(all.map((o) => [o.id, o]))
  const groups: string[][] = []
  const byKey = new Map<string, string[]>()
  for (const op of ops) {
    const direction = surfaceDirection(op.on, byId)
    const key = drillKey(op, direction) ?? chamferKey(op, direction, byId)
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

/**
 * Removes tool copies neither a plan operation nor a design tool field of the plan's part
 * references, and workholding copies no setup item names (stock and machine copies stay).
 */
export function pruneSnapshots(plan: PlanDTO): void {
  const used = new Set([
    ...plan.setups.flatMap((s) => s.operations.flatMap((o) => o.tool ?? [])),
    // a parked plan operation keeps its tool copy for when it comes back (DF106)
    ...(plan.parked ?? []).flatMap((p) => p.operation.tool ?? []),
    ...plan.design.part.operations.flatMap((o) =>
      o.tool?.kind === 'specific' ? [o.tool.snapshotId] : [],
    ),
  ])
  // and workholding copies no setup item names (a rebuild may drop a setup, WL2)
  const devices = new Set(
    plan.setups.flatMap((s) => (s.workholding ?? []).flatMap((i) => i.copyId ?? [])),
  )
  plan.snapshots = plan.snapshots.filter((s) =>
    s.kind === 'tool' ? used.has(s.id) : s.kind !== 'workholding' || devices.has(s.id),
  )
}

/**
 * A new snapshot id not used in the plan: its copies of the design's tool snapshots keep the
 * design's ids, which an id generator does not know about in tests.
 */
export function nextSnapshotId(plan: PlanDTO, ids: IdGenerator): string {
  for (;;) {
    const id = ids.next('snapshot')
    if (!plan.snapshots.some((s) => s.id === id)) return id
  }
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
  const ref = findPlanOperation(plan, planOperationId, 'plan.tool.assign')
  if (ref.isErr()) return Ok(undefined)
  const op = plan.setups[ref.unwrap().setup]!.operations[ref.unwrap().index]!
  let snap = equalCopy(plan, item)
  if (snap === undefined) {
    const taken = takeSnapshot(item, nextSnapshotId(plan, c.ids), c.now)
    if (taken.isErr()) return Err(taken.unwrapErr())
    snap = taken.unwrap().toDTO()
    plan.snapshots.push(snap)
  }
  op.tool = snap.id
  delete op.presetName
  pruneSnapshots(plan)
  return Ok(undefined)
}

/** The plan's tool copy of `item` with its current values, if any. */
function equalCopy(plan: PlanDTO, item: LibraryItem): PlanDTO['snapshots'][number] | undefined {
  const values = item.values.toDTO()
  return plan.snapshots.find(
    (s) => s.kind === 'tool' && s.libraryItemId === item.id && deepEqual(s.values, values),
  )
}

/** Sets the tool copy; a different tool resets `presetName` (the same one keeps it). */
function setTool(op: PlanOperationDTO, snapshotId: string | undefined): void {
  if (op.tool === snapshotId) return
  if (snapshotId === undefined) delete op.tool
  else op.tool = snapshotId
  delete op.presetName
}

/**
 * Resolves the tool of each listed plan operation from the design tool field, in order
 * (docs/modes/plan-v0.2.md#tool-resolution-from-the-design-tool-field), and marks it
 * `toolSource: 'design'`. Never fails because of a tool: an unresolved one is a finding.
 */
export function resolveAndAssign(
  plan: PlanDTO,
  planOperationIds: readonly string[],
  c: BuildContext,
): AppResult<void> {
  // the part is not changed here: parsed once; the copies are reloaded per operation (a tool
  // assignment adds or prunes them), each parsed once
  const cache: PlanLoadCache = { snapshots: new Map() }
  for (const id of planOperationIds) {
    const loaded = loadPlanDTO(plan, c.units, 'plan.toolResolution', cache)
    if (loaded.isErr()) return Err(loaded.unwrapErr())
    const ref = findPlanOperation(plan, id, 'plan.toolResolution')
    if (ref.isErr()) continue
    const op = plan.setups[ref.unwrap().setup]!.operations[ref.unwrap().index]!
    op.toolSource = 'design'
    delete op.designToolChanged
    const r = resolveTool(loaded.unwrap(), op, c.tools, c.region2d)
    if (r.kind === 'copy') setTool(op, r.snapshotId)
    else if (r.kind === 'none') setTool(op, undefined)
    else if (
      r.kind === 'item' &&
      (op.tool === undefined || op.tool !== equalCopy(plan, r.item)?.id)
    ) {
      const assigned = assignTool(plan, id, r.item, c)
      if (assigned.isErr()) return assigned
    }
  }
  pruneSnapshots(plan)
  return Ok(undefined)
}

function partOf(plan: PlanDTO): AppResult<Part> {
  return partFromDTO(plan.design.part)
}

/**
 * A new `draft` plan: design snapshot, one setup per approach direction in use (default setup
 * order), every operation, suggested tools, default order in each setup.
 * Doc: docs/modes/plan-v0.2.md#setups-from-face-directions
 */
export function createPlan(
  doc: ProjectDoc,
  args: { partId: string; name?: string; machine?: LibraryItem },
  c: BuildContext,
  where: string,
): AppResult<PlanDTO> {
  const taken = takeDesignSnapshot(doc, args.partId, c.now, where)
  if (taken.isErr()) return Err(taken.unwrapErr())
  const { design, stock, tools } = taken.unwrap()
  const part = partFromDTO(design.part)
  if (part.isErr()) return Err(part.unwrapErr().withContext(where))
  const id = c.ids.next('plan')
  const operations = groupOperations(part.unwrap().operations).map((g) =>
    newPlanOperation(c.ids, g),
  )
  const heights = safeHeights(c.units)
  const plan: PlanDTO = {
    id,
    name: args.name ?? `Plan ${Object.keys(doc.plans).length + 1}`,
    status: 'draft',
    design,
    snapshots: [stock, ...tools],
    // one setup holding every operation while tools are suggested; derived below
    setups: [{ ...newSetup('-', '+z', heights, []), operations }],
  }
  if (args.machine !== undefined) {
    const m = takeSnapshot(args.machine, nextSnapshotId(plan, c.ids), c.now)
    if (m.isErr()) return Err(m.unwrapErr().withContext(where))
    plan.snapshots.push(m.unwrap().toDTO())
    plan.machine = m.unwrap().id
  }
  const assigned = resolveAndAssign(
    plan,
    operations.map((o) => o.id),
    c,
  )
  if (assigned.isErr()) return Err(assigned.unwrapErr().withContext(where))
  // tools are resolved first: the default order keeps operations of one tool adjacent
  const suggested = plan.setups[0]!.operations
  plan.setups = deriveSetups(
    suggested,
    part.unwrap(),
    (d, setups) => newSetup(c.ids.next('setup'), d, heights, setups),
    c.region2d,
  )
  return Ok(plan)
}

/** The default clearance height (plan.setup.update's `auto` restores it, WH-C). */
export const defaultClearance = (units: UnitSystem): LengthDTO =>
  defaultLength(SAFE_HEIGHTS.clearanceHeight[units], units)

function safeHeights(units: UnitSystem): Pick<SetupDTO, 'clearanceHeight' | 'retractHeight'> {
  return {
    clearanceHeight: defaultLength(SAFE_HEIGHTS.clearanceHeight[units], units),
    retractHeight: defaultLength(SAFE_HEIGHTS.retractHeight[units], units),
  }
}

const RANK: Record<Operation['kind'], number> = {
  facing: 0,
  drilling: 1,
  pocket: 2,
  chamfer: 3,
  line: 3,
  profile: 4,
}

/**
 * The plan with its design snapshot replaced by the current design: plan operations matched by
 * design operation id keep tool, preset, overrides, strategy and setup; ones whose operations are
 * gone are dropped; a drilling group whose holes no longer match splits (the split-off ones keep
 * the settings); new design operations get new plan operations with a suggested tool, placed by
 * the default group order in the last setup of their direction (a new direction: a new setup at
 * its default position; an operation whose direction changed moves the same way); empty setups
 * are removed; then each setup's order is repaired so every `on` dependency holds.
 * Doc: docs/modes/plan-v0.2.md#merge-split-reorder The
 * rebuilt part must fit the plan's own stock copy (else `model.invariant`, the plan unchanged).
 * Plan-only edits are discarded (the command checks the flag).
 */
export function rebuildPlan(
  current: PlanDTO,
  doc: ProjectDoc,
  c: BuildContext,
  where: string,
  /**
   * DF106: rebuild from the plan's own snapshot (its plan edits kept) instead of the current
   * design, after its own disabled list changed: Design changes are not taken.
   */
  own = false,
): AppResult<PlanDTO> {
  const taken = own
    ? Ok(ownSnapshot(current, doc))
    : takeDesignSnapshot(doc, current.design.partId, c.now, where, current.disabled)
  if (taken.isErr()) return Err(taken.unwrapErr())
  const { design, stock, tools } = taken.unwrap()
  const plan = copy(current)
  const oldStock = plan.design.part.stock
  const before = current.design.taken
  plan.design = design
  if (design.part.stock !== oldStock)
    plan.snapshots = [stock, ...plan.snapshots.filter((s) => s.id !== oldStock)]
  // copies of new design tool snapshots; an existing copy stays (it follows the library itself)
  for (const t of tools) if (!plan.snapshots.some((s) => s.id === t.id)) plan.snapshots.push(t)
  const part = partOf(plan)
  if (part.isErr()) return Err(part.unwrapErr().withContext(where))
  const ops = part.unwrap().operations
  const byId = new Map(ops.map((o) => [o.id, o]))
  // DF106: design operations that still exist but are off (in the design or in this plan); a
  // plan operation of only such operations is parked, not dropped, and comes back when they do
  const record = Object.hasOwn(doc.parts, current.design.partId)
    ? doc.parts[current.design.partId]
    : undefined
  const exists = new Set([
    ...(record?.operations ?? []).map((o) => o.id),
    ...(own ? current.design.taken.operations.map((o) => o.id) : []),
  ])
  const isOff = (ids: readonly string[]) =>
    ids.length > 0 && ids.every((id) => exists.has(id) && !byId.has(id))
  const parked: ParkedOperationDTO[] = []
  const planEdits = new Map(current.design.part.operations.map((o) => [o.id, o]))
  const takenById = new Map(current.design.taken.operations.map((o) => [o.id, o]))
  // kept plan operations per setup (a drilling group whose holes no longer match splits)
  const setups: SetupDTO[] = plan.setups.map((s) => {
    const kept: PlanOperationDTO[] = []
    s.operations.forEach((p, index) => {
      // alignment aids are no design operation: a rebuild keeps them in place (S20)
      if (isAid(p)) {
        kept.push(p)
        return
      }
      const ids = p.designOperationIds.filter((id) => byId.has(id))
      if (ids.length === 0) {
        if (isOff(p.designOperationIds)) {
          // the plan's own edits of its design operations go with it (a settled plan's toggle)
          const edits = p.designOperationIds.flatMap((id) => {
            const e = planEdits.get(id)
            return e !== undefined && !sameValue(e, takenById.get(id)) ? [copy(e)] : []
          })
          parked.push({
            setupId: s.id,
            index,
            operation: p,
            ...(own && edits.length > 0 ? { edits } : {}),
          })
        }
        return
      }
      const groups = groupOperations(
        ids.map((id) => byId.get(id)!),
        ops,
      )
      kept.push({ ...p, designOperationIds: groups[0]! })
      for (const g of groups.slice(1))
        kept.push({ ...copy(p), id: c.ids.next('planOp'), designOperationIds: g })
    })
    return { ...s, operations: kept }
  })
  // DF106: parked plan operations whose design operations are all back return with their
  // settings, at their place when their setup is still there; others stay parked while off
  const usedIds = new Set(setups.flatMap((s) => s.operations.map((p) => p.id)))
  const restored: PlanOperationDTO[] = []
  const loose: PlanOperationDTO[] = []
  for (const entry of current.parked ?? []) {
    const ids = entry.operation.designOperationIds
    if (ids.length > 0 && ids.every((id) => byId.has(id))) {
      const p = copy(entry.operation)
      if (usedIds.has(p.id)) p.id = c.ids.next('planOp')
      usedIds.add(p.id)
      restored.push(p)
      const home = setups.find((s) => s.id === entry.setupId)
      if (home === undefined) loose.push(p)
      else home.operations.splice(Math.min(entry.index, home.operations.length), 0, p)
    } else if (isOff(ids)) {
      const { edits, ...rest } = entry
      // a rebuild from the design discards plan edits; a toggle keeps them
      parked.push(own && edits !== undefined ? { ...rest, edits } : rest)
    }
  }
  if (parked.length > 0) plan.parked = parked
  else delete plan.parked
  const covered = new Set([
    ...setups.flatMap((s) => s.operations.flatMap((p) => p.designOperationIds)),
    ...loose.flatMap((p) => p.designOperationIds),
  ])
  const fresh = groupOperations(
    ops.filter((o) => !covered.has(o.id)),
    ops,
  ).map((g) => newPlanOperation(c.ids, g))
  const direction = operationDirections(
    [...setups.flatMap((s) => s.operations), ...loose, ...fresh],
    part.unwrap(),
  )
  // an operation whose `on` changed direction moves like a new one
  const placed: PlanOperationDTO[] = []
  for (const s of setups)
    s.operations = s.operations.filter((p) => {
      if (isAid(p)) return true
      const same = direction.get(p.id) === setupDirection(s)
      if (!same) placed.push(p)
      return same
    })
  placed.push(...loose, ...fresh)
  // an aid ranks as a drilling (holes) or last (marks), alignment.md § Alignment aids (Order)
  const rank = (p: PlanOperationDTO) =>
    p.aid !== undefined
      ? p.aid.kind === 'registrationHole'
        ? RANK.drilling
        : Infinity
      : RANK[byId.get(p.designOperationIds[0]!)!.kind]
  const owner = new Map<string, string>()
  for (const s of setups)
    for (const p of s.operations) for (const d of p.designOperationIds) owner.set(d, p.id)
  const heights = setups[0]!
  for (const p of placed) {
    const d = direction.get(p.id) ?? '+z'
    // after the setups holding its dependencies (E4b: a bottom chamfer after its through
    // profile's setup of another direction)
    const deps = new Set(
      p.designOperationIds.flatMap((id) => {
        const o = byId.get(id)
        return o === undefined
          ? []
          : [...onDependencies(o), ...edgeDependencies(o)].flatMap((x) => owner.get(x) ?? [])
      }),
    )
    const after = setups.findLastIndex((s) => s.operations.some((q) => deps.has(q.id)))
    // the last setup of its direction, else a new setup at its default position
    let target = setups.findLast((s, i) => setupDirection(s) === d && i >= after)
    if (target === undefined) {
      target = newSetup(c.ids.next('setup'), d, heights, setups)
      setups.splice(Math.max(defaultSetupIndex(setups, d), after + 1), 0, target)
    }
    for (const id of p.designOperationIds) owner.set(id, p.id)
    // after the last operation of an earlier or equal group, and after its `on` dependencies
    const list = target.operations
    let at = 0
    list.forEach((q, i) => {
      if (rank(q) <= rank(p)) at = i + 1
    })
    for (const id of p.designOperationIds) {
      const o = byId.get(id)
      // its `on` surface's operation and a chamfer's edge (T1) come first
      for (const d of o === undefined ? [] : [...onDependencies(o), ...edgeDependencies(o)]) {
        const dep = list.findIndex((q) => q.id === owner.get(d))
        at = Math.max(at, dep + 1)
      }
    }
    list.splice(at, 0, p)
  }
  for (const s of setups) s.operations = repairOrder(s.operations, part.unwrap())
  // an empty setup is removed; one left with only alignment aids is kept with them, never
  // dropped silently (S20, DF78 known gap closed: `plan.aid` info `onlyAids`); a plan keeps at
  // least one setup
  const used = setups.filter((s) => s.operations.length > 0)
  plan.setups = used.length > 0 ? used : setups.slice(0, 1)
  pruneSnapshots(plan)
  // the design fits the design's stock; the plan's own stock copy may differ
  const stockCopy = plan.snapshots.find((x) => x.id === plan.design.part.stock)
  if (stockCopy === undefined)
    return fail('input.malformed', `plan ${plan.id}: the stock copy is missing`, { where })
  const fits = checkPartFits(plan.design.part, stockCopy, where, c.region2d)
  if (fits.isErr()) return Err(fits.unwrapErr().withContext(where, { planId: plan.id }))
  // re-resolve `design` tools whose design tool field changed; plan assignments stay, flagged
  const changed: string[] = []
  const freshIds = new Set(fresh.map((p) => p.id))
  const restoredIds = new Set(restored.map((p) => p.id))
  for (const s of plan.setups)
    for (const p of s.operations) {
      if (freshIds.has(p.id)) continue
      // a restored one: its design tool is resolved again when it came from the design; a
      // tool assigned in the plan stays (no earlier tool field to compare with)
      if (restoredIds.has(p.id)) {
        if (p.toolSource === 'design') changed.push(p.id)
        continue
      }
      if (sameDesignToolField(designToolField(before, p), designToolField(design.part, p))) continue
      if (p.toolSource === 'design') changed.push(p.id)
      else p.designToolChanged = true
    }
  const resolved = [...changed, ...fresh.map((p) => p.id)]
  const assigned = resolveAndAssign(plan, resolved, c)
  if (assigned.isErr()) return Err(assigned.unwrapErr().withContext(where))
  // with tools known: a new operation moves to where it adds the fewest tool changes (order
  // v2), and a resolved chamfer sharing its edge operation's tool joins it (F7)
  for (const s of plan.setups) {
    const placedByTool = placeByTool(s.operations, part.unwrap(), freshIds, c.region2d)
    s.operations = keepWithEdge(placedByTool, part.unwrap(), new Set(resolved))
  }
  return Ok(plan)
}

/**
 * The plan's own design snapshot with its disabled list applied again (DF106): `taken` and the
 * snapshot time stay; `part` is `taken` with the plan's edits (its version of each operation it
 * still has) minus the plan's disabled items. Tool snapshots of re-enabled operations come from
 * the document when the plan no longer holds them.
 */
function ownSnapshot(
  plan: PlanDTO,
  doc: ProjectDoc,
): { design: PlanDTO['design']; stock: PlanDTO['snapshots'][number]; tools: SnapshotDTO[] } {
  const edited = new Map([
    // the plan's edits of parked operations (DF106), then of the ones it has
    ...(plan.parked ?? []).flatMap((p) => (p.edits ?? []).map((o) => [o.id, o] as const)),
    ...plan.design.part.operations.map((o) => [o.id, o] as const),
  ])
  const merged: PartDTO = {
    ...plan.design.taken,
    operations: plan.design.taken.operations.map((o) => edited.get(o.id) ?? o),
  }
  const part = copy(enabledPart(merged, plan.disabled ?? []))
  const stock = plan.snapshots.find((x) => x.id === part.stock)!
  const tools = part.operations.flatMap((o) => {
    const id = o.tool?.kind === 'specific' ? o.tool.snapshotId : undefined
    if (id === undefined || plan.snapshots.some((x) => x.id === id)) return []
    const t = Object.hasOwn(doc.snapshots, id) ? doc.snapshots[id] : undefined
    return t?.kind === 'tool' ? [copy(t)] : []
  })
  return { design: { ...plan.design, part }, stock, tools }
}

/** Deep copy with a new id; status `settledDesign` (docs/modes/plan-v0.1.md#plan-status). */
export function duplicatePlan(source: PlanDTO, id: string, name: string | undefined): PlanDTO {
  const { statusBeforeArchive: _, ...rest } = copy(source)
  const copyName = `${source.name.slice(0, NAME_MAX - ' (copy)'.length)} (copy)`
  return { ...rest, id, name: name ?? copyName, status: 'settledDesign' }
}
