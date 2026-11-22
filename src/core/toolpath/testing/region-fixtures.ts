/**
 * Regions and paths for the region generators' tests (T1, T2, T3): spike S4's corpus (the pocket
 * with two islands, necks, the star, the 30° triangle, the 8 × 60 slot, the SVG shapes), T2's
 * bracket and hook, and T3's seeded random regions drawn from that corpus.
 * Doc: docs/modes/plan-v0.3.md#tests. Test-only.
 */
import type { Vec2 } from '../../geometry/model'
import { line, type Element, type Loop } from '../../geometry/2d/model'
import {
  bulgeLoop,
  circle,
  dumbbell,
  hole,
  rect,
  star,
  svgFixtures,
} from '../../geometry/2d/testing/fixtures'

const Q = Math.tan(Math.PI / 8) // bulge of a 90° arc

/** Isosceles triangle with apex angle `deg` (S4's acute-corner case). */
export function triangle(deg: number, base: number): Loop {
  const h = base / 2 / Math.tan((deg * Math.PI) / 360)
  const a: Vec2 = [0, 0]
  const b: Vec2 = [base, 0]
  const c: Vec2 = [base / 2, h]
  return { elements: [line(a, b), line(b, c), line(c, a)] }
}

/** S4's pocket with two islands: a rounded 120 × 80 rectangle, a Ø20 disc, a rounded square. */
export const twoIslands = (): Loop[] => [
  rect(0, 0, 120, 80, 6),
  hole(circle(35, 40, 10)),
  hole(rect(70, 25, 30, 30, 4)),
]

/** S4's 8 × 60 slot (corner radius 1): the Ø 4.8 helix does not fit, the entry ramps. */
export const slot = (): Loop[] => [rect(0, 0, 60, 8, 1)]

/**
 * A bracket of lines and arcs, counter-clockwise from (0, 0): a convex corner arc (r 10 round
 * (50, 10)) and a concave notch arc (r 10 round (30, 40)).
 */
export const bracket = (dx = 0, dy = 0): Loop =>
  bulgeLoop([
    [dx, dy, 0],
    [dx + 50, dy, Q],
    [dx + 60, dy + 10, 0],
    [dx + 60, dy + 40, 0],
    [dx + 40, dy + 40, -Q],
    [dx + 30, dy + 30, 0],
    [dx, dy + 30, 0],
  ])

/** An open path: a line, a quarter arc, a line (an S-free hook). */
export const hook = (dx = 0, dy = 0): Loop =>
  bulgeLoop(
    [
      [dx, dy, 0],
      [dx + 30, dy, Q],
      [dx + 40, dy + 10, 0],
      [dx + 40, dy + 30, 0],
    ],
    false,
  )

/** The spike's SVG bracket (S1 corpus `bracket.svg`), its outer loop. */
export function svgBracket(): Loop {
  return svgFixtures().find((f) => f.name === 'bracket')!.loops[0]!
}

/** Seeded pseudo-random numbers in [0, 1) (the v0.1 tests' generator). */
export function random(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31
    return s / 2 ** 31
  }
}

/** Loops scaled by `k` and turned by `angle` (rad) about the origin; arcs keep their sense. */
export function turnLoops(loops: readonly Loop[], angle: number, k: number): Loop[] {
  const c = Math.cos(angle) * k
  const s = Math.sin(angle) * k
  const t = (p: Vec2): Vec2 => [c * p[0] - s * p[1], s * p[0] + c * p[1]]
  return loops.map((l) => ({
    elements: l.elements.map((e): Element =>
      e.kind === 'line'
        ? { kind: 'line', a: t(e.a), b: t(e.b) }
        : { kind: 'arc', a: t(e.a), b: t(e.b), centre: t(e.centre), ccw: e.ccw },
    ),
  }))
}

/** A named region of the corpus (outer loops counter-clockwise, holes clockwise, mm). */
export interface CorpusRegion {
  readonly name: string
  readonly loops: Loop[]
}

/**
 * S4's pocket corpus (spikes/clearing/corpus.ts) with the triangle and the slot; the star at a
 * quarter of its size, so a heightmap over it stays fast.
 */
export function pocketCorpus(): CorpusRegion[] {
  const svg = svgFixtures()
  return [
    { name: 'pocket, 2 islands', loops: twoIslands() },
    { name: 'neck 4 mm', loops: [dumbbell(2)] },
    { name: 'neck 10 mm', loops: [dumbbell(5)] },
    { name: 'star 200 + 2 islands (¼ size)', loops: turnLoops(star(200), 0, 0.25) },
    { name: 'triangle 30°', loops: [triangle(30, 40)] },
    { name: 'slot 8 × 60', loops: slot() },
    ...svg.map((f) => ({ name: `svg/${f.name}`, loops: f.loops })),
  ]
}

/**
 * Seeded random regions from the corpus: a corpus region (seed order, so every one comes up),
 * turned by a random angle and scaled by 0.6–1.2 (the slot and necks stay ≥ their tool-relevant
 * widths at 0.75–1.2).
 */
export function randomRegion(seed: number): CorpusRegion & { angle: number; scale: number } {
  const corpus = pocketCorpus()
  const rnd = random(seed * 7919 + 17)
  const base = corpus[seed % corpus.length]!
  const narrow = /neck|slot|triangle/.test(base.name)
  const angle = rnd() * 2 * Math.PI
  const scale = narrow ? 0.75 + rnd() * 0.45 : 0.6 + rnd() * 0.6
  return { name: base.name, loops: turnLoops(base.loops, angle, scale), angle, scale }
}
