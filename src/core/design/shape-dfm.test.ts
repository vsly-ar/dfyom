// DFM and the auto tool choice for shapes through the dispatcher with the real 2D port (v0.3 K4):
// warnings of a named shape in command results, fitting tools that leave no rest material ranked
// first (library and generalized), `dfm.restMaterial` with a locked tool.
// Doc: docs/modes/design-v0.3.md#dfm-checks-for-shapes
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { createDispatcher } from '../commands/dispatcher'
import { inProcessWorkers } from '../commands/jobs'
import {
  APP_HOOKS,
  createRegistry,
  designApplyWarnings,
  PROJECT_COMMANDS,
  PROJECT_QUERIES,
} from '../commands/registry'
import { fakeClock, fakeIds, uiSource } from '../commands/testing'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import type { DfmWarning } from '../geometry/model'
import { LIBRARY_COMMANDS, LIBRARY_QUERIES } from '../library/commands'
import { Library } from '../library/library'
import { createMemoryLibraryStorage } from '../library/memory-storage'
import { newProjectDoc } from '../project/document'
import { testStock } from './design.fixture'
import type { OperationDTO } from './part.dto'
import { designToolAutoChoice } from './tool-commands'

const ui = uiSource()
const region2d = nodeRegion2d()

/** Two Ø30 discs 50 mm apart joined by a 4 mm neck: a 6 mm tool leaves the neck uncut. */
const DUMBBELL = [
  { kind: 'circle', op: 'add', center: ['0', '0'], diameter: '30' },
  { kind: 'circle', op: 'add', center: ['50', '0'], diameter: '30' },
  {
    kind: 'rectangle',
    op: 'add',
    center: ['25', '0'],
    length: '50',
    width: '4',
    cornerRadius: '0',
  },
]

async function setup(withLibrary = true) {
  const library = expectOk(await Library.open(createMemoryLibraryStorage()))
  const registry = expectOk(
    createRegistry({
      commands: [...PROJECT_COMMANDS, ...LIBRARY_COMMANDS],
      queries: [...PROJECT_QUERIES, ...LIBRARY_QUERIES],
      hooks: APP_HOOKS,
      applyHooks: [designToolAutoChoice],
      applyWarnings: designApplyWarnings,
    }),
  )
  const d = createDispatcher({
    registry,
    doc: newProjectDoc({ name: 'Bracket', unitSystem: 'mm' }),
    ids: fakeIds(),
    clock: fakeClock(Date.UTC(2026, 10, 22)),
    services: { workers: inProcessWorkers, library, region2d },
  })
  const run = async (name: string, args: object) =>
    expectOk(await d.dispatch(name, args, ui)).value as Record<string, unknown>
  const stock = await run('library.stock.add', { values: testStock() })
  const { partId } = (await run('design.part.add', {
    name: 'Bracket',
    stockLibraryItemId: stock['id'],
  })) as { partId: string }
  const tools: Record<string, string> = {}
  if (withLibrary)
    for (const diameter of ['6', '3'])
      tools[diameter] = (
        await run('library.tool.add', {
          values: {
            name: `${diameter} mm flat`,
            type: 'flatEndMill',
            diameter,
            fluteLength: '25',
            overallLength: '60',
            fluteCount: '2',
          },
        })
      )['id'] as string
  await run('design.shape.add', { partId, items: DUMBBELL })
  const op = (id: string): OperationDTO => d.doc.parts[partId]!.operations.find((o) => o.id === id)!
  const warnings = () =>
    (expectOk(d.query('design.warning.list', { partId }, ui)).value as { warnings: DfmWarning[] })
      .warnings
  return { d, run, partId, tools, op, warnings }
}

const named = { kind: 'named', shapeId: 'shape1', center: ['50', '30'] }

describe('the auto tool choice for shapes', () => {
  it('ranks fitting library tools that leave no rest material first', async () => {
    const s = await setup()
    await s.run('design.pocket.add', { partId: s.partId, shape: named, depth: '5' })
    await s.run('project.apply', {})
    // the 6 mm tool fits (width, corners) but leaves the neck: the 3 mm one is chosen
    expect(s.op('pocket1').tool).toMatchObject({ kind: 'specific' })
    const c = expectOk(
      s.d.query('design.tool.candidates', { partId: s.partId, operationId: 'pocket1' }, ui),
    ).value as { fitting: { toolLibraryItemId: string; reasons: string[] }[] }
    expect(c.fitting.map((f) => f.toolLibraryItemId)).toEqual([s.tools['3'], s.tools['6']])
    expect(c.fitting[1]!.reasons).toContain('leaves rest material')
    expect(s.warnings().map((w) => w.code)).not.toContain('dfm.restMaterial')
  })

  it('picks the largest generalized size that leaves no rest material', async () => {
    const s = await setup(false)
    await s.run('design.pocket.add', { partId: s.partId, shape: named, depth: '5' })
    await s.run('project.apply', {})
    // 4 mm neck: 4 mm passes it (within the size tolerance), 5 mm and up leave it
    expect(s.op('pocket1').tool).toMatchObject({
      kind: 'generalized',
      diameter: { source: '4 mm' },
    })
  })

  it('warns about rest material with a locked tool that leaves it', async () => {
    const s = await setup()
    await s.run('design.pocket.add', { partId: s.partId, shape: named, depth: '5' })
    const r = (await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'pocket1',
      tool: { kind: 'specific', toolLibraryItemId: s.tools['6'] },
    })) as { warnings: DfmWarning[] }
    const w = r.warnings.find((x) => x.code === 'dfm.restMaterial')
    expect(w).toMatchObject({ operation: 'pocket1', parameter: 'tool' })
    const [u, v] = w!.params['at'] as number[]
    expect(Math.abs(u! - 50)).toBeLessThan(10)
    expect(Math.abs(v! - 30)).toBeLessThan(3)
  })

  it('reports the shape rules in command results (corners, outside the face)', async () => {
    const s = await setup()
    await s.run('design.shape.add', {
      partId: s.partId,
      items: [
        {
          kind: 'rectangle',
          op: 'add',
          center: ['0', '0'],
          length: '40',
          width: '20',
          cornerRadius: '0',
        },
      ],
    })
    const r = (await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape2', center: ['85', '30'] },
      depth: '5',
    })) as { warnings: DfmWarning[] }
    expect(r.warnings.map((w) => w.code)).toEqual([
      'dfm.shapeOutsideFace',
      ...Array<string>(4).fill('dfm.cornerSharp'),
      // sharp corners: no tool fits at all (DF52)
      'dfm.noFittingTool',
    ])
  })
})
