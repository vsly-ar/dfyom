// Compare of the design against its reference (DF60 P4): the boolean method, noise, attribution,
// `cornerRadius`, the height-map fallback for an open mesh, and the BVH distances.
// Spec: docs/modes/reference-tools.md#test-plans (P4 compare)
import { beforeAll, describe, expect, it } from 'vitest'
import { fail, Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers, memoryFiles } from '../commands/jobs'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { evaluatePart } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import { nodeManifoldSource } from '../geometry/testing/node-wasm'
import type { SolidKernel } from '../geometry/solid-port'
import { hashJson } from '../plan/snapshot'
import { assetPathOf, type AssetRef } from '../project/assets'
import type { ProjectSession } from '../project/storage'
import { buildTestPart, designSetup, testStock, type DesignSetup } from './design.fixture'
import type { EvaluationService } from './evaluation'
import { partGeometryInput } from './load'
import { closestOnTriangle, MeshBvh } from './mesh-distance'
import { components, isClosed, weldSoup } from './reference-compare'
import { binaryStl, boxSoup, enclosureFullStl, soupOf } from './stl.testing'

const ui = { kind: 'ui', id: 'w' } as const
const region2d = nodeRegion2d()
let kernel: SolidKernel
beforeAll(async () => {
  kernel = expectOk(await loadManifold(nodeManifoldSource()))
})

const SOURCES: Record<string, Uint8Array> = {}

const hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

/** The part's evaluation, computed in-process on demand (no debounce, no scheduler). */
function evaluationsOf(get: () => DesignSetup): EvaluationService {
  const state = (doc: DesignSetup['d']['doc'], partId: string) => {
    const input = expectOk(partGeometryInput(doc, partId, region2d))
    const ev = kernel.withSolids((solids) => evaluatePart(input, solids, undefined, region2d))
    return ev.isErr()
      ? { status: 'failed' as const, inputHash: hashJson(input), error: ev.unwrapErr() }
      : { status: 'done' as const, inputHash: hashJson(input), evaluation: ev.unwrap() }
  }
  return {
    state,
    evaluate: (partId) => Promise.resolve(Ok(state(get().d.doc, partId))),
  }
}

async function setup(stock?: object): Promise<DesignSetup> {
  const files = new Map<string, Uint8Array>()
  const session = {
    async importAsset(source: string) {
      const bytes = SOURCES[source]
      if (bytes === undefined) return fail('input.malformed', 'no such file')
      const sha256 = await hex(bytes)
      const path = assetPathOf(sha256, 'stl')
      files.set(`/work/${path}`, bytes)
      return Ok({ path, sha256, size: bytes.length } satisfies AssetRef)
    },
    assetFile: (path: string) => Ok(`/work/${path}`),
  } as unknown as ProjectSession
  // the evaluations read `s` only once the setup has returned
  const s: DesignSetup = await designSetup({
    ...(stock === undefined ? {} : { stock }),
    services: {
      project: session,
      workers: createInProcessWorkers({
        files: memoryFiles(files),
        solids: () => loadManifold(nodeManifoldSource()),
        region2d: () => Ok(region2d),
      }),
      region2d,
      evaluations: evaluationsOf(() => s),
    },
  })
  return s
}

/** The evaluated part of `s` as an STL (part frame, mm) and its bounding box minimum. */
function partStl(s: DesignSetup): { bytes: Uint8Array; min: [number, number, number] } {
  const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
  const ev = expectOk(
    kernel.withSolids((solids) => evaluatePart(input, solids, undefined, region2d)),
  )
  const soup = soupOf(ev.positions, ev.indices)
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  for (let i = 0; i < soup.length; i++) min[i % 3] = Math.min(min[i % 3]!, soup[i]!)
  return { bytes: binaryStl(soup), min }
}

/** Imports `path` and places its min corner at `min` (part frame). */
async function importAt(s: DesignSetup, path: string, min: readonly number[]) {
  const r = (await s.run('design.reference.import', {
    partId: s.partId,
    path,
    sourceUnit: 'mm',
  })) as { referenceId: string }
  await s.run('design.reference.update', {
    partId: s.partId,
    referenceId: r.referenceId,
    position: { x: String(min[0]), y: String(min[1]), z: String(min[2]) },
  })
  return r.referenceId
}

interface Region {
  kind: 'missing' | 'extra'
  volume: number
  maxDev: number
  at: number[]
  bounds: number[][]
  surfaces: string[]
  operationIds: string[]
  cause?: string
}
interface Compared {
  method: string
  threshold: number
  stats: {
    missingVolume: number
    extraVolume: number
    maxMissing: number
    maxExtra: number
    referenceVolume: number
    partVolume: number
  }
  regions: Region[]
  more?: number
  below: { count: number; volume: number }
  offcuts?: { count: number; volume: number }
  note?: string
  evaluation: string
}

async function compare(s: DesignSetup, extra: object = {}): Promise<Compared> {
  const { jobId } = (await s.run('design.reference.compare', {
    partId: s.partId,
    source: { kind: 'part' },
    ...extra,
  })) as { jobId: string }
  return expectOk(await s.d.job(jobId).unwrap().result) as Compared
}

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
    const stl = partStl(p)
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
    const stl = partStl(p)
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
      { partId: s.partId, source: { kind: 'plan' } },
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
  const ENCLOSURE = '/models/enclosure.stl'
  const hardwood = {
    length: '260',
    width: '190',
    thickness: '60.523',
    material: { name: 'Oak', class: 'hardwood' },
  }
  interface Imported {
    shapeIds: string[]
    section: { shapes: { placeAt: { center: number[]; anchor: string } }[] }
  }
  const named = (r: Imported) => {
    const at = r.section.shapes[0]!.placeAt
    return {
      shape: { kind: 'named', shapeId: r.shapeIds[0], center: at.center.map(String) },
      anchor: at.anchor,
    }
  }

  /**
   * The enclosure approximated from its reference the way an agent would: shapes from its
   * sections, the cavity pocket, the two bottom steps and the outline profile (no tabs). The
   * notch, the rebate, the top edge round, the slot and the pilot holes are left out.
   */
  async function enclosure(cavityDepth: string): Promise<DesignSetup> {
    SOURCES[ENCLOSURE] ??= enclosureFullStl()
    const s = await setup({ ...testStock(), ...hardwood })
    const partId = s.partId
    await s.run('design.reference.import', { partId, path: ENCLOSURE, sourceUnit: 'mm' })
    const shape = (from: object) =>
      s.run('design.shape.import', { partId, from }) as Promise<Imported>
    const outline = await shape({ depth: '30', loops: 'outer' })
    const cavity = await shape({ depth: '30', loops: 'holes' })
    const step2 = await shape({ face: 'stock.bottom', depth: '3', loops: 'outer' })
    const step1 = await shape({ face: 'stock.bottom', depth: '1', loops: 'outer' })
    const tabs = { count: '0', width: '6', thickness: '2' }
    await s.run('design.pocket.add', { partId, ...named(cavity), depth: cavityDepth })
    for (const [step, depth] of [
      [step1, '1.77'],
      [step2, '4.19'],
    ] as const)
      await s.run('design.profile.add', {
        partId,
        on: 'stock.bottom',
        side: 'outside',
        ...named(step),
        depth,
        tabs,
      })
    await s.run('design.profile.add', { partId, side: 'outside', ...named(outline), tabs })
    return s
  }

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
