// Regression (v0.3 known issue): solid tabs on the imported enclosure outline. The outline's
// fitted arcs meet at turns of ≈ 1e-7 rad; per-element tab band pieces there failed the 2D port
// (`degenerate`, or an empty clip). Built through the design commands as the repro was.
// Docs: docs/architecture/shapes.md#geometry-for-shape-operations (tabs)
import { beforeAll, describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers, memoryFiles } from '../commands/jobs'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { evaluatePart } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import type { SolidKernel } from '../geometry/solid-port'
import { nodeManifoldSource } from '../geometry/testing/node-wasm'
import { designSetup, testStock, type DesignSetup } from './design.fixture'
import { ENCLOSURE_SECTIONS_SVG } from './enclosure-sections.testing'
import { partGeometryInput } from './load'

interface NodeProcess {
  getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL): Uint8Array }
}
const fs = (globalThis as unknown as { process: NodeProcess }).process.getBuiltinModule('node:fs')

const region2d = nodeRegion2d()
const SVG = '/drawings/enclosure-sections.svg'

let s: DesignSetup
let kernel: SolidKernel

beforeAll(async () => {
  kernel = expectOk(await loadManifold(nodeManifoldSource()))
  s = await designSetup({
    stock: { ...testStock(), length: '300', width: '220', thickness: '20' },
    services: {
      region2d,
      workers: createInProcessWorkers({
        files: memoryFiles(
          new Map([[SVG, new Uint8Array(fs.readFileSync(ENCLOSURE_SECTIONS_SVG))]]),
        ),
      }),
    },
  })
  await s.run('design.shape.import', {
    partId: s.partId,
    path: SVG,
    unit: 'px96',
    split: 'element',
  })
  // the outline, outside, slot 6, tabs 6 × 2 (defaults)
  await s.run('design.profile.add', {
    partId: s.partId,
    shape: { kind: 'named', shapeId: 'shape1', center: ['150', '110'] },
  })
})

describe('tabs on the imported enclosure outline', () => {
  const cases: [string, object, number][] = [
    ...[2, 3, 4, 5, 6].map((n): [string, object, number] => [`${n} tabs`, { count: String(n) }, n]),
    ['a tab at 346.91', { positions: ['346.91'] }, 1],
    ['tabs at 10, 346.91, 600', { positions: ['10', '346.91', '600'] }, 3],
  ]
  it.each(cases)('%s: the part evaluates with every tab', async (_, tabs, n) => {
    await s.run('design.profile.update', { partId: s.partId, operationId: 'profile1', tabs })
    const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const e = expectOk(
      kernel.withSolids((solids) => evaluatePart(input, solids, undefined, region2d)),
    )
    for (let i = 0; i < n; i++) {
      expect(e.surfaces).toContain(`profile1.tab[${i}].top`)
      expect(e.surfaces).toContain(`profile1.tab[${i}].end[0]`)
      expect(e.surfaces).toContain(`profile1.tab[${i}].end[1]`)
    }
    expect(e.warnings).toEqual([])
    expect(kernel.liveObjects()).toBe(0)
  })
})
