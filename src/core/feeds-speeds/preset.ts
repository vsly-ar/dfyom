/**
 * Recommended cutting presets: a preset with `recommended: true` follows the calculator for its
 * tool and material class, for no particular machine (full-width slot for end mills, drilling for
 * drills, the full cone for chamfer mills; lowest rigidity, no spindle or feed clamp). In a plan,
 * `adaptPreset` lowers those values to the plan machine (hardening DF139).
 * Docs: docs/architecture/library.md#recommended-presets,
 * docs/architecture/feeds-speeds.md#recommended-presets-on-the-plan-machine-hardening-df139
 */
import type { Issue } from '../../shared/errors/app-error'
import { Err, None, Ok, Some, type Result } from '../../shared/result'
import type { MaterialClass } from '../library/item'
import { Tool } from '../library/tool'
import type { CuttingPresetDTO, ToolValuesDTO } from '../library/tool.dto'
import { libraryUnit } from '../library/values-input'
import type { UnitSystem } from '../project/document'
import { Quantity } from '../quantity/quantity'
import type { QuantityDTO } from '../quantity/quantity.dto'
import type { QuantityKind } from '../quantity/units'
import type { MaterialRow } from './data'
import { chamferFullDepth } from './formulas'
import {
  CHECK_EPS,
  checkModel,
  noDataFor,
  suggestCutting,
  type CuttingInput,
  type Engagement,
  type MachineLimits,
} from './suggest'

/** The values a recommended preset follows, canonical (rpm, mm/min, mm); absent = not suggested. */
export interface PresetValues {
  readonly spindleSpeed?: number
  readonly feedRate?: number
  readonly plungeRate?: number
  readonly stepdown?: number
}

export const FOLLOWED_FIELDS = ['spindleSpeed', 'feedRate', 'plungeRate', 'stepdown'] as const
export type FollowedField = (typeof FOLLOWED_FIELDS)[number]

/**
 * A preset's engagement: drilling for a drill, the full cone (De = DC) for a chamfer mill, a 1 mm
 * deep Line for a tapered ball end mill, else a full-width slot.
 */
function presetEngagement(tool: Tool): Engagement {
  if (tool.type === 'drill') return { kind: 'drill' }
  if (tool.type === 'chamferMill') {
    const angle = tool.angle.mapOr(90, (q) => q.canonical)
    return {
      kind: 'chamfer',
      depth: chamferFullDepth(tool.tipDiameterMm, angle, tool.diameter.canonical),
    }
  }
  // a tapered ball at a typical carving depth, not the full cone (tapered-ball-nose.md § Feeds)
  if (tool.type === 'taperedBallEndMill') return { kind: 'taper', depth: PRESET_TAPER_DEPTH }
  return { kind: 'slot' }
}

/** A tapered ball end mill's recommended preset is for a Line this deep (mm). */
export const PRESET_TAPER_DEPTH = 1

/** The recommendation for `tool` in `materialClass`, or the calculator's reason it has none. */
export function presetRecommendation(
  tool: Tool,
  materialClass: MaterialClass,
  data?: readonly MaterialRow[],
): Result<PresetValues, string> {
  const input: CuttingInput = {
    tool,
    materialClass,
    engagement: presetEngagement(tool),
    machine: None,
  }
  const noData = data === undefined ? noDataFor(input) : noDataFor(input, data)
  if (noData.isSome()) return Err(noData.unwrap().message)
  const s = data === undefined ? suggestCutting(input) : suggestCutting(input, data)
  const out: Record<string, number> = {}
  for (const f of FOLLOWED_FIELDS) {
    const v = s[f]
    if (v.isSome()) out[f] = v.unwrap().value
  }
  return Ok(out)
}

const KIND: Record<FollowedField, QuantityKind> = {
  spindleSpeed: 'spindleSpeed',
  feedRate: 'feedRate',
  plungeRate: 'feedRate',
  stepdown: 'length',
}

/** A rounded value as a quantity DTO in the unit system's unit (whole rpm; mm or inch steps). */
function rounded(field: FollowedField, canonical: number, units: UnitSystem): QuantityDTO {
  const kind = KIND[field]
  const unit = libraryUnit(kind, units)
  const inch = units === 'inch'
  let text: string
  if (kind === 'spindleSpeed') text = String(Math.round(canonical))
  else if (kind === 'feedRate')
    text = inch ? String(Math.round((canonical / 25.4) * 10) / 10) : String(Math.round(canonical))
  else
    text = inch
      ? String(Math.round((canonical / 25.4) * 1000) / 1000)
      : String(Math.round(canonical * 100) / 100)
  return Quantity.parse(`${text} ${unit}`, { kind, defaultUnit: unit }).ok().unwrap().toDTO()
}

/**
 * `values` with every recommended preset's followed fields set to the recommendation, and the
 * issues of recommended presets the calculator has no data for (`noRecommendation`, paths below
 * the values). Values whose tool does not load, and presets without a class (a model issue), are
 * left alone. Returns `values` itself when nothing changes.
 */
export function followRecommended<V extends Pick<ToolValuesDTO, 'presets'>>(
  values: V,
  units: UnitSystem,
  data?: readonly MaterialRow[],
): { values: V; issues: Issue[] } {
  const issues: Issue[] = []
  if (!values.presets.some((p) => p.recommended === true)) return { values, issues }
  const tool = Tool.fromDTO({ ...(values as unknown as ToolValuesDTO), presets: [] })
  if (tool.isErr()) return { values, issues }
  let changed = false
  const presets = values.presets.map((p, i): CuttingPresetDTO => {
    if (p.recommended !== true || p.materialClass === undefined) return p
    const rec = presetRecommendation(tool.unwrap(), p.materialClass, data)
    if (rec.isErr()) {
      issues.push({
        path: ['presets', i, 'recommended'],
        rule: 'noRecommendation',
        message: rec.unwrapErr(),
      })
      return p
    }
    const r = rec.unwrap()
    let next: CuttingPresetDTO = p
    for (const f of FOLLOWED_FIELDS) {
      const v = r[f]
      if (v === undefined) continue
      const q = rounded(f, v, units)
      const old = p[f]
      if (old !== undefined && old.exact.num === q.exact.num && old.exact.den === q.exact.den)
        continue
      next = { ...next, [f]: q } as CuttingPresetDTO
      changed = true
    }
    return next
  })
  return { values: changed ? { ...values, presets } : values, issues }
}

/** Why plan mode lowered a recommended preset's value (DF139). */
export type AdaptReason = 'spindleRange' | 'maxFeedRate' | 'maxFeedRateZ' | 'power'

/** One adapted field: the stored value (canonical) and the step that set the new one. */
export interface AdaptedField {
  readonly from: number
  readonly reason: AdaptReason
}

export interface AdaptedPreset {
  /** The values to use (canonical); fields the preset does not have stay absent. */
  readonly values: PresetValues
  /** Fields whose value changed; the last step that changed a field gives its reason. */
  readonly adapted: Readonly<Partial<Record<FollowedField, AdaptedField>>>
  /** Power still above the budget with the feed at the chip-load floor (a real warning). */
  readonly powerExceeded: boolean
}

/**
 * The operation a recommended preset is adapted for: the plan's tool, the stock's class, the
 * strategy's engagement, and the axial and radial engagement the operation uses where the preset
 * has none (`stepdown`: the strategy's fallback; `stepover`: the preset's or the strategy's).
 */
export interface AdaptInput {
  readonly tool: Tool
  readonly materialClass: MaterialClass
  readonly engagement: Engagement
  readonly stepdown?: number
  readonly stepover?: number
}

/** Preset rounding steps in canonical units (library.md#recommended-presets). */
const STEPS: Record<UnitSystem, { readonly feed: number; readonly length: number }> = {
  mm: { feed: 1, length: 0.01 },
  inch: { feed: 2.54, length: 0.0254 },
}

/** Rounded down to a multiple of `step` (a value already on the grid stays). */
const floorTo = (v: number, step: number): number => Math.floor(v / step + 1e-9) * step
const ceilTo = (v: number, step: number): number => Math.ceil(v / step - 1e-9) * step

/** Power fit iterations (as the calculator's). */
const FIT_ITERATIONS = 30

/**
 * A recommended preset's values adapted down to the plan machine
 * (docs/architecture/feeds-speeds.md#recommended-presets-on-the-plan-machine-hardening-df139):
 * spindle range (above the maximum the feed follows, keeping the chip load), X/Y max feed (the
 * speed follows, not below the minimum), Z max plunge, then the power budget (the stepdown first,
 * then the feed at the kept speed down to the data's minimum chip load), rounded down to the
 * preset rounding. Only lowers values; the speed may only rise into the spindle range. Values are
 * judged by the final-value check's model (`checkModel`), so an adapted preset trips none of the
 * checks it adapts for. Pure and total.
 */
export function adaptPreset(
  values: PresetValues,
  input: AdaptInput,
  machine: MachineLimits,
  units: UnitSystem = 'mm',
  data?: readonly MaterialRow[],
): AdaptedPreset {
  const step = STEPS[units]
  const reasons: Partial<Record<FollowedField, AdaptReason>> = {}
  const isDrill = input.engagement.kind === 'drill'
  const minN = machine.minSpeed
  const maxN = machine.maxSpeed
  let n = values.spindleSpeed
  let vf = values.feedRate
  let pr = values.plungeRate
  let ap = values.stepdown

  // n and vf scaled together by `k` (the chip load stays): the feed rounds down and the speed
  // follows the rounded feed, rounded down, so the chip never gets thinner than the stored one
  const scaleBoth = (k: number, reason: AdaptReason) => {
    if (n === undefined) return
    if (vf === undefined) {
      n = Math.floor(n * k + 1e-9)
      reasons.spindleSpeed = reason
      return
    }
    const vfR = floorTo(vf * k, step.feed)
    const nR = Math.max(Math.floor((n * vfR) / vf + 1e-9), Math.ceil(minN - 1e-9))
    if (vfR < vf) reasons.feedRate = reason
    if (nR !== n) reasons.spindleSpeed = reason
    vf = vfR
    n = nR
  }

  // 1. spindle range: above the maximum the feed follows; below the minimum it stays
  if (n !== undefined && n > maxN) scaleBoth(maxN / n, 'spindleRange')
  else if (n !== undefined && n < minN) {
    n = Math.ceil(minN - 1e-9)
    reasons.spindleSpeed = 'spindleRange'
  }
  // 2. X/Y max feed (a drill feeds along Z: also the Z max), the speed follows down to the minimum
  const maxFeed = isDrill ? Math.min(machine.maxFeedXY, machine.maxFeedZ) : machine.maxFeedXY
  if (vf !== undefined && vf > maxFeed) {
    const reason: AdaptReason =
      isDrill && machine.maxFeedZ < machine.maxFeedXY ? 'maxFeedRateZ' : 'maxFeedRate'
    if (n === undefined) {
      vf = floorTo(maxFeed, step.feed)
      reasons.feedRate = reason
    } else scaleBoth(maxFeed / vf, reason)
  }
  // 3. Z max plunge; nothing depends on the plunge rate
  if (pr !== undefined && pr > machine.maxFeedZ) {
    pr = floorTo(machine.maxFeedZ, step.feed)
    reasons.plungeRate = 'maxFeedRateZ'
  }

  // 4. power: the stepdown first, then the feed at the kept speed down to the minimum chip load
  let powerExceeded = false
  const model = checkModel(
    {
      tool: input.tool,
      materialClass: input.materialClass,
      engagement: input.engagement,
      machine: Some(machine),
    },
    ...(data === undefined ? [] : [data]),
  )
  if (model.isSome() && n !== undefined && vf !== undefined && n > 0 && vf > 0) {
    const m = model.unwrap()
    const at = (a: number | undefined, feed: number) => {
      const apUsed = a ?? input.stepdown
      return {
        n: n!,
        vf: feed,
        ...(apUsed === undefined ? {} : { ap: apUsed }),
        ...(input.stepover === undefined ? {} : { ae: input.stepover }),
      }
    }
    const over = (a: number | undefined, feed: number): boolean =>
      m.power(at(a, feed)).mapOr(false, (p) => p.pc > p.budget * (1 + CHECK_EPS))
    if (over(ap, vf) && m.fixedAp === undefined && ap !== undefined) {
      let a = ap
      for (let i = 0; i < FIT_ITERATIONS && over(a, vf); i++) {
        const p = m.power(at(a, vf)).unwrap()
        a = a * (p.budget / p.pc) * 0.999
      }
      const fitted = floorTo(a, step.length)
      const next = fitted >= step.length ? fitted : Math.min(step.length, ap)
      if (next < ap) {
        ap = next
        reasons.stepdown = 'power'
      }
    }
    if (over(ap, vf)) {
      const z = input.tool.fluteCount.canonical
      const floor = Math.min(vf, n * z * m.chipThinning(at(ap, vf)) * m.range.min)
      let v = vf
      for (let i = 0; i < FIT_ITERATIONS && v > floor && over(ap, v); i++) {
        const p = m.power(at(ap, v)).unwrap()
        v = Math.max(floor, v * (p.budget / p.pc) * 0.999)
      }
      let rounded = floorTo(v, step.feed)
      // never below the floor by rounding (the chip would rub), never above the stored feed
      if (rounded < floor * (1 - 1e-9)) rounded = Math.min(vf, ceilTo(floor, step.feed))
      if (rounded < vf) {
        vf = rounded
        reasons.feedRate = 'power'
      }
      powerExceeded = over(ap, vf)
    }
  }

  const out: Record<string, number> = {}
  const adapted: Partial<Record<FollowedField, AdaptedField>> = {}
  const final: PresetValues = {
    ...(n === undefined ? {} : { spindleSpeed: n }),
    ...(vf === undefined ? {} : { feedRate: vf }),
    ...(pr === undefined ? {} : { plungeRate: pr }),
    ...(ap === undefined ? {} : { stepdown: ap }),
  }
  for (const f of FOLLOWED_FIELDS) {
    const v = final[f]
    if (v === undefined) continue
    out[f] = v
    const from = values[f]
    const reason = reasons[f]
    if (from !== undefined && reason !== undefined && Math.abs(v - from) > 1e-9 * Math.max(1, from))
      adapted[f] = { from, reason }
    else if (from !== undefined) out[f] = from
  }
  return { values: out, adapted, powerExceeded }
}
