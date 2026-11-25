// The pattern feature P2 through its commands: a boundary shape with a keep-out (the record, the
// restale on its edit, unknown shapes), `fit` and `invert` stored and cleared, the thin web
// finding with its marker and suggested gap, the presets, and a pattern on a split part (the
// pieces keep the owned shape with a clip rectangle; P1's `patternSplit` is gone).
// Spec: docs/modes/patterns.md#implementation-p2
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { regionArea, type Region } from '../../geometry/2d/model'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { checkPartFits } from '../../plan/validity'
import { designSetup, type DesignSetup } from '../design.fixture'
import { partGeometryInput } from '../load'
import type { PartDTO } from '../part.dto'
import { PATTERN_PRESETS } from './presets'

const region2d = nodeRegion2d()
const setup = (stock?: object) =>
  designSetup({ services: { region2d }, ...(stock === undefined ? {} : { stock }) })

interface Result {
  featureId: string
  cells?: number
  dropped?: number
  narrowestWeb?: number
  warnings: {
    code: string
    severity: string
    operation: string
    parameter?: string
    params: Record<string, unknown>
  }[]
}

const add = async (s: DesignSetup, args: object = {}) =>
  (await s.run('design.pattern.add', { partId: s.partId, ...args })) as Result
const update = async (s: DesignSetup, args: object) =>
  (await s.run('design.pattern.update', {
    partId: s.partId,
    featureId: 'pattern1',
    ...args,
  })) as Result

/** shape1: an 80 × 50 R 10 rectangle with a Ø 20 keep-out (a subtract item). */
async function withBoundary(s: DesignSetup): Promise<void> {
  await s.run('design.shape.add', {
    partId: s.partId,
    items: [
      { kind: 'rectangle', center: ['0', '0'], length: '80', width: '50', cornerRadius: '10' },
      { kind: 'circle', op: 'subtract', center: ['0', '0'], diameter: '20' },
    ],
  })
}

const pocketRegion = (s: DesignSetup, partId = s.partId): Region => {
  const g = expectOk(partGeometryInput(s.d.doc, partId, region2d))
  const op = g.operations.find((o) => o.id === 'pattern1_pocket')!
  if (op.kind !== 'pocket' || op.shape.contour.kind !== 'region') throw new Error('no region')
  return op.shape.contour.region
}

describe('boundary, fit and invert', () => {
  it('a boundary shape with a keep-out, clipped and inverted, stored in the record', async () => {
    const s = await setup()
    await withBoundary(s)
    const out = await add(s, {
      lattice: 'hex',
      cell: { kind: 'circle', diameter: '6' },
      boundary: { shapeId: 'shape1', center: ['50', '30'] },
      margin: '3',
      fit: 'clip',
    })
    expect(out.cells).toBeGreaterThan(20)
    expect(s.part().features?.[0]).toMatchObject({
      boundary: { shapeId: 'shape1' },
      fit: 'clip',
    })
    const own = s.part().shapes?.find((x) => x.id === 'pattern1_cells')
    expect(own?.pattern).toMatchObject({
      area: { shapeId: 'shape1', center: [50, 30], rotation: 0 },
      fit: 'clip',
    })
    const plain = regionArea(pocketRegion(s))
    await update(s, { invert: true })
    expect(s.part().shapes?.find((x) => x.id === 'pattern1_cells')?.pattern?.invert).toBe(true)
    // the area: 74 × 44 R 7 less a Ø 26 disc, minus the cells (its notch corners opened)
    const area = 74 * 44 - (4 - Math.PI) * 49 - Math.PI * 169
    expect(regionArea(pocketRegion(s))).toBeLessThan(area - plain)
    expect(regionArea(pocketRegion(s))).toBeGreaterThan((area - plain) * 0.98)
    // back to the face, whole cells, not inverted: the P1 record again
    await update(s, { boundary: null, fit: 'whole', invert: false })
    const p1 = s.part().shapes?.find((x) => x.id === 'pattern1_cells')?.pattern
    expect(p1).not.toHaveProperty('area')
    expect(p1).not.toHaveProperty('fit')
    expect(p1).not.toHaveProperty('invert')
    expect(s.part().features?.[0]).not.toHaveProperty('boundary')
  })

  it('editing the boundary shape restales the pattern', async () => {
    const s = await setup()
    await withBoundary(s)
    const out = await add(s, { boundary: { shapeId: 'shape1', center: ['50', '30'] } })
    await s.run('design.shape.update', {
      partId: s.partId,
      shapeId: 'shape1',
      items: [
        { kind: 'rectangle', center: ['0', '0'], length: '80', width: '50', cornerRadius: '10' },
      ],
    })
    expect(pocketRegion(s).pieces.length).toBeGreaterThan(out.cells!)
  })

  it('an unknown or owned boundary shape is refused at boundary.shapeId', async () => {
    const s = await setup()
    const e = await s.fail(
      'design.pattern.add',
      { partId: s.partId, boundary: { shapeId: 'shape9', center: ['50', '30'] } },
      'input.malformed',
    )
    expect(e.issues[0]).toMatchObject({ path: ['boundary', 'shapeId'], rule: 'unknownShape' })
    await add(s)
    const e2 = await s.fail(
      'design.pattern.add',
      { partId: s.partId, boundary: { shapeId: 'pattern1_cells', center: ['50', '30'] } },
      'model.invariant',
    )
    expect(e2.issues[0]?.path).toEqual(['boundary', 'shapeId'])
  })
})

describe('dfm.patternThinWeb', () => {
  it('a 0.6 mm web: a warning at Spacing with the web, a marker and the gap for 1 mm', async () => {
    const s = await setup()
    const out = await add(s, { lattice: 'hex', spacing: { gap: '0.6' } })
    expect(out.narrowestWeb).toBeCloseTo(0.6, 1)
    const w = out.warnings.find((x) => x.code === 'dfm.patternThinWeb')!
    expect(w).toMatchObject({ severity: 'warning', operation: 'pattern1', parameter: 'spacing' })
    expect(w.params['web']).toBeCloseTo(0.6, 1)
    expect(w.params['gap']).toBeCloseTo(1, 1)
    expect(w.params['at']).toHaveLength(2)
    // a 1 mm gap clears it
    const ok = await update(s, { spacing: { gap: '1' } })
    expect(ok.warnings.some((x) => x.code === 'dfm.patternThinWeb')).toBe(false)
    expect(ok).not.toHaveProperty('narrowestWeb')
  })

  it('inverted: a thin island is reported at Cell', async () => {
    const s = await setup()
    const out = await add(s, { invert: true, cell: { kind: 'circle', diameter: '0.8' } })
    const w = out.warnings.find((x) => x.code === 'dfm.patternThinWeb')!
    expect(w).toMatchObject({ parameter: 'cell', params: { island: true } })
  })
})

describe('presets', () => {
  it('each preset is a valid cell, lattice and gap on a 200 × 150 face', async () => {
    const s = await setup({
      name: 'Board',
      shape: 'block',
      length: '200',
      width: '150',
      thickness: '12',
      material: { name: 'Walnut', class: 'hardwood' },
    })
    await add(s)
    for (const preset of PATTERN_PRESETS) {
      const out = await update(s, preset.args)
      expect(out.cells, preset.id).toBeGreaterThan(20)
      expect(
        out.warnings.filter((w) => w.severity === 'warning').map((w) => w.code),
        preset.id,
      ).toEqual([])
    }
  })
})

describe('split parts', () => {
  it('a pattern crossing the split line: each piece clips the cells at its cell', async () => {
    const s = await setup()
    await add(s, { lattice: 'hex', cell: { kind: 'circle', diameter: '6' }, margin: '3' })
    const source = regionArea(pocketRegion(s))
    await s.run('design.split.set', {
      partId: s.partId,
      split: { lines: [{ axis: 'x', at: '50' }] },
    })
    const pieces = Object.values(s.d.doc.parts).filter(
      (p): p is PartDTO => p.derivedFrom?.partId === s.partId,
    )
    expect(pieces).toHaveLength(2)
    let sum = 0
    for (const p of pieces) {
      const own = p.shapes?.find((x) => x.id === 'pattern1_cells')
      expect(own?.owner).toBe('pattern1')
      expect(own?.pattern?.clip).toBeDefined()
      expect(p.features).toBeUndefined()
      const r = checkPartFits(p, s.d.doc.snapshots[p.stock]!, 'test', region2d)
      expect(r.isOk() ? 'ok' : r.unwrapErr().issues, p.name).toBe('ok')
      // the piece's cells within its cell (grown by the tool), away from the seam
      sum += regionArea(pocketRegion(s, p.id))
    }
    // each piece clears to the line plus the tool Ø: the halves overlap at the seam
    expect(sum).toBeGreaterThanOrEqual(source - 1e-6)
    expect(sum).toBeLessThan(source * 1.3)
  })
})
