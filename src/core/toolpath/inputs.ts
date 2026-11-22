/**
 * Plan operation → generator inputs: maps a `PlanOperationInput` (models: Part, Stock, Tool,
 * Option<Machine>, ResolvedFeeds) to the plain `GeneratorInput`s of task 2.10. Runs in the host;
 * only its plain output crosses to the worker.
 * Doc: docs/architecture/workers.md#plan-operation-to-generator-input
 */
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import { toGeometryInput } from '../design/geometry-input'
import type { OperationGeometry, StockGeometry } from '../geometry/model'
import type { Tool } from '../library/tool'
import type { ResolvedFeeds } from '../plan/feeds'
import type { PlanOperationInput } from '../plan/inputs'
import type { FeedField } from '../plan/plan.dto'
import type {
  AxisRates,
  CuttingParams,
  DrillingInput,
  DrillingStrategy,
  DrillingOperation,
  ToolpathTool,
} from './model'
import type { GeneratorRequest } from './request'

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
 * The generator request of one plan operation: one input, except drilling (one per hole,
 * nearest-neighbour order). Mapper bugs are `internal.unexpected`.
 */
export function toGeneratorInputs(input: PlanOperationInput): AppResult<GeneratorRequest> {
  const id = input.planOperationId
  const geometry = toGeometryInput(input.part, input.stock)
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
    // toolpaths in the face frame and per setup are task C3 (docs/modes/plan-v0.2.md)
    if (g.direction !== undefined && g.direction !== '+z')
      return fail(
        'plan.check',
        `${op.id} is on a ${g.direction} face; toolpaths for faces other than the top are not generated yet`,
        {
          issues: [
            {
              path: ['operations', op.id, 'on'],
              rule: 'faceNotSupported',
              message: 'toolpaths for faces other than the top come with setups',
            },
          ],
          where: WHERE,
          data: { planOperationId: id, operation: op.id },
        },
      )
    ops.push(g)
  }
  const stock: StockGeometry = geometry.unwrap().stock
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
        milling().map((c) => ({
          kind: 'facing',
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
      return single('pocket').andThen((operation) =>
        milling().map((c) => ({
          kind: 'pocket',
          inputs: [
            {
              ...base,
              cutting: c,
              operation,
              strategy: {
                entry: s.entry,
                helixDiameter: s.helixDiameter,
                rampAngle: s.rampAngle,
                finishAllowance: s.finishAllowance,
                finishStepdown: s.finishStepdown,
                direction: s.direction,
              },
            },
          ],
        })),
      )
    case 'profile':
      return single('profile').andThen((operation) =>
        milling().map((c) => ({
          kind: 'profile',
          inputs: [
            {
              ...base,
              cutting: c,
              operation,
              strategy: {
                entry: s.entry,
                rampAngle: s.rampAngle,
                breakthrough: s.breakthrough,
                finishAllowance: s.finishAllowance,
                direction: s.direction,
              },
            },
          ],
        })),
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
      return cutting(input.feeds, ['spindleSpeed', 'feedRate', 'plungeRate'], id).map((c) => ({
        kind: 'drilling',
        inputs: nearestNeighbourOrder(holes).map((operation): DrillingInput => ({
          ...base,
          cutting: { spindleSpeed: c.spindleSpeed, feedRate: c.feedRate, plungeRate: c.plungeRate },
          operation,
          strategy,
        })),
      }))
    }
  }
}
