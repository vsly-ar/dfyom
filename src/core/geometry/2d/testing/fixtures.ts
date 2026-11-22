/**
 * Spike S1's correctness fixtures (spikes/2d/corpus.ts, ADR 0019) as 2D model loops, for the port
 * tests and perf checks. Outer loops counter-clockwise, holes clockwise, millimetres.
 * The SVG corpus (spikes/2d/corpus/*.svg) is stored as the spike parser's bulge loops
 * (`__fixtures__/svg-corpus.json`); the real importer replaces that parser in I1.
 */
import type { Vec2 } from '../../model'
import { reverseLoop, type Loop } from '../model'
import { fromWire } from '../wire'
import svgCorpus from '../__fixtures__/svg-corpus.json'

type Vertex = readonly [number, number, number]

/** A loop or path from bulge vertices (x, y, bulge of the element starting there). */
export function bulgeLoop(verts: readonly Vertex[], closed = true): Loop {
  return fromWire({ closed, v: verts.flat() }, 'fixture').expect('fixture loop')
}

const Q = Math.tan(Math.PI / 8) // bulge of a 90° arc

export function rect(x: number, y: number, w: number, h: number, r = 0): Loop {
  if (r <= 0)
    return bulgeLoop([
      [x, y, 0],
      [x + w, y, 0],
      [x + w, y + h, 0],
      [x, y + h, 0],
    ])
  return bulgeLoop([
    [x + r, y, 0],
    [x + w - r, y, Q],
    [x + w, y + r, 0],
    [x + w, y + h - r, Q],
    [x + w - r, y + h, 0],
    [x + r, y + h, Q],
    [x, y + h - r, 0],
    [x, y + r, Q],
  ])
}

export const circle = (cx: number, cy: number, r: number): Loop =>
  bulgeLoop([
    [cx - r, cy, 1],
    [cx + r, cy, 1],
  ])

export const hole = (l: Loop): Loop => reverseLoop(l)

/** Two Ø30 discs joined by a neck of width 2·h: offsets above h must split the loop. */
export function dumbbell(h: number): Loop {
  const r = 15
  const x = Math.sqrt(r * r - h * h)
  const b = Math.tan((2 * Math.PI - 2 * Math.asin(h / r)) / 4)
  return bulgeLoop([
    [x, -h, 0],
    [50 - x, -h, b],
    [50 - x, h, 0],
    [x, h, b],
  ])
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
  return bulgeLoop(verts)
}

/** Two squares joined at one corner within a single loop (the boundary touches itself). */
export const bowtieSquares = (): Loop =>
  bulgeLoop([
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
    [20, 10, 0],
    [20, 20, 0],
    [10, 20, 0],
    [10, 10, 0],
    [0, 10, 0],
  ])

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
  return bulgeLoop(verts)
}

/**
 * Speed fixture with `n` segments: a star with filleted points (half lines, half arcs) and two
 * islands (a circle and a rounded rectangle). Returns [outer, hole, hole].
 */
export function star(n: number): Loop[] {
  const k = Math.max(3, Math.round(n / 4))
  const corners: Vec2[] = []
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
  return [bulgeLoop(verts), hole(circle(-30, 0, 18)), hole(rect(15, -20, 35, 40, 5))]
}
const norm = (v: Vec2): Vec2 => {
  const l = Math.hypot(v[0], v[1])
  return [v[0] / l, v[1] / l]
}

/** The SVG corpus by name (bracket, gear, heart, letter-d): loops as the spike parsed them. */
export function svgFixtures(): { name: string; loops: Loop[] }[] {
  return Object.entries(svgCorpus as Record<string, number[][][]>).map(([name, loops]) => ({
    name,
    loops: loops.map((verts) => bulgeLoop(verts.map((v) => [v[0]!, v[1]!, v[2]!] as const))),
  }))
}
