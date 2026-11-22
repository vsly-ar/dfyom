/**
 * Recommended cutting presets: a preset with `recommended: true` follows the calculator for its
 * tool and material class, for no particular machine (full-width slot for end mills, drilling for
 * drills, the full cone for chamfer mills; lowest rigidity, no spindle or feed clamp).
 * Doc: docs/architecture/library.md#recommended-presets
 */
import type { Issue } from '../../shared/errors/app-error'
import { Err, None, Ok, type Result } from '../../shared/result'
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
import { noDataFor, suggestCutting, type CuttingInput, type Engagement } from './suggest'

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
 * A preset's engagement: drilling for a drill, the full cone (De = DC) for a chamfer mill, else a
 * full-width slot.
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
  return { kind: 'slot' }
}

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
