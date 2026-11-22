// design.shape.import through a dispatcher (prepare: worker task reading the file, then one
// undoable commit): the enclosure drawing as two shapes, the report, units, split, inch sources,
// undo/redo and errors. Doc: docs/modes/design-v0.3.md#svg-import
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers, memoryFiles } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { designSetup, type DesignSetup } from './design.fixture'
import { ENCLOSURE_SECTIONS_SVG } from './enclosure-sections.testing'
import type { ShapeDTO } from './shape.dto'

interface NodeProcess {
  getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL): Uint8Array }
}
const fs = (globalThis as unknown as { process: NodeProcess }).process.getBuiltinModule('node:fs')

const region2d = nodeRegion2d()
const ui = uiSource()
const enc = (s: string) => new TextEncoder().encode(s)

const ENCLOSURE = '/drawings/enclosure-sections.svg'
const UNITLESS = '/drawings/unitless.svg'
const PLATE = 'C:\\drawings\\plate.svg'
const NOT_SVG = '/drawings/page.svg'
const EMPTY = '/drawings/empty.svg'
const FILES = new Map<string, Uint8Array>([
  [ENCLOSURE, new Uint8Array(fs.readFileSync(ENCLOSURE_SECTIONS_SVG))],
  // no size: the viewBox user units take the `unit` option (px96 by default)
  [UNITLESS, enc('<svg viewBox="0 0 200 100"><rect x="0" y="0" width="96" height="48"/></svg>')],
  // an outline and a hole drawn as its own element (even-odd between elements), plus an open line
  [
    PLATE,
    enc(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="60mm" viewBox="0 0 100 60">' +
        '<rect id="plate" x="10" y="10" width="80" height="40" rx="5"/>' +
        '<circle id="bore" cx="50" cy="30" r="10"/>' +
        '<path d="M 5 55 L 95 55"/></svg>',
    ),
  ],
  [NOT_SVG, enc('<html><body/></html>')],
  [EMPTY, enc('<svg width="10mm" height="10mm"><text>hi</text></svg>')],
])

const setup = (units: 'mm' | 'inch' = 'mm') =>
  designSetup({
    units,
    services: { region2d, workers: createInProcessWorkers({ files: memoryFiles(FILES) }) },
  })

interface Imported {
  shapeIds: string[]
  report: {
    unit: string
    unitAssumed: boolean
    size?: { width: number; height: number }
    imported: Record<string, number>
    skipped: Record<string, number>
    beziersFitted: number
    maxDeviation: number
    loops: number
    openPaths: number
    warnings: unknown[]
  }
  warnings: unknown[]
}
const importSvg = async (s: DesignSetup, args: object) =>
  (await s.run('design.shape.import', { partId: s.partId, ...args })) as Imported
const shapes = (s: DesignSetup): ShapeDTO[] => s.part().shapes ?? []
const get = (s: DesignSetup, shapeId: string) =>
  expectOk(s.d.query('design.shape.get', { partId: s.partId, shapeId }, ui)).value as {
    resolved?: { kind: string; area: number; bounds: { min: number[]; max: number[] } }
  }

describe('design.shape.import', () => {
  it('imports the enclosure drawing as two shapes in one undo step', async () => {
    const s = await setup()
    const r = await importSvg(s, { path: ENCLOSURE })
    expect(r.shapeIds).toEqual(['shape1', 'shape2'])
    expect(r.warnings).toEqual([])
    expect(r.report).toMatchObject({
      unit: 'mm',
      unitAssumed: false,
      size: { width: 250, height: 178 },
      imported: { path: 2 },
      beziersFitted: 22,
      loops: 2,
      openPaths: 0,
      warnings: [],
    })
    expect(r.report.maxDeviation).toBeLessThanOrEqual(0.01)
    const [outline, cavity] = shapes(s)
    expect(outline).toMatchObject({
      id: 'shape1',
      name: 'outline',
      source: { file: 'enclosure-sections.svg', element: '#outline' },
    })
    expect(cavity).toMatchObject({ id: 'shape2', name: 'cavity', source: { element: '#cavity' } })
    for (const sh of [outline!, cavity!]) {
      expect(sh.items).toHaveLength(1)
      const item = sh.items[0]!
      expect(item.kind === 'path' && item.closed).toBe(true)
      expect(item.kind === 'path' && item.segments.length).toBeGreaterThan(20)
      expect(get(s, sh.id).resolved?.kind).toBe('region')
    }
    // the cavity lies inside the outline
    const o = get(s, 'shape1').resolved!
    const c = get(s, 'shape2').resolved!
    expect(c.area).toBeLessThan(o.area)
    expect(c.bounds.min[0]).toBeGreaterThan(o.bounds.min[0]!)
    expect(s.d.history.undoable.at(-1)?.title).toBe('Import SVG')
    await s.undo()
    expect(shapes(s)).toEqual([])
    await s.redo()
    expect(shapes(s).map((x) => x.id)).toEqual(['shape1', 'shape2'])
    // a second import numbers on
    expect((await importSvg(s, { path: ENCLOSURE })).shapeIds).toEqual(['shape3', 'shape4'])
  })

  it('assumes 96 px per inch for unitless files unless told otherwise', async () => {
    const s = await setup()
    const px = await importSvg(s, { path: UNITLESS })
    expect(px.report).toMatchObject({ unit: 'px96', unitAssumed: true })
    expect(get(s, px.shapeIds[0]!).resolved!.bounds.max[0]).toBeCloseTo(25.4, 6)
    const mm = await importSvg(s, { path: UNITLESS, unit: 'mm' })
    expect(mm.report).toMatchObject({ unit: 'mm', unitAssumed: true })
    expect(get(s, mm.shapeIds[0]!).resolved!.bounds.max[0]).toBeCloseTo(96, 6)
    const inch = await importSvg(s, { path: UNITLESS, unit: 'in' })
    expect(get(s, inch.shapeIds[0]!).resolved!.bounds.max[0]).toBeCloseTo(96 * 25.4, 6)
  })

  it('splits per element (default), file or loop; open paths are shapes of their own', async () => {
    const s = await setup()
    const byElement = await importSvg(s, { path: PLATE })
    expect(byElement.shapeIds).toHaveLength(3)
    expect(shapes(s).map((x) => [x.name, x.source?.file, x.source?.element])).toEqual([
      ['plate', 'plate.svg', '#plate'],
      ['bore', 'plate.svg', '#bore'],
      ['Path 3', 'plate.svg', 'path[3]'],
    ])
    const open = shapes(s)[2]!.items[0]!
    expect(open.kind === 'path' && open.closed).toBe(false)
    expect(get(s, shapes(s)[2]!.id).resolved?.kind).toBe('path')

    const t = await setup()
    const byFile = await importSvg(t, { path: PLATE, split: 'file' })
    // the plate with its bore, and the open line
    expect(byFile.shapeIds).toHaveLength(2)
    const plate = shapes(t)[0]!
    expect(plate.items.map((i) => i.op)).toEqual(['add', 'subtract'])
    const area = get(t, plate.id).resolved!.area
    expect(area).toBeCloseTo(80 * 40 - (4 - Math.PI) * 25 - Math.PI * 100, 3)
  })

  it('writes mm sources in an inch project', async () => {
    const s = await setup('inch')
    const r = await importSvg(s, { path: PLATE, split: 'file' })
    const item = shapes(s)[0]!.items[0]!
    expect(item.kind === 'path' && item.start[0].source).toMatch(/ mm$/)
    expect(get(s, r.shapeIds[0]!).resolved!.bounds.min[0]).toBeCloseTo(10, 6)
  })

  it('refuses bad input without a change or an undo step', async () => {
    const s = await setup()
    const rev = s.d.revision
    const rule = async (args: object) =>
      (await s.fail('design.shape.import', { partId: s.partId, ...args }, 'input.malformed'))
        .issues[0]?.rule
    expect(await rule({ path: 'enclosure.svg' })).toBe('absolutePath')
    expect(await rule({ path: '/nope.svg' })).toBe('unreadableFile')
    expect(await rule({ path: NOT_SVG })).toBe('svgNotSvg')
    expect(await rule({ path: EMPTY })).toBe('svgEmpty')
    expect(await rule({ path: ENCLOSURE, unit: 'cm' })).toBeDefined()
    await s.fail('design.shape.import', { partId: 'nope', path: ENCLOSURE }, 'input.malformed')
    expect(s.d.revision).toBe(rev)
    expect(shapes(s)).toEqual([])
  })

  it('fails cleanly without the 2D port', async () => {
    const s = await designSetup({
      services: { workers: createInProcessWorkers({ files: memoryFiles(FILES) }) },
    })
    const e = await s.fail(
      'design.shape.import',
      { partId: s.partId, path: ENCLOSURE },
      'internal.unexpected',
    )
    expect(e.message).toBeTruthy()
  })
})
