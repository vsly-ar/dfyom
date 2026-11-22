/**
 * Plan operation → generator inputs: maps a `PlanOperationInput` (models: Part, Stock, Tool,
 * Option<Machine>, ResolvedFeeds) to the plain `GeneratorInput`s of task 2.10. Runs in the host;
 * only its plain output crosses to the worker.
 * Doc: docs/architecture/workers.md#plan-operation-to-generator-input
 */
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import { toGeometryInput } from '../design/geometry-input'
import { localStock } from '../geometry/face'
import type { Region2dPort } from '../geometry/2d/port'
import { isAnalyticOperation, type OperationGeometry, type StockGeometry } from '../geometry/model'
import { pocketRegion, profileChain } from '../geometry/outline'
import { resolveProfileTabs } from '../geometry/tab-hold'
import type { Tool } from '../library/tool'
import type { ResolvedFeeds } from '../plan/feeds'
import type { PlanOperationInput } from '../plan/inputs'
import type { FeedField } from '../plan/plan.dto'
import type {
  AxisRates,
  ChamferInput,
  ChamferOperation,
  ChamferStrategy,
  CuttingParams,
  DrillingInput,
  DrillingStrategy,
  DrillingOperation,
  ToolpathTool,
} from './model'
import type { RegionProfileOperation } from './region-profile'
import type { GeneratorRequest } from './request'
import { setupWcs, toWcs } from './wcs'

const WHERE = 'toGeneratorInputs'

/** The plan's tool copy in canonical mm/degrees; corner radius 0 flat, RE bull nose, D/2 ball. */
export function toolpathTool(tool: Tool, id: string): ToolpathTool {
  const D = tool.diameter.canonical
  const cornerRadius =
    tool.type === 'ballEndMill'
      ? D / 2
      : tool.type === 'bullNoseEndMill'
        ? tool.cornerRadius.mapOr(0, (q) => q.canonical)
        : 0
  return {
    id,
    type: tool.type,
    diameter: D,
    cornerRadius,
    fluteLength: tool.fluteLength.canonical,
    ...(tool.type === 'drill' && tool.pointAngle.isSome()
      ? { pointAngle: tool.pointAngle.unwrap().canonical }
      : {}),
    ...(tool.type === 'chamferMill' && tool.angle.isSome()
      ? { angle: tool.angle.unwrap().canonical, tipDiameter: tool.tipDiameterMm }
      : {}),
  }
}

/** The applicable feeds unwrapped; a missing one is a 2.13 bug (`plan.check` if reached). */
function cutting(
  feeds: ResolvedFeeds,
  fields: readonly FeedField[],
  planOperationId: string,
): AppResult<Record<FeedField, number>> {
  const out: Partial<Record<FeedField, number>> = {}
  const missing: FeedField[] = []
  for (const f of fields) {
    const v = feeds.fields[f]
    if (v.isSome()) out[f] = v.unwrap().value
    else missing.push(f)
  }
  if (missing.length > 0)
    return fail('plan.check', `unresolved feeds: ${missing.join(', ')}`, {
      issues: missing.map((f) => ({
        path: [planOperationId, f],
        rule: 'unresolved',
        message: `${f} is not resolved`,
      })),
      where: WHERE,
      data: { planOperationId },
    })
  return Ok(out as Record<FeedField, number>)
}

/** Holes in nearest-neighbour order, starting from the one nearest the work zero (XY 0, 0). */
export function nearestNeighbourOrder<T extends { readonly center: readonly [number, number] }>(
  holes: readonly T[],
): T[] {
  const left = [...holes]
  const out: T[] = []
  let at: readonly [number, number] = [0, 0]
  while (left.length > 0) {
    let best = 0
    let bestD = Infinity
    left.forEach((h, i) => {
      const d = Math.hypot(h.center[0] - at[0], h.center[1] - at[1])
      if (d < bestD - 1e-12) {
        best = i
        bestD = d
      }
    })
    const [h] = left.splice(best, 1)
    out.push(h!)
    at = h!.center
  }
  return out
}

/**
 * A general profile (v0.3 T2 wiring) as `generateRegionProfile` takes it, in the face frame: K3's
 * chain from its start point, through cuts from the stock face (Z 0) down `thickness`, blind `on`
 * grooves down their depth; tab centres only on a closed loop cut through, resolved on the local
 * `stock` (tabs off free sides, `resolveProfileTabs`).
 * Doc: docs/modes/plan-v0.3.md#wiring-t1-t2, docs/modes/design-v0.4.md#tabs-relocate-off-free-sides-tb1
 */
export function regionProfileOperation(
  op: Extract<OperationGeometry, { kind: 'profile' }>,
  stock: StockGeometry,
): RegionProfileOperation {
  const { chain, closed } = profileChain(op)
  const through = op.depth === undefined
  return {
    chain,
    closed,
    side: op.side,
    slotWidth: op.slotWidth,
    onZ: 0,
    depth: op.depth ?? stock.thickness,
    through,
    tabs: {
      positions: closed && through ? [...resolveProfileTabs(op, stock).centres] : [],
      width: op.tabs.width,
      thickness: op.tabs.thickness,
    },
  }
}

/**
 * The generator request of one plan operation: one input, except drilling and chamfers (one per
 * hole or chamfer, nearest-neighbour order). Mapper bugs are `internal.unexpected`.
 */
export function toGeneratorInputs(
  input: PlanOperationInput,
  region2d?: Region2dPort,
): AppResult<GeneratorRequest> {
  const id = input.planOperationId
  const geometry = toGeometryInput(input.part, input.stock, region2d)
  if (geometry.isErr()) return Err(geometry.unwrapErr().withContext(WHERE, { planOperationId: id }))
  const byId = new Map(geometry.unwrap().operations.map((g) => [g.id, g]))
  const ops: OperationGeometry[] = []
  for (const op of input.operations) {
    const g = byId.get(op.id)
    if (g === undefined || g.kind !== input.kind)
      return fail('internal.unexpected', `operation ${op.id} is not a ${input.kind} of the part`, {
        where: WHERE,
        data: { planOperationId: id },
      })
    // one approach direction per setup (E1); a plan-only edit of `on` may break it until a rebuild
    const direction = g.direction ?? '+z'
    if (direction !== input.setup.direction)
      return fail(
        'plan.setup',
        `${op.id} is on a ${direction} face but its setup machines the ${input.setup.direction} face`,
        {
          issues: [
            {
              path: ['operations', op.id, 'on'],
              rule: 'setupDirection',
              message: 'the operation is not on the face its setup machines',
              params: { direction, setupDirection: input.setup.direction },
            },
          ],
          where: WHERE,
          data: { planOperationId: id, operation: op.id },
        },
      )
    // generators stay top-down: the operation as read in its face frame, without the direction
    const { direction: _, ...local } = g
    ops.push(local)
  }
  // the stock as seen in the setup: face rectangle on X/Y, extent along `n` as the thickness
  const partStock = geometry.unwrap().stock
  const stock: StockGeometry = localStock(input.setup.direction, partStock)
  const wcs = setupWcs(input.setup.direction, input.setup.rotation, partStock)
  const turned = wcs === undefined ? {} : { wcs }
  const tool = toolpathTool(input.tool, input.toolSnapshotId)
  const heights = {
    clearanceHeight: input.setup.clearanceHeight,
    retractHeight: input.setup.retractHeight,
  }
  const machine = input.machine.isSome() ? input.machine.unwrap() : undefined
  const maxFeedRate: AxisRates | undefined =
    machine === undefined
      ? undefined
      : [
          machine.maxFeedRate.x.canonical,
          machine.maxFeedRate.y.canonical,
          machine.maxFeedRate.z.canonical,
        ]
  const base = {
    planOperationId: id,
    tool,
    heights,
    stock,
    ...(maxFeedRate === undefined ? {} : { maxFeedRate }),
  }
  const s = input.strategy
  const milling = (): AppResult<CuttingParams> =>
    cutting(input.feeds, ['spindleSpeed', 'feedRate', 'plungeRate', 'stepdown', 'stepover'], id)
  const single = <K extends OperationGeometry['kind']>(
    kind: K,
  ): AppResult<Extract<OperationGeometry, { kind: K }>> => {
    const op = ops[0]
    return ops.length === 1 && op!.kind === kind
      ? Ok(op as Extract<OperationGeometry, { kind: K }>)
      : fail('internal.unexpected', `a ${kind} plan operation machines exactly one operation`, {
          where: WHERE,
          data: { planOperationId: id, operations: ops.length },
        })
  }
  switch (s.kind) {
    case 'facing':
      return single('facing').andThen((operation) =>
        milling().map((c): GeneratorRequest => ({
          kind: 'facing',
          ...turned,
          inputs: [
            {
              ...base,
              cutting: c,
              operation,
              strategy: {
                pattern: s.pattern,
                axis: s.axis,
                overshoot: s.overshoot,
                direction: s.direction,
              },
            },
          ],
        })),
      )
    case 'pocket':
      return single('pocket').andThen((op) =>
        milling().map((c): GeneratorRequest => {
          const strategy = {
            entry: s.entry,
            helixDiameter: s.helixDiameter,
            rampAngle: s.rampAngle,
            finishAllowance: s.finishAllowance,
            finishStepdown: s.finishStepdown,
            direction: s.direction,
          }
          // v0.1 rectangles and circles keep the v0.1 generator (byte-identical v0.1/v0.2
          // output); general shapes go to the region generator in the face frame (T1 wiring)
          return isAnalyticOperation(op)
            ? {
                kind: 'pocket',
                ...turned,
                inputs: [{ ...base, cutting: c, operation: op, strategy }],
              }
            : {
                kind: 'regionPocket',
                ...turned,
                inputs: [{ ...base, cutting: c, operation: pocketRegion(op), strategy }],
              }
        }),
      )
    case 'profile':
      return single('profile').andThen((op) =>
        milling().map((c): GeneratorRequest => {
          const strategy = {
            entry: s.entry,
            rampAngle: s.rampAngle,
            breakthrough: s.breakthrough,
            finishAllowance: s.finishAllowance,
            direction: s.direction,
          }
          if (isAnalyticOperation(op))
            return {
              kind: 'profile',
              ...turned,
              inputs: [{ ...base, cutting: c, operation: op, strategy }],
            }
          return {
            kind: 'regionProfile',
            ...turned,
            inputs: [
              {
                ...base,
                cutting: c,
                operation: regionProfileOperation(op, stock),
                // no plan parameter yet: the documented default 0.5 D (plan-v0.3.md § Profile)
                strategy: { ...strategy, leadRadius: tool.diameter / 2 },
              },
            ],
          }
        }),
      )
    case 'drilling': {
      const strategy: DrillingStrategy =
        s.cycle === 'simple'
          ? { cycle: 'simple', breakthrough: s.breakthrough }
          : s.cycle === 'peck'
            ? { cycle: 'peck', breakthrough: s.breakthrough, peckDepth: s.peckDepth }
            : s.cycle === 'chipBreak'
              ? {
                  cycle: 'chipBreak',
                  breakthrough: s.breakthrough,
                  peckDepth: s.peckDepth,
                  chipBreakBack: s.chipBreakBack,
                }
              : {
                  cycle: 'helix',
                  breakthrough: s.breakthrough,
                  helixPitch: s.helixPitch,
                  rampAngle: s.rampAngle,
                  direction: s.direction,
                }
      const holes = ops.filter((o): o is DrillingOperation => o.kind === 'drilling')
      // visiting order from the work zero of the setup's WCS
      const visits = nearestNeighbourOrder(
        holes.map((operation) => ({
          operation,
          center: wcs === undefined ? operation.center : toWcs(operation.center, wcs),
        })),
      )
      return cutting(input.feeds, ['spindleSpeed', 'feedRate', 'plungeRate'], id).map((c) => ({
        kind: 'drilling',
        ...turned,
        inputs: visits.map(({ operation }): DrillingInput => ({
          ...base,
          cutting: { spindleSpeed: c.spindleSpeed, feedRate: c.feedRate, plungeRate: c.plungeRate },
          operation,
          strategy,
        })),
      }))
    }
    case 'chamfer': {
      const chamfers = ops.filter((o): o is ChamferOperation => o.kind === 'chamfer')
      const visits = nearestNeighbourOrder(
        chamfers.map((operation) => ({
          operation,
          center: wcs === undefined ? operation.center : toWcs(operation.center, wcs),
        })),
      )
      // one ring in climb direction (plan-v0.4.md § Chamfer toolpath); entry resolved by the plan,
      // per chamfer `stepped` when it has a stepdown (F7)
      const strategyOf = (op: ChamferOperation): ChamferStrategy => ({
        entry: op.stepdown !== undefined ? 'stepped' : s.entry === 'stepped' ? 'contour' : s.entry,
        rampAngle: s.rampAngle,
        direction: 'climb',
      })
      return cutting(input.feeds, ['spindleSpeed', 'feedRate', 'plungeRate'], id).map((c) => ({
        kind: 'chamfer',
        ...turned,
        inputs: visits.map(({ operation }): ChamferInput => ({
          ...base,
          cutting: { spindleSpeed: c.spindleSpeed, feedRate: c.feedRate, plungeRate: c.plungeRate },
          operation,
          strategy: strategyOf(operation),
        })),
      }))
    }
  }
}
