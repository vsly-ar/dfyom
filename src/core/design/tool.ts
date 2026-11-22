/**
 * The operation's tool field as a model: a generalized tool (type + diameter, no lengths) or a
 * specific library tool held as a tool snapshot of the project; its validation, labels and the
 * standard size series of the auto choice.
 * Doc: docs/modes/design-v0.2.md#operation-tool (data model, standard sizes),
 * docs/modes/design-v0.4.md#chamfer-mill-tool-type (the generalized chamfer mill)
 */
import type { Issue } from '../../shared/errors/app-error'
import { fail, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import { quantityFromDTO } from '../library/item'
import type { Tool } from '../library/tool'
import { CHAMFER_MILL_ANGLE, type ToolType } from '../library/tool.dto'
import { Quantity } from '../quantity/quantity'
import type { UnitSystem } from '../project/document'
import { Rational } from '../quantity/rational'
import type { DesignToolDTO } from './part.dto'

export interface GeneralizedTool {
  readonly kind: 'generalized'
  readonly type: ToolType
  readonly diameter: Quantity
  /** RE: bull nose only, 0 < RE < DC/2. */
  readonly cornerRadius: Option<Quantity>
  /** Included angle: chamfer mill only (required), 30°–150°; a generalized one is pointed. */
  readonly angle: Option<Quantity>
}

export type DesignTool =
  GeneralizedTool | { readonly kind: 'specific'; readonly snapshotId: string }

/** Display names of the tool types (labels, messages). */
export const TOOL_TYPE_LABEL: Record<ToolType, string> = {
  flatEndMill: 'flat end mill',
  bullNoseEndMill: 'bull-nose end mill',
  ballEndMill: 'ball end mill',
  drill: 'drill',
  chamferMill: 'chamfer mill',
}

/** Issues of a generalized tool's values (paths relative to the tool); none = valid. */
export function generalizedToolIssues(t: GeneralizedTool): Issue[] {
  const issues: Issue[] = []
  const dc = t.diameter.exact
  if (t.diameter.kind !== 'length' || dc.compare(Rational.ZERO) <= 0)
    issues.push({ path: ['diameter'], rule: 'positive', message: 'must be a length > 0' })
  if (t.type === 'bullNoseEndMill') {
    if (t.cornerRadius.isNone())
      issues.push({
        path: ['cornerRadius'],
        rule: 'required',
        message: 'is required for a bull nose',
      })
    else {
      const re = t.cornerRadius.unwrap()
      const half = dc.toNumber() / 2
      if (re.kind !== 'length' || re.canonical <= 0 || re.canonical >= half)
        issues.push({
          path: ['cornerRadius'],
          rule: 'range',
          message: 'must be > 0 and < diameter / 2',
          params: { max: half },
        })
    }
  } else if (t.cornerRadius.isSome())
    issues.push({
      path: ['cornerRadius'],
      rule: 'notAllowed',
      message: 'is only stored for a bull nose',
    })
  if (t.type === 'chamferMill') {
    const { min, max } = CHAMFER_MILL_ANGLE
    const a = t.angle
    if (a.isNone())
      issues.push({ path: ['angle'], rule: 'required', message: 'is required for a chamfer mill' })
    else if (
      a.unwrap().kind !== 'angle' ||
      a.unwrap().canonical < min ||
      a.unwrap().canonical > max
    )
      issues.push({
        path: ['angle'],
        rule: 'range',
        message: `must be an angle between ${min}° and ${max}°`,
        params: { min, max },
      })
  } else if (t.angle.isSome())
    issues.push({
      path: ['angle'],
      rule: 'notAllowed',
      message: 'is only stored for a chamfer mill',
    })
  return issues
}

/** A valid generalized tool, or `model.invariant` with one issue per field. */
export function checkGeneralizedTool(t: GeneralizedTool): AppResult<GeneralizedTool> {
  const issues = generalizedToolIssues(t)
  if (issues.length === 0) return Ok(t)
  return fail('model.invariant', `invalid generalized tool: ${issues[0]!.message}`, { issues })
}

export function designToolFromDTO(dto: DesignToolDTO): AppResult<DesignTool> {
  if (dto.kind === 'specific') return Ok({ kind: 'specific', snapshotId: dto.snapshotId })
  const diameter = quantityFromDTO(dto.diameter, 'diameter')
  if (diameter.isErr()) return diameter
  const re =
    dto.cornerRadius === undefined
      ? Ok<Option<Quantity>>(None)
      : quantityFromDTO(dto.cornerRadius, 'cornerRadius').map((q): Option<Quantity> => Some(q))
  if (re.isErr()) return re
  const angle =
    dto.angle === undefined
      ? Ok<Option<Quantity>>(None)
      : quantityFromDTO(dto.angle, 'angle').map((q): Option<Quantity> => Some(q))
  if (angle.isErr()) return angle
  return checkGeneralizedTool({
    kind: 'generalized',
    type: dto.type,
    diameter: diameter.unwrap(),
    cornerRadius: re.unwrap(),
    angle: angle.unwrap(),
  })
}

export function designToolToDTO(t: DesignTool): DesignToolDTO {
  if (t.kind === 'specific') return { kind: 'specific', snapshotId: t.snapshotId }
  return {
    kind: 'generalized',
    type: t.type,
    diameter: t.diameter.toDTO(),
    ...(t.cornerRadius.isSome() ? { cornerRadius: t.cornerRadius.unwrap().toDTO() } : {}),
    ...(t.angle.isSome() ? { angle: t.angle.unwrap().toDTO() } : {}),
  } as DesignToolDTO
}

/** "1/4" flat end mill", "6 mm bull-nose end mill R1 mm", "90° chamfer mill Ø12 mm". */
export function generalizedLabel(t: GeneralizedTool): string {
  if (t.type === 'chamferMill') {
    const angle = t.angle.mapOr('', (a) => `${degrees(a)} `)
    return `${angle}${TOOL_TYPE_LABEL[t.type]} Ø${withUnit(t.diameter)}`
  }
  const re = t.cornerRadius.isSome() ? ` R${withUnit(t.cornerRadius.unwrap())}` : ''
  return `${withUnit(t.diameter)} ${TOOL_TYPE_LABEL[t.type]}${re}`
}

/** An angle as whole or decimal degrees: `90°`, `82.5°`. */
const degrees = (a: Quantity): string => `${Number(a.canonical.toFixed(2))}°`

/** A length's source with its unit: a bare `6` reads "6 mm" (or `6"` in an inch project). */
function withUnit(q: Quantity): string {
  if (!/^[\d.\s/]+$/.test(q.source)) return q.source
  return q.defaultUnit === 'in' ? `${q.source.trim()}"` : `${q.source.trim()} ${q.defaultUnit}`
}

export function designToolLabel(t: DesignTool, specific: Option<Tool>): string {
  if (t.kind === 'generalized') return generalizedLabel(t)
  return specific.mapOr(`tool snapshot ${t.snapshotId}`, (tool) => tool.name)
}

/**
 * Standard sizes of generalized tools per unit system (design-v0.2.md § Standard sizes), as
 * entered; a constant in v0.2 (a setting later). A generalized drill takes the hole's diameter.
 */
export const STANDARD_SIZES: Record<UnitSystem, readonly string[]> = {
  mm: ['1 mm', '1.5 mm', '2 mm', '3 mm', '4 mm', '5 mm', '6 mm', '8 mm', '10 mm', '12 mm'],
  inch: ['1/32"', '1/16"', '1/8"', '3/16"', '1/4"', '5/16"', '3/8"', '1/2"'],
}

/**
 * Standard sizes of generalized chamfer mills (design-v0.4.md § Chamfer mill tool type): 90°,
 * Ø6/12 mm or Ø1/4″/1/2″, as entered. For the chamfer operation's auto choice (task C2).
 */
export const CHAMFER_MILL_STANDARD = {
  angle: '90 deg',
  sizes: { mm: ['6 mm', '12 mm'], inch: ['1/4"', '1/2"'] },
} as const satisfies { angle: string; sizes: Record<UnitSystem, readonly string[]> }

/** A length as a plain quantity (no tolerance) for a generalized tool: `6 mm`, `0.25"`. */
export function plainLength(mm: Rational, units: UnitSystem): Quantity {
  const n = mm.toNumber()
  const source =
    units === 'inch' ? `${Number((n / 25.4).toFixed(4))}"` : `${Number(n.toFixed(4))} mm`
  return Quantity.create({
    kind: 'length',
    source,
    defaultUnit: units === 'inch' ? 'in' : 'mm',
    exact: mm,
    tolerance: None,
  }).unwrap()
}
