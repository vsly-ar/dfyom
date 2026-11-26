// Engraved patterns E4: tiles on Pattern's lattices through the commands. The Waves default
// tiles a lid clipped to a rounded rectangle (continuous chained lines, nothing outside the area,
// no element cut twice); square tiles sharing edges lose the coincident ones (each seam once);
// whole tiles vs clipped lines; scales on a polar lattice, radial (each chord tangent to its
// ring) or not; update rules (a tile preset tiles, layout fields kept, the fit follows);
// issues at the feature's fields; dfm.lineMerge on rows pitched too close.
// Spec: docs/modes/engraved-patterns.md#implementation-e4
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { ClipBoundary } from '../../geometry/2d/clip-lines'
import { elementPointAt } from '../../geometry/2d/measure'
import { elementLength, regionLoops, type Element } from '../../geometry/2d/model'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { lineChains } from '../../geometry/line'
import type { LineGeometry } from '../../geometry/model'
import { designSetup, type DesignSetup } from '../design.fixture'
import { partGeometryInput } from '../load'
import { engravingResolved } from './engraving'
import { ENGRAVING_PRESETS } from './presets'

const region2d = nodeRegion2d()
const LID = {
  name: 'Lid',
  shape: 'block',
  length: '150',
  width: '100',
  thickness: '6',
  material: { name: 'Birch plywood', class: 'sheetGood' },
}
const setup = (stock?: object) =>
  designSetup({ services: { region2d }, ...(stock ? { stock } : {}) })

interface Result {
  featureId: string
  lines?: number
  length?: number
  tiles?: number
  crossings?: number
  warnings: { code: string; severity: string; operation: string; parameter?: string }[]
}
const add = async (s: DesignSetup, args: object = {}) =>
  (await s.run('design.engraving.add', { partId: s.partId, ...args })) as Result
const update = async (s: DesignSetup, args: object) =>
  (await s.run('design.engraving.update', {
    partId: s.partId,
    featureId: 'engraving1',
    ...args,
  })) as Result

function lineOf(s: DesignSetup): LineGeometry {
  const g = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
  const op = g.operations.find((o) => o.id === 'engraving1_line')
  if (op?.kind !== 'line') throw new Error('no line')
  return op
}
const resolved = (s: DesignSetup) =>
  engravingResolved('engraving1', s.part().shapes ?? [], region2d)!

const elementsOf = (s: DesignSetup): Element[] =>
  resolved(s).lines.flatMap((l) =>
    l.shape.contour.kind === 'path'
      ? [...l.shape.contour.path.elements]
      : l.shape.contour.kind === 'region'
        ? regionLoops(l.shape.contour.region).flatMap((x) => [...x.elements])
        : [],
  )

const roundedRect = async (s: DesignSetup) =>
  (
    (await s.run('design.shape.add', {
      partId: s.partId,
      name: 'Lid outline',
      items: [
        {
          kind: 'rectangle',
          op: 'add',
          center: ['0', '0'],
          length: '140',
          width: '90',
          cornerRadius: '15',
        },
      ],
    })) as { shapeId: string }
  ).shapeId

describe('tiles on a lattice (E4)', () => {
  it('the crossings in the results: none between rows of waves, one per crosshatch tile', async () => {
    const s = await setup(LID)
    expect((await add(s, {})).crossings).toBe(0)
    const one = await update(s, {
      motif: { preset: 'crosshatch' },
      layout: 'single',
      fit: 'whole',
      center: ['75', '50'],
    })
    // the tile's two diagonals cross at its centre
    expect(one.crossings).toBe(1)
    // tiled: every tile's centre and every corner where four tiles meet
    const many = await update(s, { layout: { lattice: 'square' }, fit: 'clip' })
    expect(many.crossings!).toBeGreaterThan(many.tiles!)
  })

  it('Waves (the default) over a lid, clipped to a rounded rectangle: continuous lines, cut once', async () => {
    const s = await setup(LID)
    const outline = await roundedRect(s)
    const out = await add(s, {
      boundary: { shapeId: outline, center: ['75', '50'] },
      depth: '0.5',
    })
    const f = s.part().features![0]!
    expect(f['motif']).toEqual({ preset: 'waves' })
    expect(f['layout']).toMatchObject({ lattice: 'square', spacing: { gap: { source: '0' } } })
    expect(f['fit']).toBe('clip')
    expect(out.warnings).toEqual([])
    // 20 × 10 tiles over the 134 × 84 area: rows of waves 10 mm apart about the centre; the 7
    // inner rows are one chained line each, across the area (the outer two dip out at y = 8 / 92
    // and are cut into pieces there)
    expect(out.tiles).toBeGreaterThan(60)
    const spans = resolved(s).lines.map((l) => {
      const els = l.shape.contour.kind === 'path' ? l.shape.contour.path.elements : []
      const xs = els.flatMap((e) => [e.a[0], e.b[0]])
      return Math.max(...xs) - Math.min(...xs)
    })
    expect(spans.filter((x) => x > 100)).toHaveLength(7)
    // every element inside the boundary less the margin's box (an exact clip)
    const els = elementsOf(s)
    const r = resolved(s)
    for (const e of els) {
      const m = elementPointAt(e, 0.5).point
      expect(m[0]).toBeGreaterThanOrEqual(8 - 1e-6)
      expect(m[0]).toBeLessThanOrEqual(142 + 1e-6)
      expect(m[1]).toBeGreaterThanOrEqual(8 - 1e-6)
      expect(m[1]).toBeLessThanOrEqual(92 + 1e-6)
    }
    expect(r.facts.area).toEqual({ min: [8, 8], max: [142, 92] })
    // the corners are round: the rows near the top and bottom are shorter than the middle one
    const lengths = r.lines.map((l) =>
      l.shape.contour.kind === 'path'
        ? l.shape.contour.path.elements.reduce((a, e) => a + elementLength(e), 0)
        : 0,
    )
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeGreaterThan(5)
    // the Line sees nothing twice and nothing to chain: each row one line, cut once
    const chains = lineChains(lineOf(s))
    expect(chains.coincident).toBe(0)
    expect(chains.lines).toHaveLength(out.lines!)
  })

  it('square tiles sharing edges: each shared edge is cut once', async () => {
    const s = await setup({ ...LID, length: '30', width: '30' })
    const { shapeId } = (await s.run('design.shape.add', {
      partId: s.partId,
      items: [
        {
          kind: 'rectangle',
          op: 'add',
          center: ['0', '0'],
          length: '10',
          width: '10',
          cornerRadius: '0',
        },
      ],
    })) as { shapeId: string }
    const out = await add(s, {
      motif: { shapeIds: [shapeId] },
      layout: { lattice: 'square' },
      fit: 'whole',
      margin: '0',
      depth: '0.3',
    })
    expect(out.tiles).toBe(9)
    const r = resolved(s)
    expect(r.facts.coincident).toBe(12)
    // 24 distinct edges of 10 mm
    expect(r.facts.length).toBeCloseTo(240, 6)
    expect(lineChains(lineOf(s)).coincident).toBe(0)
  })

  it('whole keeps only tiles inside; clip cuts the lines at the area', async () => {
    const s = await setup(LID)
    const whole = await add(s, { motif: { preset: 'crosshatch' }, fit: 'whole', depth: '0.4' })
    const clipped = await update(s, { fit: 'clip' })
    expect(whole.tiles).toBe(13 * 9)
    expect(clipped.tiles!).toBeGreaterThan(whole.tiles!)
    expect(clipped.length!).toBeGreaterThan(whole.length!)
    // the clipped lines reach the area's edges, the whole ones stop a part tile short
    const b = resolved(s).facts.bounds!
    expect(b.min[0]).toBeCloseTo(3, 6)
    expect(b.max[1]).toBeCloseTo(97, 6)
  })

  it('scales on a polar lattice round a lid: radial tiles face outwards', async () => {
    const s = await setup({ ...LID, length: '100', width: '100' })
    const { shapeId } = (await s.run('design.shape.add', {
      partId: s.partId,
      items: [{ kind: 'circle', op: 'add', center: ['0', '0'], diameter: '90' }],
    })) as { shapeId: string }
    const out = await add(s, {
      motif: { preset: 'scales' },
      layout: { lattice: 'polar', spacing: { gap: '3' } },
      rotation: 'radial',
      boundary: { shapeId, center: ['50', '50'] },
      fit: 'whole',
      depth: '0.4',
    })
    expect(s.part().features![0]!['radial']).toBe(true)
    expect(out.tiles!).toBeGreaterThan(20)
    // every scale's chord is tangent to its ring: perpendicular to the ray through its middle
    const chordCos = () =>
      resolved(s).lines.map((l) => {
        const els = l.shape.contour.kind === 'path' ? l.shape.contour.path.elements : []
        const a = els[0]!.a
        const b = els.at(-1)!.b
        const m = [(a[0] + b[0]) / 2 - 50, (a[1] + b[1]) / 2 - 50]
        const d = [b[0] - a[0], b[1] - a[1]]
        return (
          Math.abs(m[0]! * d[0]! + m[1]! * d[1]!) /
          (Math.hypot(m[0]!, m[1]!) * Math.hypot(d[0]!, d[1]!))
        )
      })
    expect(Math.max(...chordCos())).toBeLessThan(1e-9)
    // not radial: every chord stays horizontal
    await update(s, { rotation: '0' })
    expect(s.part().features![0]!['radial']).toBeUndefined()
    for (const l of resolved(s).lines) {
      const els = l.shape.contour.kind === 'path' ? l.shape.contour.path.elements : []
      expect(Math.abs(els[0]!.a[1] - els.at(-1)!.b[1])).toBeLessThan(1e-9)
    }
    // everything inside the Ø 90 less 3 mm
    const ring = new ClipBoundary({
      pieces: [
        {
          outer: {
            elements: [
              { kind: 'arc', a: [92, 50], b: [8, 50], centre: [50, 50], ccw: true },
              { kind: 'arc', a: [8, 50], b: [92, 50], centre: [50, 50], ccw: true },
            ],
          },
          holes: [],
        },
      ],
    })
    for (const e of elementsOf(s)) expect(ring.contains(elementPointAt(e, 0.5).point)).toBe(true)
  })

  it('update: a tile preset tiles, a round one is single; layout fields are kept', async () => {
    const s = await setup(LID)
    await add(s, { motif: { preset: 'rosette' } })
    expect(s.part().features![0]!['layout']).toBeUndefined()
    expect(s.part().features![0]!['fit']).toBe('boundary')
    await update(s, { motif: { preset: 'scales' } })
    expect(s.part().features![0]!['layout']).toMatchObject({ lattice: 'staggered' })
    expect(s.part().features![0]!['fit']).toBe('clip')
    await update(s, { layout: { lattice: 'hex', spacing: { gap: '1' }, angle: '15' } })
    await update(s, { layout: { lattice: 'square' } })
    expect(s.part().features![0]!['layout']).toMatchObject({
      lattice: 'square',
      spacing: { gap: { source: '1' } },
      angle: { source: '15' },
    })
    await update(s, { layout: 'single' })
    expect(s.part().features![0]!['layout']).toBeUndefined()
    expect(s.part().features![0]!['fit']).toBeUndefined()
  })

  it('reports layout issues at the feature’s fields', async () => {
    const s = await setup(LID)
    await add(s)
    const bad = async (args: object) =>
      (
        await s.fail(
          'design.engraving.update',
          { partId: s.partId, featureId: 'engraving1', ...args },
          'model.invariant',
        )
      ).issues.map((i) => [i.path.join('.'), i.rule])
    expect(await bad({ layout: { lattice: 'square', spacing: { gap: '-1' } } })).toEqual([
      ['layout.spacing.gap', 'nonNegative'],
    ])
    expect(await bad({ fit: 'boundary' })).toEqual([['fit', 'engravingFitBoundary']])
    expect(await bad({ rotation: 'radial' })).toEqual([['rotation', 'engravingRadial']])
    expect(await bad({ size: '0.05' })).toEqual([['layout', 'engravingTooMany']])
  })

  it('every preset at its defaults on a lid (tiles tiled): no merge or other finding', async () => {
    for (const preset of ENGRAVING_PRESETS) {
      const s = await setup(LID)
      const out = await add(s, { motif: { preset: preset.id } })
      // the Vine's last leaf sits 0.79 mm off its stem: their grooves do overlap there
      const codes = out.warnings.map((w) => w.code)
      expect([preset.id, codes]).toEqual([preset.id, preset.id === 'vine' ? ['dfm.lineMerge'] : []])
      if (preset.kind === 'tile') expect(out.tiles!).toBeGreaterThan(10)
    }
  })

  it('dfm.lineMerge: rows pitched closer than the grooves are wide leave no wall', async () => {
    const s = await setup({ ...LID, length: '60', width: '40' })
    const ok = await add(s, { depth: '1' })
    expect(ok.warnings.map((w) => w.code)).not.toContain('dfm.lineMerge')
    const close = await update(s, {
      layout: { lattice: 'square', spacing: { pitch: ['20', '1.2'] } },
    })
    expect(close.warnings).toContainEqual(
      expect.objectContaining({
        code: 'dfm.lineMerge',
        severity: 'warning',
        operation: 'engraving1_line',
        parameter: 'depth',
      }),
    )
  })
})
