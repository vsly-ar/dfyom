/**
 * Spike S3 tests and measurements (report: spikes/prisms/results.md). Run:
 * `npx vitest run -c spikes/prisms/vitest.config.mts` (prints the cost and sliver tables).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { Direction } from '../../src/core/geometry/face'
import type { StockGeometry, Vec2 } from '../../src/core/geometry/model'
import {
  evaluateShapes,
  loadSpike,
  type Evaluation,
  type ShapePocket,
  type Spike,
} from './evaluate'
import type { PlacementMode } from './prism'
import {
  circle,
  elementCount,
  flatten,
  islandsRegion,
  ringArea,
  scallop,
  starRegion,
  type Region,
} from './region'
import { census, meetPockets, randomMeet, type MeetCase } from './slivers'

let spike: Spike
beforeAll(async () => {
  spike = await loadSpike()
})

const STOCK: StockGeometry = { length: 200, width: 120, thickness: 30 }
/** Stock face tile size for the tiled variant (mm). */
const TILE = 15

/** Regions sized for the face of `direction` on STOCK. */
function region(family: 'star' | 'islands', n: number, direction: Direction): Region {
  const top = direction === '+z' || direction === '-z'
  if (family === 'star') return top ? starRegion(n) : starRegion(n, [60, 15], 12)
  return top ? islandsRegion(n) : islandsRegion(n, 5, 3, 115, 27)
}

describe('labelled prisms', () => {
  it('keeps every element label, has no air, and removes area × depth', () => {
    for (const mode of ['local', 'part'] as PlacementMode[])
      for (const tile of [undefined, 15])
        for (const direction of ['+z', '+x', '-z'] as Direction[])
          for (const family of ['star', 'islands'] as const) {
            const r = region(family, 500, direction)
            const depth = 7.3
            const e = evaluateShapes(
              spike,
              STOCK,
              [{ id: 'p', direction, region: r, depth }],
              mode,
              tile,
            )
            expect(e.airTriangles).toBe(0)
            expect(e.pieces).toBe(1)
            expect(e.tinyPieces).toBe(0)
            expect(e.surfaces.has('p.floor')).toBe(true)
            const kinds = r.loops.flatMap((l) => l.map((x) => x.kind))
            kinds.forEach((k, i) =>
              expect(e.surfaces.has(`p.${k === 'line' ? 'wall' : 'corner'}[${i}]`)).toBe(true),
            )
            const removed = ringArea(flatten(r)) * depth
            const full = STOCK.length * STOCK.width * STOCK.thickness
            expect(Math.abs(full - removed - e.volume)).toBeLessThan(1e-3 * removed)
          }
  })

  it('handles 2000 elements and a pocket with 250 islands', () => {
    for (const family of ['star', 'islands'] as const) {
      const r = region(family, 2000, '+z')
      expect(elementCount(r)).toBeGreaterThanOrEqual(1990)
      const e = evaluateShapes(
        spike,
        STOCK,
        [{ id: 'p', direction: '+z', region: r, depth: 5 }],
        'part',
      )
      expect(e.pieces).toBe(1)
      expect(e.airTriangles).toBe(0)
      // every wall / corner, the floor and the six stock faces
      expect(e.surfaces.size).toBe(elementCount(r) + 1 + 6)
    }
  })

  it('triangulates a concave region with holes into CCW triangles covering its area', () => {
    const r: Region = { loops: [scallop([0, 0], 20, 40), circle([5, 0], 3, false)] }
    const rings = flatten(r)
    const pts = rings.flatMap((x) => x.points)
    const tris = spike.triangulate(rings.map((x) => x.points as Vec2[]))
    let area = 0
    for (const [a, b, c] of tris) {
      const p = pts[a!]!
      const q = pts[b!]!
      const s = pts[c!]!
      const t = ((q[0] - p[0]) * (s[1] - p[1]) - (s[0] - p[0]) * (q[1] - p[1])) / 2
      expect(t).toBeGreaterThan(0)
      area += t
    }
    expect(area).toBeCloseTo(ringArea(rings), 6)
  })
})

describe('where a top and a side pocket meet', () => {
  const fixed: MeetCase = {
    stock: { length: 100.3, width: 60.7, thickness: 20.1 },
    side: '+y',
    a: 17.3,
    b: 51.1,
    c: 81.7,
    depth: 7.7,
    reach: 30.9,
  }

  function run(m: MeetCase, mode: PlacementMode) {
    const e = evaluateShapes(spike, m.stock, meetPockets(m), mode, TILE)
    return { e, ...census(e.mesh, m) }
  }

  it('leaves nothing in the shared plane when vertices are placed in float64', () => {
    const { e, plane, thin } = run(fixed, 'part')
    expect(e.pieces).toBe(1)
    expect(e.tinyPieces).toBe(0)
    expect(plane).toBe(0)
    expect(thin).toBe(0)
    // the same case with v0.2 placement leaves a step in the shared plane
    const local = run(fixed, 'local')
    console.log(`fixed case, local (v0.2): plane ${local.plane}, thin ${local.thin}`)
    expect(local.plane).toBeGreaterThan(0)
  })

  it('census over 60 seeded cases (both placements)', () => {
    const rows: string[] = []
    const totals = { local: [0, 0, 0, 0], part: [0, 0, 0, 0] }
    for (let seed = 1; seed <= 60; seed++) {
      const m = randomMeet(seed)
      for (const mode of ['local', 'part'] as const) {
        const { e, plane, thin } = run(m, mode)
        const t = totals[mode]
        if (plane > 0) t[0]!++
        if (thin > 0) t[1]!++
        if (e.tinyPieces > 0) t[2]!++
        if (e.pieces !== 1) t[3]!++
        if (mode === 'local' && seed <= 8)
          rows.push(
            `seed ${seed} ${m.side}: local plane ${plane} thin ${thin} tiny ${e.tinyPieces}`,
          )
      }
    }
    const f = (t: number[]) =>
      `plane ${t[0]}/60, thin ${t[1]}/60, tiny pieces ${t[2]}/60, pieces ≠ 1 ${t[3]}/60`
    console.log(
      [
        'meet census',
        `  local (v0.2): ${f(totals.local)}`,
        `  part (float64): ${f(totals.part)}`,
        ...rows,
      ].join('\n'),
    )
    expect(totals.part).toEqual([0, 0, 0, 0])
  })
})

describe('cost', () => {
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
  function measure(pockets: ShapePocket[], mode: PlacementMode, tile?: number, runs = 15) {
    for (let i = 0; i < 3; i++) evaluateShapes(spike, STOCK, pockets, mode, tile)
    const all: Evaluation[] = []
    for (let i = 0; i < runs; i++) all.push(evaluateShapes(spike, STOCK, pockets, mode, tile))
    const keys = Object.keys(all[0]!.ms) as (keyof Evaluation['ms'])[]
    const ms = Object.fromEntries(keys.map((k) => [k, median(all.map((e) => e.ms[k]))]))
    return { ms, e: all[0]! }
  }

  it('prints the cost table (budget 50 ms per evaluation)', () => {
    const rows = [
      '| case | elements | chords | triangles out | flatten | triangulate | mesh build | to solid | union + subtract | toMesh + labels | pieces | total | tiled: union + subtract | tiled: total | tiled: triangles |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ]
    const cases: [string, ShapePocket[]][] = []
    for (const n of [50, 500, 2000])
      for (const family of ['star', 'islands'] as const)
        for (const direction of ['+z', '+x'] as Direction[])
          cases.push([
            `${family} ${direction}`,
            [{ id: 'p', direction, region: region(family, n, direction), depth: 8.3 }],
          ])
    cases.push([
      '3 ops (star +z 200, islands −z 200, star +x 100)',
      [
        { id: 'a', direction: '+z', region: region('star', 200, '+z'), depth: 8.3 },
        { id: 'b', direction: '-z', region: region('islands', 200, '-z'), depth: 6.1 },
        { id: 'c', direction: '+x', region: region('star', 100, '+x'), depth: 12.7 },
      ],
    ])
    const f = (x: number) => x.toFixed(x < 10 ? 2 : 1)
    for (const [name, pockets] of cases) {
      const { ms, e } = measure(pockets, 'part')
      const tiled = measure(pockets, 'part', TILE)
      const els = pockets.reduce((n, p) => n + elementCount(p.region), 0)
      rows.push(
        `| ${name} | ${els} | ${e.chords} | ${e.triangles} | ${f(ms['flatten']!)} | ${f(ms['triangulate']!)} | ${f(ms['build']!)} | ${f(ms['toSolid']!)} | ${f(ms['boolean']!)} | ${f(ms['mesh']!)} | ${f(ms['pieces']!)} | **${f(ms['total']!)}** | ${f(tiled.ms['boolean']!)} | **${f(tiled.ms['total']!)}** | ${tiled.e.triangles} |`,
      )
    }
    const local = measure(cases.at(-1)![1], 'local')
    rows.push(`\n3 ops with v0.2 placement (local): total ${f(local.ms['total']!)} ms`)
    console.log(rows.join('\n'))
  })
})
