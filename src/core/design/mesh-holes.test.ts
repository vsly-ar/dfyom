// Holes of a reference mesh (DF60 P3): detection on parts evaluated from drillings and hole
// features (through, flat and cone bottoms; counterbore and countersink mouths), bosses, grid
// and circle patterns, suggestions that round-trip through the design commands, and the
// enclosure's four countersunk foot holes.
// Spec: docs/modes/reference-tools.md#test-plans (P3 holes)
import { beforeAll, describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { faceFrame, type Direction } from '../geometry/face'
import { evaluatePart } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import type { SolidKernel } from '../geometry/solid-port'
import { nodeManifoldSource } from '../geometry/testing/node-wasm'
import { designSetup, type DesignSetup } from './design.fixture'
import { partGeometryInput } from './load'
import {
  csAngle,
  fastenerFor,
  holeGroups,
  holeSuggestion,
  meshHoles,
  type MeshHole,
} from './mesh-holes'
import { sectionMatrix } from './reference'
import { createStlParser, STL_LIMITS, StlPositions } from './stl'
import { ENCLOSURE_FULL_TRIANGLES, enclosureFullStl, soupOf } from './stl.testing'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const STOCK = { length: 100, width: 60, thickness: 20 }
const OPTIONS = { maxDiameter: 50, limit: 64 }

let kernel: SolidKernel
beforeAll(async () => {
  kernel = expectOk(await loadManifold(nodeManifoldSource()))
})

/** The evaluated part as a triangle soup (part frame, mm). */
function partSoup(s: DesignSetup): Float32Array {
  const input = expectOk(partGeometryInput(s.d.doc, s.partId))
  const ev = expectOk(kernel.withSolids((solids) => evaluatePart(input, solids)))
  return soupOf(ev.positions, ev.indices)
}

/** The part soup → a stock face's frame. */
const frameOf = (d: Direction) => sectionMatrix(IDENTITY, faceFrame(d, STOCK))
const holesOf = (soup: Float32Array, d: Direction = '+z') =>
  expectOk(meshHoles(soup, frameOf(d), OPTIONS)).holes
const at = (holes: readonly MeshHole[], u: number, v: number) => {
  const h = holes.find((x) => Math.hypot(x.center[0] - u, x.center[1] - v) < 0.05)
  expect(h, `a hole at ${u}, ${v}`).toBeDefined()
  return h!
}

/** A cylinder (prism over a 64-gon) as a closed soup: a boss, no hole. */
function cylinderSoup(r: number, h: number, hole = 0): number[] {
  const out: number[] = []
  const n = 64
  const ring = (rr: number, k: number): [number, number] => [
    rr * Math.cos((2 * Math.PI * (k % n)) / n),
    rr * Math.sin((2 * Math.PI * (k % n)) / n),
  ]
  for (let k = 0; k < n; k++) {
    const [ax, ay] = ring(r, k)
    const [bx, by] = ring(r, k + 1)
    out.push(ax, ay, 0, bx, by, 0, bx, by, h, ax, ay, 0, bx, by, h, ax, ay, h)
    if (hole > 0) {
      const [cx, cy] = ring(hole, k)
      const [dx, dy] = ring(hole, k + 1)
      out.push(dx, dy, 0, cx, cy, 0, cx, cy, h, dx, dy, 0, cx, cy, h, dx, dy, h)
      // annular caps
      out.push(ax, ay, h, bx, by, h, dx, dy, h, ax, ay, h, dx, dy, h, cx, cy, h)
      out.push(bx, by, 0, ax, ay, 0, cx, cy, 0, bx, by, 0, cx, cy, 0, dx, dy, 0)
    } else {
      out.push(0, 0, h, ax, ay, h, bx, by, h, 0, 0, 0, bx, by, 0, ax, ay, 0)
    }
  }
  return out
}

describe('meshHoles on evaluated parts', () => {
  let s: DesignSetup
  let soup: Float32Array
  beforeAll(async () => {
    s = await designSetup()
    const drill = (center: [string, string], diameter: string, extra: object = {}) =>
      s.run('design.drilling.add', { partId: s.partId, center, diameter, ...extra })
    await drill(['15', '15'], '5', { bottom: 'through' })
    await drill(['35', '15'], '4', { bottom: 'flat', depth: '6' })
    await drill(['55', '15'], '6', { bottom: 'drillPoint', depth: '8' })
    await s.run('design.hole.add', {
      partId: s.partId,
      center: ['15', '42'],
      type: 'counterbore',
      diameter: '3.4',
      cbDiameter: '6.5',
      cbDepth: '3.2',
    })
    await s.run('design.hole.add', {
      partId: s.partId,
      center: ['40', '42'],
      type: 'countersink',
      diameter: '3.4',
      csDiameter: '6.72',
      csAngle: '90',
    })
    soup = partSoup(s)
  })

  it('reads through, flat and cone bottoms', () => {
    const holes = holesOf(soup)
    const through = at(holes, 15, 15)
    expect(through).toMatchObject({ bottom: 'through', top: expect.closeTo(0, 3) })
    expect(through.diameter).toBeCloseTo(5, 1)
    expect(through.mouth).toBeUndefined()
    const flat = at(holes, 35, 15)
    expect(flat.bottom).toBe('flat')
    expect(flat.depth).toBeCloseTo(6, 2)
    const cone = at(holes, 55, 15)
    expect(cone.bottom).toBe('cone')
    expect(cone.depth).toBeCloseTo(8, 1)
    expect(cone.coneAngle).toBeCloseTo(118, 0)
  })

  it('reads a counterbore and a countersink mouth (angle within 1°)', () => {
    const holes = holesOf(soup)
    const cb = at(holes, 15, 42)
    expect(cb.bottom).toBe('through')
    expect(cb.diameter).toBeCloseTo(3.4, 1)
    expect(cb.mouth).toMatchObject({ type: 'counterbore' })
    if (cb.mouth?.type !== 'counterbore') throw new Error('counterbore')
    expect(cb.mouth.diameter).toBeCloseTo(6.5, 1)
    expect(cb.mouth.depth).toBeCloseTo(3.2, 2)
    const cs = at(holes, 40, 42)
    if (cs.mouth?.type !== 'countersink') throw new Error('countersink')
    expect(Math.abs(cs.mouth.angle - 90)).toBeLessThan(1)
    expect(cs.mouth.diameter).toBeCloseTo(6.72, 1)
    expect(cs.diameter).toBeCloseTo(3.4, 1)
  })

  it('from the bottom, the through holes open there and the blind ones are absent', () => {
    const holes = holesOf(soup, '-z')
    // the bottom's face frame mirrors v: the 5 mm through hole and both hole features remain
    expect(holes.map((h) => Math.round(h.diameter * 10) / 10).sort()).toEqual([3.4, 3.4, 5])
    for (const h of holes) expect(h.mouth).toBeUndefined()
  })

  it('suggestions round-trip: the suggested calls give a part with the same holes', async () => {
    const groups = holeGroups(holesOf(soup)).groups
    const t = await designSetup()
    for (const g of groups)
      for (const c of g.holes) {
        const sug = holeSuggestion({ ...g, holes: [c], count: 1 }, 'stock.top')
        expect(sug.note).toBeUndefined()
        await t.run(sug.command, { partId: t.partId, ...sug.args })
        for (const a of sug.also ?? []) await t.run(sug.command, { partId: t.partId, ...a })
      }
    const again = holesOf(partSoup(t))
    for (const h of holesOf(soup)) {
      const k = at(again, h.center[0], h.center[1])
      expect(Math.abs(k.diameter - h.diameter)).toBeLessThanOrEqual(0.02)
      expect(k.bottom).toBe(h.bottom)
      if (h.bottom !== 'through') expect(Math.abs(k.depth - h.depth)).toBeLessThanOrEqual(0.02)
      expect(k.mouth?.type).toBe(h.mouth?.type)
      if (h.mouth !== undefined && k.mouth !== undefined)
        expect(Math.abs(k.mouth.diameter - h.mouth.diameter)).toBeLessThanOrEqual(0.02)
    }
  })
})

describe('bosses and tubes', () => {
  it('a boss (an outer circle) is not a hole; a tube’s bore is', () => {
    expect(holesOf(Float32Array.from(cylinderSoup(5, 10)), '+z')).toEqual([])
    const tube = expectOk(
      meshHoles(
        Float32Array.from(cylinderSoup(5, 10, 2)),
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1],
        OPTIONS,
      ),
    ).holes
    expect(tube).toHaveLength(1)
    expect(tube[0]!.bottom).toBe('through')
    expect(tube[0]!.diameter).toBeCloseTo(4, 1)
  })
})

describe('holeGroups and suggestions', () => {
  const hole = (u: number, v: number, extra: Partial<MeshHole> = {}): MeshHole => ({
    center: [u, v],
    diameter: 3.4,
    top: 0,
    depth: 20,
    bottom: 'through',
    ...extra,
  })

  it('a 2 × 2 grid: origin, pitch, count, a Clones grid row from the first hole', () => {
    const { groups } = holeGroups([hole(30, 10), hole(10, 10), hole(30, 25), hole(10, 25)])
    expect(groups).toHaveLength(1)
    const g = groups[0]!
    expect(g.pattern).toEqual({ kind: 'grid', origin: [10, 10], pitch: [20, 15], count: [2, 2] })
    expect(g.holes[0]).toEqual([10, 10])
    const sug = holeSuggestion(g, 'stock.top')
    expect(sug).toMatchObject({
      command: 'design.drilling.add',
      args: { on: 'stock.top', center: ['10 mm', '10 mm'], diameter: '3.4 mm', bottom: 'through' },
      clones: { rows: [{ kind: 'grid', cols: 2, rows: 2, du: '20 mm', dv: '15 mm' }] },
    })
  })

  it('a 6-hole circle: centre, pitch diameter, start angle and a full arc row', () => {
    const holes = Array.from({ length: 6 }, (_, k) => {
      const a = ((30 + 60 * k) * Math.PI) / 180
      return hole(50 + 20 * Math.cos(a), 30 + 20 * Math.sin(a))
    })
    const g = holeGroups(holes).groups[0]!
    expect(g.pattern?.kind).toBe('circle')
    if (g.pattern?.kind !== 'circle') throw new Error('circle')
    expect(g.pattern.center[0]).toBeCloseTo(50, 6)
    expect(g.pattern.pitchDiameter).toBeCloseTo(40, 6)
    expect(g.pattern.startAngle).toBeCloseTo(30, 6)
    expect(g.holes[0]![0]).toBeCloseTo(50 + 20 * Math.cos(Math.PI / 6), 6)
    expect(holeSuggestion(g, 'stock.top').clones).toEqual({
      rows: [{ kind: 'arc', radius: '20 mm', angle: '210°', arc: '360°', step: '60°' }],
    })
  })

  it('an irregular set is a list; different sizes are different groups', () => {
    const { groups } = holeGroups([
      hole(10, 10),
      hole(31, 10),
      hole(10, 27),
      hole(5, 5, { diameter: 5 }),
    ])
    expect(groups.map((g) => [g.size.diameter, g.count, g.pattern])).toEqual([
      [5, 1, undefined],
      [3.4, 3, undefined],
    ])
  })

  it('a countersunk group is a Bolt hole with the fastener whose clearance is within 0.1 mm', () => {
    const g = holeGroups([
      hole(10, 10, {
        diameter: 2.447,
        mouth: { type: 'countersink', diameter: 4.861, angle: 82.85 },
      }),
    ]).groups[0]!
    expect(holeSuggestion(g, 'stock.bottom')).toEqual({
      command: 'design.hole.add',
      args: {
        on: 'stock.bottom',
        center: ['10 mm', '10 mm'],
        type: 'countersink',
        csDiameter: '4.861 mm',
        csAngle: '82°',
        fastener: 'M2',
        fit: 'normal',
        diameter: '2.447 mm',
        bottom: 'through',
      },
    })
    expect(csAngle(88.5)).toBe(90)
    expect(csAngle(95)).toBe(95)
    expect(fastenerFor(1.33)).toBeUndefined()
  })

  it('a mouth below the face: depths from the mouth, note belowFace', () => {
    const g = holeGroups([
      hole(10, 10, {
        top: 4,
        depth: 10,
        bottom: 'flat',
        mouth: { type: 'counterbore', diameter: 6.5, depth: 7.2 },
      }),
    ]).groups[0]!
    expect(holeSuggestion(g, 'stock.top')).toMatchObject({
      note: 'belowFace',
      args: { cbDepth: '3.2 mm', depth: '6 mm', bottom: 'flat' },
    })
  })

  it('a stepped hole is a Drilling per band, widest first', () => {
    const g = holeGroups([
      hole(10, 10, {
        diameter: 3,
        depth: 12,
        bottom: 'flat',
        steps: [
          { diameter: 8, depth: 2 },
          { diameter: 5, depth: 6 },
          { diameter: 3, depth: 12 },
        ],
      }),
    ]).groups[0]!
    const sug = holeSuggestion(g, 'stock.top')
    expect(sug.args).toMatchObject({ diameter: '8 mm', depth: '2 mm', bottom: 'flat' })
    expect(sug.also).toMatchObject([
      { diameter: '5 mm', depth: '6 mm' },
      { diameter: '3 mm', depth: '12 mm' },
    ])
  })
})

describe('the enclosure (full body fixture)', () => {
  it('the four foot holes from the bottom: one countersunk group, grid 2 × 2 at (±88.53, ±44.27)', () => {
    const bytes = enclosureFullStl()
    const keep = new StlPositions(ENCLOSURE_FULL_TRIANGLES)
    const p = expectOk(createStlParser(bytes.length, STL_LIMITS, keep.add))
    expectOk(p.push(bytes))
    expectOk(p.finish())
    // the bottom face frame of the STL as it lies (z 0 at the bottom): u = x, v = −y, w = −z
    const bottom = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]
    const t0 = performance.now()
    const r = expectOk(meshHoles(keep.positions(), bottom, OPTIONS))
    const ms = performance.now() - t0
    const { groups } = holeGroups(r.holes)
    expect(groups).toHaveLength(1)
    const g = groups[0]!
    expect(g.count).toBe(4)
    expect(g.pattern).toMatchObject({ kind: 'grid', count: [2, 2] })
    for (const c of g.holes) {
      expect(Math.abs(c[0])).toBeCloseTo(88.53, 2)
      expect(Math.abs(c[1])).toBeCloseTo(44.27, 2)
    }
    expect(g.size.diameter).toBeCloseTo(2.447, 2)
    expect(g.size.mouth).toMatchObject({ type: 'countersink' })
    // the foot holes are blind: they end 0.24 mm under the cavity floor
    expect(g.size.bottom).toBe('flat')
    expect(g.size.depth).toBeCloseTo(3.944, 2)
    expect(holeSuggestion(g, 'stock.bottom')).toMatchObject({
      command: 'design.hole.add',
      args: { type: 'countersink', fastener: 'M2', csAngle: '82°' },
      clones: { rows: [{ kind: 'grid', cols: 2, rows: 2 }] },
    })
    expect(ms).toBeLessThan(5000) // ≈ 0.2 s on the dev machine
  })
})
