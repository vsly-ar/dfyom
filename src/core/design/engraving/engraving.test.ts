// The engraved pattern (engraved-patterns.md E3) through its commands: the 13 presets import
// clean through `?raw`; the owned lines shape and Line; the expansion into Line paths with their
// levels; a round preset fitted to a Ø 90 coaster boundary (Pattern's boundary handling reused:
// placed by its box centre as a pattern's); a tile at a centre and size; the part's shapes as the
// motif (following their edits); update rules (a new motif takes its default fit); issues at the
// feature's fields; dfm.engravingEmpty / engravingHeavy; disable (DF106), stock follow, remove.
// Spec: docs/modes/engraved-patterns.md#implementation-e3
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { regionLoops } from '../../geometry/2d/model'
import { lineMaxDepth, lineMinDepth } from '../../geometry/line'
import type { LineGeometry } from '../../geometry/model'
import { designSetup, type DesignSetup } from '../design.fixture'
import { partGeometryInput } from '../load'
import { patternFacts } from '../pattern/pattern'
import { engravingResolved } from './engraving'
import { ENGRAVING_PRESETS, presetLines } from './presets'

interface NodeProcess {
  getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL, enc: 'utf8'): string }
}
const fs = (globalThis as unknown as { process: NodeProcess }).process.getBuiltinModule('node:fs')

const region2d = nodeRegion2d()
const setup = (stock?: object) =>
  designSetup({ services: { region2d }, ...(stock ? { stock } : {}) })

interface Result {
  featureId: string
  operationIds: string[]
  lines?: number
  length?: number
  size?: number
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

/** The owned Line's geometry input. */
function lineOf(s: DesignSetup, id = 'engraving1_line'): LineGeometry {
  const g = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
  const op = g.operations.find((o) => o.id === id)
  if (op?.kind !== 'line') throw new Error(`no line ${id}`)
  return op
}

const facts = (s: DesignSetup) =>
  engravingResolved('engraving1', s.part().shapes ?? [], region2d)!.facts

const circleShape = async (s: DesignSetup, diameter: string) =>
  (
    (await s.run('design.shape.add', {
      partId: s.partId,
      items: [{ kind: 'circle', op: 'add', center: ['0', '0'], diameter }],
    })) as { shapeId: string }
  ).shapeId

describe('engraving presets (EP-G)', () => {
  it('ships 13 presets, each importing clean with its size and lines', () => {
    expect(ENGRAVING_PRESETS.map((p) => p.id)).toEqual([
      'waves',
      'chevrons',
      'crosshatch',
      'scales',
      'seigaiha',
      'basket-weave',
      'greek-key',
      'wood-grain',
      'vine',
      'rosette',
      'sunburst',
      'ripples',
      'mandala',
    ])
    for (const p of ENGRAVING_PRESETS) {
      // the manifest's size is the file's
      expect(p.svg, p.id).toContain(`width="${p.size[0]}mm" height="${p.size[1]}mm"`)
      expect(p.svg, p.id).toContain('GPL-3.0-or-later')
      const r = expectOk(presetLines(p.id))
      expect(r.warnings, p.id).toEqual([])
      expect(r.lines.length, p.id).toBeGreaterThan(0)
    }
    // the texts are the shipped files (preset-svgs.ts, node scripts/engraving-presets.mjs)
    for (const p of ENGRAVING_PRESETS) {
      const file = new URL(`./presets/${p.id}.svg`, import.meta.url)
      expect(p.svg, p.id).toBe(fs.readFileSync(file, 'utf8'))
    }
    // the rosette: twelve circles, the border ring and the centre ring, two levels
    const rosette = expectOk(presetLines('rosette')).lines
    expect(rosette).toHaveLength(14)
    expect(rosette.every((l) => l.closed)).toBe(true)
    expect(new Set(rosette.map((l) => l.levels?.level[0] ?? 1)).size).toBe(2)
    expect(presetLines('nope').isErr()).toBe(true)
  })
})

describe('design.engraving.add', () => {
  it('owns a lines shape and one Line; the default Rosette fits the face less the margin', async () => {
    const s = await setup()
    const out = await add(s)
    expect(out).toMatchObject({
      featureId: 'engraving1',
      operationIds: ['engraving1_line'],
      lines: 14,
    })
    expect(out.warnings).toEqual([])
    expect(s.part().shapes).toEqual([
      {
        id: 'engraving1_lines',
        name: 'Engraved pattern 1 · lines',
        items: [],
        owner: 'engraving1',
        engraving: {
          motif: { preset: 'rosette' },
          boundary: { min: [0, 0], max: [100, 60] },
          margin: 3,
          rotation: 0,
          fit: 'boundary',
        },
      },
    ])
    const line = s.op('engraving1_line') as unknown as {
      on: string
      paths: { shapeId: string; anchor?: object }[]
      depth: { min: { source: string }; max: { source: string } }
    }
    expect(line.on).toBe('stock.top')
    expect(line.paths).toMatchObject([
      { shapeId: 'engraving1_lines', anchor: { u: 'min', v: 'min' } },
    ])
    expect([line.depth.min.source, line.depth.max.source]).toEqual(['0.2 mm', '1 mm'])
    // the expansion: one Line path per motif line, each with its level
    const g = lineOf(s)
    expect(g.paths).toHaveLength(14)
    expect(g.levels).toHaveLength(14)
    expect(lineMaxDepth(g)).toBeCloseTo(1, 9)
    expect(lineMinDepth(g)).toBeCloseTo(
      0.2 + 0.8 * (1 - (0.0722 * 0x4d) / 255 - (0.7152 * 0x4d) / 255 - (0.2126 * 0x4d) / 255),
      3,
    )
    // fitted: the drawn Ø 72 to the 54 mm high area, centred on the face
    const f = facts(s)
    expect(out.size).toBeCloseTo(60, 6)
    expect(f.bounds!.min[0]).toBeCloseTo(23, 6)
    expect(f.bounds!.max[0]).toBeCloseTo(77, 6)
    expect(f.bounds!.min[1]).toBeCloseTo(3, 6)
    expect(f.bounds!.max[1]).toBeCloseTo(57, 6)
  })

  it('fits the Rosette to a Ø 90 coaster boundary (Pattern’s boundary, placed by its box centre)', async () => {
    const s = await setup({
      name: 'Coaster blank',
      shape: 'block',
      length: '100',
      width: '100',
      thickness: '6',
      material: { name: 'Birch plywood', class: 'sheetGood' },
    })
    const circle = await circleShape(s, '90')
    const out = await add(s, {
      boundary: { shapeId: circle, center: ['50', '50'] },
      depth: { min: '0.2', max: '1' },
    })
    expect(out.warnings).toEqual([])
    const f = facts(s)
    // the area: Ø 90 less 3 mm → a box of 84 centred at (50, 50); the border ring Ø 84
    expect(f.area).toEqual({ min: [8, 8], max: [92, 92] })
    expect(f.bounds!.min[0]).toBeCloseTo(8, 6)
    expect(f.bounds!.max[1]).toBeCloseTo(92, 6)
    // the same boundary on a pattern: the same area box (Pattern's handling reused)
    await s.run('design.pattern.add', {
      partId: s.partId,
      boundary: { shapeId: circle, center: ['50', '50'] },
      margin: '3',
      depth: '0.5',
    })
    const pf = patternFacts('pattern1', s.part().shapes ?? [], region2d)!
    // x extremes of the area's elements (a full-circle arc reaches centre ± radius)
    const xs = regionLoops(pf.area).flatMap((l) =>
      l.elements.flatMap((e) => {
        if (e.kind === 'line') return [e.a[0], e.b[0]]
        const r = Math.hypot(e.a[0] - e.centre[0], e.a[1] - e.centre[1])
        return [e.a[0], e.b[0], e.centre[0] - r, e.centre[0] + r]
      }),
    )
    expect(Math.min(...xs)).toBeCloseTo(8, 6)
    expect(Math.max(...xs)).toBeCloseTo(92, 6)
    // fitted motifs ignore their size; the border ring is a full circle at Ø 84
    const ring = lineOf(s).paths.find((p) => {
      const c = p.contour
      return c.kind === 'region' && regionLoops(c.region)[0]!.elements.length === 2
    })
    expect(ring).toBeDefined()
  })

  it('places a tile once at a centre, size and rotation (layout single, E3)', async () => {
    const s = await setup()
    const out = await add(s, {
      motif: { preset: 'waves' },
      center: ['30', '20'],
      size: '40',
      rotation: '90',
      depth: '0.5',
    })
    expect(out).toMatchObject({ lines: 1, size: 40 })
    const rec = s.part().shapes![0]!.engraving!
    expect(rec).not.toHaveProperty('fit')
    const f = facts(s)
    // the 20 × 10 tile doubled and turned: its 40 mm across along v, centred at (30, 20)
    expect(f.bounds!.max[1] - f.bounds!.min[1]).toBeCloseTo(40, 6)
    expect((f.bounds!.max[1] + f.bounds!.min[1]) / 2).toBeCloseTo(20, 6)
    expect(lineOf(s).depth).toEqual({ start: 0.5, end: 0.5 })
  })

  it('takes the part’s shapes as the motif and follows their edits', async () => {
    const s = await setup()
    const { shapeId } = (await s.run('design.shape.add', {
      partId: s.partId,
      items: [
        {
          kind: 'path',
          op: 'add',
          closed: false,
          start: ['0', '0'],
          segments: [{ kind: 'line', to: ['20', '0'] }],
        },
      ],
    })) as { shapeId: string }
    const out = await add(s, { motif: { shapeIds: [shapeId] }, depth: '0.4' })
    expect(out).toMatchObject({ lines: 1, length: 20 })
    // removing a shape the motif uses is refused
    await s.fail('design.shape.remove', { partId: s.partId, shapeId }, 'design.referenced')
    await s.run('design.shape.update', {
      partId: s.partId,
      shapeId,
      items: [
        {
          kind: 'path',
          op: 'add',
          closed: false,
          start: ['0', '0'],
          segments: [{ kind: 'line', to: ['30', '0'] }],
        },
      ],
    })
    expect(facts(s).length).toBeCloseTo(30, 9)
  })
})

describe('design.engraving.update', () => {
  it('a new motif takes its own default fit; a given fit wins', async () => {
    const s = await setup()
    await add(s)
    await update(s, { motif: { preset: 'vine' } })
    expect(s.part().features![0]!['fit']).toBeUndefined()
    await update(s, { fit: 'boundary' })
    expect(s.part().features![0]!['fit']).toBe('boundary')
    await update(s, { motif: { preset: 'mandala' }, fit: 'whole' })
    expect(s.part().features![0]!['fit']).toBeUndefined()
  })

  it('reports issues at the feature’s fields', async () => {
    const s = await setup()
    await add(s)
    const bad = async (args: object) =>
      (
        await s.fail(
          'design.engraving.update',
          { partId: s.partId, featureId: 'engraving1', ...args },
          'model.invariant',
        )
      ).issues.map((i) => [i.path.join('.'), i.rule])
    expect(await bad({ motif: { preset: 'nope' } })).toEqual([['motif.preset', 'unknownPreset']])
    expect(await bad({ margin: '-1' })).toEqual([['margin', 'nonNegative']])
    expect(await bad({ size: '0' })).toEqual([['size', 'positive']])
    const open = (await s.run('design.shape.add', {
      partId: s.partId,
      items: [
        {
          kind: 'path',
          op: 'add',
          closed: false,
          start: ['0', '0'],
          segments: [{ kind: 'line', to: ['9', '0'] }],
        },
      ],
    })) as { shapeId: string }
    const e = await s.fail(
      'design.engraving.update',
      {
        partId: s.partId,
        featureId: 'engraving1',
        boundary: { shapeId: open.shapeId, center: ['50', '30'] },
      },
      'input.malformed',
    )
    expect(e.issues.map((i) => i.rule)).toEqual(['engravingBoundaryOpen'])
  })
})

describe('engraving findings, disable and follow', () => {
  it('dfm.engravingEmpty when the motif sits outside the area', async () => {
    const s = await setup()
    const out = await add(s, { motif: { preset: 'scales' }, center: ['-50', '30'] })
    expect(out.warnings.map((w) => [w.code, w.operation, w.parameter])).toContainEqual([
      'dfm.engravingEmpty',
      'engraving1',
      'margin',
    ])
  })

  it('a disabled engraving is out of the geometry (DF106); the stock change re-places it', async () => {
    const s = await setup()
    await add(s)
    await s.run('design.part.update', { partId: s.partId, disabled: ['engraving1'] })
    const g = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    expect(g.operations.some((o) => o.id === 'engraving1_line')).toBe(false)
    await s.run('design.part.update', { partId: s.partId, disabled: [] })
    expect(lineOf(s).paths).toHaveLength(14)
    // removing the feature removes its owned shape and Line
    await s.run('design.feature.remove', { partId: s.partId, featureId: 'engraving1' })
    expect(s.part().shapes ?? []).toEqual([])
    expect(s.part().operations).toEqual([])
    await s.undo()
    expect(s.part().shapes).toHaveLength(1)
  })
})
