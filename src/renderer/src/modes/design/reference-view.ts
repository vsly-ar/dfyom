// Design mode's view of the part's reference models (task R3), pure: the records, their placement
// in canonical numbers, the ghost's matrix (R2's placed-box convention), the live warnings and the
// unit guess. Commands do the checking; this only builds what the UI shows.
// Doc: docs/modes/reference-model.md#display, #placement-math-task-r2
import {
  exceedsStock,
  fitPosition,
  fitScale,
  ghostMatrix,
  guessUnit,
  placedBox,
  placedExtent,
  roundScaleDown,
  sectionMatrix,
  type Anchor,
  type FitAxis,
  type FitScaleProblem,
  type FitZ,
  type FrameLike,
  type Placement,
  type ReferenceWarning,
  type StockSize,
  type UnitGuess,
} from '../../../../core/design/reference'
import type { ReferenceDTO } from '../../../../core/design/reference.dto'
import type { Box } from '../../../../core/design/stl'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import { Quantity } from '../../../../core/quantity/quantity'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import type { DesignPart } from './model'

// moved to core for the headless reference queries (DF60); re-exported for the views
export { ghostMatrix, sectionMatrix }

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

// ── the Reference panel (dogfood DF5–DF7) ─────────────────────────────────────────────────

const sig4 = (v: number) => String(Number(v.toPrecision(4)))

/** "249.5 × 177.1 × 39 mm" (or in inch): a placed extent in the project units (DF6). */
export function sizeText(extent: { x: number; y: number; z: number }, units: UnitSystem): string {
  const k = units === 'mm' ? 1 : 1 / 25.4
  const unit = units === 'mm' ? 'mm' : 'in'
  return `${sig4(extent.x * k)} × ${sig4(extent.y * k)} × ${sig4(extent.z * k)} ${unit}`
}

/** A length in mm as a literal in the project's units (0.0001 mm / 0.00001 in), as fit writes. */
export function lengthSource(mm: number, units: UnitSystem): string {
  const trim = (s: string) => {
    const t = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
    return t === '-0' ? '0' : t
  }
  return units === 'mm' ? `${trim(mm.toFixed(4))} mm` : `${trim((mm / 25.4).toFixed(5))}"`
}

/** Fit mode's settings (ui.md § Reference panel): `scaleTo` null = keep the scale. */
export interface FitSettings {
  readonly anchor: Anchor
  readonly z: FitZ
  /** mm, ≥ 0. */
  readonly margin: number
  readonly scaleTo: readonly FitAxis[] | null
}

/**
 * The placement `design.reference.update { fit }` would write (core `fitScale` / `fitPosition`,
 * the scale rounded down as the command does), for Fit mode's live preview.
 */
export function fitPreview(
  bounds: Box,
  p: Placement,
  stock: StockSize,
  f: FitSettings,
): { ok: true; placement: Placement } | { ok: false; problem: FitScaleProblem } {
  if (2 * f.margin >= stock.length || 2 * f.margin >= stock.width)
    return { ok: false, problem: 'marginTooLarge' }
  let scale = p.scale
  if (f.scaleTo !== null) {
    const k = fitScale(placedExtent(bounds, { ...p, scale: 1 }), stock, f.scaleTo, f.margin)
    if (!k.ok) return k
    scale = roundScaleDown(k.scale)
  }
  const next = { ...p, scale }
  const position = fitPosition(placedExtent(bounds, next), stock, f.anchor, f.z, f.margin)
  return { ok: true, placement: { ...next, position } }
}

const at = (point: Anchor['u'], min: number, size: number) =>
  point === 'min' ? min : point === 'max' ? min + size : min + size / 2

/**
 * Scale about the anchor (DF7): the position (mm) that keeps the anchor point of the placed box
 * in X/Y and its top in Z where they are when the scale becomes `scale`.
 */
export function scaleAbout(bounds: Box, p: Placement, scale: number, anchor: Anchor) {
  const before = placedExtent(bounds, p)
  const after = placedExtent(bounds, { ...p, scale })
  const u = anchor.u ?? 'centre'
  const v = anchor.v ?? 'centre'
  return {
    x: at(u, p.position.x, before.x) - at(u, 0, after.x),
    y: at(v, p.position.y, before.y) - at(v, 0, after.y),
    z: p.position.z + before.z - after.z,
  }
}

// ── the reference section (task U3) ───────────────────────────────────────────────────────

/**
 * The section depth (mm below the face at `w = faceW`) that cuts the placed reference box at its
 * middle along the face normal, at least 0: "mid-wall height" of a reference fitted to the stock.
 */
export function middleDepth(box: Box, frame: FrameLike, faceW: number): number {
  let lo = Infinity
  let hi = -Infinity
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const w =
          frame.n[0] * (x - frame.origin[0]) +
          frame.n[1] * (y - frame.origin[1]) +
          frame.n[2] * (z - frame.origin[2])
        lo = Math.min(lo, w)
        hi = Math.max(hi, w)
      }
  return Math.max(0, faceW - (lo + hi) / 2)
}

/** A length in the part's units as a `Quantity` (for a `QuantityInput`), or undefined. */
export const lengthQuantity = (mm: number, units: UnitSystem): Quantity | undefined => {
  const q = Quantity.parse(lengthSource(mm, units), {
    kind: 'length',
    defaultUnit: units === 'mm' ? 'mm' : 'in',
  })
  return q.isOk() ? q.unwrap() : undefined
}
