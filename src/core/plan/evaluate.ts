/**
 * Evaluation of a plan: per plan operation its tool, preset, stickout, resolved strategy and
 * feeds, and every finding of `plan.warning.list`. Derived on every call, never stored.
 * Doc: docs/modes/plan-v0.1.md (Tool assignment and checks, Feeds and speeds, Pass strategies)
 */
import { None, Option, Some } from '../../shared/result'
import { partIssueText } from '../design/issue-text'
import type { Operation } from '../design/operation'
import type { OperationKind } from '../design/part.dto'
import { machineLimits } from '../feeds-speeds/suggest'
import type { MaterialRow } from '../feeds-speeds/data'
import type { CuttingPreset, Tool } from '../library/tool'
import { Quantity } from '../quantity/quantity'
import { feedFindings, stockFindings, toolFindings, type PlanWarning } from './checks'
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
import { planThroughDepths } from './through'
import { checkPartFits } from './validity'
import { shapeToolFindings } from './shape-checks'
import type { Region2dPort } from '../geometry/2d/port'
import { designOperations, type LoadedPlan } from './plan'
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
  const ops = designOperations(plan, op)
  const kind: OperationKind = ops[0]?.kind ?? 'facing'
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
  const strategy = resolveStrategy(kind, op.strategy, sctx)
  const findings: PlanWarning[] = []
  const push = (
    f: Omit<PlanWarning, 'code' | 'severity' | 'planOperationId'>,
    code: PlanWarning['code'] = 'plan.check',
    severity: PlanWarning['severity'] = 'error',
  ) => findings.push({ ...f, code, severity, planOperationId: op.id })
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
      ...(strategy.kind === 'chamfer' ? { chamferDepth: strategy.cutDepth } : {}),
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
  for (const f of toolFindings({
    ops,
    part: plan.part,
    stock: plan.stock,
    throughDepths: planThroughDepths(plan, port),
    tool: t,
    stickout,
    ...(stepdown.isSome() ? { stepdown: stepdown.unwrap() } : {}),
    strategy,
  }))
    push(f)
  if (port !== undefined)
    for (const { severity, ...f } of shapeToolFindings(
      {
        ops,
        part: plan.part,
        stock: plan.stock,
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
    strategy,
    feeds: Some(feeds),
    findings,
  }
}

/**
 * Every finding of the plan: per operation, then order (across setups), then setups, then machine
 * (stock vs. travel per setup; `params.setupId` when the plan has several setups). With the 2D port
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
  for (const op of plan.operations)
    out.push(...evaluateOperation(plan, op, undefined, data, port).findings)
  out.push(...orderFindings(plan.operations, plan.part, port))
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
      const clearance = Quantity.fromDTO(s.clearanceHeight).mapOr(0, (q) => q.canonical)
      for (const f of stockFindings(setupStockSize(plan.stock, s), clearance, m))
        out.push({
          ...f,
          code: 'plan.machine',
          severity: 'warning',
          ...(several ? { params: { ...f.params, setupId: s.id } } : {}),
        })
    }
  })
  return out
}
