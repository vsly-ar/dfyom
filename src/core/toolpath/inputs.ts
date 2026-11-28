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
import {
  isAnalyticOperation,
  isLoopChamfer,
  type OperationGeometry,
  type StockGeometry,
} from '../geometry/model'
import type { EdgeChamferOperation } from './edge-chamfer'
import { isCutter } from './line'
import { openReach, opensStock, openRegion, uncoveredRegion } from '../geometry/open-sides'
import { slotSplit } from '../geometry/slots'
import type { MaterialBand } from '../geometry/through-depth'
import { pocketRegion, profileChain } from '../geometry/outline'
import { regionArea, type Region } from '../geometry/2d/model'
import { cutTop, levels } from './common'
import { resolveProfileTabs } from '../geometry/tab-hold'
import type { Tool } from '../library/tool'
import { FEED_FIELD_LABEL, type ResolvedFeeds } from '../plan/feeds'
import type { PlanOperationInput } from '../plan/inputs'
import type { OperationKind } from '../design/part.dto'
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
import type { GeneratorRequest, SingleRequest } from './request'
import { setupWcs, toWcs } from './wcs'
import { facingRegion, keepOutRegion } from './keep-out'

const WHERE = 'toGeneratorInputs'

/** Ramp angle of a facing cleared around workholding (degrees, as the pocket default). */
const FACING_RAMP_ANGLE = 3

/** The loop chamfer a plan operation machines alone (edge-chamfers.md E1). */
function loopChamferOf(
  op: OperationGeometry,
  planOperationId: string,
): AppResult<EdgeChamferOperation> {
  if (op.kind === 'chamfer' && isLoopChamfer(op)) return Ok(op)
  return fail('internal.unexpected', 'a loop chamfer is planned alone', {
    where: WHERE,
    data: { planOperationId },
  })
}

/**
 * Whether cutting a partly cleared pocket in two (`rest` down to `level`, then `region` from
 * there) saves work: levels × area below the unsplit cut's, by at least `SPLIT_GAIN` (equal steps
 * per part can add a level, and a rest grown into the cleared part can cover most of the region).
 */
function splitSaves(
  region: Region,
  rest: Region,
  op: { readonly onZ: number; readonly depth: number },
  level: number,
  band: MaterialBand,
  stepdown: number,
): boolean {
  const floor = op.onZ - op.depth
  const top = cutTop(op.onZ, floor, band)
  const n = (a: number, b: number) => levels(a, b, stepdown).length
  const whole = regionArea(region)
  const split = n(top, level) * regionArea(rest) + n(level, floor) * whole
  return split < n(top, floor) * whole * (1 - SPLIT_GAIN)
}

/** The least share of the work a split must save. */
const SPLIT_GAIN = 0.05

/**
 * A drilling's or chamfer's input `material`: the band's top only (holes skip no levels below; a
 * chamfer's top is its as-cut bevel's depth, DF135 C4 follow-up).
 */
const holeBand = (m: MaterialBand | undefined): { material?: MaterialBand } =>
  m?.top === undefined ? {} : { material: { top: m.top } }

/**
 * The plan's tool copy in canonical mm/degrees; corner radius 0 flat, RE bull nose, D/2 ball, the
 * ball's radius of a tapered ball end mill.
 */
export function toolpathTool(tool: Tool, id: string): ToolpathTool {
  const D = tool.diameter.canonical
  const cornerRadius =
    tool.type === 'ballEndMill'
      ? D / 2
      : tool.type === 'bullNoseEndMill'
        ? tool.cornerRadius.mapOr(0, (q) => q.canonical)
        : tool.type === 'taperedBallEndMill'
          ? tool.tipDiameterMm / 2
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
    ...(tool.type === 'taperedBallEndMill' && tool.taperAngle.isSome()
      ? { tipDiameter: tool.tipDiameterMm, taperAngle: tool.taperAngle.unwrap().canonical }
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
    return fail(
      'plan.check',
      `unresolved feeds: ${missing.map((f) => FEED_FIELD_LABEL[f].toLowerCase()).join(', ')}`,
      {
        issues: missing.map((f) => ({
          path: [planOperationId, f],
          rule: 'unresolved',
          message: `${FEED_FIELD_LABEL[f].toLowerCase()} is not resolved: enter a value or pick a preset (plan_operation_update)`,
        })),
        where: WHERE,
        data: { planOperationId },
      },
    )
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
 * DF122 R4: the slot a roughing profile cuts: its owner's, a through profile's widened to the
 * roughing tool's Ø + wall (its passes run from R + wall outward; the extra width is offcut or
 * slug). A step keeps the owner's slot (beyond it stands the part), the wall margin shrinking when
 * the tool is wider than the slot less the wall. Doc: docs/modes/roughing.md#implementation-r4
 */
export function roughingSlot(
  owner: Pick<RegionProfileOperation, 'slotWidth' | 'through'>,
  diameter: number,
  wall: number,
): number {
  return owner.through ? Math.max(owner.slotWidth, diameter + wall) : owner.slotWidth
}

/**
 * A general profile (v0.3 T2 wiring) as `generateRegionProfile` takes it, in the face frame: K3's
 * chain from its start point, through cuts from the stock face (Z 0) down `throughDepth` (DF50) or
 * `thickness`, blind `on`
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
    // a through cut: the material left under the slot (DF50), else the stock extent
    depth: op.depth ?? op.throughDepth ?? stock.thickness,
    through,
    tabs: {
      positions: closed && through ? [...resolveProfileTabs(op, stock).centres] : [],
      width: op.tabs.width,
      thickness: op.tabs.thickness,
    },
  }
}

interface GeometryById {
  readonly stock: StockGeometry
  readonly byId: ReadonlyMap<string, OperationGeometry>
}
const geometryMemo = new WeakMap<
  PlanOperationInput['part'],
  WeakMap<PlanOperationInput['stock'], Map<Region2dPort | undefined, AppResult<GeometryById>>>
>()

/**
 * The part's operation geometry by id, mapped once per (part, stock, port): the inputs of one
 * plan share the plan's part and stock models (immutable), and mapping the whole part per plan
 * operation made generating a plan quadratic in operations (hardening P4,
 * docs/research/s6-clone-budgets.md#follow-up-p4).
 */
function partGeometry(input: PlanOperationInput, region2d?: Region2dPort): AppResult<GeometryById> {
  let byStock = geometryMemo.get(input.part)
  if (byStock === undefined) geometryMemo.set(input.part, (byStock = new WeakMap()))
  let byPort = byStock.get(input.stock)
  if (byPort === undefined) byStock.set(input.stock, (byPort = new Map()))
  let r = byPort.get(region2d)
  if (r === undefined) {
    r = toGeometryInput(input.part, input.stock, region2d).map((g): GeometryById => ({
      stock: g.stock,
      byId: new Map(g.operations.map((o) => [o.id, o])),
    }))
    byPort.set(region2d, r)
  }
  return r
}

/** Kinds whose generators cut one operation per request (DF146: a clone group is split). */
export const SINGLE_KINDS: ReadonlySet<OperationKind> = new Set([
  'facing',
  'pocket',
  'profile',
  'line',
])

/**
 * A clone group of a kind cut one operation at a time (DF146): one request per instance, in
 * path order (design order), each with its own material and roughing rest
 * (`PlanOperationInput.instances`).
 */
function groupRequest(
  input: PlanOperationInput,
  region2d: Region2dPort | undefined,
): AppResult<GeneratorRequest> {
  const { material: _m, restAfter: _r, roughingFloor: _f, instances, ...shared } = input
  const parts: SingleRequest[] = []
  for (const op of input.operations) {
    const one = toGeneratorInputs(
      { ...shared, ...instances?.get(op.id), operations: [op] },
      region2d,
    )
    if (one.isErr()) return Err(one.unwrapErr())
    const r = one.unwrap()
    if (r.kind === 'group')
      return fail('internal.unexpected', 'a clone instance mapped to a group', {
        where: WHERE,
        data: { planOperationId: input.planOperationId },
      })
    parts.push(r)
  }
  const unmachined = parts.flatMap((p) => p.unmachined ?? [])
  return Ok({
    kind: 'group',
    parts,
    operationIds: input.operations.map((o) => o.id),
    ...(unmachined.length === 0 ? {} : { unmachined }),
  })
}

/**
 * The generator request of one plan operation: one input, except drilling and chamfers (one per
 * hole or chamfer, nearest-neighbour order); a clone group of another kind is a `group` of one
 * request per instance (DF146). Mapper bugs are `internal.unexpected`.
 */
export function toGeneratorInputs(
  input: PlanOperationInput,
  region2d?: Region2dPort,
): AppResult<GeneratorRequest> {
  const id = input.planOperationId
  const geometry = partGeometry(input, region2d)
  if (geometry.isErr()) return Err(geometry.unwrapErr().withContext(WHERE, { planOperationId: id }))
  const { byId, stock: partStock } = geometry.unwrap()
  const ops: OperationGeometry[] = []
  // alignment aids (S14) carry their own geometry: a registration hole is a through drilling
  // on the stock face, a witness mark has its own generator (below)
  const aid = input.aid
  if (aid?.kind === 'hole')
    ops.push({
      kind: 'drilling',
      id: input.operations[0]?.id ?? id,
      onZ: 0,
      center: aid.center,
      diameter: aid.diameter,
      bottom: { kind: 'through' },
    })
  for (const op of aid === undefined ? input.operations : []) {
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
    // generators stay top-down: the operation as read in its face frame, without the direction;
    // a through profile (DF50), hole (DF61) or pocket (patterns P4) cuts the material the plan's
    // earlier setups left (the plan's setup order, not the design's default one)
    const { direction: _, ...local } = g
    if (local.kind === 'profile' || local.kind === 'drilling' || local.kind === 'pocket') {
      const { throughDepth: __, ...rest } = local
      const t = input.throughDepths?.get(op.id)
      ops.push(t === undefined ? rest : { ...rest, throughDepth: t })
    } else ops.push(local)
  }
  if (
    aid === undefined &&
    ops.length > 1 &&
    (SINGLE_KINDS.has(input.kind) || ops.some((o) => o.kind === 'chamfer' && isLoopChamfer(o)))
  )
    return groupRequest(input, region2d)
  // the stock as seen in the setup: face rectangle on X/Y, extent along `n` as the thickness
  const stock: StockGeometry = localStock(input.setup.direction, partStock)
  const wcs = setupWcs(input.setup.direction, input.setup.rotation, partStock, input.setup.zero)
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
  // the material earlier cuts left (DF61): milled cuts skip the passes wholly in air
  // (the band only: a pocket's partial coverage is resolved here, below)
  const band: MaterialBand = {
    ...(input.material?.top === undefined ? {} : { top: input.material.top }),
    ...(input.material?.bottom === undefined ? {} : { bottom: input.material.bottom }),
  }
  const material = Object.keys(band).length === 0 ? {} : { material: band }
  const s = input.strategy
  const milling = (): AppResult<CuttingParams> =>
    cutting(
      input.feeds,
      ['spindleSpeed', 'feedRate', 'plungeRate', 'stepdown', 'stepover'],
      id,
    ).map((c) =>
      // DF74: the finishing passes' own feed (pockets and profiles with an allowance)
      input.feeds.finish.mapOr<CuttingParams>(c, (f) => ({ ...c, finishFeedRate: f.feedRate })),
    )
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
  if (aid?.kind === 'mark')
    return cutting(input.feeds, ['spindleSpeed', 'feedRate', 'plungeRate'], id).map(
      (c): GeneratorRequest => ({
        kind: 'mark',
        ...turned,
        inputs: [
          {
            ...base,
            cutting: {
              spindleSpeed: c.spindleSpeed,
              feedRate: c.feedRate,
              plungeRate: c.plungeRate,
            },
            operation: { id, from: aid.from, to: aid.to, depth: aid.depth },
            strategy: {},
          },
        ],
      }),
    )
  switch (s.kind) {
    case 'facing':
      return single('facing').andThen((operation) =>
        milling().andThen((c): AppResult<GeneratorRequest> => {
          // WH-D: around the workholding, a facing clears its region as a pocket does
          const kept =
            region2d === undefined || input.keepOut === undefined
              ? Ok(undefined)
              : keepOutRegion(
                  region2d,
                  facingRegion(stock.length, stock.width, s.overshoot),
                  input.keepOut,
                  -operation.depth,
                  wcs,
                )
          if (kept.isErr()) return Err(kept.unwrapErr())
          const around = kept.unwrap()
          if (around !== undefined)
            return Ok({
              kind: 'regionPocket',
              ...turned,
              unmachined: around.unmachined,
              inputs: [
                {
                  ...base,
                  ...material,
                  cutting: c,
                  operation: { region: around.region, onZ: 0, depth: operation.depth },
                  strategy: {
                    entry: 'ramp',
                    helixDiameter: 0.8 * tool.diameter,
                    rampAngle: FACING_RAMP_ANGLE,
                    finishAllowance: 0,
                    finishStepdown: operation.depth,
                    direction: s.direction,
                  },
                },
              ],
            })
          return Ok({
            kind: 'facing',
            ...turned,
            inputs: [
              {
                ...base,
                ...material,
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
          })
        }),
      )
    case 'pocket':
      return single('pocket').andThen((op) =>
        milling().andThen((c): AppResult<GeneratorRequest> => {
          const strategy = {
            entry: s.entry,
            helixDiameter: s.helixDiameter,
            rampAngle: s.rampAngle,
            finishAllowance: s.finishAllowance,
            finishStepdown: s.finishStepdown,
            direction: s.direction,
          }
          // a through pocket (patterns P4) goes `breakthrough` below the opposite face, or below
          // the material an earlier setup left under it (its `throughDepth`, DF50)
          const outline = pocketRegion(op)
          const left = op.throughDepth === undefined ? outline.depth : op.throughDepth + outline.onZ
          // DF122: a roughing pocket with a floor margin stops that much above the floor (or the
          // stock bottom: no breakthrough)
          const roughFloor = input.roughingFloor
          const deep =
            roughFloor !== undefined
              ? { ...outline, depth: left - roughFloor }
              : op.through === true && s.kind === 'pocket'
                ? { ...outline, depth: left + (s.breakthrough ?? 0) }
                : outline
          // H1 slot rule: slots exactly as wide as the tool are taken out of the region (before
          // its open region is built) and cut along their centre lines; not with workholding
          // keep-outs or a partly cleared region (those keep the rings), nor in v0.1 shapes
          const slotted =
            region2d !== undefined &&
            op.roughing !== true &&
            input.keepOut === undefined &&
            input.material?.partial === undefined &&
            !isAnalyticOperation(op)
              ? slotSplit(deep.region, tool.diameter, s.finishAllowance, stock)
              : undefined
          const slots = slotted === undefined || slotted.slots.length === 0 ? undefined : slotted
          const placed = slots === undefined ? deep : { ...deep, region: slots.region }
          const R = tool.diameter / 2
          const reach = openReach(R, s.finishAllowance)
          // DF108: a roughing pocket, and its pocket's rest machining after it (DF122: down to
          // the roughing's floor)
          const after = input.restAfter
          const rest = {
            ...(op.roughing === true ? { roughing: true as const } : {}),
            ...(slots === undefined ? {} : { slots: slots.slots }),
            ...(after === undefined
              ? {}
              : {
                  restAfter: {
                    radius: after.radius,
                    cornerRadius: after.cornerRadius,
                    wall: after.wall,
                    floorDepth: after.floor > 0 ? left - after.floor : placed.depth,
                  },
                }),
          }
          // open sides (DF61): a pocket reaching the stock edge is cut as its open region, so the
          // tool runs past the edge there
          const open =
            region2d !== undefined &&
            placed.region.pieces.length > 0 &&
            opensStock(region2d, placed.region, stock)
          // WH-D: the clearing goes around the workholding (no partial-cover split then)
          if (region2d !== undefined && input.keepOut !== undefined) {
            const whole = open
              ? openRegion(region2d, placed.region, stock, reach)
              : Ok(placed.region)
            const kept = whole.andThen((r) =>
              keepOutRegion(region2d, r, input.keepOut!, placed.onZ - placed.depth, wcs),
            )
            if (kept.isErr()) return Err(kept.unwrapErr())
            const around = kept.unwrap()
            if (around !== undefined)
              return Ok({
                kind: 'regionPocket',
                ...turned,
                unmachined: around.unmachined,
                inputs: [
                  {
                    ...base,
                    ...material,
                    cutting: c,
                    operation: { ...placed, region: around.region, ...rest },
                    strategy,
                  },
                ],
              })
          }
          const partial = input.material?.partial
          if (region2d !== undefined && (open || partial !== undefined))
            return (
              open ? openRegion(region2d, placed.region, stock, reach) : Ok(placed.region)
            ).map((region): GeneratorRequest => {
              const whole = { ...placed, region, ...rest }
              // partly cleared (DF61 follow-up): the uncovered part down to the cleared level,
              // then the whole region from there; no split when it could skip material
              const uncovered =
                partial === undefined
                  ? undefined
                  : uncoveredRegion(region2d, region, partial.region, reach, R)
              if (
                partial === undefined ||
                uncovered === undefined ||
                !splitSaves(region, uncovered, placed, partial.level, band, c.stepdown)
              )
                return {
                  kind: 'regionPocket',
                  ...turned,
                  inputs: [{ ...base, ...material, cutting: c, operation: whole, strategy }],
                }
              const below = { material: { ...band, top: partial.level } }
              const lower = { ...base, ...below, cutting: c, operation: whole, strategy }
              if (uncovered.pieces.length === 0)
                return { kind: 'regionPocket', ...turned, inputs: [lower] }
              const upper = {
                ...base,
                ...material,
                cutting: c,
                operation: {
                  region: uncovered,
                  onZ: placed.onZ,
                  depth: placed.onZ - partial.level,
                  ...rest,
                },
                strategy,
              }
              // DF135 C4: a recut pocket's as-cut version cleared down to its floor (widened,
              // the old one as deep): the whole-region pass would only re-trace the old floor
              if (partial.asCut === true && partial.level <= placed.onZ - placed.depth + 1e-9)
                return { kind: 'regionPocket', ...turned, inputs: [upper] }
              return { kind: 'regionPocket', ...turned, inputs: [upper, lower] }
            })
          // v0.1 rectangles and circles keep the v0.1 generator (byte-identical v0.1/v0.2
          // output); general shapes go to the region generator in the face frame (T1 wiring)
          return Ok(
            isAnalyticOperation(op) && op.through !== true && Object.keys(rest).length === 0
              ? {
                  kind: 'pocket',
                  ...turned,
                  inputs: [{ ...base, ...material, cutting: c, operation: op, strategy }],
                }
              : {
                  kind: 'regionPocket',
                  ...turned,
                  inputs: [
                    {
                      ...base,
                      ...material,
                      cutting: c,
                      operation: { ...placed, ...rest },
                      strategy,
                    },
                  ],
                },
          )
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
            finishStepdown: s.finishStepdown,
            direction: s.direction,
          }
          // DF122 R4: a roughing profile and its owner's rest machining take the general
          // generator (clipping); profiles without roughing keep theirs (goldens byte-equal)
          const after = input.restAfter
          const roughing = op.roughing === true
          if (isAnalyticOperation(op) && !roughing && after === undefined)
            return {
              kind: 'profile',
              ...turned,
              inputs: [{ ...base, ...material, cutting: c, operation: op, strategy }],
            }
          const plain = regionProfileOperation(op, stock)
          const operation = roughing
            ? {
                // the owner's slot (a through profile's at least its own tool's width + wall, into
                // the offcut), above its skin, no tabs (docs/modes/roughing.md#implementation-r4)
                ...plain,
                slotWidth: roughingSlot(plain, tool.diameter, s.finishAllowance),
                depth: plain.depth - (input.roughingFloor ?? 0),
                through: plain.through && input.roughingFloor === undefined,
                tabs: { ...plain.tabs, positions: [] },
                roughing: true as const,
              }
            : after === undefined
              ? plain
              : {
                  ...plain,
                  restAfter: {
                    radius: after.radius,
                    cornerRadius: after.cornerRadius,
                    wall: after.wall,
                    floorDepth: plain.depth - after.floor,
                    slotWidth: roughingSlot(plain, 2 * after.radius, after.wall),
                  },
                }
          return {
            kind: 'regionProfile',
            ...turned,
            inputs: [
              {
                ...base,
                ...material,
                cutting: c,
                operation,
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
      // visiting order from the work zero of the setup's WCS (moved with the setup's zero)
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
          // a hole below material earlier cuts cleared starts on the material (DF61 follow-up)
          ...holeBand(input.materials?.get(operation.id)),
          cutting: { spindleSpeed: c.spindleSpeed, feedRate: c.feedRate, plungeRate: c.plungeRate },
          operation,
          strategy,
        })),
      }))
    }
    case 'chamfer': {
      // a general edge (edge-chamfers.md E1): never grouped, its own generator in the face frame
      if (ops.some((o) => o.kind === 'chamfer' && isLoopChamfer(o)))
        return single('chamfer').andThen((op) =>
          loopChamferOf(op, id).andThen((operation: EdgeChamferOperation) =>
            cutting(input.feeds, ['spindleSpeed', 'feedRate', 'plungeRate'], id).map(
              (c): GeneratorRequest => ({
                kind: 'edgeChamfer',
                ...turned,
                inputs: [
                  {
                    ...base,
                    // a recut chamfer's bevel already cut (DF135 C4 follow-up)
                    ...holeBand(input.materials?.get(op.id)),
                    cutting: {
                      spindleSpeed: c.spindleSpeed,
                      feedRate: c.feedRate,
                      plungeRate: c.plungeRate,
                    },
                    operation,
                    // climb, as the circular chamfer's ring (plan-v0.4.md § Chamfer toolpath)
                    strategy: { direction: 'climb' },
                  },
                ],
              }),
            ),
          ),
        )
      const chamfers = ops.filter(
        (o): o is ChamferOperation => o.kind === 'chamfer' && !isLoopChamfer(o),
      )
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
          // a recut chamfer's bevel already cut (DF135 C4 follow-up)
          ...holeBand(input.materials?.get(operation.id)),
          cutting: { spindleSpeed: c.spindleSpeed, feedRate: c.feedRate, plungeRate: c.plungeRate },
          operation,
          strategy: strategyOf(operation),
        })),
      }))
    }
    case 'line':
      // a Line (engraved-patterns.md E1): never grouped; its grooves in the face frame
      return single('line').andThen((operation) =>
        cutting(input.feeds, ['spindleSpeed', 'feedRate', 'plungeRate', 'stepdown'], id).map(
          (c): GeneratorRequest => ({
            kind: 'line',
            ...turned,
            inputs: [
              {
                ...base,
                // a recut Line starts on its as-cut groove's floor (DF135 C4 follow-up) when the
                // plan's tool is the Line's cutter: the run cut the groove with it
                ...(isCutter(tool, operation.cutter) ? material : {}),
                cutting: {
                  spindleSpeed: c.spindleSpeed,
                  feedRate: c.feedRate,
                  plungeRate: c.plungeRate,
                  stepdown: c.stepdown,
                },
                // DF147 SL3: a through Line goes `breakthrough` below the opposite face
                operation: throughLine(operation, s.breakthrough),
                strategy: { entry: s.entry, rampAngle: s.rampAngle },
              },
            ],
          }),
        ),
      )
  }
}

/** A through Line's depth plus `breakthrough` (DF147 SL3); any other Line unchanged. */
function throughLine<T extends { readonly through?: true; readonly depth: object }>(
  op: T,
  breakthrough: number | undefined,
): T {
  if (op.through !== true || !('start' in op.depth)) return op
  const d = op.depth as { start: number; end: number }
  const b = breakthrough ?? 0
  return { ...op, depth: { start: d.start + b, end: d.end + b } }
}
