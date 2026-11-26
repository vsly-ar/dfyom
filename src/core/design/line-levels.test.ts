// Engraved patterns E2: levels from an SVG to a Line's depth. The E0 sample imported through
// design.shape.import keeps its levels on the path items (colour → level, data-level stops); a
// Line with `{ min, max }` maps them to depth, chains the three coloured pieces into one line with
// blended steps and gives the spike's depths (±0.001 mm); a path `scale`; item edits keep or drop
// the levels; `{ min, max }` rules. Doc: docs/modes/engraved-patterns.md#implementation-e2
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers, memoryFiles } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { lineChains, lineMaxDepth, profileAt } from '../geometry/line'
import type { LineGeometry } from '../geometry/model'
import { designSetup, type DesignSetup } from './design.fixture'
import { toGeometryInput } from './geometry-input'
import { loadPart } from './load'
import type { ShapeDTO } from './shape.dto'

interface NodeProcess {
  getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL): Uint8Array }
}
const fs = (globalThis as unknown as { process: NodeProcess }).process.getBuiltinModule('node:fs')

const region2d = nodeRegion2d()
const SAMPLE = '/drawings/levels-sample.svg'
const FILES = new Map<string, Uint8Array>([
  [
    SAMPLE,
    new Uint8Array(fs.readFileSync(new URL('./__fixtures__/levels-sample.svg', import.meta.url))),
  ],
])

interface Listed {
  shapes: { id: string; name: string; bounds?: { min: number[]; max: number[] } }[]
}

/** The sample imported, its shapes by name with the centre of their bounds (shape frame). */
async function imported(): Promise<
  DesignSetup & { byName: Map<string, { id: string; center: [string, string] }> }
> {
  const s = await designSetup({
    services: { region2d, workers: createInProcessWorkers({ files: memoryFiles(FILES) }) },
  })
  await s.run('design.shape.import', { partId: s.partId, path: SAMPLE })
  const list = expectOk(s.d.query('design.shape.list', { partId: s.partId }, uiSource()))
    .value as Listed
  const byName = new Map(
    list.shapes.map((sh) => {
      const b = sh.bounds!
      const c = (k: 0 | 1) => String((b.min[k]! + b.max[k]!) / 2)
      return [sh.name, { id: sh.id, center: [c(0), c(1)] as [string, string] }]
    }),
  )
  return Object.assign(s, { byName })
}

const shapeDto = (s: DesignSetup, id: string): ShapeDTO =>
  s.part().shapes!.find((x) => x.id === id)!

/** The Line's geometry input (its first operation). */
function lineGeometry(s: DesignSetup): LineGeometry {
  const { part, stock } = expectOk(loadPart(s.d.doc, s.partId, 'test'))
  const input = expectOk(toGeometryInput(part, stock, region2d))
  return input.operations.find((o) => o.kind === 'line') as LineGeometry
}

describe('levels from an SVG (E2)', () => {
  it('keeps the colour and data-level levels on the imported path items', async () => {
    const s = await imported()
    const levels = (name: string) => {
      const item = shapeDto(s, s.byName.get(name)!.id).items[0]!
      return item.kind === 'path' ? item.levels : undefined
    }
    expect(levels('wave')).toBeUndefined() // black: level 1, the default
    expect(levels('seg2')).toBeCloseTo(1 - 128 / 255, 9)
    expect(levels('seg3')).toBeCloseTo(1 - 192 / 255, 9)
    expect(levels('ramp')).toEqual([0.1, 1])
    expect(levels('ring')).toBeCloseTo(1 - 64 / 255, 9)
  })

  it('maps levels to depth by { min, max }, chains the pieces and gives the spike depths', async () => {
    const s = await imported()
    const paths = ['wave', 'seg1', 'seg2', 'seg3', 'ramp', 'ring'].map((n) => ({
      shapeId: s.byName.get(n)!.id,
      center: s.byName.get(n)!.center,
    }))
    await s.run('design.line.add', { partId: s.partId, paths, depth: { min: '0.2', max: '1.5' } })
    const g = lineGeometry(s)
    expect(g.depth).toEqual({ min: 0.2, max: 1.5 })
    expect(g.levels).toHaveLength(6)
    const { lines } = lineChains(g)
    // wave, the chained seg1+seg2+seg3, ramp (open), then the ring (closed)
    expect(lines.map((l) => l.closed)).toEqual([false, false, false, true])
    const chain = lines.find((l) => Math.abs(l.length - (25 + 10 * Math.PI + 35)) < 0.01)!
    expect(chain).toBeDefined()
    const d = (x: number) => profileAt(chain.profile, x)
    // the spike's table: 1.500 / 0.847 / 0.521 mm (levels 1, 0.498, 0.247 between 0.2 and 1.5)
    expect(d(10)).toBeCloseTo(1.5, 3)
    expect(d(25 + 5 * Math.PI)).toBeCloseTo(0.2 + 1.3 * (1 - 128 / 255), 3)
    expect(d(chain.length - 10)).toBeCloseTo(0.2 + 1.3 * (1 - 192 / 255), 3)
    // the step at s = 25 is blended over ±1 mm (the default)
    expect(d(24)).toBeCloseTo(1.5, 6)
    expect(d(26)).toBeCloseTo(0.2 + 1.3 * (1 - 128 / 255), 6)
    expect(d(25)).toBeCloseTo((1.5 + 0.2 + 1.3 * (1 - 128 / 255)) / 2, 6)
    const ramp = lines.find((l) => Math.abs(l.length - 50) < 1e-6)!
    expect(profileAt(ramp.profile, 0)).toBeCloseTo(0.33, 3)
    expect(profileAt(ramp.profile, 50)).toBeCloseTo(1.5, 3)
    const ring = lines.find((l) => l.closed)!
    expect(profileAt(ring.profile, 1)).toBeCloseTo(0.2 + 1.3 * (1 - 64 / 255), 3)
    expect(lineMaxDepth(g)).toBeCloseTo(1.5, 9)
  })

  it('blend 0 keeps the step; a constant depth ignores levels', async () => {
    const s = await imported()
    const paths = ['seg1', 'seg2'].map((n) => ({
      shapeId: s.byName.get(n)!.id,
      center: s.byName.get(n)!.center,
    }))
    await s.run('design.line.add', {
      partId: s.partId,
      paths,
      depth: { min: '0.2', max: '1.5' },
      blend: '0',
    })
    const stepped = lineChains(lineGeometry(s)).lines[0]!
    expect(profileAt(stepped.profile, 24.999)).toBeCloseTo(1.5, 6)
    expect(profileAt(stepped.profile, 25.001)).toBeCloseTo(0.2 + 1.3 * (1 - 128 / 255), 6)
    await s.run('design.line.update', { partId: s.partId, operationId: 'line1', depth: '0.7' })
    const g = lineGeometry(s)
    expect(g.levels).toBeUndefined()
    expect(lineChains(g).lines.every((l) => l.profile.d.every((x) => x === 0.7))).toBe(true)
  })

  it('scales a path about its anchor point', async () => {
    const s = await imported()
    const { id } = s.byName.get('seg1')!
    await s.run('design.line.add', {
      partId: s.partId,
      paths: [{ shapeId: id, center: ['50', '30'], scale: 2 }],
      depth: { min: '0.2', max: '1.5' },
    })
    const l = lineChains(lineGeometry(s)).lines[0]!
    expect(l.length).toBeCloseTo(50, 9)
    const xs = l.elements.flatMap((e) => [e.a[0], e.b[0]])
    expect(Math.min(...xs)).toBeCloseTo(25, 9)
    expect(Math.max(...xs)).toBeCloseTo(75, 9)
  })

  it('refuses min deeper than max and a negative blend', async () => {
    const s = await imported()
    const shapeId = s.byName.get('seg1')!.id
    const e = await s.fail(
      'design.line.add',
      {
        partId: s.partId,
        paths: [{ shapeId, center: ['50', '30'] }],
        depth: { min: '1', max: '0.5' },
        blend: '-1',
      },
      'model.invariant',
    )
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual(
      expect.arrayContaining([
        ['depth.min', 'minAboveMax'],
        ['blend', 'nonNegative'],
      ]),
    )
  })

  it('an item edit keeps per-vertex levels with the vertex count, drops them otherwise', async () => {
    const s = await imported()
    const { id } = s.byName.get('ramp')!
    await s.run('design.shape.item.update', {
      partId: s.partId,
      shapeId: id,
      index: 0,
      start: ['0', '1'],
    })
    const kept = shapeDto(s, id).items[0]!
    expect(kept.kind === 'path' && kept.levels).toEqual([0.1, 1])
    await s.run('design.shape.item.update', {
      partId: s.partId,
      shapeId: id,
      index: 0,
      segments: [
        { kind: 'line', to: ['25', '1'] },
        { kind: 'line', to: ['50', '1'] },
      ],
    })
    const dropped = shapeDto(s, id).items[0]!
    expect(dropped.kind === 'path' && dropped.levels).toBeUndefined()
  })
})
