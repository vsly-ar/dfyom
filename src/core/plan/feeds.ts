/**
 * Feeds and speeds of one plan operation: auto mode (calculator, with locks) or a cutting preset
 * (fixed values), entered values, the strategy fallback, the `source` of every field, and the
 * lock state and recommendation per field.
 * Docs: docs/modes/plan-v0.1.md#feeds-and-speeds, docs/modes/plan-v0.1.md#locks-and-auto-mode,
 * docs/architecture/feeds-speeds.md#locked-inputs
 *
 * Total and pure: a field nothing resolves is `None` (a `plan.check` issue in evaluate.ts).
 * Values are float64 in canonical units (rpm, mm/min, mm).
 */
import type { Issue } from '../../shared/errors/app-error'
import { None, Some, type Option } from '../../shared/result'
import type { OperationKind } from '../design/part.dto'
import type { MaterialClass } from '../library/item'
import type { CuttingPreset, Tool } from '../library/tool'
import type { Quantity } from '../quantity/quantity'
import {
  checkCutting,
  cuttingAt,
  noDataFor,
  suggestCutting,
  type CuttingDisplay,
  type CuttingInput,
  type CuttingSuggestion,
  type CuttingWarning,
  type CuttingWarningCode,
  type DerivationStep,
  type Engagement,
  type LockedInputs,
  type MachineLimits,
} from '../feeds-speeds/suggest'
import { lockIssue, powerLockIssue, type LockIssue, type LockLimits } from '../feeds-speeds/locks'
import type { MaterialRow } from '../feeds-speeds/data'
import type { FeedField, PlanOperationDTO } from './plan.dto'

export type FeedSource = 'override' | 'preset' | 'calculator' | 'strategy'

export interface ResolvedFeed {
  readonly value: number
  readonly unit: 'rpm' | 'mm/min' | 'mm'
  readonly source: FeedSource
  /** The calculator's explanation (`calculator` only). */
  readonly derivation?: readonly DerivationStep[]
}

export type Overrides = Readonly<Partial<Record<FeedField, Quantity>>>

/** Whether a field's lock is shown, and whether it can be pressed (docs: Impossible locks). */
export type LockState =
  | { readonly state: 'hidden' }
  | { readonly state: 'available' }
  | { readonly state: 'unavailable'; readonly rule: LockIssue['rule']; readonly reason: string }

/** Auto mode: on, off (a preset is used), or unavailable (no calculator data) with the reason. */
export type AutoState = 'on' | 'off' | { readonly unavailable: string }

export interface FeedsInput {
  readonly kind: OperationKind
  readonly tool: Tool
  /** The preset used outside auto mode (chosen, else the default by material). */
  readonly preset: Option<CuttingPreset>
  readonly overrides: Overrides
  readonly materialClass: MaterialClass
  readonly machine: Option<MachineLimits>
  /** Auto mode requested: chosen (`auto: true`), or the default when the tool has no preset. */
  readonly auto: boolean
  /** Stored locks (`locked`); only auto mode uses them. */
  readonly locked?: readonly FeedField[]
  /** Resolved stickout (mm), for the `toolLength` lock rule. */
  readonly stickout?: number
  /** Facing: the facing depth (mm), the fallback stepdown. */
  readonly facingDepth?: number
  /** Drilling with an end mill (helix): the resolved helix pitch (mm). */
  readonly helixPitch?: number
  /** Chamfer (v0.4): the cut's depth below the tool tip (mm), the resolved strategy's `cutDepth`. */
  readonly chamferDepth?: number
}

export type FeedWarningCode = CuttingWarningCode | 'feeds.lockInactive'

/** A calculator, lock or final-value warning; joins `plan.warning.list`. */
export interface FeedWarning {
  readonly code: FeedWarningCode
  readonly severity: 'warning' | 'info'
  readonly message: string
  readonly params: Readonly<Record<string, number | string>>
  readonly field?: FeedField
  /** Defaults to `code`; `feeds.lockInactive` carries the lock rule. */
  readonly rule?: string
}

export interface ResolvedFeeds {
  /** Fields that apply to the operation kind (drilling: no stepdown/stepover). */
  readonly applicable: readonly FeedField[]
  readonly fields: Readonly<Record<FeedField, Option<ResolvedFeed>>>
  /** The engagement the calculator sees (facing: the strategy's stepover, or a locked one). */
  readonly engagement: Engagement
  readonly auto: AutoState
  /** Stored locks of applicable fields (active or inactive). */
  readonly locked: readonly FeedField[]
  /** Auto mode only: what each field would be without its own entry. */
  readonly recommended: Readonly<Record<FeedField, Option<number>>>
  readonly locks: Readonly<Record<FeedField, LockState>>
  /** Derived, never stored: feed ÷ (rpm × flutes), mm. */
  readonly chipLoad: Option<number>
  /**
   * Derived at the values that will be used (entered ones included): surface speed, chip load
   * after chip thinning, Q, Pc, spindle load. None without calculator data or speed and feed.
   */
  readonly used: Option<CuttingDisplay>
  /** Calculator warnings, inactive locks and the final-value check. */
  readonly warnings: readonly FeedWarning[]
}

const UNIT: Record<FeedField, ResolvedFeed['unit']> = {
  spindleSpeed: 'rpm',
  feedRate: 'mm/min',
  plungeRate: 'mm/min',
  stepdown: 'mm',
  stepover: 'mm',
}

const LABEL: Record<FeedField, string> = {
  spindleSpeed: 'Spindle speed',
  feedRate: 'Feed rate',
  plungeRate: 'Plunge rate',
  stepdown: 'Stepdown',
  stepover: 'Stepover',
}

/** The calculator input each lockable field feeds. */
const INPUT: Readonly<Record<FeedField, keyof LockedInputs | undefined>> = {
  spindleSpeed: 'n',
  feedRate: 'vf',
  plungeRate: undefined,
  stepdown: 'ap',
  stepover: 'ae',
}

const MILLING: readonly FeedField[] = [
  'spindleSpeed',
  'feedRate',
  'plungeRate',
  'stepdown',
  'stepover',
]
const DRILLING: readonly FeedField[] = ['spindleSpeed', 'feedRate', 'plungeRate']

/**
 * Fields that can be locked (docs/modes/plan-v0.1.md#locks-and-auto-mode): the inputs other
 * recommendations depend on. Plunge rate and pocket/profile stepover depend on nothing else.
 */
export function lockableFields(kind: OperationKind): readonly FeedField[] {
  switch (kind) {
    case 'facing':
      return ['spindleSpeed', 'feedRate', 'stepdown', 'stepover']
    case 'pocket':
    case 'profile':
      return ['spindleSpeed', 'feedRate', 'stepdown']
    case 'drilling':
    case 'chamfer':
      return ['spindleSpeed', 'feedRate']
  }
}

/**
 * Invariants of `auto`, `presetName` and `locked` (model.invariant): auto and a preset exclude
 * each other; locks only in auto mode, on lockable fields with an entered value, no duplicates.
 */
export function feedModeIssues(op: PlanOperationDTO, kind: OperationKind): Issue[] {
  const issues: Issue[] = []
  if (op.auto === true && op.presetName !== undefined)
    issues.push({
      path: ['auto'],
      rule: 'autoAndPreset',
      message: 'auto mode and a cutting preset exclude each other',
    })
  const locked = op.locked
  if (locked === undefined) return issues
  if (op.auto !== true)
    issues.push({ path: ['locked'], rule: 'lockOutsideAuto', message: 'locks need auto mode' })
  const lockable = lockableFields(kind)
  locked.forEach((f, i) => {
    if (locked.indexOf(f) !== i)
      issues.push({ path: ['locked', i], rule: 'duplicateLock', message: `${f} is locked twice` })
    if (!lockable.includes(f))
      issues.push({ path: ['locked', i], rule: 'notLockable', message: `${f} has no lock` })
    if (op.overrides[f] === undefined)
      issues.push({ path: ['locked', i], rule: 'lockWithoutValue', message: `${f} has no value` })
  })
  return issues
}

/**
 * The tool's preset for this plan operation: `presetName` if given (None when the tool has no
 * such preset), else the one for the stock's material class, else one without a class.
 */
export function pickPreset(
  tool: Tool,
  materialClass: MaterialClass,
  presetName: string | undefined,
): Option<CuttingPreset> {
  const find = (f: (p: CuttingPreset) => boolean): Option<CuttingPreset> => {
    const p = tool.presets.find(f)
    return p === undefined ? None : Some(p)
  }
  if (presetName !== undefined) return find((p) => p.name === presetName)
  const byClass = find((p) => p.materialClass.mapOr(false, (c) => c === materialClass))
  return byClass.isSome() ? byClass : find((p) => p.materialClass.isNone())
}

/** Strategy fallback (stepdown/stepover only), docs/modes/plan-v0.1.md#pass-strategies-v01. */
function fallback(
  field: 'stepdown' | 'stepover',
  i: Pick<FeedsInput, 'kind' | 'tool' | 'facingDepth'>,
): Option<number> {
  const D = i.tool.diameter.canonical
  if (i.kind === 'drilling' || i.kind === 'chamfer') return None
  if (field === 'stepover') return Some((i.kind === 'facing' ? 0.75 : 0.4) * D)
  if (i.kind === 'facing') return i.facingDepth === undefined ? None : Some(i.facingDepth)
  return Some(0.25 * D)
}

const given = (value: number, source: FeedSource, field: FeedField): ResolvedFeed => ({
  value,
  unit: UNIT[field],
  source,
})

function presetValue(preset: Option<CuttingPreset>, field: FeedField): Option<ResolvedFeed> {
  return preset
    .andThen((p): Option<Quantity> => {
      switch (field) {
        case 'stepdown':
          return p.stepdown
        case 'stepover':
          return p.stepover
        default:
          return Some(p[field])
      }
    })
    .map((q) => given(q.canonical, 'preset', field))
}

/** The calculator's engagement: the strategy's (facing: its stepover, never an entered one). */
function engagementOf(
  i: Pick<FeedsInput, 'kind' | 'tool' | 'helixPitch' | 'chamferDepth'>,
): Engagement {
  const D = i.tool.diameter.canonical
  switch (i.kind) {
    case 'facing':
      return { kind: 'stepover', ae: 0.75 * D }
    case 'pocket':
    case 'profile':
      return { kind: 'slot' }
    case 'drilling':
      return i.tool.type === 'drill'
        ? { kind: 'drill' }
        : { kind: 'helix', ap: i.helixPitch ?? 0.25 * D }
    case 'chamfer':
      // F10: the effective diameter at the deepest point of the cut (plan-v0.4.md P-D); a stepped
      // chamfer's end mill (F7) as helical boring, one terrace deep
      return i.tool.type === 'flatEndMill'
        ? { kind: 'helix', ap: i.chamferDepth ?? 0.25 * D }
        : { kind: 'chamfer', depth: i.chamferDepth ?? 0 }
  }
}

/** The `feeds.noData` warning when the calculator has no data for this tool and stock. */
export function calculatorNoData(
  i: Pick<FeedsInput, 'kind' | 'tool' | 'materialClass' | 'machine'>,
  data?: readonly MaterialRow[],
): Option<CuttingWarning> {
  const input = { ...i, engagement: engagementOf(i) }
  return data === undefined ? noDataFor(input) : noDataFor(input, data)
}

const HIDDEN: LockState = { state: 'hidden' }
/** Coupling warnings the final-value check re-runs on the values used (they replace these). */
const RECHECKED = new Set<FeedWarningCode>([
  'feeds.rubbing',
  'feeds.chipLoadHigh',
  'feeds.powerExceeded',
])

const perField = <T>(f: (field: FeedField) => T): Record<FeedField, T> =>
  Object.fromEntries(MILLING.map((k) => [k, f(k)])) as Record<FeedField, T>

/**
 * Resolves every field. Auto mode (requested and with data): entered value, else the
 * calculator's recommendation around the active locks (stepover: the strategy's; stepdown: the
 * strategy's when the calculator has none). Otherwise: entered value, else preset, else the
 * strategy fallback (stepdown/stepover). `data` is the material table (tests may pass a fixture).
 */
export function resolveFeeds(i: FeedsInput, data?: readonly MaterialRow[]): ResolvedFeeds {
  const applicable = i.kind === 'drilling' || i.kind === 'chamfer' ? DRILLING : MILLING
  const engagement = engagementOf(i)
  const base: CuttingInput = {
    tool: i.tool,
    materialClass: i.materialClass,
    engagement,
    machine: i.machine,
  }
  const run = (locked: LockedInputs): CuttingSuggestion =>
    data === undefined
      ? suggestCutting({ ...base, locked })
      : suggestCutting({ ...base, locked }, data)
  const noData = calculatorNoData(i, data)
  const auto: AutoState = noData.isSome()
    ? { unavailable: noData.unwrap().message }
    : i.auto
      ? 'on'
      : 'off'
  const locked = [...new Set(i.locked ?? [])].filter((f) => applicable.includes(f))
  const entered = (f: FeedField): Option<ResolvedFeed> => {
    const o = i.overrides[f]
    return o === undefined ? None : Some(given(o.canonical, 'override', f))
  }
  const strategy = (f: FeedField): Option<ResolvedFeed> =>
    f === 'stepdown' || f === 'stepover' ? fallback(f, i).map((v) => given(v, 'strategy', f)) : None
  const or = (a: Option<ResolvedFeed>, b: () => Option<ResolvedFeed>) => (a.isSome() ? a : b())
  const warnings: FeedWarning[] = []

  let fields: Record<FeedField, Option<ResolvedFeed>>
  let recommended = perField<Option<number>>(() => None)
  let locks = perField<LockState>(() => HIDDEN)
  let lockEngagement = engagement

  if (auto !== 'on') {
    fields = perField((f) =>
      applicable.includes(f)
        ? or(entered(f), () => or(presetValue(i.preset, f), () => strategy(f)))
        : None,
    )
    if (i.auto && noData.isSome()) {
      // as before locks: the missing data matters when it leaves a field without a value
      if (applicable.some((f) => fields[f].isNone())) warnings.push(noData.unwrap())
      for (const f of locked)
        warnings.push(inactive(f, 'noData', 'the calculator has no data for this tool and stock.'))
    }
  } else {
    const lockable = lockableFields(i.kind)
    const limits: LockLimits = {
      tool: i.tool,
      machine: i.machine,
      drill: engagement.kind === 'drill',
      ...(i.stickout === undefined ? {} : { stickout: i.stickout }),
    }
    // Stored locks: active unless a rule breaks them now (then inactive, with a warning).
    const active: Record<string, number> = {}
    const broken = new Map<FeedField, LockIssue>()
    for (const f of locked) {
      const key = INPUT[f]
      if (key === undefined || !lockable.includes(f)) continue
      const v = i.overrides[f]?.canonical
      const why = lockIssue(key, v, limits)
      if (why.isSome()) broken.set(f, why.unwrap())
      else if (v !== undefined) active[key] = v
    }
    const s = run(active)
    if (active['ae'] !== undefined && engagement.kind === 'stepover')
      lockEngagement = { kind: 'stepover', ae: active['ae'] }
    const recommendation = (sugg: CuttingSuggestion, f: FeedField): Option<ResolvedFeed> => {
      if (f === 'stepover') return strategy(f)
      const calc = sugg[f].map((v): ResolvedFeed => ({
        value: v.value,
        unit: UNIT[f],
        source: 'calculator',
        derivation: v.derivation,
      }))
      return f === 'stepdown' ? or(calc, () => strategy(f)) : calc
    }
    fields = perField((f) =>
      applicable.includes(f) ? or(entered(f), () => recommendation(s, f)) : None,
    )
    recommended = perField((f) => {
      if (!applicable.includes(f)) return None
      const key = INPUT[f]
      if (key !== undefined && active[key] !== undefined) {
        const { [key]: _own, ...others } = active
        return recommendation(run(others), f).map((r) => r.value)
      }
      return recommendation(s, f).map((r) => r.value)
    })
    locks = perField((f): LockState => {
      const key = INPUT[f]
      if (!applicable.includes(f) || key === undefined || !lockable.includes(f)) return HIDDEN
      if (locked.includes(f)) {
        const why = broken.get(f)
        return why === undefined ? { state: 'available' } : unavailable(why)
      }
      const v = fields[f].map((r) => r.value).unwrapOr(undefined as unknown as number)
      const why = lockIssue(key, v, limits)
      if (why.isSome()) return unavailable(why.unwrap())
      const power = powerLockIssue({ ...base, locked: { ...active, [key]: v } }, data)
      return power.isSome() ? unavailable(power.unwrap()) : { state: 'available' }
    })
    // The calculator's warnings matter only when it supplies a value.
    const used = applicable.some((f) => fields[f].mapOr(false, (v) => v.source === 'calculator'))
    if (used) warnings.push(...s.warnings.filter((w) => !RECHECKED.has(w.code)))
    for (const [f, why] of broken) warnings.push(inactive(f, why.rule, why.reason, why.params))
  }

  // Final-value check on the values that will be used, entered ones included.
  const value = (f: FeedField) => fields[f].map((r) => r.value)
  let used: Option<CuttingDisplay> = None
  if (noData.isNone() && value('spindleSpeed').isSome() && value('feedRate').isSome()) {
    const ap = value('stepdown')
    const ae = value('stepover')
    const values = {
      n: value('spindleSpeed').unwrap(),
      vf: value('feedRate').unwrap(),
      ...(ap.isSome() ? { ap: ap.unwrap() } : {}),
      ...(ae.isSome() ? { ae: ae.unwrap() } : {}),
    }
    const checked =
      data === undefined ? checkCutting(base, values) : checkCutting(base, values, data)
    warnings.push(...checked)
    used = data === undefined ? cuttingAt(base, values) : cuttingAt(base, values, data)
  }

  const flutes = i.tool.fluteCount.canonical
  const chipLoad =
    fields.spindleSpeed.isSome() && fields.feedRate.isSome() && flutes > 0
      ? Some(fields.feedRate.unwrap().value / (fields.spindleSpeed.unwrap().value * flutes))
      : None
  return {
    applicable,
    fields,
    engagement: lockEngagement,
    auto,
    locked: auto === 'on' || i.auto ? locked : [],
    recommended,
    locks,
    chipLoad,
    used,
    warnings,
  }
}

const unavailable = (why: LockIssue): LockState => ({
  state: 'unavailable',
  rule: why.rule,
  reason: why.reason,
})

function inactive(
  field: FeedField,
  rule: string,
  reason: string,
  params: Readonly<Record<string, number | string>> = {},
): FeedWarning {
  return {
    code: 'feeds.lockInactive',
    severity: 'warning',
    message: `${LABEL[field]} lock is inactive: ${reason}`,
    params: { ...params, reason: rule },
    field,
    rule,
  }
}
