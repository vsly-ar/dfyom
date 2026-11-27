/**
 * Footprints of a Clones source (hardening B3): the area its operations cut in the face, in the
 * face frame, for `dfm.cloneOutsideStock` and `dfm.cloneOverlap`. Circles and axis-aligned
 * (rounded) rectangles are rounded boxes, compared exactly; named and rotated shapes and open
 * paths are regions, intersected through the `Region2dPort` (their bounds when there is none).
 * Instances are translations of the source, so every test takes an offset.
 * Doc: docs/modes/features.md#clones (Outside the stock, Overlaps),
 * docs/modes/design-v0.4.md#implementation-f5
 */
import type { Bounds2, Region } from '../../geometry/2d/model'
import { chainBounds, regionArea, regionLoops } from '../../geometry/2d/model'
import { orientRegion, translateRegion } from '../../geometry/2d/place'
import type { Region2dPort } from '../../geometry/2d/port'
import type { OperationGeometry, Shape } from '../../geometry/model'
import { shapeOutline } from '../../geometry/outline'
import { grooveWidth, lineMaxDepth } from '../../geometry/line'
import type { Flip, UV } from './path'

/** The Minkowski sum of the box centre ± (hu, hv) and a disk of radius `r` (a circle: hu = hv = 0). */
export interface RoundBox {
  readonly kind: 'box'
  readonly cu: number
  readonly cv: number
  readonly hu: number
  readonly hv: number
  readonly r: number
}

/** A general area (named or rotated shape, a slot along an open path) with its bounds. */
export interface RegionPart {
  readonly kind: 'region'
  readonly region: Region
  readonly bounds: Bounds2
}

export type FootprintPart = RoundBox | RegionPart

/** Overlaps smaller than this, mm (or mm² for regions), are touching, not overlapping. */
const TOUCH = 1e-6

const box = (cu: number, cv: number, hu: number, hv: number, r: number): RoundBox => ({
  kind: 'box',
  cu,
  cv,
  hu,
  hv,
  r,
})

function regionPart(region: Region): RegionPart | undefined {
  const b = chainBounds(regionLoops(region).flatMap((l) => l.elements))
  return b === undefined ? undefined : { kind: 'region', region, bounds: b }
}

/** A region's bounds as a box grown by `grow` (no port: conservative). */
function boundsBox(b: Bounds2, grow: number): RoundBox {
  return box(
    (b.min[0] + b.max[0]) / 2,
    (b.min[1] + b.max[1]) / 2,
    (b.max[0] - b.min[0]) / 2,
    (b.max[1] - b.min[1]) / 2,
    grow,
  )
}

/** A shape grown outwards by `grow` (0: the shape itself). */
function shapePart(shape: Shape, grow: number, port: Region2dPort | undefined): FootprintPart[] {
  const c = shape.contour
  const [cu, cv] = shape.center
  if (c.kind === 'circle') return [box(cu, cv, 0, 0, c.radius + grow)]
  if (c.kind === 'rectangle') {
    const r = Math.min(c.cornerRadius, c.length / 2, c.width / 2)
    return [box(cu, cv, c.length / 2 - r, c.width / 2 - r, r + grow)]
  }
  const outline = shapeOutline(shape)
  if (outline.kind === 'region') {
    const placed = regionPart(outline.region)
    if (placed === undefined) return []
    if (grow <= 0) return [placed]
    const grown = port?.offset(outline.region, grow)
    if (grown?.isOk()) {
      const g = regionPart(grown.unwrap())
      if (g !== undefined) return [g]
    }
    return [boundsBox(placed.bounds, grow)]
  }
  // an open path: its slot (half the slot width either side)
  const b = chainBounds(outline.path.elements)
  if (b === undefined) return []
  const slot = port?.offsetPath(outline.path, grow)
  if (slot?.isOk()) {
    const s = regionPart(slot.unwrap())
    if (s !== undefined) return [s]
  }
  return [boundsBox(b, grow)]
}

/**
 * The footprint of the source operations (their geometry input, face frame): a drilling's
 * circle, a chamfer's outer circle, a pocket's or inside profile's shape, an "on" profile's shape
 * grown by half the slot width, an outside profile's by the slot width; facings have none.
 */
export function sourceFootprint(
  src: readonly OperationGeometry[],
  port: Region2dPort | undefined,
): FootprintPart[] {
  return src.flatMap((op): FootprintPart[] => {
    switch (op.kind) {
      case 'facing':
        return []
      case 'drilling':
        return [box(op.center[0], op.center[1], 0, 0, op.diameter / 2)]
      case 'chamfer':
        // a loop chamfer (E1): its edge's shape grown by the bevel's width
        return op.edge !== undefined
          ? shapePart(op.edge.shape, op.width, port)
          : [box(op.center[0], op.center[1], 0, 0, op.diameter / 2)]
      case 'pocket':
        return shapePart(op.shape, 0, port)
      case 'profile': {
        const grow =
          op.side === 'inside' ? 0 : op.side === 'outside' ? op.slotWidth : op.slotWidth / 2
        return shapePart(op.shape, grow, port)
      }
      case 'line': {
        // each path grown by half the groove's widest width (engraved-patterns.md E1)
        const half = grooveWidth(op.cutter, lineMaxDepth(op)) / 2
        return op.paths.flatMap((p) => shapePart(p, half, port))
      }
    }
  })
}

/** The bounds of the footprint moved by `d`; undefined when empty. */
export function footprintBounds(
  parts: readonly FootprintPart[],
  d: UV = { u: 0, v: 0 },
): Bounds2 | undefined {
  if (parts.length === 0) return undefined
  let u0 = Infinity
  let v0 = Infinity
  let u1 = -Infinity
  let v1 = -Infinity
  for (const p of parts) {
    const b =
      p.kind === 'box'
        ? {
            min: [p.cu - p.hu - p.r, p.cv - p.hv - p.r],
            max: [p.cu + p.hu + p.r, p.cv + p.hv + p.r],
          }
        : p.bounds
    u0 = Math.min(u0, b.min[0] + d.u)
    v0 = Math.min(v0, b.min[1] + d.v)
    u1 = Math.max(u1, b.max[0] + d.u)
    v1 = Math.max(v1, b.max[1] + d.v)
  }
  return { min: [u0, v0], max: [u1, v1] }
}

/** Two rounded boxes, the second moved by `d`, share area (more than touching). */
function boxesOverlap(a: RoundBox, b: RoundBox, d: UV): boolean {
  const dx = Math.abs(b.cu + d.u - a.cu) - (a.hu + b.hu)
  const dy = Math.abs(b.cv + d.v - a.cv) - (a.hv + b.hv)
  // signed distance between the inner boxes (negative: they interpenetrate)
  const sd = dx <= 0 && dy <= 0 ? Math.max(dx, dy) : Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return sd < a.r + b.r - TOUCH
}

/** A rounded box as a region (for the port). */
function boxRegion(b: RoundBox): Region {
  const shape: Shape =
    b.hu === 0 && b.hv === 0
      ? { center: [b.cu, b.cv], contour: { kind: 'circle', radius: b.r } }
      : {
          center: [b.cu, b.cv],
          contour: {
            kind: 'rectangle',
            length: 2 * (b.hu + b.r),
            width: 2 * (b.hv + b.r),
            cornerRadius: b.r,
          },
        }
  const o = shapeOutline(shape)
  return o.kind === 'region' ? o.region : { pieces: [] }
}

const boundsOf = (p: FootprintPart): Bounds2 => footprintBounds([p])!

function strictlyOverlap(a: Bounds2, b: Bounds2): boolean {
  return (
    a.min[0] < b.max[0] - TOUCH &&
    b.min[0] < a.max[0] - TOUCH &&
    a.min[1] < b.max[1] - TOUCH &&
    b.min[1] < a.max[1] - TOUCH
  )
}

/** Two footprint parts, the second moved by `d`, share area. */
function partsOverlap(
  a: FootprintPart,
  b: FootprintPart,
  d: UV,
  port: Region2dPort | undefined,
): boolean {
  if (a.kind === 'box' && b.kind === 'box') return boxesOverlap(a, b, d)
  const bb = footprintBounds([b], d)!
  if (!strictlyOverlap(boundsOf(a), bb)) return false
  // no port: the region's bounds decide (conservative)
  if (port === undefined) return true
  const ra = a.kind === 'box' ? boxRegion(a) : a.region
  const rb = translateRegion(b.kind === 'box' ? boxRegion(b) : b.region, [d.u, d.v])
  const both = port.intersect(ra, rb)
  return both.isErr() || regionArea(both.unwrap()) > TOUCH
}

/**
 * The footprint and its copy moved by `d` share area; with `other`, the footprint and `other`
 * moved by `d` (a mirrored instance's flipped footprint, clones-mirror.md).
 */
export function footprintsOverlap(
  parts: readonly FootprintPart[],
  d: UV,
  port: Region2dPort | undefined,
  other: readonly FootprintPart[] = parts,
): boolean {
  const all = footprintBounds(parts)
  const moved = footprintBounds(other, d)
  if (all === undefined || moved === undefined || !strictlyOverlap(all, moved)) return false
  return parts.some((a) => other.some((b) => partsOverlap(a, b, d, port)))
}

/** A flip as a cache key: '' for none. */
export const flipKey = (f: Flip | undefined): string =>
  `${f?.u === true ? 'u' : ''}${f?.v === true ? 'v' : ''}`

/**
 * The footprint flipped about the face frame axes (u → −u, v → −v): what a mirrored instance's
 * footprint is before its translation (clones-mirror.md § Clones of Clones, … Checks).
 */
export function flipFootprint(parts: readonly FootprintPart[], f: Flip): FootprintPart[] {
  const su = f.u === true ? -1 : 1
  const sv = f.v === true ? -1 : 1
  // x → −x is the mirror; y → −y the mirror then a half turn; both a half turn
  const o =
    su < 0 && sv < 0
      ? { rotation: 180, mirror: false }
      : { rotation: sv < 0 ? 180 : 0, mirror: true }
  return parts.flatMap((p): FootprintPart[] => {
    if (p.kind === 'box') return [{ ...p, cu: su * p.cu, cv: sv * p.cv }]
    const r = regionPart(orientRegion(p.region, o))
    return r === undefined ? [] : [r]
  })
}
