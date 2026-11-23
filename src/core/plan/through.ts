/**
 * Through depths in the plan's own setup order (DF50): a through profile counts the material that
 * facings and pockets of the opposite direction cleared under its slot in an earlier setup of
 * this plan (design reads the default setup order instead). The toolpaths, the tool checks and
 * `plan.operation.list`'s `throughDepth` take it from here.
 * Doc: docs/modes/plan-v0.2.md#material-removed-by-earlier-setups
 */
import { toGeometryInput } from '../design/geometry-input'
import type { Operation } from '../design/operation'
import type { Region2dPort } from '../geometry/2d/port'
import { throughDepths } from '../geometry/through-depth'
import type { LoadedPlan } from './plan'

const memo = new WeakMap<LoadedPlan, Map<Region2dPort | undefined, ReadonlyMap<string, number>>>()

/**
 * Through depth (mm) by design operation id of every through profile that an earlier setup of
 * the plan cleared material under; the others cut the stock extent. Without the 2D port only
 * facings count (pockets need region booleans).
 */
export function planThroughDepths(
  plan: LoadedPlan,
  port?: Region2dPort,
): ReadonlyMap<string, number> {
  let byPort = memo.get(plan)
  if (byPort === undefined) memo.set(plan, (byPort = new Map()))
  let out = byPort.get(port)
  if (out === undefined) {
    const setupOf = new Map<string, number>()
    plan.setups.forEach((s, i) => {
      for (const op of s.operations) for (const id of op.designOperationIds) setupOf.set(id, i)
    })
    out = toGeometryInput(plan.part, plan.stock, port).mapOr(new Map<string, number>(), (input) =>
      throughDepths(input.operations, input.stock, port, (a, b) => {
        const sa = setupOf.get(a.id)
        const sb = setupOf.get(b.id)
        return sa !== undefined && sb !== undefined && sa < sb
      }),
    )
    byPort.set(port, out)
  }
  return out
}

/**
 * The material a through profile cuts below its stock face (mm; DF23, DF50): its through depth in
 * this plan, else the stock thickness. Null for a blind groove or another kind.
 */
export function planThroughDepth(
  plan: LoadedPlan,
  ops: readonly Operation[],
  port?: Region2dPort,
): number | null {
  const op = ops[0]
  if (op === undefined || !ops.every((o) => o.kind === 'profile' && o.depth.isNone())) return null
  // a profile plan operation machines one profile; the stock thickness as the checks count it
  return planThroughDepths(plan, port).get(op.id) ?? plan.stock.thickness.canonical
}
