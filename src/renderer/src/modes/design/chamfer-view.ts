// Pure helpers of the chamfer UI (v0.4 task U4): which operations can be a chamfer's edge (a
// drilling, a pocket of any shape or an outside/inside profile; edge chamfers E1/E2 widened the
// circular edges of v0.4 to general loops), the edge the Add menu's Chamfer uses (the selected one, else the
// last in design order, else disabled with the reason), the Edge field's options ("Drilling 2 ·
// Ø 3.4 mm", earlier operations only), the derived diameter and depth (D45: a chamfer stores its
// width) and the section illustration's values from the part.
// Doc: docs/conventions/ui.md#feature-rows-and-add, #chamfer-inspector;
// docs/modes/design-v0.4.md#implementation-c2
import { derivedLength } from '../../../../core/design/hole'
import { placeShape } from '../../../../core/design/placement'
import type { Region2dPort } from '../../../../core/geometry/2d/port'
import type { OperationDTO, PartDTO } from '../../../../core/design/part.dto'
import type { UnitSystem } from '../../../../core/project/document'
import type { Quantity } from '../../../../core/quantity/quantity'
import { chamferMessages } from '../../messages/chamfer'
import { lengthSource } from '../../messages/dfm'
import type { ChamferSectionValues, WallChamferSectionValues } from '../../viewport/chamfer-section'
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
 * by edge-chamfers.md E1/E2): a drilling, any pocket, any outside or inside profile.
 */
export const isChamferEdge = (op: OperationDTO): boolean =>
  edgeDiameterDto(op) !== undefined || isLoopEdge(op) || isWallEdge(op)

/** DF147 SL4: a through Line: its chamfer bevels the wall on the side that stays (`edgeSide`). */
export const isWallEdge = (op: OperationDTO): boolean =>
  op.kind === 'line' && op.depth === 'through'

/**
 * A general edge (edge-chamfers.md E1/E2): a pocket or inside profile that is not round, or any
 * outside profile.
 */
export const isLoopEdge = (op: OperationDTO): boolean =>
  edgeDiameterDto(op) === undefined &&
  (op.kind === 'pocket' || (op.kind === 'profile' && op.side !== 'on'))

/** Stock face ids opposite each other (a flip, edge-chamfers.md E4b). */
const OPPOSITE: Readonly<Record<string, string>> = {
  'stock.top': 'stock.bottom',
  'stock.bottom': 'stock.top',
  'stock.side[0]': 'stock.side[2]',
  'stock.side[2]': 'stock.side[0]',
  'stock.side[1]': 'stock.side[3]',
  'stock.side[3]': 'stock.side[1]',
}

/**
 * The face a bottom chamfer of `op` sits on (E4b, the core's `bottomEdgeFace`): the stock face
 * opposite a through, non-round outside/inside profile's or (patterns P5) a through pocket's;
 * undefined for any other edge.
 */
export function bottomEdgeFaceDto(op: OperationDTO | undefined): string | undefined {
  // patterns P5: a through pocket (a pattern's through cells) has one too
  const through =
    op?.kind === 'pocket'
      ? op.through === true
      : op?.kind === 'profile' && op.depth === undefined && isLoopEdge(op)
  if (op === undefined || !through) return undefined
  return OPPOSITE[op.on ?? 'stock.top']
}

/**
 * Which edge a general edge is, for its Edge option (E3): a pocket's rim, an inside profile's
 * opening, an outside profile's outline.
 */
export const loopEdgeRole = (op: OperationDTO): 'rim' | 'opening' | 'outline' =>
  op.kind === 'profile' ? (op.side === 'outside' ? 'outline' : 'opening') : 'rim'

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
    label: isWallEdge(o)
      ? chamferMessages.edgeLineOption(o.name)
      : isLoopEdge(o)
        ? chamferMessages.edgeLoopOption(o.name, loopEdgeRole(o))
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
  // a general edge draws the wall section instead (`wallSectionValues`, E3)
  const edgeD = edgeDiameter(edge)
  if (!Number.isFinite(edgeD)) return undefined
  const diameter = edgeD + 2 * width
  const { depth, through } = edgeDepth(part, edge)
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

/**
 * The edge's depth below its face (mm): a pocket's, a blind drilling's or a blind profile's
 * depth; a through drilling or profile: the stock below its face (NaN while it does not load).
 */
function edgeDepth(part: DesignPart, edge: OperationDTO): { depth: number; through: boolean } {
  const q = (d: Parameters<typeof quantityOf>[0]) => quantityOf(d)?.canonical ?? Number.NaN
  if (edge.kind === 'pocket') return { depth: q(edge.depth), through: false }
  if (edge.kind === 'drilling' && edge.bottom !== 'through' && edge.depth !== undefined)
    return { depth: q(edge.depth), through: false }
  if (edge.kind === 'profile' && edge.depth !== undefined)
    return { depth: q(edge.depth), through: false }
  if (edge.kind !== 'drilling' && edge.kind !== 'profile')
    return { depth: Number.NaN, through: false }
  const loaded = part.loaded?.part.operations.find((o) => o.id === edge.id)
  if (loaded === undefined || part.loaded === undefined || part.table === undefined)
    return { depth: Number.NaN, through: true }
  const face = operationFace(loaded, part.loaded.stock, part.table)
  return { depth: face.w + face.local.thickness, through: true }
}

/**
 * The wall section's values of a chamfer along a general edge (edge chamfers E3): width, angle,
 * the wall's depth and side, no diameter. Undefined for a round edge (`chamferSectionValues`) or
 * while the part or the edge does not load.
 */
export function wallSectionValues(
  part: DesignPart,
  chamfer: ChamferDTO,
  invalid?: ReadonlySet<string>,
): WallChamferSectionValues | undefined {
  const edge = part.dto.operations.find((o) => o.id === chamfer.edgeOf)
  const width = quantityOf(chamfer.width)?.canonical
  const angle = quantityOf(chamfer.angle)?.canonical
  if (
    edge === undefined ||
    width === undefined ||
    angle === undefined ||
    !(isLoopEdge(edge) || isWallEdge(edge))
  )
    return undefined
  // DF147 SL4: a through Line's slot goes through
  const { depth, through } = isWallEdge(edge)
    ? { depth: Number.NaN, through: true }
    : edgeDepth(part, edge)
  return {
    width,
    angle,
    edgeDepth: depth,
    through,
    edgeName: edge.name,
    side: edge.kind === 'profile' && edge.side === 'outside' ? 'outside' : 'inside',
    ...(invalid !== undefined ? { invalid } : {}),
  }
}

/**
 * The loops of a general edge as the Loops checkboxes name them (edge chamfers E4a), in the
 * order of the chamfer's `loops` indices: per piece its outer loop ("Rim", "Rim 2"; "Opening",
 * "Outline"), then its islands ("Island 1" …). One loop for a v0.1 shape and an outline; a named
 * shape needs the 2D port (none without it: no Loops group).
 */
export function edgeLoopLabels(
  part: DesignPart,
  chamfer: ChamferDTO,
  port: Region2dPort | undefined,
): string[] {
  const edge = part.dto.operations.find((o) => o.id === chamfer.edgeOf)
  if (
    edge === undefined ||
    !isLoopEdge(edge) ||
    (edge.kind !== 'pocket' && edge.kind !== 'profile')
  )
    return []
  const role = chamferMessages.loopRole(loopEdgeRole(edge))
  if (edge.kind === 'profile' && edge.side === 'outside') return [role(1)]
  if (edge.shape.kind !== 'named') return [role(1)]
  const op = part.loaded?.part.operations.find((o) => o.id === edge.id)
  if (port === undefined || op === undefined || !('shape' in op)) return []
  const placed = placeShape(port, op.shape, part.loaded!.part.shapes)
  if (placed.isErr()) return []
  const outline = placed.unwrap().outline
  if (outline.kind !== 'region') return []
  let island = 0
  return outline.region.pieces.flatMap((p, i) => [
    role(i + 1),
    ...p.holes.map(() => chamferMessages.island(++island)),
  ])
}
