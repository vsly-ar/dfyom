/**
 * Reference-model placement: source unit guess, placed bounding box, fit to stock and the
 * reference warnings. Doc: docs/modes/reference-model.md#placement-math-task-r2
 *
 * Pure numbers in canonical units (mm, degrees). The mesh is never re-read: placement works on
 * the source bounds stored with the record. The facing depth suggestion (DF4) takes any box of the
 * reference in the part frame: the placed box here, the mesh's own box where a caller has it.
 * Doc: docs/modes/reference-model.md#facing-depth-from-the-reference-df4
 */
import { z } from 'zod'
import { DIRECTION, stockFaceLevel, type Direction } from '../geometry/face'
import type { UnitSystem } from '../project/document'
import type { Box, Xyz } from './stl'

export type SourceUnit = 'mm' | 'inch'

/** Millimetres per source unit. */
export const UNIT_MM: Readonly<Record<SourceUnit, number>> = { mm: 1, inch: 25.4 }

/** The stock box in the part frame: `0..length × 0..width × −thickness..0` (mm). */
export interface StockSize {
  readonly length: number
  readonly width: number
  readonly thickness: number
}

export interface Placement {
  readonly sourceUnit: SourceUnit
  readonly scale: number
  /** Degrees, applied x, then y, then z about the part axes. */
  readonly rotation: Xyz
  /** mm: where the placed box's min corner lands. */
  readonly position: Xyz
}

const extentOf = (b: Box): Xyz => ({
  x: b.max.x - b.min.x,
  y: b.max.y - b.min.y,
  z: b.max.z - b.min.z,
})

// ── unit guess ────────────────────────────────────────────────────────────────────────────

export interface UnitGuess {
  readonly unit: SourceUnit
  readonly reason: string
}

const fmt = (v: number) => String(Number(v.toPrecision(4)))
const dims = (e: Xyz, k: number) => `${fmt(e.x * k)} × ${fmt(e.y * k)} × ${fmt(e.z * k)}`

/**
 * reference-model.md § Source unit guess: mm unless the mm reading's largest extent is under
 * 1/10 of the stock's largest extent and the inch reading still fits within the stock. "Fits"
 * compares sorted extents, so the model's orientation in the file does not matter.
 */
export function guessUnit(bounds: Box, stock: StockSize): UnitGuess {
  const e = extentOf(bounds)
  const model = [e.x, e.y, e.z].sort((a, b) => a - b)
  const box = [stock.length, stock.width, stock.thickness].sort((a, b) => a - b)
  const stockMax = box[2]!
  const mmMax = model[2]!
  const inchFits = model.every((v, i) => v * UNIT_MM.inch <= box[i]! + 1e-9)
  if (mmMax < stockMax / 10 && inchFits) {
    const ratio = mmMax > 0 ? Math.round(stockMax / mmMax) : Infinity
    return {
      unit: 'inch',
      reason: `Read as inch: ${dims(e, 1)} in mm would be ${ratio}× smaller than the stock`,
    }
  }
  return {
    unit: 'mm',
    reason:
      mmMax < stockMax / 10
        ? `Read as mm: ${dims(e, 1)} mm (as inch it would not fit the stock)`
        : `Read as mm: ${dims(e, 1)} mm`,
  }
}

// ── placement ─────────────────────────────────────────────────────────────────────────────

/** cos and sin of an angle in degrees; exact for multiples of 90°. */
function cosSin(deg: number): [number, number] {
  if (Number.isInteger(deg) && deg % 90 === 0) {
    const q = (((deg / 90) % 4) + 4) % 4
    return (
      [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ] as const
    )[q]! as [number, number]
  }
  const r = (deg * Math.PI) / 180
  return [Math.cos(r), Math.sin(r)]
}

type Mat = readonly [number, number, number, number, number, number, number, number, number]

const mul = (a: Mat, b: Mat): Mat => {
  const out: number[] = []
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      out.push(a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!)
  return out as unknown as Mat
}

/** Rz · Ry · Rx: x first, then y, then z, about the fixed part axes. */
export function rotationMatrix(r: Xyz): Mat {
  const [cx, sx] = cosSin(r.x)
  const [cy, sy] = cosSin(r.y)
  const [cz, sz] = cosSin(r.z)
  const rx: Mat = [1, 0, 0, 0, cx, -sx, 0, sx, cx]
  const ry: Mat = [cy, 0, sy, 0, 1, 0, -sy, 0, cy]
  const rz: Mat = [cz, -sz, 0, sz, cz, 0, 0, 0, 1]
  return mul(rz, mul(ry, rx))
}

/**
 * Extent (mm) of the placed reference: the axis-aligned box of the scaled, rotated corners of
 * the source bounds. Exact for 90° steps; for free angles it can be larger than the mesh's own
 * box (the mesh is not re-read), and the renderer uses the same box for `position`.
 */
export function placedExtent(bounds: Box, p: Omit<Placement, 'position'>): Xyz {
  const k = p.scale * UNIT_MM[p.sourceUnit]
  const m = rotationMatrix(p.rotation)
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z])
        for (let r = 0; r < 3; r++) {
          const v = k * (m[r * 3]! * x + m[r * 3 + 1]! * y + m[r * 3 + 2]! * z)
          lo[r] = Math.min(lo[r]!, v)
          hi[r] = Math.max(hi[r]!, v)
        }
  return { x: hi[0]! - lo[0]!, y: hi[1]! - lo[1]!, z: hi[2]! - lo[2]! }
}

/** The placed bounding box in the part frame (mm). */
export function placedBox(bounds: Box, p: Placement): Box {
  const e = placedExtent(bounds, p)
  const q = p.position
  return { min: q, max: { x: q.x + e.x, y: q.y + e.y, z: q.z + e.z } }
}

// ── fit to stock ──────────────────────────────────────────────────────────────────────────

export const ANCHOR_POINTS = ['min', 'centre', 'max'] as const
export type AnchorPoint = (typeof ANCHOR_POINTS)[number]

/**
 * The 9-point placement anchor (docs/modes/design-v0.2.md#placement-anchors): a point of a
 * bounding rectangle in a face frame; on the top face `u` is X and `v` is Y.
 */
export const AnchorSchema = z.object({
  u: z.enum(ANCHOR_POINTS).optional(),
  v: z.enum(ANCHOR_POINTS).optional(),
})
export type Anchor = z.output<typeof AnchorSchema>

export const FIT_Z = ['top', 'centre', 'bottom'] as const
export type FitZ = (typeof FIT_Z)[number]

const along = (point: AnchorPoint, size: number, extent: number) =>
  point === 'min' ? 0 : point === 'max' ? size - extent : (size - extent) / 2

/**
 * `position` (mm) that puts the placed box on the stock at `anchor` and `z`; `margin` (mm, ≥ 0)
 * is kept free on each side in X and Y (the fit rectangle is the top face shrunk by it).
 */
export function fitPosition(
  extent: Xyz,
  stock: StockSize,
  anchor: Anchor,
  z: FitZ,
  margin = 0,
): Xyz {
  const t = stock.thickness
  return {
    x: margin + along(anchor.u ?? 'centre', stock.length - 2 * margin, extent.x),
    y: margin + along(anchor.v ?? 'centre', stock.width - 2 * margin, extent.y),
    z: z === 'top' ? -extent.z : z === 'bottom' ? -t : -(t + extent.z) / 2,
  }
}

export const FIT_AXES = ['x', 'y', 'z'] as const
export type FitAxis = (typeof FIT_AXES)[number]

/** Why a scale to fit is impossible (the command's rule ids). */
export type FitScaleProblem = 'marginTooLarge' | 'zeroExtent'

/**
 * Scale to fit (docs/modes/reference-model.md#fit-to-stock): the largest factor `k` such that
 * `k × unitExtent` fits, along every axis of `axes`, the fit rectangle (stock length and width
 * minus `2 × margin`) and the stock thickness. `unitExtent` is the placed extent at scale 1.
 * Axes along which the model has no extent are skipped. Not rounded.
 */
export function fitScale(
  unitExtent: Xyz,
  stock: StockSize,
  axes: readonly FitAxis[],
  margin = 0,
): { ok: true; scale: number } | { ok: false; problem: FitScaleProblem } {
  const room: Xyz = {
    x: stock.length - 2 * margin,
    y: stock.width - 2 * margin,
    z: stock.thickness,
  }
  if (room.x <= 0 || room.y <= 0) return { ok: false, problem: 'marginTooLarge' }
  let k = Infinity
  for (const a of axes) if (unitExtent[a] > 1e-12) k = Math.min(k, room[a] / unitExtent[a])
  return Number.isFinite(k) ? { ok: true, scale: k } : { ok: false, problem: 'zeroExtent' }
}

/** A scale factor rounded down to 6 significant digits (a fitted box never sticks out). */
export function roundScaleDown(k: number): number {
  const e = Math.floor(Math.log10(k)) - 5
  // the tiny bias keeps exact factors (2, 0.5) exact despite float noise
  const n = Math.floor(k * 10 ** -e * (1 + 1e-12))
  return Number((n * 10 ** e).toPrecision(6))
}

// ── warnings ──────────────────────────────────────────────────────────────────────────────

export const REFERENCE_WARNING_CODES = [
  'reference.exceedsStock',
  'reference.unitGuessed',
  'reference.openMesh',
  'reference.manyTriangles',
] as const

export const ReferenceWarningSchema = z.object({
  code: z.enum(REFERENCE_WARNING_CODES),
  severity: z.enum(['warning', 'info']),
  message: z.string().describe('English, values in mm'),
  referenceId: z.string(),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
})
export type ReferenceWarning = z.output<typeof ReferenceWarningSchema>

/** Ignore overhangs below this (mm): fitted positions are rounded to 0.0001 mm. */
const EPS = 1e-3

/** `reference.exceedsStock` with the overhang per axis (both sides added), if any. */
export function exceedsStock(
  referenceId: string,
  placed: Box,
  stock: StockSize,
): ReferenceWarning | undefined {
  const over = (lo: number, hi: number, min: number, max: number) =>
    Math.max(0, min - lo) + Math.max(0, hi - max)
  const o = {
    x: over(placed.min.x, placed.max.x, 0, stock.length),
    y: over(placed.min.y, placed.max.y, 0, stock.width),
    z: over(placed.min.z, placed.max.z, -stock.thickness, 0),
  }
  const axes = (['x', 'y', 'z'] as const).filter((a) => o[a] > EPS)
  if (axes.length === 0) return undefined
  return {
    code: 'reference.exceedsStock',
    severity: 'warning',
    message: `The reference sticks out of the stock by ${axes
      .map((a) => `${a.toUpperCase()} ${fmt(o[a])}`)
      .join(', ')} mm`,
    referenceId,
    params: { x: o.x, y: o.y, z: o.z },
  }
}

// ── facing depth from the reference (DF4) ─────────────────────────────────────────────────

/** A reference's box in the part frame (mm): its placed box, or the mesh's own box. */
export interface ReferenceBox {
  readonly referenceId: string
  readonly box: Box
}

export interface FacingDepthSuggestion {
  /** mm, exact (before rounding). */
  readonly depth: number
  /** The depth as a literal in the project's units, rounded down (never into the reference). */
  readonly source: string
  /** The reference that decided it (the closest to the face). */
  readonly referenceId: string
}

const AXES = ['x', 'y', 'z'] as const

/** Stock box per axis in the part frame: x ∈ [0, L], y ∈ [0, W], z ∈ [−T, 0]. */
const stockRange = (stock: StockSize, a: 'x' | 'y' | 'z'): [number, number] =>
  a === 'x' ? [0, stock.length] : a === 'y' ? [0, stock.width] : [-stock.thickness, 0]

/**
 * Distance (mm) from the stock face of `direction` to the reference's extreme point along the
 * face's outward normal: what a facing on that face removes to reach the reference. Undefined when
 * the box does not overlap the face rectangle (nothing to face down to). May be ≤ 0 or beyond the
 * stock; `suggestFacingDepth` applies the limits.
 */
export function depthToReference(
  direction: Direction,
  stock: StockSize,
  box: Box,
): number | undefined {
  const d = DIRECTION[direction]
  for (const a of AXES) {
    if (a === d.axis) continue
    const [lo, hi] = stockRange(stock, a)
    if (box.max[a] <= lo || box.min[a] >= hi) return undefined
  }
  // n · p of the reference's extreme point along n
  const extreme = d.sign > 0 ? box.max[d.axis] : -box.min[d.axis]
  return stockFaceLevel(direction, stock) - extreme
}

const trimNumber = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s)

/**
 * A facing depth (mm) as a literal in the project's units, **rounded down** to 0.001 mm or
 * 0.0001 in so the facing never reaches into the reference: "0.48 mm", `0.0189"`.
 */
export function facingDepthSource(mm: number, units: UnitSystem): string {
  // a tiny slack, so 0.4800000001 is not rounded down to 0.479
  const down = (v: number, decimals: number) => {
    const f = 10 ** decimals
    return Math.floor(v * f + 1e-6) / f
  }
  return units === 'mm'
    ? `${trimNumber(down(mm, 3).toFixed(3))} mm`
    : `${trimNumber(down(mm / 25.4, 4).toFixed(4))}"`
}

/**
 * The depth a facing on the stock face of `direction` takes to face down to the closest of the
 * `references` (the smallest depth, so it reaches into none of them). Only a sensible value is
 * suggested: positive after rounding down to the project's unit and less than the stock's extent
 * along the normal (the facing's own limit); else undefined.
 */
export function suggestFacingDepth(
  direction: Direction,
  stock: StockSize,
  references: readonly ReferenceBox[],
  units: UnitSystem,
): FacingDepthSuggestion | undefined {
  let best: { depth: number; referenceId: string } | undefined
  for (const r of references) {
    const depth = depthToReference(direction, stock, r.box)
    if (depth === undefined || !Number.isFinite(depth)) continue
    if (best === undefined || depth < best.depth) best = { depth, referenceId: r.referenceId }
  }
  if (best === undefined) return undefined
  const source = facingDepthSource(best.depth, units)
  const rounded = Number.parseFloat(source)
  if (!(rounded > 0) || best.depth >= stock[DIRECTION[direction].extent]) return undefined
  return { depth: best.depth, source, referenceId: best.referenceId }
}
