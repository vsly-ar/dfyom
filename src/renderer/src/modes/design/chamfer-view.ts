// Pure helpers of the chamfer UI (v0.4 task U4): which operations can be a chamfer's edge (a
// drilling, a pocket of any shape or an inside profile; edge chamfers E1 widened the circular
// edges of v0.4 to general loops), the edge the Add menu's Chamfer uses (the selected one, else the
// last in design order, else disabled with the reason), the Edge field's options ("Drilling 2 ·
// Ø 3.4 mm", earlier operations only), the derived diameter and depth (D45: a chamfer stores its
// width) and the section illustration's values from the part.
// Doc: docs/conventions/ui.md#feature-rows-and-add, #chamfer-inspector;
// docs/modes/design-v0.4.md#implementation-c2
import { derivedLength } from '../../../../core/design/hole'
import type { OperationDTO, PartDTO } from '../../../../core/design/part.dto'
import type { UnitSystem } from '../../../../core/project/document'
import type { Quantity } from '../../../../core/quantity/quantity'
import { chamferMessages } from '../../messages/chamfer'
import { lengthSource } from '../../messages/dfm'
import type { ChamferSectionValues } from '../../viewport/chamfer-section'
import { itemName, quantityOf, type DesignPart } from './model'
import { operationFace } from './outline'

type ChamferDTO = Extract<OperationDTO, { kind: 'chamfer' }>

/**
 * The edge's diameter DTO: a drilling's, a circle pocket's, an inside circle profile's (core
 * `circularEdgeDiameter`); undefined for any other operation.
 */
function edgeDiameterDto(op: OperationDTO) {
  if (op.kind === 'drilling') return op.diameter
  if (op.kind === 'pocket' && op.shape.kind === 'circle') return op.shape.diameter
  if (op.kind === 'profile' && op.side === 'inside' && op.shape.kind === 'circle')
    return op.shape.diameter
  return undefined
}

/**
 * Whether a chamfer can break this operation's edge (design-v0.4.md rule `chamferEdge`, widened
 * by edge-chamfers.md E1): a drilling, any pocket, any inside profile.
 */
export const isChamferEdge = (op: OperationDTO): boolean =>
  edgeDiameterDto(op) !== undefined || isLoopEdge(op)

/** A general edge (edge-chamfers.md E1): a pocket or inside profile that is not round. */
export const isLoopEdge = (op: OperationDTO): boolean =>
  edgeDiameterDto(op) === undefined &&
  (op.kind === 'pocket' || (op.kind === 'profile' && op.side === 'inside'))

/** The edge's diameter in mm (NaN when not round or not loadable). */
export function edgeDiameter(op: OperationDTO): number {
  const dto = edgeDiameterDto(op)
  return dto === undefined ? Number.NaN : (quantityOf(dto)?.canonical ?? Number.NaN)
}

/**
 * The chamfer's diameter at the face, edge Ø + 2 × width (core `chamferDiameter`), exact and
 * shown in the project's units; undefined while the edge or the width doesn't load.
 */
export function chamferDiameter(
  part: Pick<PartDTO, 'operations'>,
  chamfer: ChamferDTO,
  units: UnitSystem,
): Quantity | undefined {
  const edge = part.operations.find((o) => o.id === chamfer.edgeOf)
  const edgeDto = edge === undefined ? undefined : edgeDiameterDto(edge)
  const edgeQ = edgeDto === undefined ? undefined : quantityOf(edgeDto)
  const width = quantityOf(chamfer.width)
  if (edgeQ === undefined || width === undefined) return undefined
  const d = derivedLength(edgeQ.exact.add(width.exact).add(width.exact), units)
  return d.isOk() ? d.unwrap() : undefined
}

/** The chamfer's depth below the face (mm): width / tan(angle / 2), as core `chamferDepth`. */
export function chamferDepthOf(width: number, angle: number): number {
  return width / Math.tan(((angle / 2) * Math.PI) / 180)
}

export type ChamferEdgeChoice =
  { readonly ok: true; readonly edgeOf: string } | { readonly ok: false; readonly reason: string }

/**
 * The edge "Add chamfer" breaks: the selected drilling, circle pocket or inside circle profile, else the last one in
 * design order; none in the part: disabled with the reason (ui.md § Feature rows and Add).
 */
export function chamferEdgeChoice(part: PartDTO, selected: string | null): ChamferEdgeChoice {
  const chosen = part.operations.find((o) => o.id === selected)
  if (chosen !== undefined && isChamferEdge(chosen)) return { ok: true, edgeOf: chosen.id }
  const last = part.operations.findLast(isChamferEdge)
  return last !== undefined
    ? { ok: true, edgeOf: last.id }
    : { ok: false, reason: chamferMessages.noEdge }
}

export interface EdgeOption {
  readonly value: string
  readonly label: string
}

/**
 * The Edge field's options: the drillings, circle pockets and inside circle profiles before the chamfer in design order,
 * "Drilling 2 · Ø 3.4 mm"; the current edge is listed even when it no longer qualifies, so the
 * field never shows an empty value.
 */
export function edgeOptions(part: PartDTO, chamfer: ChamferDTO, units: UnitSystem): EdgeOption[] {
  const index = part.operations.findIndex((o) => o.id === chamfer.id)
  const before = index < 0 ? part.operations : part.operations.slice(0, index)
  const options = before.filter(isChamferEdge).map((o) => ({
    value: o.id,
    label: isLoopEdge(o)
      ? o.name
      : chamferMessages.edgeOption(o.name, lengthSource(edgeDiameter(o), units)),
  }))
  if (!options.some((o) => o.value === chamfer.edgeOf))
    options.push({
      value: chamfer.edgeOf,
      label: chamferMessages.edgeMissing(itemName(part, chamfer.edgeOf)),
    })
  return options
}

/** The chamfer's depth below the face (mm) from its stored width and angle; undefined while either doesn't load. */
export function chamferDepthValue(chamfer: ChamferDTO): number | undefined {
  const width = quantityOf(chamfer.width)?.canonical
  const angle = quantityOf(chamfer.angle)?.canonical
  return width === undefined || angle === undefined ? undefined : chamferDepthOf(width, angle)
}

/**
 * The section's values from the stored chamfer and its edge (mm): the edge's depth is a pocket's
 * or blind drilling's depth, or for a through drilling the stock below its face. Undefined while
 * the part or the edge does not load.
 */
export function chamferSectionValues(
  part: DesignPart,
  chamfer: ChamferDTO,
  invalid?: ReadonlySet<string>,
): ChamferSectionValues | undefined {
  const edge = part.dto.operations.find((o) => o.id === chamfer.edgeOf)
  const width = quantityOf(chamfer.width)?.canonical
  const angle = quantityOf(chamfer.angle)?.canonical
  if (edge === undefined || width === undefined || angle === undefined) return undefined
  // a general edge (E1) has no section illustration yet: its section is the same bevel at every
  // point of the loop, but the illustration draws a round edge's Ø
  const edgeD = edgeDiameter(edge)
  if (!Number.isFinite(edgeD)) return undefined
  const diameter = edgeD + 2 * width
  let depth = Number.NaN
  let through = false
  if (edge.kind === 'pocket') depth = quantityOf(edge.depth)?.canonical ?? Number.NaN
  else if (edge.kind === 'drilling' && edge.bottom !== 'through' && edge.depth !== undefined)
    depth = quantityOf(edge.depth)?.canonical ?? Number.NaN
  else if (edge.kind === 'drilling') {
    through = true
    const loaded = part.loaded?.part.operations.find((o) => o.id === edge.id)
    if (loaded !== undefined && part.loaded !== undefined && part.table !== undefined) {
      const face = operationFace(loaded, part.loaded.stock, part.table)
      depth = face.w + face.local.thickness
    }
  }
  return {
    width,
    diameter,
    angle,
    edgeDiameter: edgeD,
    edgeDepth: depth,
    through,
    edgeName: edge.name,
    ...(invalid !== undefined ? { invalid } : {}),
  }
}
