/**
 * Display labels of plan operations and the clone position comments of the program, read from the
 * plan's design snapshot (no feature logic in Plan, plan-v0.4.md P-A). Doc:
 * docs/modes/plan-v0.4.md#plan-side
 */
import type { PlanOperationDTO } from './plan.dto'
import { instanceOf, stepOf } from '../design/feature'
import type { PartDTO } from '../design/part.dto'

type OpDTO = PartDTO['operations'][number]

/** The label of an operation id the part no longer has (ui.md § Selection and picking). */
export const UNKNOWN_OPERATION = 'Unknown operation'

const byIdMemo = new WeakMap<readonly OpDTO[], ReadonlyMap<string, OpDTO>>()

/**
 * The part's operation `id` (the first of that id): indexed once per frozen operation list (a
 * committed document's), so labelling every plan operation stays linear (hardening P4); a
 * draft's list is scanned.
 */
function operationOf(part: PartDTO, id: string): OpDTO | undefined {
  const ops = part.operations
  if (!Object.isFrozen(ops)) return ops.find((o) => o.id === id)
  let byId = byIdMemo.get(ops)
  if (byId === undefined) {
    const m = new Map<string, OpDTO>()
    for (const o of ops) if (!m.has(o.id)) m.set(o.id, o)
    byIdMemo.set(ops, (byId = m))
  }
  return byId.get(id)
}

/** A Clones feature's source as stored (`clones.ts` `ClonesSource`). */
function sourceOf(f: NonNullable<PartDTO['features']>[number]): {
  operationIds?: readonly string[]
  featureIds: readonly string[]
} {
  const s = (f as { source?: unknown }).source
  if (typeof s !== 'object' || s === null) return { featureIds: [] }
  const r = s as { operationIds?: string[]; featureId?: string; featureIds?: string[] }
  return {
    ...(r.operationIds === undefined ? {} : { operationIds: r.operationIds }),
    featureIds: r.featureIds ?? (r.featureId === undefined ? [] : [r.featureId]),
  }
}

/** The Clones position an operation cuts: an instance's number, 1 for the source; else none. */
export function clonesPosition(
  part: PartDTO,
  operationId: string,
): { readonly featureId: string; readonly name: string; readonly n: number } | undefined {
  const op = operationOf(part, operationId)
  if (op === undefined) return undefined
  const features = part.features ?? []
  const owner = features.find((f) => f.id === op.featureId)
  if (owner?.kind === 'clones' && op.featureRole !== undefined)
    return { featureId: owner.id, name: owner.name, n: instanceOf(op.featureRole) }
  const sources = features.filter((f) => {
    if (f.kind !== 'clones') return false
    const s = sourceOf(f)
    return (
      s.operationIds?.includes(op.id) === true ||
      (op.featureId !== undefined && s.featureIds.includes(op.featureId))
    )
  })
  // the innermost position (Clones v2): an outer Clones holds the inner one as a member
  const source = sources.find(
    (f) => !sources.some((g) => g !== f && sourceOf(f).featureIds.includes(g.id)),
  )
  return source === undefined ? undefined : { featureId: source.id, name: source.name, n: 1 }
}

/** Program comment of a clone position (plan-v0.4.md P-E): `Clones 1 #3`; none outside Clones. */
export function positionComment(part: PartDTO, operationId: string): string | undefined {
  const p = clonesPosition(part, operationId)
  return p === undefined ? undefined : `${p.name} #${p.n}`
}

/** The name an operation repeats: a Clones instance's source operation name, else its own. */
function baseName(op: OpDTO, part: PartDTO): string {
  const owner = part.features?.find((f) => f.id === op.featureId)
  if (owner?.kind !== 'clones' || op.featureRole === undefined) return op.name
  const source = operationOf(part, stepOf(op.featureRole!))
  return source?.name ?? op.name
}

/**
 * A plan operation's label: its design operation's name (owned ones default to "Hole 1 ·
 * counterbore", Clones instances to "Hole 1 · counterbore · 3"); a group repeating one operation
 * (Clones instances and their source) is "Hole 1 · drill × 6", and a group of several repeated
 * operations names each once with its count, "Hole 1 · drill × 6, Hole 2 · drill × 6" (X2 F10);
 * single operations keep their names.
 */
export function planOperationLabel(part: PartDTO, designOperationIds: readonly string[]): string {
  const ops = designOperationIds.map((id) => operationOf(part, id))
  // an id the part no longer has reads "Unknown operation", never the id (DF43, ui.md)
  const names = ops.map((o) => o?.name ?? UNKNOWN_OPERATION)
  if (ops.length < 2 || ops.some((o) => o === undefined)) return names.join(', ')
  const counts = new Map<string, number>()
  for (const o of ops) {
    const base = baseName(o!, part)
    counts.set(base, (counts.get(base) ?? 0) + 1)
  }
  if (counts.size === ops.length) return names.join(', ')
  return [...counts].map(([base, n]) => (n === 1 ? base : `${base} × ${n}`)).join(', ')
}

/**
 * A plan operation's label: an alignment aid's own name ("Witness mark 1", alignment.md S13),
 * else `planOperationLabel` of its design operations.
 */
export function planOpLabel(
  part: PartDTO,
  op: {
    readonly designOperationIds: readonly string[]
    readonly aid?: { readonly name: string } | undefined
  },
): string {
  return op.aid?.name ?? planOperationLabel(part, op.designOperationIds)
}

/** `{ aid }` of the plan operation `id` when it is an alignment aid (for `planOpLabel`). */
export function aidName(
  plan: { readonly setups: readonly { readonly operations: readonly PlanOperationDTO[] }[] },
  id: string,
): { aid?: { name: string } } {
  for (const s of plan.setups) {
    const aid = s.operations.find((o) => o.id === id)?.aid
    if (aid !== undefined) return { aid: { name: aid.name } }
  }
  return {}
}
