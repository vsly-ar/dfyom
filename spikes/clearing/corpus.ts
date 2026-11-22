// Spike S4 (docs/research/s4-offset-clearing.md): pockets from S1's corpus (spikes/2d/corpus.ts)
// plus an acute triangle for the step cap. Outer loops counter-clockwise, islands clockwise, mm;
// every fixture is moved so its bounding box starts at (MARGIN, MARGIN) (the heightmap's origin).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Candidate } from '../2d/candidates.ts'
import { circle, dumbbell, hole, rect, star } from '../2d/corpus.ts'
import { transform, type Loop } from '../2d/geom.ts'
import { parseSvg } from '../2d/svg.ts'
import { bbox } from './coverage.ts'

export const MARGIN = 5

export interface Pocket {
  readonly name: string
  readonly region: Loop[]
  readonly size: { length: number; width: number }
}

function place(name: string, region: Loop[]): Pocket {
  const b = bbox(region)
  const moved = region.map((l) =>
    transform(l, (p) => ({ x: p.x - b.minX + MARGIN, y: p.y - b.minY + MARGIN })),
  )
  return {
    name,
    region: moved,
    size: { length: b.maxX - b.minX + 2 * MARGIN, width: b.maxY - b.minY + 2 * MARGIN },
  }
}

/** Isosceles triangle with apex angle `deg` and the given base, sharp corners. */
function triangle(deg: number, base: number): Loop {
  const h = base / 2 / Math.tan((deg * Math.PI) / 360)
  return {
    closed: true,
    verts: [
      [0, 0, 0],
      [base, 0, 0],
      [base / 2, h, 0],
    ],
  }
}

const svg = (f: string) =>
  parseSvg(readFileSync(join(import.meta.dirname, '..', '2d', 'corpus', f), 'utf8'), 0.005)

export function pockets(cc: Candidate): Pocket[] {
  // S1: an island touching the outer loop is normalised by the boolean before offsetting (ADR 0019)
  const touching = cc.difference(rect(0, 0, 40, 40), circle(20, 8, 8))
  return [
    place('pocket, 2 islands', [
      rect(0, 0, 120, 80, 6),
      hole(circle(35, 40, 10)),
      hole(rect(70, 25, 30, 30, 4)),
    ]),
    place('neck 4 mm (< D)', [dumbbell(2)]),
    place('neck 10 mm (splits)', [dumbbell(5)]),
    place('star 200 + 2 islands', star(200)),
    place('triangle 30°', [triangle(30, 40)]),
    // 8 mm wide: the Ø 4.8 helix needs 4.8 + D = 10.8 mm, so the entry ramps along the ring
    place('slot 8 × 60', [rect(0, 0, 60, 8, 1)]),
    place('island touches outer (normalised)', touching),
    place('svg/bracket', svg('bracket.svg')),
    place('svg/gear', svg('gear.svg')),
    place('svg/letter-d', svg('letter-d.svg')),
    place('svg/heart', svg('heart.svg')),
  ]
}
