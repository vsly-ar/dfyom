/**
 * Through depths and material bands in the plan's own order (DF50, DF61): a through profile or
 * hole counts the material that facings and pockets of the opposite direction cleared under it in
 * an earlier setup of this plan (design reads the default setup order instead), and every facing,
 * pocket, profile and drilling the material earlier cuts left over its region (`materialBands`). The
 * toolpaths, the tool checks and `plan.operation.list`'s `throughDepth` take them from here.
 * Doc: docs/modes/plan-v0.2.md#material-removed-by-earlier-setups,
 * docs/modes/plan-v0.2.md#material-left-for-later-cuts-df61
 */
import { toGeometryInput } from '../design/geometry-input'
import type { Operation } from '../design/operation'
import type { Region2dPort } from '../geometry/2d/port'
import { materialBands, throughDepths, type MaterialCover } from '../geometry/through-depth'
import type { LoadedPlan } from './plan'

interface Derived {
  readonly through: ReadonlyMap<string, number>
  readonly bands: ReadonlyMap<string, MaterialCover>
}

const memo = new WeakMap<LoadedPlan, Map<Region2dPort | undefined, Derived>>()

const earlier =
  (of: ReadonlyMap<string, number>) =>
  (a: { readonly id: string }, b: { readonly id: string }): boolean => {
    const ia = of.get(a.id)
    const ib = of.get(b.id)
    return ia !== undefined && ib !== undefined && ia < ib
  }

function derived(plan: LoadedPlan, port: Region2dPort | undefined): Derived {
  let byPort = memo.get(plan)
  if (byPort === undefined) memo.set(plan, (byPort = new Map()))
  let out = byPort.get(port)
  if (out === undefined) {
    // the setup of every design operation, and its plan operation's place in the machining order
    // (the setups in order, each in its order)
    const setupOf = new Map<string, number>()
    const indexOf = new Map<string, number>()
    let index = 0
    plan.setups.forEach((s, i) => {
      for (const op of s.operations) {
        for (const id of op.designOperationIds) {
          setupOf.set(id, i)
          indexOf.set(id, index)
        }
        index++
      }
    })
    const none: Derived = { through: new Map(), bands: new Map() }
    out = toGeometryInput(plan.part, plan.stock, port).mapOr(none, (input): Derived => ({
      through: throughDepths(input.operations, input.stock, port, earlier(setupOf)),
      // openings count from the next setup on (the slug may still sit in its slot in its own)
      bands: materialBands(input.operations, input.stock, port, earlier(indexOf), earlier(setupOf)),
    }))
    byPort.set(port, out)
  }
  return out
}

/**
 * Through depth (mm) by design operation id of every through profile or through hole that an
 * earlier setup of the plan cleared material under; the others cut the stock extent. Without the
 * 2D port only facings count (pockets need region booleans).
 */
export function planThroughDepths(
  plan: LoadedPlan,
  port?: Region2dPort,
): ReadonlyMap<string, number> {
  return derived(plan, port).through
}

/**
 * The material band (DF61) by design operation id of every facing, pocket, profile and drilling
 * whose whole region earlier cuts of the plan (machining order) cleared above or below it, with a
 * pocket's partial coverage.
 */
export function planMaterialBands(
  plan: LoadedPlan,
  port?: Region2dPort,
): ReadonlyMap<string, MaterialCover> {
  return derived(plan, port).bands
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
