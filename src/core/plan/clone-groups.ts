/**
 * Clone groups (hardening DF146): the one piece of Clones knowledge Plan has. A Clones instance
 * names the operation it repeats by `stepOf` of its role; the source operation and all its
 * instances share one plan operation. Doc: docs/modes/features.md#clone-groups-in-plan-hardening-df146
 */
import { stepOf } from '../design/feature'
import type { Operation } from '../design/operation'

const CLONES_ID = /^clones[1-9]\d*$/

/** The operation a Clones instance repeats (`stepOf` of its role); undefined for any other. */
function repeated(op: Operation): string | undefined {
  if (op.owner.isNone()) return undefined
  const { featureId, role } = op.owner.unwrap()
  if (!CLONES_ID.test(featureId)) return undefined
  const step = stepOf(role)
  return step === role ? undefined : step
}

/**
 * The clone source of every operation that has one, by operation id: an instance's source
 * operation, followed through nested Clones (an outer Clones repeats the inner one's
 * operations) to the innermost source; a source with instances maps to itself. Operations
 * without clones are absent. A source the part no longer has (off in the plan, DF106) still
 * names the group of its instances.
 */
export function cloneSources(ops: readonly Operation[]): ReadonlyMap<string, string> {
  const byId = new Map(ops.map((o) => [o.id, o]))
  const out = new Map<string, string>()
  for (const op of ops) {
    let source = repeated(op)
    if (source === undefined) continue
    const seen = new Set([op.id])
    while (!seen.has(source)) {
      seen.add(source)
      const next = byId.get(source)
      const up = next === undefined ? undefined : repeated(next)
      if (up === undefined) break
      source = up
    }
    out.set(op.id, source)
    if (byId.has(source)) out.set(source, source)
  }
  return out
}
