/**
 * Plan-side pending keys of Apply and the `pendingApply` flag of plan queries:
 * plan inputs of kept-current plans, `draft` plans that do not follow their part, and changed
 * library items that `draft` plans copy.
 * Doc: docs/architecture/apply.md#what-is-pending, docs/architecture/apply.md#queries-for-pending-state
 */
import { changedFields, movedIds, type PendingChange } from '../commands/apply'
import type { Services } from '../commands/context'
import type { PendingSource } from '../commands/define'
import type { ProjectDoc } from '../project/document'
import { planOperationInputs } from './inputs'
import type { PlanDTO } from './plan.dto'
import { designChanged, planStale } from './snapshot'
import { rebuildBlocker, sameValue } from './validity'

type Rec = Record<string, unknown>

/**
 * A plan is **kept current** when it is not archived and its toolpaths were generated before
 * (the toolpath cache remembers one of its operations): Apply regenerates its stale toolpaths
 * (docs/architecture/apply.md#apply-jobs).
 */
export function keptCurrent(plan: PlanDTO, services: Services): boolean {
  return plan.status !== 'archived' && services.toolpaths?.generated(plan.id) === true
}

/** Plan operation fields no toolpath reads. */
const PLAN_OPERATION_IGNORED = new Set(['id'])
/** Setup fields read elsewhere (`operations`) or by no toolpath. */
const SETUP_IGNORED = new Set(['id', 'name', 'operations'])

/** "Pocket 1, Drilling 2": the design operations a plan operation machines. */
function opLabel(plan: PlanDTO, designOperationIds: readonly string[]): string {
  const names = designOperationIds.map(
    (id) => plan.design.part.operations.find((o) => o.id === id)?.name ?? id,
  )
  return names.join(', ')
}

/** Changed plan inputs of one plan (both versions exist), by value. */
function planInputDiff(after: PlanDTO, before: PlanDTO): PendingChange[] {
  const out: PendingChange[] = []
  const key = (
    field: string,
    label: string,
    at: { operationId?: string; setupId?: string } = {},
  ): PendingChange => ({
    kind: 'plan',
    planId: after.id,
    partId: after.design.partId,
    ...at,
    field,
    label: `${after.name}: ${label}`,
  })
  if (after.machine !== before.machine) out.push(key('machine', 'machine'))
  if (after.design.part !== before.design.part && !sameValue(after.design.part, before.design.part))
    out.push(key('design', 'design copy'))
  if (after.snapshots !== before.snapshots) {
    const old = new Map(before.snapshots.map((s) => [s.id, s]))
    for (const s of after.snapshots) {
      const b = old.get(s.id)
      if (b === s || (b !== undefined && sameValue(b, s))) continue
      out.push(key(`snapshots.${s.id}`, `${s.kind} copy`))
    }
  }
  if (after.setups === before.setups) return out
  // setups: fields, added / removed / moved
  const oldSetups = new Map(before.setups.map((s) => [s.id, s]))
  const movedSetups = new Set(movedIds(before.setups, after.setups))
  for (const s of after.setups) {
    const b = oldSetups.get(s.id)
    if (b === undefined) {
      out.push(key('added', `${s.name} added`, { setupId: s.id }))
      continue
    }
    if (movedSetups.has(s.id)) out.push(key('moved', `${s.name} moved`, { setupId: s.id }))
    if (b === s) continue
    for (const f of changedFields(s as unknown as Rec, b as unknown as Rec, SETUP_IGNORED))
      out.push(key(f, `${s.name}: ${f}`, { setupId: s.id }))
  }
  const afterSetupIds = new Set(after.setups.map((s) => s.id))
  for (const b of before.setups)
    if (!afterSetupIds.has(b.id)) out.push(key('removed', `${b.name} removed`, { setupId: b.id }))
  // plan operations across setups: fields, setup, added / removed / moved
  const flat = (p: PlanDTO) => p.setups.flatMap((s) => s.operations.map((op) => ({ op, s })))
  const beforeOps = flat(before)
  const afterOps = flat(after)
  const oldOps = new Map(beforeOps.map((e) => [e.op.id, e]))
  const movedOps = new Set(
    movedIds(
      beforeOps.map((e) => e.op),
      afterOps.map((e) => e.op),
    ),
  )
  for (const { op, s } of afterOps) {
    const at = { operationId: op.id }
    const name = opLabel(after, op.designOperationIds)
    const b = oldOps.get(op.id)
    if (b === undefined) {
      out.push(key('added', `${name} added`, at))
      continue
    }
    if (b.s.id !== s.id) out.push(key('setup', `${name}: setup`, at))
    else if (movedOps.has(op.id)) out.push(key('moved', `${name} moved`, at))
    if (b.op === op) continue
    for (const f of changedFields(
      op as unknown as Rec,
      b.op as unknown as Rec,
      PLAN_OPERATION_IGNORED,
    ))
      out.push(key(f, `${name}: ${f}`, at))
  }
  const afterOpIds = new Set(afterOps.map((e) => e.op.id))
  for (const { op } of beforeOps)
    if (!afterOpIds.has(op.id))
      out.push(
        key('removed', `${opLabel(before, op.designOperationIds)} removed`, { operationId: op.id }),
      )
  return out
}

/**
 * The plan-input keys whose toolpaths are not current (apply.md § Implementation (task P2)).
 * Input hashes are chained over the machining order (`planOperationInputs`), so a key is covered
 * when the **first plan operation it affects** has a cached input: a toolpath was generated with
 * the change, and later operations that are stale are stale for a later change (its own key).
 * First affected operation of a key:
 * - an operation key (fields, `setup`, `moved`, `added`): that operation;
 * - `removed` (operation or setup): the earliest remaining operation that came after it;
 * - a setup key (fields, `added`, `moved`): the setup's earliest operation;
 * - `machine`, `design`, a stock or machine copy: the first operation; a tool copy: the first
 *   operation using it.
 * A key that affects no operation (a copy nothing uses, the last operation removed) needs no
 * toolpath and is covered. Every key is kept when the inputs cannot be derived (error findings)
 * or without a cache, and when all keys are covered while a toolpath is still stale (an entry
 * the cache no longer has), so a stale plan is never shown as up to date.
 */
function uncoveredChanges(
  doc: ProjectDoc,
  after: PlanDTO,
  before: PlanDTO,
  diff: readonly PendingChange[],
  services: Services,
): readonly PendingChange[] {
  const cache = services.toolpaths
  if (cache === undefined) return diff
  const derived = planOperationInputs(doc, after.id, undefined, services.region2d)
  if (derived.isErr()) return diff
  const inputs = derived.unwrap()
  const current = inputs.map((i) => cache.has(i.inputHash))
  if (current.every(Boolean)) return []
  const position = new Map(inputs.map((i, index) => [i.planOperationId, index]))
  const beforeOps = before.setups.flatMap((s) => s.operations.map((op) => op.id))
  const earliest = (ids: readonly string[]): number | undefined => {
    const at = ids.flatMap((id) => {
      const p = position.get(id)
      return p === undefined ? [] : [p]
    })
    return at.length === 0 ? undefined : Math.min(...at)
  }
  /** Earliest remaining operation that came after the removed one in the baseline. */
  const nextRemaining = (removedId: string | undefined) =>
    removedId === undefined
      ? undefined
      : earliest(beforeOps.slice(beforeOps.indexOf(removedId) + 1))
  const first = inputs.length > 0 ? 0 : undefined
  const affected = (c: PendingChange): number | undefined => {
    if (c.operationId !== undefined)
      return c.field === 'removed' ? nextRemaining(c.operationId) : position.get(c.operationId)
    if (c.setupId !== undefined) {
      if (c.field === 'removed')
        return nextRemaining(before.setups.find((s) => s.id === c.setupId)?.operations.at(-1)?.id)
      const s = after.setups.find((x) => x.id === c.setupId)
      return earliest(s?.operations.map((op) => op.id) ?? [])
    }
    if (c.field?.startsWith('snapshots.') === true) {
      const id = c.field.slice('snapshots.'.length)
      if (id === after.design.part.stock || id === after.machine) return first
      return earliest(inputs.filter((i) => i.toolSnapshotId === id).map((i) => i.planOperationId))
    }
    return first // machine, design copy
  }
  const out = diff.filter((c) => {
    const at = affected(c)
    return at !== undefined && current[at] === false
  })
  return out.length === 0 ? diff : out
}

/**
 * Changed plan inputs (operation tool, feeds, strategy, setup, machine) of kept-current plans
 * whose toolpaths are not current: an explicit "Generate toolpaths" after plan edits leaves
 * nothing for Apply, even though the baseline predates those edits (found by X2), and a later
 * edit lists only the inputs not generated yet (`uncoveredChanges`).
 */
export const planInputPending: PendingSource = {
  name: 'plan.inputs',
  changes(doc, baseline, _design, ctx) {
    if (doc.plans === baseline.plans) return []
    const out: PendingChange[] = []
    for (const [id, after] of Object.entries(doc.plans)) {
      const before = Object.hasOwn(baseline.plans, id) ? baseline.plans[id] : undefined
      if (before === undefined || before === after || !keptCurrent(after, ctx.services)) continue
      const diff = planInputDiff(after, before)
      if (diff.length === 0) continue
      out.push(...uncoveredChanges(doc, after, before, diff, ctx.services))
    }
    return out
  },
}

/**
 * `draft` plans whose design snapshot differs from their part by value while the part has no
 * pending design change (an older build's file, a recovered working folder, an un-archived
 * draft, an Apply undone below its edits): the next Apply rebuilds them. A plan whose rebuild is
 * blocked (its stock copy no longer fits) is not pending: it shows `rebuildBlocked`.
 */
export const draftPlanPending: PendingSource = {
  name: 'plan.draftFollow',
  changes(doc, _baseline, design, ctx) {
    const parts = new Set(design.flatMap((c) => (c.partId === undefined ? [] : [c.partId])))
    return Object.values(doc.plans)
      .filter(
        (p) =>
          p.status === 'draft' &&
          !parts.has(p.design.partId) &&
          designChanged(p, doc) &&
          rebuildBlocker(p, doc, ctx.services.region2d) === undefined,
      )
      .map((p) => ({
        kind: 'plan' as const,
        planId: p.id,
        partId: p.design.partId,
        field: 'design',
        label: `${p.name}: design changes not followed yet`,
      }))
  },
}

/**
 * Changed library items that a `draft` plan holds a copy of (one key per item), unless
 * re-importing the copy is blocked (it stays a notice): the next Apply follows them
 * (docs/architecture/apply.md#decisions, decision 5).
 */
export const libraryPending: PendingSource = {
  name: 'plan.libraryFollow',
  changes(doc, _baseline, _design, ctx) {
    const lookup = ctx.services.library?.lookup
    if (lookup === undefined) return []
    const out = new Map<string, PendingChange>()
    for (const plan of Object.values(doc.plans)) {
      if (plan.status !== 'draft') continue
      for (const c of planStale(plan, doc, lookup, ctx.services.region2d).libraryCopies) {
        if (c.status !== 'libraryChanged' || c.blocked !== null || out.has(c.libraryItemId))
          continue
        const found = lookup(c.kind, c.libraryItemId)
        const name = found.state === 'found' ? found.item.values.name : c.libraryItemId
        out.set(c.libraryItemId, {
          kind: 'library',
          libraryItemId: c.libraryItemId,
          field: c.kind,
          label: `${name} changed in the library`,
        })
      }
    }
    return [...out.values()]
  },
}

export const PLAN_PENDING_SOURCES: readonly PendingSource[] = [
  planInputPending,
  draftPlanPending,
  libraryPending,
]

/**
 * `pendingApply` of a plan (apply.md § Queries for pending state): its inputs have pending
 * changes – a `draft` plan of a part with pending design changes (or not following it, or with
 * a pending library item it copies), or a plan with pending plan inputs.
 */
export function planPendingApply(plan: PlanDTO, pending: readonly PendingChange[]): boolean {
  const draft = plan.status === 'draft'
  return pending.some(
    (c) =>
      (c.kind === 'plan' && c.planId === plan.id) ||
      (draft && c.kind === 'design' && c.partId === plan.design.partId) ||
      (draft &&
        c.kind === 'library' &&
        plan.snapshots.some((s) => s.libraryItemId === c.libraryItemId)),
  )
}
