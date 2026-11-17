/**
 * Feeds and speeds of one plan operation: strategy → engagement, the resolution order
 * override → tool preset → calculator → strategy fallback, and the `source` of every field.
 * Docs: docs/modes/plan-v0.1.md#feeds-and-speeds,
 * docs/architecture/feeds-speeds.md#engagement-per-strategy
 *
 * Total and pure: a field nothing resolves is `None` (a `plan.check` issue in checks.ts).
 * Values are float64 in canonical units (rpm, mm/min, mm).
 */
import { None, Some, type Option } from '../../shared/result'
import type { OperationKind } from '../design/part.dto'
import type { MaterialClass } from '../library/item'
import type { CuttingPreset, Tool } from '../library/tool'
import type { Quantity } from '../quantity/quantity'
import {
  suggestCutting,
  type CuttingSuggestion,
  type CuttingWarning,
  type DerivationStep,
  type Engagement,
  type MachineLimits,
} from '../feeds-speeds/suggest'
import type { MaterialRow } from '../feeds-speeds/data'
import type { FeedField } from './plan.dto'

export type FeedSource = 'override' | 'preset' | 'calculator' | 'strategy'

export interface ResolvedFeed {
  readonly value: number
  readonly unit: 'rpm' | 'mm/min' | 'mm'
  readonly source: FeedSource
  /** The calculator's explanation (`calculator` only). */
  readonly derivation?: readonly DerivationStep[]
}

export type Overrides = Readonly<Partial<Record<FeedField, Quantity>>>

export interface FeedsInput {
  readonly kind: OperationKind
  readonly tool: Tool
  readonly preset: Option<CuttingPreset>
  readonly overrides: Overrides
  readonly materialClass: MaterialClass
  readonly machine: Option<MachineLimits>
  /** Facing: the facing depth (mm), the fallback stepdown. */
  readonly facingDepth?: number
  /** Drilling with an end mill (helix): the resolved helix pitch (mm). */
  readonly helixPitch?: number
}

export interface ResolvedFeeds {
  /** Fields that apply to the operation kind (drilling: no stepdown/stepover). */
  readonly applicable: readonly FeedField[]
  readonly fields: Readonly<Record<FeedField, Option<ResolvedFeed>>>
  readonly engagement: Engagement
  /** Derived, never stored: feed ÷ (rpm × flutes), mm. */
  readonly chipLoad: Option<number>
  /** The calculator's warnings (they join `plan.warning.list`). */
  readonly warnings: readonly CuttingWarning[]
}

const UNIT: Record<FeedField, ResolvedFeed['unit']> = {
  spindleSpeed: 'rpm',
  feedRate: 'mm/min',
  plungeRate: 'mm/min',
  stepdown: 'mm',
  stepover: 'mm',
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
function fallback(field: 'stepdown' | 'stepover', i: FeedsInput): Option<number> {
  const D = i.tool.diameter.canonical
  if (i.kind === 'drilling') return None
  if (field === 'stepover') return Some((i.kind === 'facing' ? 0.75 : 0.4) * D)
  if (i.kind === 'facing') return i.facingDepth === undefined ? None : Some(i.facingDepth)
  return Some(0.25 * D)
}

const given = (value: number, source: FeedSource, field: FeedField): ResolvedFeed => ({
  value,
  unit: UNIT[field],
  source,
})

/** Override, then preset (no calculator, no fallback). */
function userValue(i: FeedsInput, field: FeedField): Option<ResolvedFeed> {
  const o = i.overrides[field]
  if (o !== undefined) return Some(given(o.canonical, 'override', field))
  return i.preset
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

/** The engagement the calculator sees, from the strategy and the user-resolved engagement. */
function engagementOf(
  i: FeedsInput,
  stepdown: Option<ResolvedFeed>,
  stepover: number | undefined,
): Engagement {
  const ap = stepdown.isSome() ? { ap: stepdown.unwrap().value } : {}
  switch (i.kind) {
    case 'facing':
      return { kind: 'stepover', ae: stepover ?? 0.75 * i.tool.diameter.canonical, ...ap }
    case 'pocket':
    case 'profile':
      return { kind: 'slot', ...ap }
    case 'drilling':
      return i.tool.type === 'drill'
        ? { kind: 'drill' }
        : { kind: 'helix', ap: i.helixPitch ?? 0.25 * i.tool.diameter.canonical }
  }
}

/**
 * Resolves every field: `stepdown`/`stepover` first (override → preset → calculator → fallback),
 * then the calculator runs for the resolved engagement, then speeds and feeds (override →
 * preset → calculator). `data` is the material table (tests may pass a fixture).
 */
export function resolveFeeds(i: FeedsInput, data?: readonly MaterialRow[]): ResolvedFeeds {
  const applicable = i.kind === 'drilling' ? DRILLING : MILLING
  const milling = i.kind !== 'drilling'
  const userStepdown: Option<ResolvedFeed> = milling ? userValue(i, 'stepdown') : None
  const userStepover: Option<ResolvedFeed> = milling ? userValue(i, 'stepover') : None
  // The calculator never suggests a stepover (v0.1): the fallback joins right away.
  const stepover: Option<ResolvedFeed> = userStepover.isSome()
    ? userStepover
    : fallback('stepover', i).map((v) => given(v, 'strategy', 'stepover'))
  const engagement = engagementOf(i, userStepdown, stepover.map((s) => s.value).unwrapOr(0))
  const s: CuttingSuggestion = suggestCutting(
    { tool: i.tool, materialClass: i.materialClass, engagement, machine: i.machine },
    data,
  )
  const calc = (field: FeedField): Option<ResolvedFeed> =>
    s[field].map((v) => ({
      value: v.value,
      unit: UNIT[field],
      source: 'calculator',
      derivation: v.derivation,
    }))
  const or = (a: Option<ResolvedFeed>, b: () => Option<ResolvedFeed>) => (a.isSome() ? a : b())
  const stepdown: Option<ResolvedFeed> = !milling
    ? None
    : or(userStepdown, () =>
        or(calc('stepdown'), () =>
          fallback('stepdown', i).map((v) => given(v, 'strategy', 'stepdown')),
        ),
      )
  const speed = (field: 'spindleSpeed' | 'feedRate' | 'plungeRate') =>
    or(userValue(i, field), () => calc(field))
  const fields: Record<FeedField, Option<ResolvedFeed>> = {
    spindleSpeed: speed('spindleSpeed'),
    feedRate: speed('feedRate'),
    plungeRate: speed('plungeRate'),
    stepdown,
    stepover: milling ? stepover : None,
  }
  const flutes = i.tool.fluteCount.canonical
  const chipLoad =
    fields.spindleSpeed.isSome() && fields.feedRate.isSome() && flutes > 0
      ? Some(fields.feedRate.unwrap().value / (fields.spindleSpeed.unwrap().value * flutes))
      : None
  // The calculator's warnings matter only when it supplies a value or explains a missing one.
  const used = applicable.some((f) => fields[f].mapOr(true, (v) => v.source === 'calculator'))
  return { applicable, fields, engagement, chipLoad, warnings: used ? s.warnings : [] }
}
