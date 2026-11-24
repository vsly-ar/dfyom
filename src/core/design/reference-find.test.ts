// The reference tools through the dispatcher (DF60 P1): `design.reference.find` (an async query:
// levels and section summaries in the face frame, errors), `design.shape.import { from }` (the
// fitted radius reaches the shape, `roundInside`, scale, undo) and the fit result fields.
// Spec: docs/modes/reference-tools.md#test-plans
import { beforeAll, describe, expect, it } from 'vitest'
import { fail, Ok } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createInProcessWorkers, memoryFiles } from '../commands/jobs'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { assetPathOf, type AssetRef } from '../project/assets'
import type { ProjectSession } from '../project/storage'
import { faceFrame } from '../geometry/face'
import { applyPlacement, unapplyPlacement } from '../geometry/model'
import { setupFrame } from '../toolpath/wcs'
import { evaluatePart } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import { nodeManifoldSource } from '../geometry/testing/node-wasm'
import { designSetup, type DesignSetup } from './design.fixture'
import { partGeometryInput } from './load'
import { binaryStl, boxSoup, soupOf } from './stl.testing'

type V2 = [number, number]
const ui = { kind: 'ui', id: 'w' } as const
const region2d = nodeRegion2d()

/** Side walls of a prism over the loops (counter-clockwise outer, clockwise holes), z 0..h. */
function prism(loops: V2[][], h: number): number[] {
  const out: number[] = []
  for (const l of loops)
    l.forEach((a, i) => {
      const b = l[(i + 1) % l.length]!
      out.push(
        a[0],
        a[1],
        0,
        b[0],
        b[1],
        0,
        b[0],
        b[1],
        h,
        a[0],
        a[1],
        0,
        b[0],
        b[1],
        h,
        a[0],
        a[1],
        h,
      )
    })
  return out
}
const rect = (x0: number, y0: number, x1: number, y1: number): V2[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
]
function roundedRect(w: number, h: number, r: number, chords: number): V2[] {
  const out: V2[] = []
  const corners: [V2, number][] = [
    [[w - r, r], -Math.PI / 2],
    [[w - r, h - r], 0],
    [[r, h - r], Math.PI / 2],
    [[r, r], Math.PI],
  ]
  for (const [c, start] of corners)
    for (let k = 0; k <= chords; k++) {
      const a = start + ((Math.PI / 2) * k) / chords
      out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)])
    }
  return out
}

const FRAME = '/models/frame.stl' // 40 × 20 × 10 with a 10 × 10 hole through it
const ROUNDED = '/models/rounded.stl' // 40 × 20 × 10, corners r 4 (8 chords each)
const BOX = '/models/box.stl'
const SOURCES: Record<string, Uint8Array> = {
  [FRAME]: binaryStl(prism([rect(0, 0, 40, 20), rect(15, 5, 25, 15).reverse()], 10)),
  [ROUNDED]: binaryStl(prism([roundedRect(40, 20, 4, 8)], 10)),
  [BOX]: binaryStl(boxSoup(40, 20, 10)),
}

const hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

async function setup(): Promise<DesignSetup> {
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
  return designSetup({
    services: {
      project: session,
      workers: createInProcessWorkers({ files: memoryFiles(files) }),
      region2d,
    },
  })
}

const importRef = async (s: DesignSetup, path: string, extra: object = {}) =>
  (await s.run('design.reference.import', {
    partId: s.partId,
    path,
    sourceUnit: 'mm',
    ...extra,
  })) as {
    referenceId: string
    scale: string
    placed: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
    facingDepth: Record<string, string>
  }

async function find(s: DesignSetup, args: object) {
  return expectOk(await s.d.queryAsync('design.reference.find', { partId: s.partId, ...args }, ui))
    .value as Record<string, unknown> & {
    levels?: {
      depth: number
      facing: string
      area: number
      visibleArea: number
      depthFromOpposite?: number
    }[]
    loops?: {
      role: string
      area: number
      bounds: [V2, V2]
      elements: number
      corners: { minInsideRadius?: number; sharp: V2[]; sharpCount: number }
    }[]
  }
}

const shapeGet = (s: DesignSetup, shapeId: string) =>
  expectOk(s.d.query('design.shape.get', { partId: s.partId, shapeId }, ui)).value as {
    shape: { name: string }
    resolved: { smallestInsideRadius?: number; area: number }
  }

describe('design.reference.find', () => {
  it('levels: both sides from the top in the face frame (stock 100 × 60 × 20, box fitted on top)', async () => {
    const s = await setup()
    await importRef(s, BOX)
    const r = await find(s, { kind: 'levels' })
    expect(r).toMatchObject({ kind: 'levels', face: 'stock.top', opposite: 'stock.bottom' })
    expect(r.levels).toEqual([
      {
        depth: 0,
        facing: 'face',
        area: 800,
        visibleArea: 800,
        bounds: [
          [30, 20],
          [70, 40],
        ],
      },
      {
        depth: 10,
        facing: 'opposite',
        area: 800,
        visibleArea: 800,
        bounds: [
          [30, 20],
          [70, 40],
        ],
        depthFromOpposite: 10,
      },
    ])
  })

  it('section: loops with roles, bounds and sharp corners; a miss is a note, not an error', async () => {
    const s = await setup()
    await importRef(s, FRAME)
    const r = await find(s, { kind: 'section', depth: '5' })
    expect(r).toMatchObject({ kind: 'section', depth: 5, tolerance: 0.01, fit: { elements: 8 } })
    expect(r.loops!.map((l) => [l.role, l.area, l.bounds, l.corners.sharpCount])).toEqual([
      [
        'outer',
        800,
        [
          [30, 20],
          [70, 40],
        ],
        0,
      ],
      [
        'hole',
        100,
        [
          [45, 25],
          [55, 35],
        ],
        4,
      ],
    ])
    expect((await find(s, { kind: 'section', depth: '5', loops: 'holes' })).loops).toHaveLength(1)
    const miss = await find(s, { kind: 'section', depth: '15' })
    expect(miss.loops).toEqual([])
    expect(miss['note']).toMatch(/misses/)
  })

  it('section from the bottom reads the same frame the bottom face’s operations use', async () => {
    const s = await setup()
    await importRef(s, FRAME)
    // the frame sits 10 deep under the top of a 20 thick stock: from the bottom it starts at 10
    expect((await find(s, { kind: 'section', face: 'stock.bottom', depth: '5' })).loops).toEqual([])
    const r = await find(s, { kind: 'section', face: 'stock.bottom', depth: '15' })
    expect(r.loops!.map((l) => [l.role, l.area])).toEqual([
      ['outer', 800],
      ['hole', 100],
    ])
  })

  it('refuses: no reference, several without referenceId, a non-stock face, a missing depth', async () => {
    const s = await setup()
    const err = async (args: object, rule: string) => {
      const e = expectErrCode(
        await s.d.queryAsync('design.reference.find', { partId: s.partId, ...args }, ui),
        'input.malformed',
      )
      expect(e.issues.map((i) => i.rule)).toContain(rule)
    }
    await err({ kind: 'levels' }, 'noReference')
    await importRef(s, BOX)
    await err({ kind: 'levels', face: 'pocket-1.floor' }, 'stockFaceOnly')
    await err({ kind: 'section' }, 'required')
    await importRef(s, FRAME)
    await err({ kind: 'levels' }, 'referenceAmbiguous')
  })

  describe('setup faces (P2)', () => {
    /** A plan with a top and a bottom setup (a facing on each face). */
    async function withPlan(s: DesignSetup) {
      await s.run('design.facing.add', { partId: s.partId, on: 'stock.top', depth: '0.5' })
      await s.run('design.facing.add', { partId: s.partId, on: 'stock.bottom', depth: '0.5' })
      const plan = (await s.run('plan.create', { partId: s.partId })) as {
        planId: string
        setupIds: string[]
      }
      const setups = s.d.doc.plans[plan.planId]!.setups
      const id = (d: string | undefined) => setups.find((x) => (x.direction ?? '+z') === d)!.id
      return { planId: plan.planId, top: id('+z'), bottom: id('-z') }
    }

    it('{ setupId } of a bottom setup reads as stock.bottom (levels and section)', async () => {
      const s = await setup()
      await importRef(s, FRAME)
      const { bottom } = await withPlan(s)
      const section = { kind: 'section', depth: '15' }
      const byFace = await find(s, { ...section, face: 'stock.bottom' })
      const bySetup = await find(s, { ...section, face: { setupId: bottom } })
      expect(bySetup).toEqual({ ...byFace, setupId: bottom })
      const levels = await find(s, { kind: 'levels', face: { setupId: bottom } })
      expect(levels).toEqual({
        ...(await find(s, { kind: 'levels', face: 'stock.bottom' })),
        setupId: bottom,
      })
      // shapes from it are made on the bottom face's frame, as from stock.bottom
      const shape = (await s.run('design.shape.import', {
        partId: s.partId,
        from: { face: { setupId: bottom }, depth: '15', loops: 'holes' },
      })) as { section: { face: string } }
      expect(shape.section.face).toBe('stock.bottom')
    })

    it("frame: 'setup' with a 90° rotation gives the points in the setup's WCS (setupFrame)", async () => {
      const s = await setup()
      await importRef(s, FRAME)
      const { planId, top } = await withPlan(s)
      await s.run('plan.setup.update', { planId, setupId: top, rotation: 90 })
      const r = (await find(s, {
        kind: 'section',
        depth: '5',
        loops: 'holes',
        face: { setupId: top },
        frame: 'setup',
      })) as unknown as {
        wcs: { z: number }
        loops: {
          bounds: [V2, V2]
          corners: { sharp: V2[] }
          wcs: { bounds: [V2, V2]; sharp: V2[] }
        }[]
      }
      expect(r.wcs).toEqual({ z: -5 })
      const stock = { length: 100, width: 60, thickness: 20 }
      const wcs = setupFrame('+z', 90, stock)
      const toWcs = (p: V2) => {
        const q = unapplyPlacement(wcs, applyPlacement(faceFrame('+z', stock), [p[0], p[1], -5]))
        return [q[0], q[1]].map((v) => Math.round(v * 1000) / 1000 || 0)
      }
      const [hole] = r.loops
      // every sharp corner, and the bounds' corners, where setupFrame puts them
      expect(hole!.wcs.sharp).toEqual(hole!.corners.sharp.map(toWcs))
      const corners = [hole!.bounds[0], hole!.bounds[1]].map(toWcs)
      expect(hole!.wcs.bounds).toEqual([
        [Math.min(corners[0]![0]!, corners[1]![0]!), Math.min(corners[0]![1]!, corners[1]![1]!)],
        [Math.max(corners[0]![0]!, corners[1]![0]!), Math.max(corners[0]![1]!, corners[1]![1]!)],
      ])
      // a quarter turn: the hole's 10 × 10 face-frame box stays 10 × 10, moved
      expect(hole!.wcs.bounds).not.toEqual(hole!.bounds)
      // levels carry their WCS height and bounds
      const levels = (await find(s, { kind: 'levels', face: { setupId: top }, frame: 'setup' }))
        .levels as unknown as { depth: number; wcs: { z: number } }[]
      for (const l of levels) expect(l.wcs.z).toBe(-l.depth || 0)
    })

    it('refuses an unknown setup and the setup frame without a setup face', async () => {
      const s = await setup()
      await importRef(s, FRAME)
      const err = async (args: object, rule: string) => {
        const e = expectErrCode(
          await s.d.queryAsync('design.reference.find', { partId: s.partId, ...args }, ui),
          'input.malformed',
        )
        expect(e.issues.map((i) => [i.rule, i.path.join('.')])).toContainEqual(rule.split(' '))
      }
      await err({ kind: 'levels', face: { setupId: 'setup9' } }, 'unknownSetup face.setupId')
      await err({ kind: 'levels', frame: 'setup' }, 'setupFrameNeedsSetup frame')
    })
  })

  it('is an async query: query() refuses it, queryAsync() also answers synchronous queries', async () => {
    const s = await setup()
    expectErrCode(
      s.d.query('design.reference.find', { partId: s.partId, kind: 'levels' }, ui),
      'internal.unexpected',
    )
    const r = expectOk(await s.d.queryAsync('design.reference.list', { partId: s.partId }, ui))
    expect(r.value).toEqual({ references: [] })
  })
})

describe('design.shape.import { from }', () => {
  it('a section of a rounded part gives a shape whose smallest inside radius is the fitted one', async () => {
    const s = await setup()
    await importRef(s, ROUNDED)
    const r = (await s.run('design.shape.import', {
      partId: s.partId,
      from: { depth: '5' },
    })) as {
      shapeIds: string[]
      section: {
        shapes: { minInsideRadius?: number; sharpCount: number; placeAt: object }[]
        arcs: number
      }
    }
    expect(r.shapeIds).toEqual(['shape1'])
    const got = shapeGet(s, 'shape1')
    expect(got.shape.name).toBe('Section 5 mm')
    expect(got.resolved.smallestInsideRadius).toBeCloseTo(4, 2)
    expect(r.section.shapes[0]).toMatchObject({
      sharpCount: 0,
      placeAt: { center: [30, 20], anchor: { u: 'min', v: 'min' } },
    })
    expect(r.section.shapes[0]!.minInsideRadius).toBeCloseTo(4, 2)
  })

  it('holes: the cavity is a shape with four sharp corners; roundInside 1.6 rounds them; one undo step', async () => {
    const s = await setup()
    await importRef(s, FRAME)
    const before = s.d.doc
    const sharp = (await s.run('design.shape.import', {
      partId: s.partId,
      from: { depth: '5', loops: 'holes' },
    })) as { shapeIds: string[]; section: { shapes: { sharpCount: number }[] } }
    expect(sharp.section.shapes[0]!.sharpCount).toBe(4)
    expect(shapeGet(s, sharp.shapeIds[0]!).resolved).toMatchObject({
      smallestInsideRadius: 0,
      area: 100,
    })
    const round = (await s.run('design.shape.import', {
      partId: s.partId,
      from: { depth: '5', loops: 'holes', roundInside: '1.6' },
    })) as {
      shapeIds: string[]
      section: {
        rounded: { corners: number; maxChange: number }
        shapes: { sharpCount: number; minInsideRadius: number }[]
      }
    }
    expect(round.section.rounded.corners).toBe(4)
    expect(round.section.rounded.maxChange).toBeCloseTo(1.6 * (Math.SQRT2 - 1), 3)
    expect(round.section.shapes[0]).toMatchObject({ sharpCount: 0 })
    expect(shapeGet(s, round.shapeIds[0]!).resolved.smallestInsideRadius).toBeCloseTo(1.6, 3)
    await s.run('history.undo', {})
    await s.run('history.undo', {})
    expect(s.d.doc.parts[s.partId]!.shapes ?? []).toEqual(before.parts[s.partId]!.shapes ?? [])
  })

  it('reads the placed reference: after scale 0.5 the loops are half size', async () => {
    const s = await setup()
    const { referenceId } = await importRef(s, FRAME)
    const updated = (await s.run('design.reference.update', {
      partId: s.partId,
      referenceId,
      scale: '0.5',
      fit: {},
    })) as {
      scale: string
      placed: { min: object; max: object }
      facingDepth: Record<string, string>
    }
    // the fit result fields (Q80): no follow-up list needed
    expect(updated.scale).toBe('0.5')
    expect(updated.placed).toEqual({ min: { x: 40, y: 25, z: -5 }, max: { x: 60, y: 35, z: 0 } })
    expect(updated.facingDepth).toEqual(
      expect.objectContaining({ 'stock.bottom': expect.any(String) }),
    )
    const r = await find(s, { kind: 'section', depth: '2' })
    expect(r.loops!.map((l) => [l.area, l.bounds])).toEqual([
      [
        200,
        [
          [40, 25],
          [60, 35],
        ],
      ],
      [
        25,
        [
          [47.5, 27.5],
          [52.5, 32.5],
        ],
      ],
    ])
  })

  it('refuses path with from, and a section with no loop', async () => {
    const s = await setup()
    await importRef(s, FRAME)
    const e = expectErrCode(
      await s.d.dispatch(
        'design.shape.import',
        { partId: s.partId, path: '/a.svg', from: { depth: '5' } },
        ui,
      ),
      'input.malformed',
    )
    expect(e.issues.map((i) => i.rule)).toEqual(['pathOrFrom'])
    const miss = expectErrCode(
      await s.d.dispatch('design.shape.import', { partId: s.partId, from: { depth: '15' } }, ui),
      'input.malformed',
    )
    expect(miss.issues.map((i) => i.rule)).toEqual(['emptySection'])
  })
})

describe('design.reference.import result fields', () => {
  it('returns scale, placed and facingDepth', async () => {
    const s = await setup()
    const r = await importRef(s, BOX)
    expect(r.scale).toBe('1')
    expect(r.placed).toEqual({ min: { x: 30, y: 20, z: -10 }, max: { x: 70, y: 40, z: 0 } })
    expect(Object.keys(r.facingDepth)).toContain('stock.bottom')
  })
})

describe('holes (P3)', () => {
  const PLATE = '/models/plate.stl' // the 100 × 60 × 20 test block with a 2 × 2 grid of Ø 1.2 holes
  beforeAll(async () => {
    const kernel = expectOk(await loadManifold(nodeManifoldSource()))
    const p = await designSetup()
    for (const [u, v] of [
      [20, 15],
      [50, 15],
      [20, 40],
      [50, 40],
    ])
      await p.run('design.drilling.add', {
        partId: p.partId,
        center: [String(u), String(v)],
        diameter: '1.2',
        bottom: 'through',
      })
    const input = expectOk(partGeometryInput(p.d.doc, p.partId))
    const ev = expectOk(kernel.withSolids((solids) => evaluatePart(input, solids)))
    SOURCES[PLATE] = binaryStl(soupOf(ev.positions, ev.indices))
  })
  const addTool = (s: DesignSetup, diameter: string) =>
    s.run('library.tool.add', {
      values: {
        name: `Drill ${diameter}`,
        type: 'drill',
        diameter,
        fluteLength: '25',
        overallLength: '60',
        fluteCount: '2',
        pointAngle: '118',
      },
    })
  const referenceId = (s: DesignSetup) => Object.keys(s.d.doc.references)[0]!
  type Groups = {
    holeCount: number
    groups: {
      count: number
      holes: V2[]
      size: { diameter: number; bottom: string; top: number }
      pattern?: { kind: string; count: V2 }
      suggest: { command: string; args: Record<string, unknown>; clones?: object }
      note?: string
      smallestTool?: number
    }[]
  }

  it('groups the holes with a ready-to-send suggestion; noTool below the smallest library tool', async () => {
    const s = await setup()
    await importRef(s, PLATE)
    const r = (await find(s, { kind: 'holes' })) as unknown as Groups
    expect(r).toMatchObject({ kind: 'holes', face: 'stock.top', holeCount: 4 })
    expect(r.groups).toHaveLength(1)
    const g = r.groups[0]!
    expect(g).toMatchObject({
      count: 4,
      holes: [
        [20, 15],
        [50, 15],
        [20, 40],
        [50, 40],
      ],
      size: { diameter: 1.2, bottom: 'through', top: 0 },
      pattern: { kind: 'grid', count: [2, 2] },
      suggest: {
        command: 'design.drilling.add',
        args: { on: 'stock.top', center: ['20 mm', '15 mm'], diameter: '1.2 mm' },
        clones: { rows: [{ kind: 'grid', cols: 2, rows: 2, du: '30 mm', dv: '25 mm' }] },
      },
    })
    expect(g.note).toBeUndefined() // an empty library says nothing
    // the suggestion is sent as it is
    const added = (await s.run('design.drilling.add', { partId: s.partId, ...g.suggest.args })) as {
      operationId: string
    }
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: [added.operationId] },
      ...(g.suggest.clones as object),
    })
    await addTool(s, '1.588')
    const small = (await find(s, { kind: 'holes' })) as unknown as Groups
    expect(small.groups[0]).toMatchObject({ note: 'noTool', smallestTool: 1.588 })
  })

  it('reference.featureBelowTool after a scale change that puts the holes below the smallest tool', async () => {
    const s = await setup()
    await importRef(s, PLATE)
    await addTool(s, '1')
    const update = async (args: object) =>
      (
        (await s.run('design.reference.update', {
          partId: s.partId,
          referenceId: referenceId(s),
          ...args,
        })) as { warnings: { code: string; severity: string; params: object }[] }
      ).warnings
    expect(await update({ name: 'Plate' })).toEqual([])
    expect(await update({ scale: '0.5' })).toContainEqual(
      expect.objectContaining({
        code: 'reference.featureBelowTool',
        severity: 'info',
        params: { diameter: 0.6, count: 4, smallest: 1, scale: '0.5' },
      }),
    )
    expect((await update({ scale: '1' })).map((w) => w.code)).not.toContain(
      'reference.featureBelowTool',
    )
  })
})
