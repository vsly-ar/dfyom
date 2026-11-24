/**
 * The fitted reference section (DF60 P1): the chained mesh section (`sectionChains`) oriented as
 * a region by nesting (outer loops counter-clockwise, holes clockwise), each closed loop fitted to
 * lines and tangent arcs (`fitClosedPolyline`), with its inside corners: the concave corners of
 * the material where a tool must fit (an outer loop's for an outside profile, a hole's for a
 * pocket). Pure; the worker task `reference.section` runs it on the mesh it keeps.
 * Doc: docs/modes/reference-tools.md#section, docs/modes/reference-tools.md#fitting
 */
import { z } from 'zod'
import { fitClosedPolyline } from '../geometry/2d/fit-polyline'
import {
  chainBounds,
  reverseLoop,
  signedArea,
  type Bounds2,
  type Element,
  type Loop,
} from '../geometry/2d/model'
import type { Vec2 } from '../geometry/model'
import { LoopSchema, Vec2Schema } from '../geometry/schemas'
import { insideCorners } from '../geometry/shape-measure'
import type { SectionChain } from './mesh-section'

export interface SectionFitOptions {
  /** mm. */
  readonly tolerance: number
  /** Degrees. */
  readonly cornerAngle: number
}

export const SECTION_TOLERANCE_MM = 0.01
export const SECTION_CORNER_DEG = 15

/** One loop of a fitted section, in the face frame (mm). */
export interface FittedLoop {
  readonly role: 'outer' | 'hole'
  /** An unclosed chain (open mesh): no elements, bounds of its vertices only. */
  readonly open: boolean
  /** Oriented as a region: outer counter-clockwise, hole clockwise; empty when open. */
  readonly loop: Loop
  readonly circle?: { readonly centre: Vec2; readonly diameter: number }
  readonly area: number
  readonly bounds: Bounds2
  /** Inside corners: the smallest fitted arc radius (absent: none) and the sharp ones' points. */
  readonly minInsideRadius?: number
  readonly sharp: readonly Vec2[]
  /** Largest distance of a section vertex from the fitted loop. */
  readonly maxDeviation: number
}

export const FittedLoopSchema: z.ZodType<FittedLoop> = z.object({
  role: z.enum(['outer', 'hole']),
  open: z.boolean(),
  loop: LoopSchema,
  circle: z.object({ centre: Vec2Schema, diameter: z.number() }).optional(),
  area: z.number(),
  bounds: z.object({ min: Vec2Schema, max: Vec2Schema }),
  minInsideRadius: z.number().optional(),
  sharp: z.array(Vec2Schema).readonly(),
  maxDeviation: z.number(),
}) as unknown as z.ZodType<FittedLoop>

function polyArea(p: Float64Array): number {
  let s = 0
  const n = p.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    s += p[2 * i]! * p[2 * j + 1]! - p[2 * j]! * p[2 * i + 1]!
  }
  return s / 2
}

/** Even-odd containment of a point in a polygon. */
function inside(p: Float64Array, x: number, y: number): boolean {
  let c = false
  const n = p.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[2 * i]!
    const yi = p[2 * i + 1]!
    const xj = p[2 * j]!
    const yj = p[2 * j + 1]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

function polyBounds(p: Float64Array): Bounds2 {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]!)
    x1 = Math.max(x1, p[i]!)
    y0 = Math.min(y0, p[i + 1]!)
    y1 = Math.max(y1, p[i + 1]!)
  }
  return { min: [x0, y0], max: [x1, y1] }
}

/**
 * The inside corners of an oriented loop of the material region: concave turns (clockwise arcs
 * and right turns of more than 5°, the pocket check's rule mirrored), so a hole made a shape of its
 * own (reversed) has the same corners as its `smallestInsideRadius` reads. `minInsideRadius` is
 * the smallest fitted arc there (absent without one); `sharp` the corners kept sharp (radius 0).
 */
export function loopInsideCorners(l: Loop): { minInsideRadius?: number; sharp: Vec2[] } {
  const corners = insideCorners([l], -1)
  const sharp = corners.filter((c) => c.radius === 0).map((c) => c.at)
  const radii = corners.filter((c) => c.radius > 0).map((c) => c.radius)
  return radii.length === 0 ? { sharp } : { minInsideRadius: Math.min(...radii), sharp }
}

/** Orients and fits the chains of a section (see the file comment); largest loops first. */
export function fitSection(chains: readonly SectionChain[], o: SectionFitOptions): FittedLoop[] {
  const closed = chains.filter((c) => c.closed && c.points.length >= 6)
  const areas = closed.map((c) => polyArea(c.points))
  const out: FittedLoop[] = []
  closed.forEach((c, i) => {
    const x = c.points[0]!
    const y = c.points[1]!
    let depth = 0
    closed.forEach((d, j) => {
      if (j !== i && Math.abs(areas[j]!) > Math.abs(areas[i]!) && inside(d.points, x, y)) depth++
    })
    const role = depth % 2 === 0 ? 'outer' : 'hole'
    const pts: Vec2[] = []
    for (let k = 0; k < c.points.length; k += 2) pts.push([c.points[k]!, c.points[k + 1]!])
    const wantCcw = role === 'outer'
    if (areas[i]! > 0 !== wantCcw) pts.reverse()
    const fit = fitClosedPolyline(pts, {
      tolerance: o.tolerance,
      cornerAngle: (o.cornerAngle * Math.PI) / 180,
    })
    if (fit.elements.length === 0) return
    let loop: Loop = { elements: fit.elements as Element[] }
    // the fit keeps the polyline's direction; guard against a self-touching section flipping it
    if (signedArea(loop) > 0 !== wantCcw) loop = reverseLoop(loop)
    const corners = loopInsideCorners(loop)
    out.push({
      role,
      open: false,
      loop,
      ...(fit.circle
        ? { circle: { centre: fit.circle.centre, diameter: 2 * fit.circle.radius } }
        : {}),
      area: Math.abs(signedArea(loop)),
      bounds: chainBounds(loop.elements) ?? polyBounds(c.points),
      ...corners,
      maxDeviation: fit.maxDeviation,
    })
  })
  for (const c of chains)
    if (!c.closed && c.points.length >= 4)
      out.push({
        role: 'outer',
        open: true,
        loop: { elements: [] },
        area: 0,
        bounds: polyBounds(c.points),
        sharp: [],
        maxDeviation: 0,
      })
  return out.sort((a, b) => b.area - a.area)
}
