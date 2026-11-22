// Design mode's view of the part's reference models (task R3), pure: the records, their placement
// in canonical numbers, the ghost's matrix (R2's placed-box convention), the live warnings and the
// unit guess. Commands do the checking; this only builds what the UI shows.
// Doc: docs/modes/reference-model.md#display, #placement-math-task-r2
import {
  exceedsStock,
  guessUnit,
  placedBox,
  rotationMatrix,
  UNIT_MM,
  type Placement,
  type ReferenceWarning,
  type StockSize,
  type UnitGuess,
} from '../../../../core/design/reference'
import type { ReferenceDTO } from '../../../../core/design/reference.dto'
import type { Box } from '../../../../core/design/stl'
import type { ProjectDoc } from '../../../../core/project/document'
import { Quantity } from '../../../../core/quantity/quantity'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import type { DesignPart } from './model'

/** The part's references in id order (the v0.2 UI focuses on the first, the model has no limit). */
export function partReferences(doc: ProjectDoc, partId: string): readonly ReferenceDTO[] {
  return Object.values(doc.references)
    .filter((r) => r.partId === partId)
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
}

const canonical = (dto: QuantityDTO): number | undefined => {
  const q = Quantity.fromDTO(dto)
  return q.isOk() ? q.unwrap().canonical : undefined
}

/** The record's placement in mm and degrees; undefined if a stored value does not load. */
export function referencePlacement(ref: ReferenceDTO): Placement | undefined {
  const v = [
    ref.scale,
    ref.rotation.x,
    ref.rotation.y,
    ref.rotation.z,
    ref.position.x,
    ref.position.y,
    ref.position.z,
  ].map(canonical)
  if (v.some((n) => n === undefined)) return undefined
  const [scale, rx, ry, rz, px, py, pz] = v as number[]
  return {
    sourceUnit: ref.sourceUnit,
    scale: scale!,
    rotation: { x: rx!, y: ry!, z: rz! },
    position: { x: px!, y: py!, z: pz! },
  }
}

/**
 * The ghost's model matrix (column-major 4 × 4, three.js `Matrix4.fromArray`): scale by
 * `scale × unit`, rotate `Rz · Ry · Rx`, then translate so the placed bounding box's min corner
 * (the box of the 8 rotated corners of the source bounds, as `placedBox` in core) lands on
 * `position`. The same box as fit and `exceedsStock`, so the ghost sits where they say.
 */
export function ghostMatrix(bounds: Box, p: Placement): number[] {
  const k = p.scale * UNIT_MM[p.sourceUnit]
  const m = rotationMatrix(p.rotation)
  const lo = [Infinity, Infinity, Infinity]
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z])
        for (let r = 0; r < 3; r++)
          lo[r] = Math.min(lo[r]!, k * (m[r * 3]! * x + m[r * 3 + 1]! * y + m[r * 3 + 2]! * z))
  const pos = [p.position.x, p.position.y, p.position.z]
  const out = new Array<number>(16).fill(0)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[c * 4 + r] = k * m[r * 3 + c]!
    out[12 + r] = pos[r]! - lo[r]!
  }
  out[15] = 1
  return out
}

/** The part's stock size (mm), if the part loads. */
export function stockSizeOf(part: DesignPart): StockSize | undefined {
  const s = part.loaded?.stock
  return s === undefined
    ? undefined
    : { length: s.length.canonical, width: s.width.canonical, thickness: s.thickness.canonical }
}

/** The placed bounding box (mm, part frame), if the record loads. */
export function referenceBox(ref: ReferenceDTO): Box | undefined {
  const p = referencePlacement(ref)
  return p === undefined ? undefined : placedBox(ref.asset.bounds, p)
}

/** `reference.exceedsStock` now (as the list query reports it), if any. */
export function liveWarnings(ref: ReferenceDTO, stock: StockSize | undefined): ReferenceWarning[] {
  const box = referenceBox(ref)
  if (box === undefined || stock === undefined) return []
  const w = exceedsStock(ref.id, box, stock)
  return w === undefined ? [] : [w]
}

/** What the import's unit guess says for this stock (shown beside the source unit). */
export function unitGuessOf(
  ref: ReferenceDTO,
  stock: StockSize | undefined,
): UnitGuess | undefined {
  return stock === undefined ? undefined : guessUnit(ref.asset.bounds, stock)
}

/** Source size as text: `120 × 80 × 30` (source units, 4 significant digits). */
export function sourceSize(bounds: Box): string {
  const f = (v: number) => String(Number(v.toPrecision(4)))
  return `${f(bounds.max.x - bounds.min.x)} × ${f(bounds.max.y - bounds.min.y)} × ${f(
    bounds.max.z - bounds.min.z,
  )}`
}
