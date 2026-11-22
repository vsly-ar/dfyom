// Spike S5 (docs/research/s5-biarc-fitting.md): the fitting corpus. The S1 SVG files (heart, letter
// D, gear) plus hand-made nasty cases and two synthetic paths for counts and throughput.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cubic, type Curve, type Pt } from './curves.ts'
import { parsePathData, parseSvgPaths, type Subpath } from './svg.ts'

export interface Case {
  readonly name: string
  readonly note: string
  readonly paths: readonly Subpath[]
}

const S1 = join(import.meta.dirname, '..', '2d', 'corpus')
const file = (name: string): Subpath[] => parseSvgPaths(readFileSync(join(S1, name), 'utf8'))
const path = (d: string): Subpath[] => parsePathData(d)

/** Superellipse |x/a|^n + |y/b|^n = 1 as Catmull-Rom cubics, like an outline traced from a mesh. */
function superellipse(a: number, b: number, n: number, segs: number): Subpath[] {
  const pt = (k: number): Pt => {
    const th = (2 * Math.PI * k) / segs
    const c = Math.cos(th)
    const s = Math.sin(th)
    return {
      x: a * Math.sign(c) * Math.abs(c) ** (2 / n),
      y: b * Math.sign(s) * Math.abs(s) ** (2 / n),
    }
  }
  const curves: Curve[] = []
  for (let k = 0; k < segs; k++) {
    const p0 = pt(k - 1)
    const p1 = pt(k)
    const p2 = pt(k + 1)
    const p3 = pt(k + 2)
    curves.push(
      cubic(
        p1,
        { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
        { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
        p2,
      ),
    )
  }
  return [{ closed: true, curves }]
}

/** A G1 closed chain of `count` random cubics on a ~200 mm board (seeded, deterministic). */
export function randomChain(count: number, seed = 1): Subpath[] {
  let s = seed
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
  const pts: Pt[] = []
  for (let k = 0; k < count; k++) {
    const th = (2 * Math.PI * k) / count
    const r = 80 + 20 * rnd()
    pts.push({ x: 100 + r * Math.cos(th), y: 100 + r * Math.sin(th) })
  }
  const curves: Curve[] = []
  const at = (k: number): Pt => pts[((k % count) + count) % count]!
  for (let k = 0; k < count; k++) {
    const p0 = at(k - 1)
    const p1 = at(k)
    const p2 = at(k + 1)
    const p3 = at(k + 2)
    const w = 0.5 + rnd() // random tension, still G1 (shared tangent direction at each joint)
    curves.push(
      cubic(
        p1,
        { x: p1.x + (w * (p2.x - p0.x)) / 6, y: p1.y + (w * (p2.y - p0.y)) / 6 },
        { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
        p2,
      ),
    )
  }
  return [{ closed: true, curves }]
}

export const CORPUS: readonly Case[] = [
  {
    name: 'heart',
    note: 'S1 heart.svg: 6 cubics, cusp corner at the bottom',
    paths: file('heart.svg'),
  },
  {
    name: 'letter D',
    note: 'S1 letter-d.svg: lines, C, S, Q, with a counter',
    paths: file('letter-d.svg'),
  },
  {
    name: 'gear',
    note: 'S1 gear.svg: lines and circular arcs only (exact)',
    paths: file('gear.svg'),
  },
  {
    name: 'oval 64',
    note: 'superellipse 249.5 × 177, n 2.5, 64 Catmull-Rom cubics (exit-criteria outline)',
    paths: superellipse(124.75, 88.5, 2.5, 64),
  },
  { name: 'cusp', note: 'cubic with a true cusp at t = 0.5', paths: path('M0 0 C30 30 0 30 30 0') },
  {
    name: 'near-cusp',
    note: 'cubic one micron away from a cusp (a tiny loop)',
    paths: path('M0 0 C30 30 0 30.001 30 0'),
  },
  { name: 'loop', note: 'self-intersecting cubic loop', paths: path('M0 0 C60 40 -20 40 40 0') },
  {
    name: 'inflection',
    note: 'S-shaped cubic, inflection at t = 0.5',
    paths: path('M0 0 C30 40 30 -40 60 0'),
  },
  {
    name: 'two inflections',
    note: 'cubic with two inflections',
    paths: path('M0 0 C50 60 10 -60 60 0'),
  },
  {
    name: 'control on end',
    note: 'first control point on the start point (tangent from the second derivative)',
    paths: path('M0 0 C0 0 40 30 60 0'),
  },
  {
    name: 'line in disguise',
    note: 'controls on both end points: a straight cubic',
    paths: path('M0 0 C0 0 60 10 60 10'),
  },
  {
    name: 'collinear backtrack',
    note: 'all four points on a line, the curve runs back (two cusps)',
    paths: path('M0 0 C40 0 -10 0 30 0'),
  },
  {
    name: 'nearly straight',
    note: 'controls 1 nm off the chord (radii in the 10⁸ mm range)',
    paths: path('M0 0 C20 0.000001 40 -0.000001 60 0'),
  },
  {
    name: 'huge radius 2 µm',
    note: '300 mm cubic bowed 1.5 µm (R ≈ 7.5 km)',
    paths: path('M0 0 C100 0.002 200 0.002 300 0'),
  },
  {
    name: 'huge radius 50 µm',
    note: '300 mm cubic bowed 50 µm (R ≈ 225 m: a 10 m rule would cut it to a line, 0.05 mm off)',
    paths: path('M0 0 C100 0.0667 200 0.0667 300 0'),
  },
  {
    name: 'tiny cubic',
    note: 'heart scaled to 0.05 mm',
    paths: path(
      'M0.025 0.044 C0.01 0.0325 0 0.0225 0 0.0125 C0 0.005 0.006 0 0.013 0 C0.0185 0 0.023 0.0035 0.025 0.008',
    ),
  },
  {
    name: 'tiny arcs',
    note: 'circular arcs of r 0.005 mm and an ellipse of 0.02 × 0.01 mm',
    paths: path('M0 0 A0.005 0.005 0 0 1 0.01 0 A0.02 0.01 0 0 1 0.05 0'),
  },
  {
    name: 'ellipse',
    note: 'full ellipse 100 × 40 as two SVG arcs',
    paths: path('M0 20 A50 20 0 0 1 100 20 A50 20 0 0 1 0 20 Z'),
  },
  {
    name: 'thin ellipse',
    note: 'ellipse 200 × 2 rotated 30°, two arcs (end curvature radius 0.01 mm)',
    paths: path('M0 0 A100 1 30 0 1 173.205 100 A100 1 30 0 1 0 0 Z'),
  },
  {
    name: 'flat elliptical arc',
    note: 'elliptical arc with radii 10⁵ / 5·10⁴ over a 100 mm chord',
    paths: path('M0 0 A100000 50000 20 0 1 100 0'),
  },
  {
    name: 'quadratic chain',
    note: 'Q and smooth T segments',
    paths: path('M0 0 Q20 40 40 0 T80 0 T120 0'),
  },
]
