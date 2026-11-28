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
  finishingAt,
  type FinishingFeed,
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
import { adaptPreset, type AdaptedField, type PresetValues } from '../feeds-speeds/preset'
import type { UnitSystem } from '../project/document'
import type { FeedField, PlanOperationDTO } from './plan.dto'

export type FeedSource = 'override' | 'preset' | 'calculator' | 'strategy'

export interface ResolvedFeed {
  readonly value: number
  readonly unit: 'rpm' | 'mm/min' | 'mm'
  readonly source: FeedSource
  /** The calculator's explanation (`calculator` only). */
  readonly derivation?: readonly DerivationStep[]
  /**
   * A recommended preset's value lowered to the plan machine (`preset` only, DF139): the stored
   * value and why. Doc: docs/architecture/feeds-speeds.md#recommended-presets-on-the-plan-machine-hardening-df139
   */
  readonly adapted?: AdaptedField
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
  /**
   * DF141: a chamfer plunged by a chamfer mill into an edge (hole) of this Ø (0: solid, a witness
   * mark): its power is F12 at the plunge rate (feeds-speeds.md § Plunged chamfers).
   */
  readonly chamferPlunge?: { readonly edgeDiameter: number }
  /** Pocket/profile: the resolved finishing allowance (mm; 0 or absent = no finishing pass). */
  readonly finishAllowance?: number
  /** Pocket/profile: the resolved finish stepdown (mm), the finishing pass's axial engagement. */
  readonly finishStepdown?: number
  /** The plan's unit system: the rounding of adapted recommended presets (DF139); default mm. */
  readonly units?: UnitSystem
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
  /**
   * The finishing pass's own feed (DF74), at the values used; None without a finishing pass or
   * calculator data (the finishing pass then runs at `feedRate`).
   */
  readonly finish: Option<FinishingFeed>
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

/** A feed field in words, for visible text ("Feed rate", never `feedRate`; DF43). */
export const FEED_FIELD_LABEL: Readonly<Record<FeedField, string>> = {
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
/** A Line (engraved-patterns.md § Toolpath): depth passes, no stepover (one groove). */
const LINE: readonly FeedField[] = ['spindleSpeed', 'feedRate', 'plungeRate', 'stepdown']

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
    case 'line':
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

/** A preset's stored value of `field` (canonical). */
function storedValue(p: CuttingPreset, field: FeedField): Option<number> {
  switch (field) {
    case 'stepdown':
      return p.stepdown.map((q) => q.canonical)
    case 'stepover':
      return p.stepover.map((q) => q.canonical)
    default:
      return Some(p[field].canonical)
  }
}

/** A preset's values for one operation: stored, or adapted to the plan machine (DF139). */
interface PresetUse {
  readonly value: (field: FeedField) => Option<ResolvedFeed>
  /** A recommended preset's power is above the budget even at the chip-load floor. */
  readonly powerExceeded: boolean
}

/**
 * The preset's values: a recommended preset with a plan machine is adapted down to it (Q211,
 * Q212: only `recommended: true`); others give their stored values.
 * Doc: docs/architecture/feeds-speeds.md#recommended-presets-on-the-plan-machine-hardening-df139
 */
function presetUse(
  i: FeedsInput,
  engagement: Engagement,
  data?: readonly MaterialRow[],
): PresetUse {
  const stored = (field: FeedField) =>
    i.preset.andThen((p) => storedValue(p, field)).map((v) => given(v, 'preset', field))
  if (i.preset.isNone() || i.machine.isNone() || i.preset.unwrap().recommended !== true)
    return { value: stored, powerExceeded: false }
  const p = i.preset.unwrap()
  const values: Record<string, number> = {}
  for (const f of ['spindleSpeed', 'feedRate', 'plungeRate', 'stepdown'] as const)
    storedValue(p, f).map((v) => (values[f] = v))
  const stepdown: Option<number> = p.stepdown.isNone() ? fallback('stepdown', i) : None
  const stepover = storedValue(p, 'stepover').orElse(() => fallback('stepover', i))
  const a = adaptPreset(
    values as PresetValues,
    {
      tool: i.tool,
      materialClass: i.materialClass,
      engagement,
      ...(stepdown.isSome() ? { stepdown: stepdown.unwrap() } : {}),
      ...(stepover.isSome() ? { stepover: stepover.unwrap() } : {}),
    },
    i.machine.unwrap(),
    i.units ?? 'mm',
    ...(data === undefined ? [] : [data]),
  )
  return {
    powerExceeded: a.powerExceeded,
    value: (field) => {
      if (field === 'stepover') return stored(field)
      const v = a.values[field]
      if (v === undefined) return None
      const adapted = a.adapted[field]
      return Some({ ...given(v, 'preset', field), ...(adapted === undefined ? {} : { adapted }) })
    },
  }
}

/** The calculator's engagement: the strategy's (facing: its stepover, never an entered one). */
function engagementOf(
  i: Pick<FeedsInput, 'kind' | 'tool' | 'helixPitch' | 'chamferDepth' | 'chamferPlunge'>,
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
        : {
            kind: 'chamfer',
            depth: i.chamferDepth ?? 0,
            ...(i.chamferPlunge === undefined ? {} : { plunge: i.chamferPlunge }),
          }
    case 'line':
      // engraved-patterns.md § Toolpath: a V-bit by F10 at the deepest point, a tapered ball by F11
      // there (tapered-ball-nose.md § Feeds and speeds), else a full slot
      return i.tool.type === 'chamferMill'
        ? { kind: 'chamfer', depth: i.chamferDepth ?? 0 }
        : i.tool.type === 'taperedBallEndMill'
          ? { kind: 'taper', depth: i.chamferDepth ?? 0 }
          : { kind: 'slot' }
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
  const applicable =
    i.kind === 'drilling' || i.kind === 'chamfer' ? DRILLING : i.kind === 'line' ? LINE : MILLING
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

  let presetPowerExceeded = false
  if (auto !== 'on') {
    const preset = presetUse(i, engagement, data)
    presetPowerExceeded = preset.powerExceeded
    fields = perField((f) =>
      applicable.includes(f) ? or(entered(f), () => or(preset.value(f), () => strategy(f))) : None,
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
  let finish: Option<FinishingFeed> = None
  if (noData.isNone() && value('spindleSpeed').isSome() && value('feedRate').isSome()) {
    const ap = value('stepdown')
    const ae = value('stepover')
    const vp = value('plungeRate')
    const values = {
      n: value('spindleSpeed').unwrap(),
      vf: value('feedRate').unwrap(),
      ...(ap.isSome() ? { ap: ap.unwrap() } : {}),
      ...(ae.isSome() ? { ae: ae.unwrap() } : {}),
      // a plunged chamfer cuts at the plunge rate (F12, DF141)
      ...(vp.isSome() ? { vp: vp.unwrap() } : {}),
    }
    const checked =
      data === undefined ? checkCutting(base, values) : checkCutting(base, values, data)
    // DF139: an adapted recommended preset's own values still above the budget at the chip-load
    // floor; an entered value warns as before
    const ownValues = !applicable.some((f) =>
      fields[f].mapOr(false, (v) => v.source === 'override'),
    )
    warnings.push(
      ...(presetPowerExceeded && ownValues ? checked.map(adaptedPowerWarning) : checked),
    )
    used = data === undefined ? cuttingAt(base, values) : cuttingAt(base, values, data)
    // DF74: the finishing pass's own feed, and whether the feed limit makes it rub
    const allowance = i.finishAllowance ?? 0
    if (allowance > 0) {
      const finishAp = i.finishStepdown ?? values.ap ?? i.tool.fluteLength.canonical
      finish =
        data === undefined
          ? finishingAt(base, values, allowance, finishAp)
          : finishingAt(base, values, allowance, finishAp, data)
      finish.map((f) => {
        if (f.clamped && f.fz < FINISH_RUBBING_FRACTION * f.minimum * (1 - 1e-9))
          warnings.push(finishRubbing(f, values.n, i.tool, i.machine))
      })
    }
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
    finish,
    warnings,
  }
}

/**
 * The finishing pass warns below this share of the data minimum (DF74): a light finishing cut
 * between it and the minimum is left alone, the research case (0.055 of 0.127 mm) is below it.
 * Doc: docs/architecture/feeds-speeds.md#finishing-pass-feed-hardening-df74
 */
export const FINISH_RUBBING_FRACTION = 0.5

/** A number for a message: at most `digits` decimals, trailing zeros dropped. */
const num = (v: number, digits: number): string => String(Number(v.toFixed(digits)))

/**
 * `feeds.rubbing` rule `finishRubbing` (DF74): the machine's feed limit holds the finishing feed
 * below the one that keeps the chip load, and the finishing chip falls below the data minimum.
 * The message names the fixes that work at the values used: a larger allowance, a lower locked
 * spindle speed, fewer flutes at this speed.
 * Doc: docs/architecture/feeds-speeds.md#finishing-pass-feed-hardening-df74
 */
function finishRubbing(
  f: FinishingFeed,
  n: number,
  tool: Tool,
  machine: Option<MachineLimits>,
): FeedWarning {
  const D = tool.diameter.canonical
  const z = tool.fluteCount.canonical
  const maxFeed = f.feedRate
  const params: Record<string, number> = {
    chipLoad: f.fz,
    minimum: f.minimum,
    finishAllowance: f.allowance,
    finishFeedRate: f.feedRate,
    maxFeedRate: maxFeed,
  }
  const fixes: string[] = []
  // F3 inverted: the radial engagement whose thinning still leaves the minimum at this feed
  const k = maxFeed / (n * z * f.minimum)
  if (k > 1) {
    const a = Math.ceil(((D * (1 - Math.sqrt(1 - 1 / (k * k)))) / 2) * 10) / 10
    if (a < D / 2) {
      params['allowanceForMinimum'] = a
      fixes.push(`a finishing allowance of at least ${num(a, 1)} mm`)
    }
  }
  const nMin = Math.floor(maxFeed / (z * f.chipThinning * f.minimum) / 10) * 10
  if (nMin >= machine.mapOr(0, (m) => m.minSpeed) && nMin > 0) {
    params['spindleSpeedForMinimum'] = nMin
    fixes.push(`a spindle speed of at most ${nMin} rpm`)
  }
  const zMax = Math.floor((z * f.fz) / f.minimum + 1e-9)
  if (zMax >= 1 && zMax < z) {
    params['flutesForMinimum'] = zMax
    fixes.push(`a tool with ${zMax} ${zMax === 1 ? 'flute' : 'flutes'} at this spindle speed`)
  }
  const list =
    fixes.length <= 1
      ? (fixes[0] ?? '')
      : `${fixes.slice(0, -1).join(', ')} or ${fixes[fixes.length - 1]!}`
  const fix =
    list.length > 0
      ? ` ${list[0]!.toUpperCase()}${list.slice(1)} makes a real chip.`
      : ' No setting of this tool on this machine makes a real chip.'
  return {
    code: 'feeds.rubbing',
    rule: 'finishRubbing',
    severity: 'warning',
    field: 'spindleSpeed',
    message:
      `Finishing pass rubs: radial chip thinning at the ${num(f.allowance, 3)} mm finishing ` +
      `allowance leaves ${num(f.fz, 3)} mm chips, under the ${num(f.minimum, 3)} mm minimum, and ` +
      `the machine's ${num(maxFeed, 0)} mm/min feed limit (X/Y) stops a faster finishing feed.` +
      fix,
    params,
  }
}

/**
 * DF139: `feeds.powerExceeded` on an adapted recommended preset: the adaptation already lowered
 * the stepdown and the feed as far as they go, so the fix is another tool or a shallower cut.
 */
function adaptedPowerWarning<W extends FeedWarning>(w: W): W {
  if (w.code !== 'feeds.powerExceeded') return w
  const share = w.params['loadLimit']
  const spindle =
    typeof share === 'number' && share < 1
      ? `${Math.round(share * 100)} % of the spindle's power`
      : 'the spindle'
  return {
    ...w,
    message: `Cutting power exceeds ${spindle} even with the preset adapted: use a smaller tool or a shallower cut.`,
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
    message: `${FEED_FIELD_LABEL[field]} lock is inactive: ${reason}`,
    params: { ...params, reason: rule },
    field,
    rule,
  }
}
