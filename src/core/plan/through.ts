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
import { SurfaceTable } from '../design/surfaces'
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
 * Through depth (mm) by design operation id of every through profile, hole or pocket that an
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
 * The material a through profile or (patterns P4) a through pocket cuts below its stock face (mm;
 * DF23, DF50): its through depth in this plan, else the stock thickness (a through pocket: its
 * floor below the stock face, the material below its `on`). Null for a blind cut or another kind.
 */
export function planThroughDepth(
  plan: LoadedPlan,
  ops: readonly Operation[],
  port?: Region2dPort,
): number | null {
  const op = ops[0]
  if (op === undefined) return null
  const profiles = ops.every((o) => o.kind === 'profile' && o.depth.isNone())
  const pockets = ops.every((o) => o.kind === 'pocket' && o.through === true)
  if (!profiles && !pockets) return null
  // a plan operation machines one profile or pocket; the depth as the checks count it
  const known = planThroughDepths(plan, port).get(op.id)
  if (known !== undefined) return known
  if (op.kind !== 'pocket') return plan.stock.thickness.canonical
  const floor = SurfaceTable.of(plan.part.operations, plan.stock).get(`${op.id}.floor`)
  return floor.mapOr(plan.stock.thickness.canonical, (e) => -e.faceZ.toNumber() + 0)
}
