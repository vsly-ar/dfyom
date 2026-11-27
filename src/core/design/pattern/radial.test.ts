// Heatsink presets H3 (docs/modes/pattern-presets.md#implementation-h3): the `radial` lattice
// through the pattern commands (count cells on one circle, each turned to face out; the web at the
// hub; overlap at the hub; flip refused; count and radius kept across lattices, absent from other
// lattices' records) and the Radial fins step as pure functions (count from the fin at the hub,
// the args of one update, the read-out). The worked example: a Ø 60 round part, hub Ø 24, slots
// 2 wide with round ends, fins ≥ 1.5 mm at the hub, 8 deep: 21 slots, fin(12) = 1.59 mm, the
// narrowest web 1.88 mm (between the round inner ends).
import { describe, expect, it } from 'vitest'
import { regionArea, type Region } from '../../geometry/2d/model'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { expectOk } from '../../../shared/testing/result'
import { designSetup, type DesignSetup } from '../design.fixture'
import { partGeometryInput } from '../load'
import {
  radialFins,
  radialFinsArgs,
  radialReadout,
  radialWeb,
  type FinsFields,
  type RadialFinsStep,
} from './heatsink'
import { radialNodes, radialTurn } from './layout'

const region2d = nodeRegion2d()
const STOCK = {
  name: 'Round heatsink plate',
  shape: 'block' as const,
  length: '70',
  width: '70',
  thickness: '12',
  material: { name: '6061-T6', class: 'aluminum' as const },
}
const setup = () => designSetup({ services: { region2d }, stock: STOCK })

interface Result {
  cells?: number
  narrowestWeb?: number
  warnings: { code: string; parameter?: string; params: Record<string, unknown> }[]
}
const add = async (s: DesignSetup, args: object = {}) =>
  (await s.run('design.pattern.add', { partId: s.partId, ...args })) as Result
const update = async (s: DesignSetup, args: object) =>
  (await s.run('design.pattern.update', {
    partId: s.partId,
    featureId: 'pattern1',
    ...args,
  })) as Result

const pocketRegion = (s: DesignSetup): Region => {
  const g = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
  const op = g.operations.find((o) => o.id === 'pattern1_pocket')!
  if (op.kind !== 'pocket' || op.shape.contour.kind !== 'region') throw new Error('no region')
  return op.shape.contour.region
}

/** The worked example's step: Ø 60 part centred on the 70 × 70 plate, hub Ø 24, slots 2, fins 1.5. */
const STEP: RadialFinsStep = {
  fin: 1.5,
  slot: 2,
  height: 8,
  hub: 24,
  outer: 60,
  centre: [35, 35],
  thickness: 12,
}

describe('radial lattice (H3)', () => {
  it('nodes: count on the circle from angle, each turned to face out', () => {
    const n = radialNodes([10, 20], 4, 5, 90)
    expect(n.map((x) => x.at.map((v) => Math.round(v * 1e9) / 1e9))).toEqual([
      [10, 25],
      [5, 20],
      [10, 15],
      [15, 20],
    ])
    expect(radialTurn([10, 20], n[0]!.at)).toBeCloseTo(0, 9)
    expect(radialTurn([10, 20], n[1]!.at)).toBeCloseTo(90, 9)
    expect(radialTurn([10, 20], [10, 20])).toBe(0)
  })

  it('the worked example: 21 slots from the step, radial, fin 1.59 at the hub, 8 deep', async () => {
    const layout = radialFins(STEP)!
    expect(layout).toMatchObject({ count: 21, most: 21, hubFin: 1.59, radius: 22, length: 20 })
    expect(layout).toMatchObject({ web: 1.88, rimFin: 6.98, ratio: 5, base: 4 })
    const s = await setup()
    await add(s, { name: 'Radial fins' })
    const out = await update(s, radialFinsArgs(STEP, layout))
    expect(out.cells).toBe(21)
    // 1.88 > 1 mm: no thin web; 8 / 1.88 < 8: not tall
    expect(out.warnings.filter((w) => w.code.startsWith('dfm.pattern'))).toEqual([])
    const region = pocketRegion(s)
    // the geometry input's frame has the plate's centre (the part's, 35, 35) at the origin
    const c: [number, number] = [0, 0]
    expect(region.pieces).toHaveLength(21)
    // each slot 20 × 2 with round ends from r 12 to r 32: its two lines run from r 13 to r 31,
    // 1 mm each side of its axis through the centre
    for (const piece of region.pieces) {
      const lines = piece.outer.elements.filter((e) => e.kind === 'line')
      expect(lines).toHaveLength(2)
      const radii = lines
        .flatMap((e) => [e.a, e.b])
        .map((p) => Math.hypot(p[0] - c[0], p[1] - c[1]))
        .sort((a, b) => a - b)
      expect(radii[0]).toBeCloseTo(Math.hypot(13, 1), 6)
      expect(radii[3]).toBeCloseTo(Math.hypot(31, 1), 6)
      expect(regionArea({ pieces: [piece] })).toBeCloseTo(36 + Math.PI, 4)
    }
    // the first slot points along +v
    const top = region.pieces.find((p) => p.outer.elements.every((e) => e.a[1] > c[1] + 11))
    expect(top).toBeDefined()
    // the stored record carries count and radius; the feature keeps them as quantities
    const own = s.part().shapes?.find((x) => x.id === 'pattern1_cells')
    expect(own?.pattern).toMatchObject({ lattice: 'radial', count: 21, radius: 22, angle: 90 })
    expect(s.part().features?.[0]).toMatchObject({ lattice: 'radial' })
  })

  it('the web at the hub: dfm.patternThinWeb measures radialWeb between the round ends', async () => {
    const s = await setup()
    await add(s)
    // 30 slots on the Ø 24 hub: 2 · 13 · sin 6° − 2 = 0.718 mm
    const out = await update(s, radialFinsArgs(STEP, radialFins({ ...STEP, count: 30 })!))
    expect(radialWeb(12, 2, 30)).toBeCloseTo(0.7177, 3)
    expect(out.narrowestWeb).toBeCloseTo(0.72, 1)
    const thin = out.warnings.find((w) => w.code === 'dfm.patternThinWeb')
    expect(thin?.params['web']).toBeCloseTo(0.72, 1)
    // the marker is at the hub
    const at = thin?.params['at'] as [number, number]
    expect(Math.hypot(at[0] - 35, at[1] - 35)).toBeLessThan(14)
  })

  it('dfm.patternTallWeb on the hub fin at 1:8 ± 0.2 mm of depth', async () => {
    const s = await setup()
    await add(s)
    // 25 slots: a web of 1.26 mm, so 1:8 is 10.1 mm (inside the 12 mm plate)
    const hub = radialWeb(12, 2, 25)
    const st = { ...STEP, count: 25, height: Math.round((8 * hub + 0.2) * 100) / 100 }
    const tall = await update(s, radialFinsArgs(st, radialFins(st)!))
    const w = tall.warnings.find((x) => x.code === 'dfm.patternTallWeb')
    expect(w).toMatchObject({ parameter: 'depth' })
    expect(w?.params['web']).toBeCloseTo(hub, 1)
    const ok = await update(s, { depth: `${Math.floor((8 * hub - 0.2) * 100) / 100} mm` })
    expect(ok.warnings.map((x) => x.code)).not.toContain('dfm.patternTallWeb')
  })

  it('overlap at the hub, a count under 2, a missing radius and flip are refused', async () => {
    const s = await setup()
    await add(s)
    await update(s, radialFinsArgs(STEP, radialFins(STEP)!))
    const overlap = await s.fail(
      'design.pattern.update',
      { partId: s.partId, featureId: 'pattern1', count: '45' },
      'model.invariant',
    )
    expect(overlap.issues?.[0]).toMatchObject({ path: ['count'], rule: 'patternOverlap' })
    const one = await s.fail(
      'design.pattern.update',
      { partId: s.partId, featureId: 'pattern1', count: '1' },
      'model.invariant',
    )
    expect(one.issues?.[0]).toMatchObject({ path: ['count'], rule: 'radialCount' })
    const half = await s.fail(
      'design.pattern.update',
      { partId: s.partId, featureId: 'pattern1', count: '2.5' },
      'model.invariant',
    )
    expect(half.issues?.[0]).toMatchObject({ path: ['count'], rule: 'radialCount' })
    const flip = await s.fail(
      'design.pattern.update',
      { partId: s.partId, featureId: 'pattern1', alternate: 'flip' },
      'model.invariant',
    )
    expect(flip.issues?.[0]).toMatchObject({ path: ['alternate'], rule: 'radialFlip' })
    const t = await setup()
    await add(t)
    const bare = await t.fail(
      'design.pattern.update',
      { partId: t.partId, featureId: 'pattern1', lattice: 'radial', count: '6' },
      'model.invariant',
    )
    expect(bare.issues?.map((i) => i.rule)).toContain('radialRadius')
  })

  it('count and radius are kept when the lattice changes back, absent from its record', async () => {
    const s = await setup()
    await add(s)
    await update(s, radialFinsArgs(STEP, radialFins(STEP)!))
    await update(s, { lattice: 'square' })
    expect(s.part().features?.[0]).toMatchObject({ lattice: 'square' })
    expect(s.part().features?.[0]).toHaveProperty('count')
    const own = s.part().shapes?.find((x) => x.id === 'pattern1_cells')
    expect(own?.pattern).not.toHaveProperty('count')
    expect(own?.pattern).not.toHaveProperty('radius')
    const back = await update(s, { lattice: 'radial' })
    expect(back.cells).toBe(21)
  })

  it('whole cells on a face too small for the slots: those crossing the edge are left out', async () => {
    const s = await setup()
    await add(s)
    // centred at (20, 35): slots towards −u run past the face edge
    await update(s, {
      ...radialFinsArgs({ ...STEP, centre: [20, 35] }, radialFins(STEP)!),
      fit: 'whole',
    })
    const out = await update(s, {})
    expect(out.cells).toBeGreaterThan(10)
    expect(out.cells).toBeLessThan(21)
    // clip keeps every slot (cut at the edge)
    const clipped = await update(s, { fit: 'clip' })
    expect(clipped.cells).toBe(21)
  })
})

describe('Radial fins step (H3)', () => {
  it('counts from the fin at the hub; a chosen count overrides; sizes must make sense', () => {
    expect(radialFins({ ...STEP, fin: 1 })?.count).toBe(25)
    expect(radialFins({ ...STEP, count: 18 })).toMatchObject({ count: 18, most: 21 })
    expect(radialFins({ ...STEP, outer: 20 })).toBeUndefined()
    expect(radialFins({ ...STEP, slot: 0 })).toBeUndefined()
    // slots that would touch at the hub
    expect(radialFins({ ...STEP, count: 45 })).toBeUndefined()
  })

  it('args: one update with the slot cell on the radial lattice about the part centre', () => {
    expect(radialFinsArgs(STEP, radialFins(STEP)!)).toEqual({
      cell: {
        kind: 'rectangle',
        length: '20 mm',
        width: '2 mm',
        round: true,
        rotation: '90°',
      },
      lattice: 'radial',
      count: '21',
      radius: '22 mm',
      alternate: 'none',
      angle: '90°',
      origin: ['35 mm', '35 mm'],
      boundary: null,
      margin: '0 mm',
      fit: 'clip',
      invert: false,
      through: false,
      depth: '8 mm',
    })
  })

  it('read-out from the fields; other shapes read as cells', () => {
    const f: FinsFields = {
      cell: { kind: 'rectangle', length: 20, width: 2, cornerRadius: 1, rotation: 90 },
      lattice: 'radial',
      alternate: 'none',
      invert: false,
      through: false,
      gap: 2,
      angle: 90,
      depth: 8,
      cells: 21,
      area: { min: [0, 0], max: [70, 70] },
      margin: [0, 0],
      thickness: 12,
      radial: { count: 21, radius: 22 },
    }
    expect(radialReadout(f)).toEqual({
      slots: 21,
      hubFin: 1.59,
      rimFin: 6.98,
      slot: 2,
      height: 8,
      ratio: 5,
      hub: 24,
      outer: 60,
      base: 4,
    })
    expect(
      radialReadout({ ...f, cell: { ...f.cell, cornerRadius: 0 } as FinsFields['cell'] }),
    ).toMatchObject({ slots: 21 })
    expect(
      radialReadout({ ...f, cell: { ...f.cell, cornerRadius: 0.5 } as FinsFields['cell'] }),
    ).toBeUndefined()
    expect(radialReadout({ ...f, lattice: 'polar' })).toBeUndefined()
    expect(radialReadout({ ...f, invert: true })).toBeUndefined()
    expect(
      radialReadout({ ...f, cell: { ...f.cell, rotation: 0 } as FinsFields['cell'] }),
    ).toBeUndefined()
    expect(radialReadout({ ...f, radial: undefined })).toBeUndefined()
  })
})
