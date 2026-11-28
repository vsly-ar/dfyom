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

/** One design operation of a plan operation group, as its read-only row (DF146 G2). */
export interface GroupInstance {
  readonly id: string
  /** Its Clones position (1 = the source); undefined outside Clones (equal holes). */
  readonly n: number | undefined
  /** The design operation's name. */
  readonly name: string
}

/**
 * The instance rows of a plan operation of several design operations (hardening DF146 G2), in its
 * order (path order): each with its stable Clones number (skipped positions are absent), and
 * `of`, the name the group repeats ("Bolt hole 1 · countersink"). No rows for a single operation.
 * Doc: docs/modes/features.md#clone-groups-in-plan-hardening-df146
 */
export function groupInstances(
  part: PartDTO,
  designOperationIds: readonly string[],
): { readonly of: string; readonly instances: readonly GroupInstance[] } {
  const first = operationOf(part, designOperationIds[0] ?? '')
  const of = first === undefined ? UNKNOWN_OPERATION : baseName(first, part)
  if (designOperationIds.length < 2) return { of, instances: [] }
  const ns = designOperationIds.map((id) => clonesPosition(part, id)?.n)
  // a source the Clones does not name itself (a pocket's roughing) is still position 1
  const cloned = ns.some((n) => n !== undefined)
  return {
    of,
    instances: designOperationIds.map((id, i) => ({
      id,
      n: ns[i] ?? (cloned && i === 0 ? 1 : undefined),
      name: operationOf(part, id)?.name ?? UNKNOWN_OPERATION,
    })),
  }
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

/**
 * Plan messages name their plan operation by label and id (D4, docs/modes/design-llm-first.md#dfm-in-waste):
 * a finding with a `planOperationId` of the plan reads "Pocket 1 (op3): no tool assigned"; one
 * that already starts with the label ("Witness mark 1 cuts the part") gets the id after it.
 * Others are left as they are; applying it twice changes nothing. The app shows the text without
 * the prefix (`withoutOperationName`), in the inspector of that operation.
 */
export function namedPlanMessages<
  W extends { readonly message: string; readonly planOperationId?: string },
>(
  plan: {
    readonly design: { readonly part: PartDTO }
    readonly setups: readonly { readonly operations: readonly PlanOperationDTO[] }[]
  },
  findings: readonly W[],
): W[] {
  const ops = new Map(plan.setups.flatMap((s) => s.operations.map((o) => [o.id, o] as const)))
  const labels = new Map<string, string>()
  return findings.map((f) => {
    const id = f.planOperationId
    const op = id === undefined ? undefined : ops.get(id)
    if (id === undefined || op === undefined) return f
    let label = labels.get(id)
    if (label === undefined) labels.set(id, (label = planOpLabel(plan.design.part, op)))
    const head = `${label} (${id})`
    if (f.message.startsWith(head)) return f
    const message = f.message.startsWith(`${label} `)
      ? `${head}${f.message.slice(label.length)}`
      : `${head}: ${f.message}`
    return { ...f, message }
  })
}

/**
 * A plan message without the "Label (id): " or "Label (id)" head `namedPlanMessages` gave it
 * (the app shows findings at their operation, which names it already).
 */
export function withoutOperationName(message: string, planOperationId?: string): string {
  if (planOperationId === undefined) return message
  const at = message.indexOf(` (${planOperationId})`)
  if (at <= 0) return message
  const end = at + planOperationId.length + 3
  if (message.startsWith(': ', end)) return message.slice(end + 2)
  // "Witness mark 1 (op7) cuts the part": the label is the sentence's subject, keep it
  return message.slice(0, at) + message.slice(end)
}
