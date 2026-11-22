// Spike S1 (docs/decisions/0019-2d-geometry-library.md): hand-built fixtures. Outer loops
// counter-clockwise, islands clockwise, millimetres.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { reverse, type Loop, type Vertex } from './geom.ts'
import { parseSvg } from './svg.ts'

const Q = Math.tan(Math.PI / 8) // bulge of a 90° arc

export function rect(x: number, y: number, w: number, h: number, r = 0): Loop {
  if (r <= 0)
    return {
      closed: true,
      verts: [
        [x, y, 0],
        [x + w, y, 0],
        [x + w, y + h, 0],
        [x, y + h, 0],
      ],
    }
  return {
    closed: true,
    verts: [
      [x + r, y, 0],
      [x + w - r, y, Q],
      [x + w, y + r, 0],
      [x + w, y + h - r, Q],
      [x + w - r, y + h, 0],
      [x + r, y + h, Q],
      [x, y + h - r, 0],
      [x, y + r, Q],
    ],
  }
}

export const circle = (cx: number, cy: number, r: number): Loop => ({
  closed: true,
  verts: [
    [cx - r, cy, 1],
    [cx + r, cy, 1],
  ],
})

export const hole = (l: Loop): Loop => reverse(l)

/** Two Ø30 discs joined by a neck of width 2·h: offsets above h must split the loop. */
export function dumbbell(h: number): Loop {
  const r = 15
  const x = Math.sqrt(r * r - h * h)
  const sweep = 2 * Math.PI - 2 * Math.asin(h / r)
  const b = Math.tan(sweep / 4)
  return {
    closed: true,
    verts: [
      [x, -h, 0],
      [50 - x, -h, b],
      [50 - x, h, 0],
      [x, h, b],
    ],
  }
}

/** Box whose top is a chain of tangent semicircles (bumps and dips), perturbed by `eps`. */
export function wave(eps = 0): Loop {
  const verts: Vertex[] = [
    [0, 0, 0],
    [60, 0, 0],
  ]
  for (let k = 0; k < 6; k++)
    verts.push([60 - 10 * k, 20 + (k % 2 === 1 ? eps : 0), k % 2 === 0 ? 1 : -1])
  verts.push([0, 20, 0])
  return { closed: true, verts }
}

/** Two squares joined at one corner within a single loop (the boundary touches itself). */
export const bowtieSquares: Loop = {
  closed: true,
  verts: [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
    [20, 10, 0],
    [20, 20, 0],
    [10, 20, 0],
    [10, 10, 0],
    [0, 10, 0],
  ],
}

/** Circle of 360 arcs with a 1e-5 mm line after each and a duplicated (1e-12) vertex every 10°. */
export function tinySegments(): Loop {
  const verts: Vertex[] = []
  const r = 20
  const step = (2 * Math.PI) / 360
  const gap = 1e-5 / r
  const b = Math.tan((step - gap) / 4)
  for (let k = 0; k < 360; k++) {
    const a = k * step
    verts.push([r * Math.cos(a), r * Math.sin(a), b])
    const e = a + step - gap
    verts.push([r * Math.cos(e), r * Math.sin(e), 0])
    if (k % 10 === 0) verts.push([r * Math.cos(e) + 1e-12, r * Math.sin(e), 0])
  }
  return { closed: true, verts }
}

/**
 * Speed fixture with `n` segments: a star with filleted points (concave, half lines, half arcs)
 * and two islands (a circle and a rounded rectangle).
 */
export function star(n: number): Loop[] {
  const k = Math.max(3, Math.round(n / 4)) // points × 2 vertices × (line + arc)
  const corners: [number, number][] = []
  for (let i = 0; i < 2 * k; i++) {
    const a = (i * Math.PI) / k
    const rr = i % 2 === 0 ? 100 : 88
    corners.push([rr * Math.cos(a), rr * Math.sin(a)])
  }
  const f = 0.6 // fillet radius
  const verts: Vertex[] = []
  for (let i = 0; i < corners.length; i++) {
    const p = corners[(i - 1 + corners.length) % corners.length]!
    const c = corners[i]!
    const nx = corners[(i + 1) % corners.length]!
    const u1 = norm([c[0] - p[0], c[1] - p[1]])
    const u2 = norm([nx[0] - c[0], nx[1] - c[1]])
    const turn = Math.atan2(u1[0] * u2[1] - u1[1] * u2[0], u1[0] * u2[0] + u1[1] * u2[1])
    const t = f * Math.tan(Math.abs(turn) / 2)
    verts.push([c[0] - u1[0] * t, c[1] - u1[1] * t, Math.tan(turn / 4)])
    verts.push([c[0] + u2[0] * t, c[1] + u2[1] * t, 0])
  }
  return [{ closed: true, verts }, hole(circle(-30, 0, 18)), hole(rect(15, -20, 35, 40, 5))]
}
const norm = (v: [number, number]): [number, number] => {
  const l = Math.hypot(v[0], v[1])
  return [v[0] / l, v[1] / l]
}

export interface OffsetCase {
  name: string
  region: Loop[]
  /** Offsets (positive inward) and the expected loop count, when known. */
  offsets: [number, number | null][]
  /** Subtract the (single) island from the outer loop with the candidate's boolean before offsetting. */
  normalise?: true
}

const SVG_DIR = join(import.meta.dirname, 'corpus')

export function svgCases(): OffsetCase[] {
  return readdirSync(SVG_DIR)
    .filter((f) => f.endsWith('.svg'))
    .sort()
    .map((f) => ({
      name: `svg/${f}`,
      region: parseSvg(readFileSync(join(SVG_DIR, f), 'utf8'), 0.005),
      offsets: [
        [1, null],
        [-1.5, null],
      ],
    }))
}

export function offsetCases(): OffsetCase[] {
  return [
    {
      name: 'pocket, 2 islands',
      region: [rect(0, 0, 120, 80, 6), hole(circle(35, 40, 10)), hole(rect(70, 25, 30, 30, 4))],
      offsets: [
        [3, 3],
        [8, 3],
        [12, 2],
        [-2, 3],
      ],
    },
    {
      name: 'neck 4 mm (split)',
      region: [dumbbell(2)],
      offsets: [
        [1.9, 1],
        [2.5, 2],
        [-1, 1],
      ],
    },
    {
      name: 'tangent arcs (wave)',
      region: [wave()],
      offsets: [
        [1, 1],
        [3, null],
        [6, null],
        [-2, 1],
      ],
    },
    {
      name: 'near-tangent (1e-6)',
      region: [wave(1e-6)],
      offsets: [
        [1, 1],
        [3, null],
        [-2, 1],
      ],
    },
    {
      name: 'self-touching loop',
      region: [bowtieSquares],
      offsets: [
        [1, 2],
        [-1, 1],
      ],
    },
    {
      name: 'island touches outer',
      region: [rect(0, 0, 40, 40), hole(circle(20, 8, 8))],
      offsets: [
        [1, 1],
        [-1, null],
      ],
    },
    {
      name: 'island touches outer, normalised by difference',
      region: [rect(0, 0, 40, 40), hole(circle(20, 8, 8))],
      offsets: [
        [1, 1],
        [3, 1],
      ],
      normalise: true,
    },
    {
      name: 'tiny segments (1e-5)',
      region: [tinySegments()],
      offsets: [
        [2, 1],
        [-2, 1],
      ],
    },
    ...svgCases(),
  ]
}

export interface BoolCase {
  name: string
  op: 'union' | 'difference'
  a: Loop
  b: Loop
  area: number
  loops: number | null
}

const rrectArea = (w: number, h: number, r: number): number => w * h - (4 - Math.PI) * r * r

export const boolCases: BoolCase[] = [
  {
    name: 'rect ∪ circle',
    op: 'union',
    a: rect(0, 0, 40, 20),
    b: circle(40, 20, 10),
    area: 800 + 75 * Math.PI,
    loops: 1,
  },
  {
    name: 'rounded rect − circle (notch)',
    op: 'difference',
    a: rect(0, 0, 40, 20, 3),
    b: circle(40, 10, 6),
    area: rrectArea(40, 20, 3) - 18 * Math.PI,
    loops: 1,
  },
  {
    name: 'rect − inner circle (hole)',
    op: 'difference',
    a: rect(0, 0, 40, 20),
    b: circle(20, 10, 5),
    area: 800 - 25 * Math.PI,
    loops: 2,
  },
  {
    name: 'tangent discs ∪',
    op: 'union',
    a: circle(0, 0, 10),
    b: circle(20, 0, 10),
    area: 200 * Math.PI,
    loops: null,
  },
  {
    name: 'collinear edges ∪',
    op: 'union',
    a: rect(0, 0, 20, 10),
    b: rect(10, 0, 20, 10),
    area: 300,
    loops: 1,
  },
  {
    name: 'near-coincident ∪ (1e-7)',
    op: 'union',
    a: rect(0, 0, 30, 20, 4),
    b: rect(1e-7, 0, 30, 20, 4),
    area: rrectArea(30, 20, 4) + 2e-6,
    loops: 1,
  },
]
