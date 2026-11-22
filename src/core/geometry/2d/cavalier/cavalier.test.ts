// The 2D port on the vendored CavalierContours module, against spike S1's correctness fixtures
// (ADR 0019) and the offset oracle. Doc: docs/architecture/shapes.md#2d-port
import { describe, expect, it } from 'vitest'
import { expectErrCode as expectErr } from '../../../../shared/testing/result'
import type { Vec2 } from '../../model'
import {
  arc,
  line,
  OFFSET_EPSILON,
  regionArea,
  regionLoops,
  signedArea,
  type Loop,
  type Region,
} from '../model'
import {
  bowtieSquares,
  bulgeLoop,
  circle,
  dumbbell,
  hole,
  rect,
  star,
  svgFixtures,
  tinySegments,
  wave,
} from '../testing/fixtures'
import { nodeCavalierWasm, nodeRegion2d } from '../testing/node-wasm'
import { crossings, maxOffsetError } from '../testing/oracles'
import { Ok } from '../../../../shared/result'
import { loadCavalierSync } from './binding'
import { createCavalierPort, loadRegion2d, loadRegion2dSync } from '.'

const port = nodeRegion2d()
// 1 nm: near-tangent joins within the library epsilons deviate by |d| · 1e-7 (wave(1e-6))
const ORACLE = 1e-6

const piece = (outer: Loop, ...holes: Loop[]): Region => ({ pieces: [{ outer, holes }] })
const norm = (...loops: Loop[]): Region => port.normalise(loops).unwrap()

/** Every loop counter-clockwise as an outer, clockwise as a hole; no crossings. */
function expectValid(r: Region): void {
  for (const p of r.pieces) {
    expect(signedArea(p.outer)).toBeGreaterThan(0)
    for (const h of p.holes) expect(signedArea(h)).toBeLessThan(0)
  }
  expect(crossings(regionLoops(r))).toBe(0)
}

function offsetCase(region: Region, d: number, loops?: number): Region {
  const out = port.offset(region, d).unwrap()
  expectValid(out)
  if (loops !== undefined) expect(regionLoops(out)).toHaveLength(loops)
  expect(maxOffsetError(regionLoops(region), regionLoops(out), d)).toBeLessThan(ORACLE)
  return out
}

const kinds = (r: Region) => {
  let arcs = 0
  let lines = 0
  for (const l of regionLoops(r))
    for (const e of l.elements) {
      if (e.kind === 'arc') arcs++
      else lines++
    }
  return { arcs, lines }
}

describe('loading', () => {
  it('loads synchronously and asynchronously from the same bytes', async () => {
    expect(loadRegion2dSync(nodeCavalierWasm()).isOk()).toBe(true)
    expect((await loadRegion2d(nodeCavalierWasm())).isOk()).toBe(true)
  })

  it('refuses bytes that are not the module', async () => {
    expectErr(loadRegion2dSync(new Uint8Array([0, 97, 115, 109])), 'geometry.evaluation')
    expectErr(await loadRegion2d(new Uint8Array([1, 2, 3])), 'geometry.evaluation')
  })
})

describe('offset (spike S1 fixtures)', () => {
  it('pocket with 2 islands: rings, an island merging with the wall, growing', () => {
    const r = norm(rect(0, 0, 120, 80, 6), hole(circle(35, 40, 10)), hole(rect(70, 25, 30, 30, 4)))
    expect(r.pieces).toHaveLength(1)
    const o3 = offsetCase(r, 3, 3)
    expect(kinds(o3)).toEqual({ arcs: 10, lines: 8 })
    offsetCase(r, 8, 3)
    expect(kinds(offsetCase(r, 12, 2))).toEqual({ arcs: 6, lines: 8 })
    offsetCase(r, -2, 3)
  })

  it('a 4 mm neck splits above half its width and stays one loop outward', () => {
    const r = norm(dumbbell(2))
    offsetCase(r, 1.9, 1)
    const split = offsetCase(r, 2.5, 2)
    expect(split.pieces).toHaveLength(2)
    expect(kinds(offsetCase(r, -1, 1))).toEqual({ arcs: 2, lines: 2 })
  })

  it('tangent and near-tangent arcs', () => {
    for (const w of [wave(), wave(1e-6)]) {
      const r = norm(w)
      offsetCase(r, 1, 1)
      offsetCase(r, 3)
      offsetCase(r, -2, 1)
    }
    offsetCase(norm(wave()), 6)
  })

  it('a self-touching loop is split into its lobes, which offset apart', () => {
    const r = norm(bowtieSquares())
    expect(r.pieces).toHaveLength(2)
    offsetCase(r, 1, 2)
    offsetCase(r, -1, 1)
  })

  it('an island touching the outer loop offsets correctly once normalised', () => {
    // the raw region gives a 702 µm error (ADR 0019); normalise subtracts the island first
    const r = norm(rect(0, 0, 40, 40), hole(circle(20, 8, 8)))
    expect(r.pieces).toHaveLength(1)
    expect(r.pieces[0]!.holes).toHaveLength(0)
    offsetCase(r, 1, 1)
    offsetCase(r, 3, 1)
  })

  it('tiny segments are merged and the circle offsets exactly', () => {
    const r = norm(tinySegments())
    offsetCase(r, 2, 1)
    offsetCase(r, -2, 1)
  })

  it('the 2000-segment star with 2 islands', () => {
    const [outer, ...holes] = star(2000)
    offsetCase(norm(outer!, ...holes), 3, 3)
  })

  it('the SVG corpus, inward and outward', () => {
    for (const { name, loops } of svgFixtures()) {
      const r = norm(...loops)
      for (const d of [1, -1.5]) {
        const out = port.offset(r, d).unwrap()
        expectValid(out)
        expect(maxOffsetError(regionLoops(r), regionLoops(out), d), `${name} ${d}`).toBeLessThan(
          ORACLE,
        )
      }
    }
  })

  it('pocket rings until empty: every ring exact, none crossing', () => {
    let ring = offsetCase(norm(...star(200)), 3)
    let count = 1
    while (ring.pieces.length > 0) {
      const next = port.offset(ring, 2.4).unwrap()
      expectValid(next)
      if (next.pieces.length > 0)
        expect(maxOffsetError(regionLoops(ring), regionLoops(next), 2.4)).toBeLessThan(ORACLE)
      ring = next
      count++
    }
    expect(count).toBeGreaterThan(5)
  })

  it('grows an eroded dumbbell by more than its concave arcs radius (they collapse)', () => {
    // the eroded neck ends have concave arcs of radius 3 round the dumbbell's reflex corners;
    // growing by more used to return nothing (plans/v0.3.md, found in T1)
    const eroded = port.offset(norm(dumbbell(2)), 3).unwrap()
    expect(eroded.pieces).toHaveLength(2)
    const exact = offsetCase(eroded, -3, 2)
    const past = offsetCase(eroded, -3.0001, 2)
    expect(regionArea(past)).toBeGreaterThan(regionArea(exact))
    expect(regionArea(offsetCase(eroded, -4, 2))).toBeGreaterThan(regionArea(past))
  })

  /**
   * `d` = r + e past arcs of radius r: never empty, exact (offset oracle) from e = 0.1; closer
   * to r the library's own epsilons apply (near-tangent joins, OFFSET_EPSILON = 1e-4).
   */
  function pastRadius(name: string, region: Region, d: number, e: number, loops?: number): void {
    const out = port.offset(region, d).unwrap()
    expect(out.pieces.length, name).toBeGreaterThan(0)
    expectValid(out)
    if (loops !== undefined) expect(regionLoops(out), name).toHaveLength(loops)
    const tol = Math.abs(e) >= 0.1 ? ORACLE : 2 * OFFSET_EPSILON
    expect(maxOffsetError(regionLoops(region), regionLoops(out), d), name).toBeLessThan(tol)
  }
  const JUST_PAST = [1e-6, 1e-5, 3e-5, 1e-4, 2e-4, 1e-3, 0.1, 1, 3]

  it('openings and closings, offset just past their arcs radius', () => {
    for (const h of [1, 2, 3, 4])
      for (const R of [2.5, 3, 5, 6.35, 8]) {
        const open = port.offset(norm(dumbbell(h)), R).unwrap()
        // a closing of a dumbbell hole: growing the region shrinks the hole, rounding its corners
        const closed = port.offset(norm(rect(-30, -30, 110, 60), hole(dumbbell(h))), -R).unwrap()
        for (const e of JUST_PAST) {
          pastRadius(`open h=${h} R=${R} e=${e}`, open, -(R + e), e)
          pastRadius(`close h=${h} R=${R} e=${e}`, closed, R + e, e)
        }
      }
  })

  it('concave arcs with reflex ends, a concave fillet and convex corners, just past their radius', () => {
    const Q = Math.tan(Math.PI / 8)
    const bite = bulgeLoop([
      [0, 0, 0],
      [8, 0, -1],
      [12, 0, 0],
      [20, 0, 0],
      [20, 20, 0],
      [0, 20, 0],
    ])
    const bites = bulgeLoop([
      [0, 0, 0],
      [6, 0, -1],
      [10, 0, -1],
      [14, 0, 0],
      [20, 0, 0],
      [20, 20, 0],
      [0, 20, 0],
    ])
    const filletL = bulgeLoop([
      [0, 0, 0],
      [20, 0, 0],
      [20, 8, 0],
      [10, 8, -Q],
      [8, 10, 0],
      [8, 20, 0],
      [0, 20, 0],
    ])
    for (const [name, l] of [
      ['bite', bite],
      ['bites', bites],
      ['filletL', filletL],
    ] as const)
      for (const e of [-1e-3, 0, ...JUST_PAST]) pastRadius(`${name} ${e}`, norm(l), -(2 + e), e, 1)
    for (const e of [-1e-3, 0, ...JUST_PAST.filter((x) => x < 3)])
      pastRadius(`rounded rect ${e}`, norm(rect(0, 0, 40, 30, 2)), 2 + e, e, 1)
  })

  it('a growth that loses a piece is redone in steps, and refused if it still does', () => {
    const eroded = port.offset(norm(dumbbell(2)), 3).unwrap()
    const real = loadCavalierSync(nodeCavalierWasm()).unwrap()
    let calls = 0
    // the library returning nothing for every growth
    const failing = createCavalierPort({
      ...real,
      boolean: real.boolean.bind(real),
      plineOffset: real.plineOffset.bind(real),
      shapeOffset: (loops, d) => {
        calls++
        return d < 0 ? Ok([]) : real.shapeOffset(loops, d)
      },
    })
    const err = expectErr(failing.offset(eroded, -4), 'geometry.evaluation')
    expect(err.issues[0]?.rule).toBe('resultInvalid')
    // once, then the first step (by the arcs' radius 3) already loses everything
    expect(calls).toBe(2)
  })

  it('zero offset returns the region; a non-finite offset is refused', () => {
    const r = norm(rect(0, 0, 10, 10))
    expect(port.offset(r, 0).unwrap()).toBe(r)
    expectErr(port.offset(r, Number.NaN), 'geometry.evaluation')
  })
})

describe('booleans', () => {
  const area = (r: Region) => regionArea(r)
  const rrect = (w: number, h: number, r: number) => w * h - (4 - Math.PI) * r * r

  it('loop booleans are exact (spike S1 cases)', () => {
    const cases: [Region, number, number][] = [
      [
        port.union(norm(rect(0, 0, 40, 20)), norm(circle(40, 20, 10))).unwrap(),
        800 + 75 * Math.PI,
        1,
      ],
      [
        port.difference(norm(rect(0, 0, 40, 20, 3)), norm(circle(40, 10, 6))).unwrap(),
        rrect(40, 20, 3) - 18 * Math.PI,
        1,
      ],
      [
        port.difference(norm(rect(0, 0, 40, 20)), norm(circle(20, 10, 5))).unwrap(),
        800 - 25 * Math.PI,
        2,
      ],
      [port.union(norm(rect(0, 0, 20, 10)), norm(rect(10, 0, 20, 10))).unwrap(), 300, 1],
      [
        port.union(norm(rect(0, 0, 30, 20, 4)), norm(rect(1e-7, 0, 30, 20, 4))).unwrap(),
        rrect(30, 20, 4) + 2e-6,
        1,
      ],
    ]
    for (const [r, expected, loops] of cases) {
      expectValid(r)
      expect(regionLoops(r)).toHaveLength(loops)
      expect(Math.abs(area(r) - expected)).toBeLessThan(1e-5)
    }
  })

  it('tangent discs unite without crossings', () => {
    const r = port.union(norm(circle(0, 0, 10)), norm(circle(20, 0, 10))).unwrap()
    expectValid(r)
    expect(Math.abs(area(r) - 200 * Math.PI)).toBeLessThan(1e-6)
  })

  it('intersect, and disjoint inputs', () => {
    const r = port.intersect(norm(rect(0, 0, 20, 20)), norm(rect(10, 10, 20, 20))).unwrap()
    expect(area(r)).toBeCloseTo(100, 9)
    expect(
      port.intersect(norm(rect(0, 0, 1, 1)), norm(rect(5, 5, 1, 1))).unwrap().pieces,
    ).toHaveLength(0)
    expect(port.union(norm(rect(0, 0, 1, 1)), norm(rect(5, 5, 1, 1))).unwrap().pieces).toHaveLength(
      2,
    )
  })

  it('multi-loop regions: holes, a cut through a hole, islands in holes', () => {
    const plate = norm(rect(0, 0, 100, 60), hole(circle(30, 30, 10)), hole(circle(70, 30, 10)))
    expect(area(plate)).toBeCloseTo(6000 - 200 * Math.PI, 6)
    // a slot through both holes joins them into one hole
    const slotted = port.difference(plate, norm(rect(30, 27, 40, 6))).unwrap()
    expectValid(slotted)
    expect(slotted.pieces).toHaveLength(1)
    expect(slotted.pieces[0]!.holes).toHaveLength(1)
    expect(area(slotted)).toBeCloseTo(6000 - 200 * Math.PI - (240 - 2 * holeCap(10, 3)), 6)
    // a cut from the edge into a hole opens it: no holes left on that side
    const opened = port.difference(plate, norm(rect(-1, 28, 32, 4))).unwrap()
    expectValid(opened)
    expect(opened.pieces[0]!.holes).toHaveLength(1)
    // a disc inside a hole is an island piece; a ring around a hole is united with the plate
    const island = port.union(plate, norm(circle(30, 30, 4))).unwrap()
    expectValid(island)
    expect(island.pieces).toHaveLength(2)
    expect(area(island)).toBeCloseTo(area(plate) + 16 * Math.PI, 6)
    // the union of a region with holes and one that fills a hole
    const filled = port.union(plate, norm(circle(30, 30, 12))).unwrap()
    expectValid(filled)
    expect(filled.pieces[0]!.holes).toHaveLength(1)
    // intersect with a region that has a hole
    const ring = norm(circle(30, 30, 20), hole(circle(30, 30, 15)))
    const both = port.intersect(plate, ring).unwrap()
    expectValid(both)
    expect(area(both)).toBeCloseTo((400 - 225) * Math.PI, 6)
    // difference by a region with a hole keeps what lies in that hole
    const cut = port.difference(norm(rect(10, 10, 40, 40)), ring).unwrap()
    expectValid(cut)
    expect(area(cut)).toBeCloseTo(1600 - (400 - 225) * Math.PI, 6)
  })

  it('normalise: nesting by area, overlapping outer loops united', () => {
    // outer, hole, island in the hole
    const r = norm(island(circle(0, 0, 4)), rect(-20, -20, 40, 40), hole(circle(0, 0, 10)))
    expect(r.pieces).toHaveLength(2)
    expect(regionArea(r)).toBeCloseTo(1600 - 100 * Math.PI + 16 * Math.PI, 6)
    const u = norm(rect(0, 0, 10, 10), rect(5, 5, 10, 10), rect(30, 0, 5, 5))
    expect(u.pieces).toHaveLength(2)
    expect(regionArea(u)).toBeCloseTo(175 + 25, 9)
  })
})

/** Area of the circular segment of a circle of radius r cut by a chord at half-width w. */
function holeCap(r: number, w: number): number {
  // area of the circle inside the slot band |y| ≤ w
  const t = Math.asin(w / r)
  return r * r * (t + Math.sin(t) * Math.cos(t))
}
const island = (l: Loop) => l

describe('offsetPath (on grooves)', () => {
  it('a straight path gives a stadium', () => {
    const r = port.offsetPath({ elements: [line([0, 0], [10, 0])] }, 2).unwrap()
    expectValid(r)
    expect(regionLoops(r)).toHaveLength(1)
    expect(regionArea(r)).toBeCloseTo(40 + 4 * Math.PI, 9)
    expect(maxOffsetError([{ elements: [line([0, 0], [10, 0])] }], regionLoops(r), 2)).toBeLessThan(
      ORACLE,
    )
  })

  it('an L path, an arc path and a U path that encloses a hole', () => {
    const paths: [Loop, number][] = [
      [{ elements: [line([0, 0], [20, 0]), line([20, 0], [20, 15])] }, 3],
      [{ elements: [arc([10, 0], [-10, 0], [0, 0], true)] }, 2],
      [{ elements: [arc([10, 0], [-10, 0], [0, 0], true)] }, 12], // band wider than the radius
      [
        bulgeLoop(
          [
            [0, 0, 0],
            [30, 0, 0],
            [30, 30, 0],
            [0, 30, 0],
            [0, 2, 0],
          ],
          false,
        ),
        1.5,
      ],
    ]
    for (const [path, d] of paths) {
      const r = port.offsetPath(path, d).unwrap()
      expectValid(r)
      expect(maxOffsetError([path], regionLoops(r), d)).toBeLessThan(ORACLE)
    }
    const u = port.offsetPath(paths[3]![0], 1.5).unwrap()
    expect(u.pieces[0]!.holes).toHaveLength(1)
  })

  it('refuses a non-positive half-width', () => {
    expectErr(port.offsetPath({ elements: [line([0, 0], [1, 0])] }, 0), 'geometry.evaluation')
  })
})

describe('input checks', () => {
  it('refuses broken chains, invalid arcs and non-finite points', () => {
    const broken: Loop = { elements: [line([0, 0], [1, 0]), line([1, 0.1], [0, 0])] }
    const e1 = expectErr(port.normalise([broken, rect(0, 0, 1, 1)]), 'geometry.evaluation')
    expect(e1.issues[0]?.rule).toBe('notChained')
    const badArc: Loop = { elements: [arc([0, 0], [10, 0], [4, 1], true), line([10, 0], [0, 0])] }
    expect(expectErr(port.offset(piece(badArc), 1), 'geometry.evaluation').issues[0]?.rule).toBe(
      'arcInvalid',
    )
    const nan: Loop = { elements: [line([0, 0], [Number.NaN, 0]), line([Number.NaN, 0], [0, 0])] }
    expect(expectErr(port.offset(piece(nan), 1), 'geometry.evaluation').issues[0]?.rule).toBe(
      'notFinite',
    )
  })

  it('a full circle as one arc element', () => {
    const full: Loop = { elements: [arc([5, 0], [5, 0], [0, 0], true)] }
    expect(signedArea(full)).toBeCloseTo(25 * Math.PI, 12)
    const r = port.offset(norm(full), 1).unwrap()
    expect(regionArea(r)).toBeCloseTo(16 * Math.PI, 9)
  })
})

describe('measures', () => {
  const sq = rect(0, 0, 10, 10, 2)

  it('length and points along a loop or path', () => {
    expect(port.length(sq)).toBeCloseTo(4 * 6 + 2 * Math.PI * 2, 12)
    const p = port.pointAt(sq, 3, true).unwrap()
    expect(p.point[0]).toBeCloseTo(5, 12)
    expect(p.point[1]).toBeCloseTo(0, 12)
    expect(p.tangent).toEqual([1, 0])
    // wraps on a loop
    const q = port.pointAt(sq, 3 + port.length(sq), true).unwrap()
    expect(q.point[0]).toBeCloseTo(5, 9)
    const path: Loop = { elements: [line([0, 0], [10, 0])] }
    expect(expectErr(port.pointAt(path, 11, false), 'geometry.evaluation').issues[0]?.rule).toBe(
      'outOfRange',
    )
    // on an arc: a quarter of the fillet
    const mid = port.pointAt(sq, 6 + Math.PI / 2, true).unwrap()
    const c: Vec2 = [8, 2]
    expect(Math.hypot(mid.point[0] - c[0], mid.point[1] - c[1])).toBeCloseTo(2, 12)
  })

  it('contains and distance', () => {
    const r = norm(rect(0, 0, 20, 20), hole(circle(10, 10, 4)))
    expect(port.contains(r, [2, 2])).toBe(true)
    expect(port.contains(r, [10, 10])).toBe(false)
    expect(port.contains(r, [30, 10])).toBe(false)
    expect(port.contains(r, [0, 5])).toBe(true) // boundary
    expect(port.contains(r, [10, 6.5])).toBe(false) // in the hole, near its arc
    expect(port.contains(r, [10, 5.5])).toBe(true)
    const d = port.distance(regionLoops(r), [10, 10])!
    expect(d.distance).toBeCloseTo(4, 12)
    expect(port.distance([], [0, 0])).toBeUndefined()
  })
})

describe('library failures', () => {
  it('stays usable after many calls (no leak of input buffers)', () => {
    const r = norm(rect(0, 0, 50, 50, 5))
    for (let i = 0; i < 2000; i++) port.offset(r, 1).unwrap()
    expect(port.offset(r, 1).unwrap().pieces).toHaveLength(1)
  })
})
