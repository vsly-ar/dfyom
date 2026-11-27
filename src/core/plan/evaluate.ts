/**
 * Evaluation of a plan: per plan operation its tool, preset, stickout, resolved strategy and
 * feeds, and every finding of `plan.warning.list`. Derived on every call, never stored.
 * Doc: docs/modes/plan-v0.1.md (Tool assignment and checks, Feeds and speeds, Pass strategies)
 */
import { None, Option, Some } from '../../shared/result'
import { partIssueText } from '../design/issue-text'
import { roughingOwnerId, type Operation } from '../design/operation'
import type { OperationKind } from '../design/part.dto'
import { machineLimits } from '../feeds-speeds/suggest'
import type { MaterialRow } from '../feeds-speeds/data'
import type { CuttingPreset, Tool } from '../library/tool'
import { Quantity } from '../quantity/quantity'
import {
  feedFindings,
  neededStickout,
  rigidityFindings,
  stockFindings,
  toolFindings,
  type PlanWarning,
} from './checks'
import {
  calculatorNoData,
  FEED_FIELD_LABEL,
  pickPreset,
  resolveFeeds,
  type Overrides,
  type ResolvedFeeds,
} from './feeds'
import { orderFindings } from './order'
import { setupFindings, setupStockSize } from './setups'
import { holdsOnSurface } from './workholding/items'
import { planFaceWaste, planThroughDepths } from './through'
import { zHeadroomFindings, zHeadroomUnknown, type ZHeadroomTool } from './z-headroom'
import { checkPartFits } from './validity'
import { shapeToolFindings } from './shape-checks'
import type { Region2dPort } from '../geometry/2d/port'
import { designOperations, setupOf, type LoadedPlan } from './plan'
import {
  aidDrilling,
  aidOf,
  aidPlacementFindings,
  markDepthWith,
  mmLength,
  spoilboardDepth,
} from './aids'
import { setupWorkholding } from './workholding/setup'
import { FEED_FIELDS, type PlanOperationDTO } from './plan.dto'
import {
  resolveStrategy,
  strategyIssues,
  type ResolvedStrategy,
  type StrategyContext,
} from './strategy'

export interface OperationEvaluation {
  readonly planOperation: PlanOperationDTO
  readonly kind: OperationKind
  readonly ops: readonly Operation[]
  readonly tool: Option<Tool>
  /** The preset in use: None in auto mode. */
  readonly preset: Option<CuttingPreset>
  /** Auto mode requested: chosen, or the default because the tool has no preset. */
  readonly autoRequested: boolean
  /** Resolved stickout (mm): the plan's, else the tool's stickout, else its flute length. */
  readonly stickout: Option<number>
  /**
   * Minimum stickout (mm, DF130): the deepest cut + the collet nut clearance (`neededStickout`);
   * None without a tool. Doc: docs/modes/plan-v0.1.md#minimum-stickout-hardening-df130
   */
  readonly stickoutNeeded: Option<number>
  readonly strategy: ResolvedStrategy
  readonly feeds: Option<ResolvedFeeds>
  readonly findings: readonly PlanWarning[]
}

export function overridesOf(op: PlanOperationDTO): Overrides {
  const out: Partial<Record<(typeof FEED_FIELDS)[number], Quantity>> = {}
  for (const f of FEED_FIELDS) {
    const dto = op.overrides[f]
    if (dto === undefined) continue
    const q = Quantity.fromDTO(dto)
    if (q.isOk()) out[f] = q.unwrap()
  }
  return out
}

export function stickoutOf(op: PlanOperationDTO, tool: Tool): number {
  if (op.stickout !== undefined) {
    const q = Quantity.fromDTO(op.stickout)
    if (q.isOk()) return q.unwrap().canonical
  }
  return tool.stickout.mapOr(tool.fluteLength.canonical, (q) => q.canonical)
}

/**
 * Evaluates one plan operation with `tool` (its own, or a candidate for `plan.tool.suggest`).
 * With the 2D port the tool checks of general shapes run too (`shapeToolFindings`).
 */
export function evaluateOperation(
  plan: LoadedPlan,
  op: PlanOperationDTO,
  candidate?: Tool,
  data?: readonly MaterialRow[],
  port?: Region2dPort,
): OperationEvaluation {
  // alignment aids (S14): a registration hole is a through drilling on the setup's stock face, a
  // witness mark a V-bit cut fed as a chamfer of its depth
  const aid = aidOf(op)
  const setup = aid === undefined ? undefined : setupOf(plan, op.id)
  const hole = setup === undefined ? undefined : aidDrilling(plan, setup, op)
  const ops = hole !== undefined ? [hole] : designOperations(plan, op)
  const kind: OperationKind = aid?.kind === 'witnessMark' ? 'chamfer' : (ops[0]?.kind ?? 'facing')
  const tool: Option<Tool> =
    candidate !== undefined
      ? Some(candidate)
      : op.tool === undefined
        ? None
        : Option.nonNull(plan.tools.get(op.tool))
  const materialClass = plan.stock.material.class
  const machine = plan.machine.map(machineLimits)
  const chosen = candidate === undefined ? op.presetName : undefined
  const named = tool.andThen((t) => pickPreset(t, materialClass, chosen))
  // Auto mode: chosen, or the default without a preset; on only with calculator data.
  const autoRequested = op.auto === true || (chosen === undefined && named.isNone())
  const autoOn =
    autoRequested &&
    tool.mapOr(false, (t) =>
      calculatorNoData({ kind, tool: t, materialClass, machine }, data).isNone(),
    )
  const preset: Option<CuttingPreset> = autoOn ? None : named
  const sctx: StrategyContext = {
    ops,
    allOps: plan.part.operations,
    stock: plan.stock,
    units: plan.units,
    tool,
    preset,
  }
  const markDepth =
    aid?.kind === 'witnessMark'
      ? markDepthWith(aid, tool.isSome() ? tool.unwrap() : undefined)
      : undefined
  const strategy: ResolvedStrategy =
    aid?.kind === 'witnessMark'
      ? { kind: 'chamfer', entry: 'plunge', rampAngle: 3, cutDepth: markDepth ?? 0 }
      : resolveStrategy(
          kind,
          aid?.kind === 'registrationHole'
            ? { ...op.strategy, breakthrough: mmLength(spoilboardDepth(aid)) }
            : op.strategy,
          sctx,
        )
  const findings: PlanWarning[] = []
  const push = (
    f: Omit<PlanWarning, 'code' | 'severity' | 'planOperationId'>,
    code: PlanWarning['code'] = 'plan.check',
    severity: PlanWarning['severity'] = 'error',
  ) => findings.push({ ...f, code, severity, planOperationId: op.id })
  if (setup !== undefined)
    for (const f of aidPlacementFindings(plan, setup, op, port))
      findings.push({ ...f, planOperationId: op.id })
  if (tool.isNone()) {
    push({ field: 'tool', rule: 'noTool', message: 'no tool assigned', params: {} })
    return {
      planOperation: op,
      kind,
      ops,
      tool,
      preset,
      autoRequested,
      stickout: None,
      stickoutNeeded: None,
      strategy,
      feeds: None,
      findings,
    }
  }
  const t = tool.unwrap()
  if (candidate === undefined && op.presetName !== undefined && preset.isNone())
    push({
      field: 'presetName',
      rule: 'unknownPreset',
      message: `the tool has no preset "${op.presetName}"`,
      params: { presetName: op.presetName },
    })
  for (const issue of strategyIssues(kind, op.strategy, strategy, sctx))
    push({
      field: issue.path.join('.'),
      rule: issue.rule,
      message: issue.message,
      params: {},
    })
  const stickout = stickoutOf(op, t)
  const feeds = resolveFeeds(
    {
      kind,
      tool: t,
      preset,
      overrides: overridesOf(op),
      materialClass,
      machine,
      auto: autoRequested,
      locked: op.locked ?? [],
      stickout,
      ...(kind === 'facing' && ops[0]?.kind === 'facing'
        ? { facingDepth: ops[0].depth.canonical }
        : {}),
      ...(strategy.kind === 'drilling' ? { helixPitch: strategy.helixPitch } : {}),
      // F10 at the deepest point of the cut (plan-v0.4.md P-D)
      ...(strategy.kind === 'chamfer' || strategy.kind === 'line'
        ? { chamferDepth: strategy.cutDepth }
        : {}),
      // DF74: the finishing pass's engagement
      ...(strategy.kind === 'pocket' || strategy.kind === 'profile'
        ? {
            finishAllowance: strategy.finishAllowance,
            finishStepdown: strategy.finishStepdown,
          }
        : {}),
    },
    data,
  )
  for (const field of feeds.applicable)
    if (feeds.fields[field].isNone())
      push({
        field,
        rule: 'unresolved',
        message: `${FEED_FIELD_LABEL[field].toLowerCase()} has no entered, preset or calculator value`,
        params: {},
      })
  const stepdown = feeds.fields.stepdown.map((v) => v.value)
  const checkInput = {
    ops,
    part: plan.part,
    stock: plan.stock,
    throughDepths: planThroughDepths(plan, port),
    tool: t,
    stickout,
    strategy,
  }
  for (const f of toolFindings({
    ...checkInput,
    ...(stepdown.isSome() ? { stepdown: stepdown.unwrap() } : {}),
  }))
    push(f)
  if (aid?.kind === 'witnessMark')
    for (const f of markToolFindings(t, stickout, markDepth)) push(f, f.code, 'error')
  // DF75, DF130: warnings, never disqualifying (plan-v0.1.md § Reach and rigidity warnings)
  for (const f of rigidityFindings(checkInput)) push(f, 'plan.check', 'warning')
  if (port !== undefined)
    for (const { severity, ...f } of shapeToolFindings(
      {
        ops,
        part: plan.part,
        stock: plan.stock,
        waste: (d) => planFaceWaste(plan, d, port),
        tool: t,
        strategy,
        helixSet: op.strategy.helixDiameter !== undefined,
      },
      port,
    ))
      push(f, 'plan.check', severity)
  plan.machine.map((m) => feedFindings(feeds, m).forEach((f) => push(f, 'plan.machine', 'warning')))
  for (const w of feeds.warnings)
    findings.push({
      code: w.code,
      severity: w.severity,
      message: w.message,
      planOperationId: op.id,
      ...(w.field === undefined ? {} : { field: w.field }),
      rule: w.rule ?? w.code,
      params: w.params,
    })
  return {
    planOperation: op,
    kind,
    ops,
    tool,
    preset,
    autoRequested,
    stickout: Some(stickout),
    stickoutNeeded: Some(neededStickout(checkInput)),
    strategy,
    feeds: Some(feeds),
    findings,
  }
}

/**
 * The V-bit checks of a witness mark (S14): a pointed chamfer mill (`plan.aid`, rule
 * `pointedVBit`), its depth within the flute length and the stickout.
 */
function markToolFindings(
  tool: Tool,
  stickout: number,
  depth: number | undefined,
): (Omit<PlanWarning, 'severity' | 'planOperationId'> & { code: PlanWarning['code'] })[] {
  const tip = tool.tipDiameter.mapOr(0, (q) => q.canonical)
  if (tool.type !== 'chamferMill' || tip > 1e-9 || depth === undefined)
    return [
      {
        code: 'plan.aid',
        field: 'tool',
        rule: 'pointedVBit',
        message: 'a witness mark needs a pointed V-bit (a chamfer mill without a flat tip)',
        params: { toolType: tool.type },
      },
    ]
  const out: (Omit<PlanWarning, 'severity' | 'planOperationId'> & { code: PlanWarning['code'] })[] =
    []
  const flute = tool.fluteLength.canonical
  if (depth > flute + 1e-9)
    out.push({
      code: 'plan.check',
      field: 'tool',
      rule: 'fluteLength',
      message: 'mark depth must be at most the flute length',
      params: { depth, fluteLength: flute },
    })
  if (depth > stickout + 1e-9)
    out.push({
      code: 'plan.check',
      field: 'stickout',
      rule: 'reach',
      message: 'mark depth must be at most the stickout',
      params: { depth, stickout },
    })
  return out
}

/**
 * DF122 `plan.roughingWallThin` (warning, on the roughing): a wall margin set below its pocket's
 * resolved finishing allowance (the pocket's finishing pass then cuts the roughing's scallops at
 * the thinner margin). Doc: docs/modes/roughing.md#stock-to-leave-wall-and-floor
 */
function roughingFindings(plan: LoadedPlan): PlanWarning[] {
  const out: PlanWarning[] = []
  const byId = new Map(plan.part.operations.map((o) => [o.id, o]))
  for (const p of plan.operations) {
    const d = byId.get(p.designOperationIds[0] ?? '')
    // DF122 R4: a roughing profile likewise
    if (
      (d?.kind !== 'pocket' && d?.kind !== 'profile') ||
      d.roughing !== true ||
      d.leave?.wall === undefined
    )
      continue
    const ownerId = roughingOwnerId(d)
    const owner = plan.operations.find(
      (q) => ownerId !== undefined && q.designOperationIds.includes(ownerId),
    )
    if (owner === undefined) continue
    const s = evaluateOperation(plan, owner).strategy
    const wall = d.leave.wall.canonical
    if ((s.kind !== 'pocket' && s.kind !== 'profile') || wall >= s.finishAllowance - 1e-9) continue
    out.push({
      code: 'plan.roughingWallThin',
      severity: 'warning',
      message: `the roughing leaves ${+wall.toFixed(4)} mm on the walls, less than the ${s.kind}'s finishing allowance (${+s.finishAllowance.toFixed(4)} mm)`,
      planOperationId: p.id,
      field: 'roughing.wall',
      rule: 'roughingWallThin',
      params: { wall, finishAllowance: s.finishAllowance, ownerId: ownerId! },
    })
  }
  return out
}

/**
 * Every finding of the plan: per operation, then order (across setups; `plan.loosePiece` left out
 * in a setup held on a surface, W5), then setups, then machine
 * (stock vs. travel per setup, `params.setupId` when the plan has several setups; the Z headroom
 * per setup and tool, always with `params.setupId`, then `zHeadroomUnknown` once). With the 2D port
 * the part's shape checks run as in the design (`tabOutside`, `tabsOverlap`, …); the shape
 * findings that need geometry (`plan.restMaterial`, `plan.stepoverClamped`) are
 * `shapeFindings`' (plan.warning.list only).
 */
export function planFindings(
  plan: LoadedPlan,
  data?: readonly MaterialRow[],
  port?: Region2dPort,
): PlanWarning[] {
  const out: PlanWarning[] = []
  const tools = new Map<string, ZHeadroomTool>()
  for (const op of plan.operations) {
    const e = evaluateOperation(plan, op, undefined, data, port)
    out.push(...e.findings)
    if (e.tool.isSome() && e.stickout.isSome())
      tools.set(op.id, {
        planOperationId: op.id,
        toolName: e.tool.unwrap().name,
        stickout: e.stickout.unwrap(),
      })
  }
  out.push(...roughingFindings(plan))
  // W5: an operation in a setup held on a surface (tape, vacuum, glue) works on held pieces
  const surface = new Set(
    plan.setups.filter(holdsOnSurface).flatMap((s) => s.operations.map((o) => o.id)),
  )
  out.push(
    ...orderFindings(plan.operations, plan.part, port).filter(
      (w) => w.code !== 'plan.loosePiece' || !surface.has(w.planOperationId ?? ''),
    ),
  )
  out.push(...setupFindings(plan.setups, plan.part))
  const stock = plan.dto.snapshots.find((x) => x.id === plan.dto.design.part.stock)
  if (stock !== undefined) {
    const fits = checkPartFits(plan.dto.design.part, stock, 'plan.warning.list', port)
    if (fits.isErr())
      for (const issue of fits.unwrapErr().issues.length > 0
        ? fits.unwrapErr().issues
        : [{ path: [], message: fits.unwrapErr().message }])
        out.push({
          code: 'plan.check',
          severity: 'error',
          message: `the part does not fit the plan's stock copy: ${partIssueText(plan.dto.design.part, issue)}`,
          field: ['design', ...issue.path].join('.'),
          rule: 'stockFit',
          params: {},
        })
  }
  plan.machine.map((m) => {
    const several = plan.setups.length > 1
    for (const s of plan.setups) {
      // the clearance height the program uses: it follows the workholding (WH-C)
      const clearance = setupWorkholding(s, plan.stock).clearance
      const size = setupStockSize(plan.stock, s)
      for (const f of stockFindings(size, clearance, m))
        out.push({
          ...f,
          code: 'plan.machine',
          severity: 'warning',
          ...(several ? { params: { ...f.params, setupId: s.id } } : {}),
        })
      // DF68: the top only (the lowest Z needs the toolpath: export checks it)
      out.push(
        ...zHeadroomFindings(m, {
          setupId: s.id,
          clearance,
          stockThickness: size.z[1],
          tools: s.operations.flatMap((o) => tools.get(o.id) ?? []),
        }),
      )
    }
    const unknown = zHeadroomUnknown(m)
    if (unknown !== undefined) out.push(unknown)
  })
  return out
}
