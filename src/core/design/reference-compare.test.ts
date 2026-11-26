// Compare of the design against its reference (DF60 P4): the boolean method, noise, attribution,
// `cornerRadius`, the height-map fallback for an open mesh, and the BVH distances.
// Spec: docs/modes/reference-tools.md#test-plans (P4 compare)
import { beforeAll, describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { evaluatePart } from '../geometry/evaluate'
import type { SolidKernel } from '../geometry/solid-port'
import { buildTestPart } from './design.fixture'
import { partGeometryInput } from './load'
import { closestOnTriangle, MeshBvh } from './mesh-distance'
import { components, isClosed, weldSoup } from './reference-compare'
import { ghostMatrix } from './reference'
import { storedPlacement } from './reference-find'
import { referenceCompareView } from '../workers/tasks'
import {
  compare,
  compareSetup as setup,
  enclosureDesign as enclosure,
  importAt,
  partStl,
  region2d,
  SOURCES,
  testKernel,
} from './reference-compare.testing'
import { binaryStl, boxSoup, soupOf } from './stl.testing'

const ui = { kind: 'ui', id: 'w' } as const
let kernel: SolidKernel
beforeAll(async () => {
  kernel = await testKernel()
})

describe('mesh-distance', () => {
  it('finds the closest point on a triangle in each Voronoi region', () => {
    const c = Float64Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0])
    const out = new Float64Array(3)
    const at = (x: number, y: number, z: number) => {
      closestOnTriangle(c, 0, x, y, z, out)
      return [...out]
    }
    expect(at(2, 2, 5)).toEqual([2, 2, 0]) // face
    expect(at(-3, -3, 1)).toEqual([0, 0, 0]) // vertex a
    expect(at(5, -2, 0)).toEqual([5, 0, 0]) // edge ab
    expect(at(8, 8, 0)).toEqual([5, 5, 0]) // edge bc
  })

  it('matches brute force over a box', () => {
    const soup = boxSoup(10, 6, 4)
    const bvh = new MeshBvh(soup)
    for (const p of [
      [5, 3, 2],
      [-1, 2, 2],
      [12, 8, 9],
      [5, 3, -0.5],
    ] as const) {
      let best = Infinity
      const out = new Float64Array(3)
      const c = Float64Array.from(soup)
      for (let t = 0; t < 12; t++) {
        closestOnTriangle(c, t, p[0], p[1], p[2], out)
        best = Math.min(best, Math.hypot(out[0]! - p[0], out[1]! - p[1], out[2]! - p[2]))
      }
      expect(bvh.closest(p[0], p[1], p[2]).distance).toBeCloseTo(best, 9)
    }
    expect(bvh.closest(5, 3, 2).distance).toBeCloseTo(2, 9)
  })

  it('welds a soup, checks it is closed and splits pieces', () => {
    const two = [...boxSoup(1, 1, 1), ...boxSoup(1, 1, 1).map((v, i) => (i % 3 === 0 ? v + 5 : v))]
    const w = weldSoup(Float64Array.from(two))
    expect(w.positions.length / 3).toBe(16)
    expect(isClosed(w)).toBe(true)
    expect(components(w.triangles, 16).n).toBe(2)
    const open = weldSoup(Float64Array.from(boxSoup(1, 1, 1).slice(0, 9 * 10)))
    expect(isClosed(open)).toBe(false)
  })
})

describe('design.reference.compare (boolean)', () => {
  const PART = '/models/test-part.stl'
  let min: [number, number, number]
  beforeAll(async () => {
    const p = await setup()
    await buildTestPart(p)
    const stl = await partStl(p)
    SOURCES[PART] = stl.bytes
    min = stl.min
  })

  it('finds nothing over the threshold when the design is the reference', async () => {
    const s = await setup()
    await buildTestPart(s)
    await importAt(s, PART, min)
    const r = await compare(s)
    expect(r.method).toBe('boolean')
    expect(r.regions).toEqual([])
    expect(r.stats.maxMissing).toBeLessThan(0.1)
    expect(r.stats.maxExtra).toBeLessThan(0.1)
    expect(r.stats.referenceVolume).toBeCloseTo(r.stats.partVolume, 0)
    expect(r.evaluation).toMatch(/\w+/)
    expect(JSON.stringify(r).length).toBeLessThan(2048)
  })

  it('a pocket 0.2 mm too deep is one missing region on that pocket', async () => {
    const s = await setup()
    await buildTestPart(s)
    await importAt(s, PART, min)
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '8.2' })
    const r = await compare(s)
    expect(r.regions).toHaveLength(1)
    const [g] = r.regions
    expect(g).toMatchObject({ kind: 'missing', operationIds: ['pocket1'] })
    expect(g!.maxDev).toBeCloseTo(0.2, 2)
    expect(g!.surfaces[0]).toBe('pocket1.floor')
    // the floor area (40 × 25 less the corners and the floor fillet's run-out) × 0.2
    expect(g!.volume).toBeGreaterThan(150)
    expect(g!.volume).toBeLessThan(200)
    expect(g!.at[2]).toBeCloseTo(-8.5, 1) // the reference's floor (8 under the 0.5 facing)
  })

  it('the overlay view: per-vertex signed distances and the missing piece of the last compare (P5)', async () => {
    const s = await setup()
    await buildTestPart(s)
    await importAt(s, PART, min)
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '8.2' })
    const r = await compare(s)
    const state = s.evaluations.state(s.d.doc, s.partId)
    if (state.evaluation === undefined) throw new Error('no evaluation')
    const ev = state.evaluation
    const ref = Object.values(s.d.doc.references)[0]!
    const view = (positions: Float32Array, threshold: number) =>
      s.workers.run(
        referenceCompareView,
        {
          path: `/work/${ref.asset.path}`,
          triangles: ref.asset.triangles,
          matrix: ghostMatrix(ref.asset.bounds, expectOk(storedPlacement(ref, 'test'))),
          positions,
          threshold,
        },
        { signal: new AbortController().signal, progress: () => undefined },
      )
    const v = expectOk(await view(ev.positions, r.threshold))
    expect(v.distances).toHaveLength(ev.positions.length / 3)
    // the pocket's floor vertices lie 0.2 inside the reference (missing material), the rest on it
    const floor = ev.surfaces.indexOf('pocket1.floor')
    const onFloor = new Set<number>()
    for (let t = 0; t < ev.triangleSurface.length; t++)
      if (ev.triangleSurface[t] === floor)
        for (let k = 0; k < 3; k++) onFloor.add(ev.indices[3 * t + k]!)
    for (const i of onFloor) expect(v.distances[i]!).toBeCloseTo(-0.2, 2)
    let worst = 0
    for (let i = 0; i < v.distances.length; i++)
      if (!onFloor.has(i)) worst = Math.max(worst, Math.abs(v.distances[i]!))
    expect(worst).toBeLessThan(0.2 + 1e-3)
    // the missing piece (the 0.2 slab) for this mesh at this threshold only
    expect(v.missing).toBeDefined()
    expect(v.missing!.length % 9).toBe(0)
    expect(v.missing!.length).toBeGreaterThan(0)
    expect(expectOk(await view(ev.positions, 0.5)).missing).toBeUndefined()
  })

  it('a missing pocket is one extra region of the pocket volume', async () => {
    const s = await setup()
    await buildTestPart(s)
    await importAt(s, PART, min)
    await s.run('design.operation.remove', { partId: s.partId, operationId: 'pocket1' })
    const r = await compare(s)
    expect(r.regions).toHaveLength(1)
    const [g] = r.regions
    expect(g).toMatchObject({ kind: 'extra' })
    expect(g!.maxDev).toBeCloseTo(8, 1)
    const pocket = r.stats.partVolume - r.stats.referenceVolume
    expect(Math.abs(g!.volume - pocket) / pocket).toBeLessThan(0.01)
    expect(g!.surfaces).toContain('facing1.floor')
  })

  it('rounded corners where the reference is sharp are cornerRadius regions', async () => {
    const SHARP = '/models/sharp-pocket.stl'
    const pocket = (r: string) => ({
      partId: '',
      shape: {
        kind: 'rectangle',
        center: ['50', '30'],
        length: '40',
        width: '25',
        cornerRadius: r,
      },
      depth: '8',
    })
    const p = await setup()
    await p.run('design.pocket.add', { ...pocket('0'), partId: p.partId })
    const stl = await partStl(p)
    SOURCES[SHARP] = stl.bytes
    const s = await setup()
    await s.run('design.pocket.add', { ...pocket('3'), partId: s.partId })
    await importAt(s, SHARP, stl.min)
    const r = await compare(s)
    expect(r.regions).toHaveLength(4)
    for (const g of r.regions) {
      expect(g).toMatchObject({ kind: 'extra', operationIds: ['pocket1'], cause: 'cornerRadius' })
      // the arc's middle is r (1 − cos 45°) from either wall of the sharp corner
      expect(g.maxDev).toBeCloseTo(3 * (1 - Math.SQRT1_2), 2)
      expect(g.surfaces[0]).toMatch(/^pocket1\.corner\[\d\]$/)
    }
    // a threshold over the corner deviation leaves them as noise
    const quiet = await compare(s, { threshold: 1.5 })
    expect(quiet.regions).toEqual([])
    expect(quiet.below.count).toBe(4)
  })

  it('a part that wholly holds the reference is one extra region with a void, not an offcut', async () => {
    SOURCES['/models/small-box.stl'] ??= binaryStl(boxSoup(20, 10, 5))
    const s = await setup()
    // inside the 100 × 60 × 20 block on every side: part − reference is a block with a void
    await importAt(s, '/models/small-box.stl', [40, 25, -12])
    const r = await compare(s)
    expect(r.regions).toHaveLength(1)
    expect(r.regions[0]).toMatchObject({ kind: 'extra' })
    expect(r.stats.referenceVolume).toBeCloseTo(1000, 0)
    expect(r.stats.extraVolume).toBeCloseTo(r.stats.partVolume - 1000, 0)
    expect(r.stats.missingVolume).toBe(0)
    expect((r as { offcuts?: unknown }).offcuts).toBeUndefined()
  })

  it('names the reference and refuses without one', async () => {
    const s = await setup()
    const { jobId } = (await s.run('design.reference.compare', {
      partId: s.partId,
      source: { kind: 'part' },
    })) as { jobId: string }
    const e = await s.d.job(jobId).unwrap().result
    expect(e.unwrapErr().issues.map((i) => i.rule)).toEqual(['noReference'])
    const bad = await s.d.dispatch(
      'design.reference.compare',
      { partId: s.partId, source: { kind: 'mesh' } },
      ui,
    )
    expect(bad.unwrapErr().code).toBe('input.malformed')
  })
})

describe('design.reference.compare (height maps)', () => {
  it('an open reference falls back to the height maps from the faces in use', async () => {
    const OPEN = '/models/open-block.stl'
    // the top and four sides of the 100 × 60 × 20 block with a 40 × 25 × 8 pocket: no bottom
    const p = await setup()
    await p.run('design.pocket.add', {
      partId: p.partId,
      shape: { kind: 'rectangle', center: ['50', '30'], length: '40', width: '25' },
      depth: '8',
    })
    const input = expectOk(partGeometryInput(p.d.doc, p.partId, region2d))
    const ev = expectOk(kernel.withSolids((solids) => evaluatePart(input, solids)))
    const soup = soupOf(ev.positions, ev.indices)
    const kept: number[] = []
    for (let t = 0; t < soup.length / 9; t++) {
      const zs = [soup[9 * t + 2]!, soup[9 * t + 5]!, soup[9 * t + 8]!]
      if (zs.every((z) => Math.abs(z + 20) < 1e-6)) continue // the bottom face
      for (let k = 0; k < 9; k++) kept.push(soup[9 * t + k]!)
    }
    SOURCES[OPEN] = binaryStl(kept)
    const s = await setup()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'rectangle', center: ['50', '30'], length: '40', width: '25' },
      depth: '9',
    })
    await importAt(s, OPEN, [0, 0, -20])
    const r = await compare(s)
    expect(r.method).toBe('heightmap')
    expect(r.note).toMatch(/open/)
    expect(r.regions).toHaveLength(1)
    expect(r.regions[0]).toMatchObject({ kind: 'missing', operationIds: ['pocket1'] })
    expect(r.regions[0]!.maxDev).toBeCloseTo(1, 3)
    expect(r.regions[0]!.surfaces[0]).toBe('pocket1.floor')
  })
})

describe('design.reference.compare (enclosure fixture)', () => {
  it('an approximating design leaves only what it omits, as separate extra regions', async () => {
    const s = await enclosure('56.338')
    const r = await compare(s, { limit: 20 })
    expect(r.method).toBe('boolean')
    // nothing cut that the reference keeps
    expect(r.regions.filter((g) => g.kind === 'missing')).toEqual([])
    expect(r.stats.maxMissing).toBeLessThan(0.1)
    // the frame the through profile cuts free is not a deviation
    expect(r.offcuts?.count).toBeGreaterThan(0)
    expect(Math.abs(r.stats.partVolume - r.stats.referenceVolume)).toBeLessThan(5000)
    // the largest: the top edge round with the notch and the rebate along it (4.27 deep)
    expect(r.regions[0]!.kind).toBe('extra')
    expect(r.regions[0]!.maxDev).toBeCloseTo(4.27, 1)
    // the pilot holes and the slot at the top, each its own small region
    const top = r.regions.filter((g) => g.volume < 20 && Math.abs(g.at[2]!) < 1e-3)
    expect(top.length).toBeGreaterThanOrEqual(7)
    for (const g of top) {
      expect(g.kind).toBe('extra')
      expect(g.maxDev).toBeGreaterThan(1)
      expect(g.maxDev).toBeLessThan(1.6)
    }
    for (const g of r.regions) expect(g.volume).toBeGreaterThan(0)
    // compact enough to read
    expect(JSON.stringify(r).length).toBeLessThan(6000)
  }, 120_000)

  // DF90: the frame held by tabs touches the reference through them; it is waste, not extra
  it('a frame held by tabs is an offcut, not the largest extra regions; volumes match the regions', async () => {
    const s = await enclosure('56.338', undefined, { count: '4', thickness: '12' })
    const r = await compare(s, { limit: 20 })
    expect(r.offcuts?.count).toBeGreaterThan(0)
    for (const g of r.regions) expect(g.surfaces.some((x) => x.endsWith('.offcut'))).toBe(false)
    expect(r.regions[0]!.maxDev).toBeCloseTo(4.27, 1)
    // nothing over the threshold is missing: no missing volume either (noise is in `below`)
    expect(r.stats.maxMissing).toBeLessThan(0.1)
    expect(r.stats.missingVolume).toBe(0)
  }, 120_000)

  it('a cavity 2 mm too deep ranks first, as missing material on the cavity pocket', async () => {
    const s = await enclosure('58.338')
    const r = await compare(s)
    const [g] = r.regions
    expect(g).toMatchObject({ kind: 'missing', operationIds: ['pocket1'] })
    expect(g!.maxDev).toBeCloseTo(2, 1)
    expect(g!.surfaces[0]).toBe('pocket1.floor')
    expect(r.stats.maxMissing).toBeCloseTo(2, 1)
  }, 120_000)
})
