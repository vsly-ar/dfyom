// Reproducer corpus (hardening B2): offsets of random regions (unions and differences of circles,
// rounded rectangles and polygons with convex and concave, non-tangent arcs), swept over a grid
// of offsets and over offsets just past or short of every arc's radius. Before B2 the library's
// result was wrong at about 8 % of the offsets within 1e-5 mm of an arc's radius (open loops it
// stitched anyway: crossings, lost or overlapping pieces, loops 10 mm off), and shrinks past the
// radius of a closing's rounded corners dropped its holes at any offset. Every result must now
// be a valid region that meets the offset oracle, or a clean `resultInvalid` naming the offset;
// the corpus asserts it is always the former. Fixed seeds: the WASM build is deterministic.
// Doc: docs/architecture/shapes.md#implementation-k1
import { describe, expect, it } from 'vitest'
import type { Vec2 } from '../../model'
import { closedChainCrossing } from '../crossings'
import { regionContains } from '../measure'
import {
  arcRadius,
  MIN_ELEMENT_LENGTH,
  regionArea,
  regionLoops,
  signedArea,
  type Loop,
  type Region,
} from '../model'
import { bulgeLoop, circle, rect } from '../testing/fixtures'
import { nodeRegion2d } from '../testing/node-wasm'
import { crossings, maxOffsetError } from '../testing/oracles'
import { toWire } from '../wire'

const port = nodeRegion2d()

/** The offset oracle's tolerance: retries move an offset by up to 2e-3 mm (B2). */
const ORACLE = 2.5e-3
/** Offsets past (positive) or short of (negative) an arc's radius, in mm. */
const NEAR_RADIUS = [-1e-3, -1e-5, -1e-7, 0, 1e-7, 1e-5, 1e-4, 1e-2]
const GRID = [0.37, 1.08, 2.5, 4.63, 8.18, 13.2]

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function primitive(rand: () => number): Loop {
  const x = rand() * 40 - 20
  const y = rand() * 40 - 20
  const k = rand()
  if (k < 0.4) return circle(x, y, 1 + rand() * 12)
  if (k < 0.8) {
    const w = 2 + rand() * 30
    const h = 2 + rand() * 30
    const r = rand() < 0.3 ? 0 : rand() * Math.min(w, h) * 0.5
    return rect(x, y, w, h, r)
  }
  // a polygon whose edges are arcs, about a third of them concave, meeting at corners
  const verts: [number, number, number][] = []
  const m = 3 + Math.floor(rand() * 4)
  const R = 3 + rand() * 12
  for (let i = 0; i < m; i++) {
    const a = (2 * Math.PI * i) / m + rand() * 0.3
    verts.push([x + Math.cos(a) * R, y + Math.sin(a) * R, (rand() - 0.3) * 0.8])
  }
  return bulgeLoop(verts)
}

/** A random region, or undefined when a primitive is not a valid loop (self-crossing polygons). */
function randomRegion(rand: () => number): Region | undefined {
  const adds = 1 + Math.floor(rand() * 3)
  const subs = Math.floor(rand() * 4)
  let region: Region | undefined
  let valid = true
  for (let i = 0; i < adds + subs; i++) {
    const loop = primitive(rand)
    if (!valid) continue // keep the random stream independent of validity
    const p = signedArea(loop) > 0 ? port.normalise([loop]) : undefined
    if (p === undefined || p.isErr()) {
      valid = false
      continue
    }
    if (region === undefined) region = p.unwrap()
    else
      region = (
        i < adds ? port.union(region, p.unwrap()) : port.difference(region, p.unwrap())
      ).unwrap()
  }
  return valid && region !== undefined && region.pieces.length > 0 ? region : undefined
}

/**
 * Whether a crossing found at `p` is a corner touching within `MIN_ELEMENT_LENGTH`: near a
 * collapse the exact offset keeps arcs of a radius down to 1e-8 mm at corners (the port turns
 * those under `MIN_ELEMENT_LENGTH` into their chords), and the crossing finder counts such a
 * corner's neighbours as crossing.
 */
function atCorner(l: Loop, p: Vec2): boolean {
  return l.elements.some((e) => Math.hypot(e.a[0] - p[0], e.a[1] - p[1]) < MIN_ELEMENT_LENGTH)
}

/** What is wrong with the offset of `region` by `d`, if anything. */
function problem(region: Region, d: number): string | undefined {
  const r = port.offset(region, d)
  if (r.isErr()) return `refused: ${r.unwrapErr().message}`
  const out = r.unwrap()
  if (out.pieces.length === 0) return d < 0 ? 'a growth is empty' : undefined
  for (const p of out.pieces) {
    if (signedArea(p.outer) <= 0) return 'a clockwise outer'
    for (const h of p.holes) if (signedArea(h) >= 0) return 'a counter-clockwise hole'
  }
  if (d < 0 ? regionArea(out) < regionArea(region) : regionArea(out) > regionArea(region))
    return 'the area moved the wrong way'
  const loops = regionLoops(out)
  for (const l of loops) {
    // the result must be simple and usable as input again (the port's chain check)
    const x = closedChainCrossing(l.elements)
    if (x !== undefined && !atCorner(l, x.at)) return 'a loop crosses itself'
    const w = toWire(l.elements, true, 'test')
    if (w.isErr()) return `unusable: ${w.unwrapErr().message}`
  }
  if (crossings(loops) > loops.reduce((s, l) => s + crossings([l]), 0)) return 'loops cross'
  const e = maxOffsetError(regionLoops(region), loops, d)
  if (e > ORACLE) return `a loop lies ${e.toExponential(2)} mm off the offset distance`
  // a growth holds its input, a shrink lies away from its boundary
  for (const l of regionLoops(region))
    if (regionContains(out, l.elements[0]!.a) !== d < 0) return 'lost an input loop'
  return undefined
}

function sweep(seed: number, shapes: number): string[] {
  const rand = rng(seed)
  const fails: string[] = []
  for (let t = 0; t < shapes; t++) {
    const region = randomRegion(rand)
    if (region === undefined) continue
    const radii = new Set<number>()
    for (const l of regionLoops(region))
      for (const e of l.elements) if (e.kind === 'arc') radii.add(arcRadius(e))
    const ds = GRID.flatMap((d) => [d, -d])
    for (const r of radii) for (const e of NEAR_RADIUS) ds.push(r + e, -(r + e))
    for (const d of ds) {
      const p = problem(region, d)
      if (p !== undefined) fails.push(`seed ${seed} shape ${t} d=${d}: ${p}`)
    }
  }
  return fails
}

describe('offset reproducer corpus (B2)', () => {
  // seed 21's first 120 shapes held about 60 failing offsets near arc radii before B2 (e.g.
  // shape 47 at d = 8.2508 crossed itself, shape 122 at d = −11.6148 lay 10.5 mm off)
  // v0.3's open issue: growing a region whose concave arcs meet a larger arc at an angle
  it('discs and rounded rectangles with bites at their rim, grown past the bites radius', () => {
    const fails: string[] = []
    for (const rb of [0.5, 2, 3.175, 6])
      for (const k of [1, 2, 3, 5]) {
        let region = port.normalise([circle(0, 0, 20)]).unwrap()
        let box = port.normalise([rect(30, -10, 40, 20, 4)]).unwrap()
        for (let i = 0; i < k; i++) {
          const a = (2 * Math.PI * i) / k + 0.3
          // centres just inside, on and outside the rim: the bite meets the rim at an angle
          const c = 20 + (i % 3) - 1
          region = port
            .difference(
              region,
              port.normalise([circle(c * Math.cos(a), c * Math.sin(a), rb)]).unwrap(),
            )
            .unwrap()
          box = port
            .difference(box, port.normalise([circle(32 + 8 * i, 10 - (i % 2), rb)]).unwrap())
            .unwrap()
        }
        for (const r of [region, box])
          for (const e of [...NEAR_RADIUS, 0.1, 1, 5]) {
            const p = problem(r, -(rb + e))
            if (p !== undefined) fails.push(`rb=${rb} k=${k} d=${-(rb + e)}: ${p}`)
          }
      }
    expect(fails).toEqual([])
  })

  it('random regions, offsets near every arc radius and on a grid', { timeout: 120_000 }, () => {
    expect(sweep(21, 120)).toEqual([])
    expect(sweep(3, 60)).toEqual([])
  })
})
