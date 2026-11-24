/**
 * Section → shapes (DF60 P1, `design.shape.import { from }`): the fitted loops of a reference
 * section grouped into shapes, optionally with every sharp inside corner rounded (`roundInside`),
 * and what each shape's inside corners are. Pure apart from the 2D port.
 * Doc: docs/modes/reference-tools.md#section-to-shape
 *
 * Shapes add what they cover: from the material's loops (`loops: all | outer`) a shape is the
 * section's material (outer loops add, holes subtract, islands add again); from `holes` each
 * hole's area is a shape of its own (a cavity to pocket). Inside corners are the shape's region
 * read as a pocket, as `smallestInsideRadius` reads it, which for the material is its concave
 * corners. `roundInside` r closes the material region (grow by r, shrink by r: every concave
 * corner gets a tangent arc of radius r) or opens a cavity region (shrink, grow); the largest
 * material change is the farthest sharp corner from the new boundary, r × (1/cos(φ/2) − 1) for a
 * corner turning by φ, r × (√2 − 1) at 90°.
 */
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import { regionLoops, reverseLoop, signedArea, type Loop, type Region } from '../geometry/2d/model'
import type { Region2dPort } from '../geometry/2d/port'
import type { Vec2 } from '../geometry/model'
import { insideCorners } from '../geometry/shape-measure'
import type { FittedLoop } from './reference-section'

export type SectionSplit = 'file' | 'loop'
export type SectionLoops = 'all' | 'outer' | 'holes'

/** One loop of a shape, in item order: oriented counter-clockwise, `op` by its role. */
export interface SectionItem {
  readonly loop: Loop
  readonly op: 'add' | 'subtract'
  readonly circle?: { readonly centre: Vec2; readonly diameter: number }
}

export interface SectionShape {
  readonly items: readonly SectionItem[]
  /** The shape read as a pocket: the smallest fitted inside radius (absent: none), sharp count. */
  readonly minInsideRadius?: number
  readonly sharpCount: number
  /** Min corner of the shape's bounds (the `placeAt` centre with anchor min/min). */
  readonly min: Vec2
}

export interface SectionShapes {
  readonly shapes: readonly SectionShape[]
  /** With `roundInside`: corners rounded and the largest material change (mm). */
  readonly rounded?: { readonly corners: number; readonly maxChange: number }
  /** Open loops (open mesh) left out. */
  readonly skippedOpen: number
}

const ccw = (l: Loop): Loop => (signedArea(l) < 0 ? reverseLoop(l) : l)

/** Groups of loops, each one shape: material loops (oriented as in the section) or cavities. */
function groups(
  port: Region2dPort,
  loops: readonly FittedLoop[],
  which: SectionLoops,
  split: SectionSplit,
): { loops: FittedLoop[]; cavity: boolean }[] {
  if (which === 'holes') {
    const holes = loops.filter((l) => l.role === 'hole')
    return split === 'loop'
      ? holes.map((h) => ({ loops: [h], cavity: true }))
      : holes.length === 0
        ? []
        : [{ loops: holes, cavity: true }]
  }
  const kept = which === 'outer' ? loops.filter((l) => l.role === 'outer') : [...loops]
  if (split === 'file') return kept.length === 0 ? [] : [{ loops: kept, cavity: false }]
  // one shape per outer loop with the holes directly inside it (islands are outer loops)
  const outers = kept.filter((l) => l.role === 'outer')
  const owned = new Map<FittedLoop, FittedLoop[]>(outers.map((o) => [o, [o]]))
  for (const h of kept.filter((l) => l.role === 'hole')) {
    const p = h.loop.elements[0]!.a
    let best: FittedLoop | undefined
    for (const o of outers)
      if (
        o.area > h.area &&
        (best === undefined || o.area < best.area) &&
        port.contains({ pieces: [{ outer: o.loop, holes: [] }] }, p)
      )
        best = o
    if (best !== undefined) owned.get(best)!.push(h)
  }
  return outers.map((o) => ({ loops: owned.get(o)!, cavity: false }))
}

function cornersOf(items: readonly SectionItem[]): {
  minInsideRadius?: number
  sharpCount: number
} {
  // as a pocket: each item's loop counter-clockwise when it adds, clockwise when it subtracts
  const oriented = items.map((i) => (i.op === 'add' ? i.loop : reverseLoop(i.loop)))
  const c = insideCorners(oriented, 1)
  const radii = c.filter((x) => x.radius > 0).map((x) => x.radius)
  return {
    ...(radii.length > 0 ? { minInsideRadius: Math.min(...radii) } : {}),
    sharpCount: c.filter((x) => x.radius === 0).length,
  }
}

function minOf(items: readonly SectionItem[], bounds: (l: Loop) => [Vec2, Vec2] | undefined): Vec2 {
  let u = Infinity
  let v = Infinity
  for (const i of items) {
    const b = bounds(i.loop)
    if (b === undefined) continue
    u = Math.min(u, b[0][0])
    v = Math.min(v, b[0][1])
  }
  return [u, v]
}

/** Items of a region: every loop by decreasing area, outer loops add, holes subtract. */
function regionItems(r: Region): SectionItem[] {
  const all = r.pieces.flatMap((p) => [
    { loop: p.outer, op: 'add' as const },
    ...p.holes.map((h) => ({ loop: reverseLoop(h), op: 'subtract' as const })),
  ])
  return all.sort((a, b) => Math.abs(signedArea(b.loop)) - Math.abs(signedArea(a.loop)))
}

export function sectionShapes(
  port: Region2dPort,
  loops: readonly FittedLoop[],
  o: {
    readonly loops: SectionLoops
    readonly split: SectionSplit
    /** mm; absent or 0 = keep the section as it is. */
    readonly roundInside?: number | undefined
    readonly bounds: (l: Loop) => [Vec2, Vec2] | undefined
  },
  where: string,
): AppResult<SectionShapes> {
  const closed = loops.filter((l) => !l.open)
  const skippedOpen = loops.length - closed.length
  const r = o.roundInside ?? 0
  let corners = 0
  let maxChange = 0
  const shapes: SectionShape[] = []
  for (const g of groups(port, closed, o.loops, o.split)) {
    let items: SectionItem[] = g.loops.map((l) => ({
      loop: ccw(l.loop),
      op: g.cavity || l.role === 'outer' ? 'add' : 'subtract',
      ...(l.circle ? { circle: l.circle } : {}),
    }))
    const sharp = g.loops.flatMap((l) => l.sharp)
    if (r > 0 && sharp.length > 0) {
      // the region the shape covers, then closed (material) or opened (cavity) by r
      const base = port.normalise(items.map((i) => (i.op === 'add' ? i.loop : reverseLoop(i.loop))))
      if (base.isErr()) return Err(base.unwrapErr().withContext(where))
      const first = port.offset(base.unwrap(), g.cavity ? r : -r)
      const done = first.andThen((x) => port.offset(x, g.cavity ? -r : r))
      if (done.isErr()) return Err(done.unwrapErr().withContext(where))
      const region = done.unwrap()
      if (region.pieces.length === 0)
        return fail('model.invariant', `roundInside ${r} mm removes the whole shape`, {
          issues: [
            {
              path: ['from', 'roundInside'],
              rule: 'tooLarge',
              message: 'the radius removes the whole shape',
            },
          ],
          where,
        })
      const chains = regionLoops(region)
      for (const p of sharp) {
        const d = port.distance(chains, p)
        if (d !== undefined) maxChange = Math.max(maxChange, d.distance)
      }
      corners += sharp.length
      items = regionItems(region)
    }
    shapes.push({ items, ...cornersOf(items), min: minOf(items, o.bounds) })
  }
  return Ok({
    shapes,
    ...(r > 0 ? { rounded: { corners, maxChange } } : {}),
    skippedOpen,
  })
}
