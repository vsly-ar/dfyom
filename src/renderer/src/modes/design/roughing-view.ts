// Roughing passes in the Design UI (hardening DF122, slice R2): what the Roughing accordion, the
// roughing pocket's short inspector and the navigator's roughing row show – the roughing tool's
// diameter, the stock to leave with its defaults ("Auto · 0.5 mm": the finishing allowance), the
// closed accordion's summary, and the `roughing` arg a margin edit sends (an object replaces both
// margins, so the other one's source goes along).
// Doc: docs/modes/roughing.md#ui, docs/modes/roughing.md#implementation-r2
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import type { OperationDTO } from '../../../../core/design/part.dto'
import { defaultFinishAllowance } from '../../../../core/plan/strategy'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import { designMessages } from '../../messages/design'
import { lengthSource } from '../../messages/dfm'
import { quantityOf, type DesignPart } from './model'

const r = designMessages.roughing

/** A roughing pass's stock to leave as stored (absent fields: the defaults). */
export interface RoughingMarginsView {
  readonly wall?: QuantityDTO | undefined
  readonly floor?: QuantityDTO | undefined
}

/** A plain pocket's roughing setting (`roughingPass`); undefined = off. */
export function pocketRoughing(op: OperationDTO): RoughingMarginsView | undefined {
  return op.kind === 'pocket' && op.roughing !== true ? op.roughingPass : undefined
}

/** A pattern's roughing setting (`roughing: true | { wall, floor }`); undefined = off. */
export function patternRoughing(feature: FeatureDTO): RoughingMarginsView | undefined {
  const v = feature['roughing']
  if (v === true) return {}
  return v !== null && typeof v === 'object' ? (v as RoughingMarginsView) : undefined
}

/** The roughing pocket of plain pocket `op` (`<id>_roughing`), if roughing is on. */
export function roughingOperationOf(
  part: Pick<DesignPart, 'dto'>,
  op: OperationDTO,
): OperationDTO | undefined {
  return part.dto.operations.find(
    (o) => o.kind === 'pocket' && o.roughing === true && o.roughingOf === op.id,
  )
}

/** The tool's cutting diameter in mm (a generalized tool's, or its library snapshot's). */
export function toolDiameter(
  tool: OperationDTO['tool'],
  doc: DesignPart['doc'],
): number | undefined {
  if (tool === undefined) return undefined
  if (tool.kind === 'generalized') return quantityOf(tool.diameter)?.canonical
  const snap = Object.hasOwn(doc.snapshots, tool.snapshotId)
    ? doc.snapshots[tool.snapshotId]
    : undefined
  const d = (snap?.values as { diameter?: unknown } | undefined)?.diameter
  return d !== null && typeof d === 'object' && 'exact' in d
    ? quantityOf(d as QuantityDTO)?.canonical
    : undefined
}

/** "Ø 8 mm": the roughing pocket's tool, or undefined before the first Apply chose one. */
export function roughingToolText(
  part: Pick<DesignPart, 'doc' | 'units'>,
  op: OperationDTO,
): string | undefined {
  const d = toolDiameter(op.tool, part.doc)
  return d === undefined ? undefined : r.tool(lengthSource(d, part.units))
}

/**
 * The default wall margin in mm: the owner's finishing allowance (0.2 mm, wood 0.5 mm; the plan
 * may set another, which the roughing then follows), from the part's stock material.
 */
export function defaultWall(part: Pick<DesignPart, 'loaded' | 'units'>): number | undefined {
  const stock = part.loaded?.stock
  return stock === undefined ? undefined : defaultFinishAllowance(stock.material.class, part.units)
}

/** The empty Leave on walls field's text: "Auto · 0.5 mm". */
export function wallPlaceholder(part: Pick<DesignPart, 'loaded' | 'units'>): string {
  const d = defaultWall(part)
  return d === undefined ? r.auto : r.autoValue(lengthSource(d, part.units))
}

/** The empty Leave on floor field's text: 0 (a flat end mill cuts the floor to size; the unit shows beside it). */
export const floorPlaceholder = (): string => '0'

/**
 * The closed accordion's summary: "Off", or "Ø 8 mm · walls auto · floor 0" (the margins as
 * entered, "auto" for the default wall).
 */
export function roughingSummary(
  part: Pick<DesignPart, 'doc' | 'units'>,
  margins: RoughingMarginsView | undefined,
  roughingOp: OperationDTO | undefined,
): string {
  if (margins === undefined) return r.off
  const tool = roughingOp === undefined ? undefined : roughingToolText(part, roughingOp)
  return [
    ...(tool === undefined ? [] : [tool]),
    r.wallsSummary(margins.wall?.source ?? r.autoShort),
    r.floorSummary(margins.floor?.source ?? '0'),
  ].join(' · ')
}

/**
 * The `roughing` arg after one margin edit: the edited margin's source (undefined = back to its
 * default), the other margin kept as entered.
 */
export function marginArg(
  margins: RoughingMarginsView | undefined,
  which: 'wall' | 'floor',
  source: string | undefined,
): { wall?: string; floor?: string } {
  const other = which === 'wall' ? 'floor' : 'wall'
  const kept = margins?.[other]?.source
  return {
    ...(kept === undefined ? {} : { [other]: kept }),
    ...(source === undefined ? {} : { [which]: source }),
  }
}
