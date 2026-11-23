/**
 * Display labels of plan operations and the clone position comments of the program, read from the
 * plan's design snapshot (no feature logic in Plan, plan-v0.4.md P-A). Doc:
 * docs/modes/plan-v0.4.md#plan-side
 */
import { instanceOf, stepOf } from '../design/feature'
import type { PartDTO } from '../design/part.dto'

type OpDTO = PartDTO['operations'][number]

/** A Clones feature's source as stored (`clones.ts` `ClonesSource`). */
function sourceOf(f: NonNullable<PartDTO['features']>[number]): {
  operationIds?: readonly string[]
  featureId?: string
} {
  const s = (f as { source?: unknown }).source
  return typeof s === 'object' && s !== null
    ? (s as { operationIds?: string[]; featureId?: string })
    : {}
}

/** The Clones position an operation cuts: an instance's number, 1 for the source; else none. */
export function clonesPosition(
  part: PartDTO,
  operationId: string,
): { readonly featureId: string; readonly name: string; readonly n: number } | undefined {
  const op = part.operations.find((o) => o.id === operationId)
  if (op === undefined) return undefined
  const features = part.features ?? []
  const owner = features.find((f) => f.id === op.featureId)
  if (owner?.kind === 'clones' && op.featureRole !== undefined)
    return { featureId: owner.id, name: owner.name, n: instanceOf(op.featureRole) }
  const source = features.find((f) => {
    if (f.kind !== 'clones') return false
    const s = sourceOf(f)
    return (
      s.operationIds?.includes(op.id) === true ||
      (op.featureId !== undefined && s.featureId === op.featureId)
    )
  })
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
  const source = part.operations.find((o) => o.id === stepOf(op.featureRole!))
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
  const ops = designOperationIds.map((id) => part.operations.find((o) => o.id === id))
  const names = ops.map((o, i) => o?.name ?? designOperationIds[i]!)
  if (ops.length < 2 || ops.some((o) => o === undefined)) return names.join(', ')
  const counts = new Map<string, number>()
  for (const o of ops) {
    const base = baseName(o!, part)
    counts.set(base, (counts.get(base) ?? 0) + 1)
  }
  if (counts.size === ops.length) return names.join(', ')
  return [...counts].map(([base, n]) => (n === 1 ? base : `${base} × ${n}`)).join(', ')
}
