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
      // the two corners 5 mm beyond the stock's right side leave material only in air (DF53)
      ...Array<string>(2).fill('dfm.cornerSharp'),
      // sharp corners: no tool fits at all (DF52)
      'dfm.noFittingTool',
    ])
    expect(r.warnings[0]).toMatchObject({ severity: 'info', params: { by: 5 } })
  })
})

describe('ring pockets round the stock edge (DF53)', () => {
  /** A sharp rectangle of `outer` minus a rounded r4 rectangle of `inner`, both centred. */
  const ring = (outer: [string, string], inner: [string, string]) => [
    {
      kind: 'rectangle',
      op: 'add',
      center: ['0', '0'],
      length: outer[0],
      width: outer[1],
      cornerRadius: '0',
    },
    {
      kind: 'rectangle',
      op: 'subtract',
      center: ['0', '0'],
      length: inner[0],
      width: inner[1],
      cornerRadius: '4',
    },
  ]
  const ringPocket = async (outer: [string, string], inner: [string, string]) => {
    const s = await setup()
    await s.run('design.shape.add', { partId: s.partId, items: ring(outer, inner) })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape2', center: ['50', '30'] },
      depth: '2',
    })
    await s.run('project.apply', {})
    return s
  }

  it('corners beyond the stock are open: no corner warning, the margin is no wall', async () => {
    // outer corners 5 mm beyond the stock, a 4 mm stock margin (9 mm of region) to the inner loop
    const s = await ringPocket(['110', '70'], ['92', '52'])
    const codes = s.warnings().map((w) => w.code)
    expect(codes).not.toContain('dfm.cornerSharp')
    expect(codes).not.toContain('dfm.noFittingTool')
    expect(codes).not.toContain('dfm.restMaterial')
    expect(s.warnings().find((w) => w.code === 'dfm.shapeOutsideFace')).toMatchObject({
      severity: 'info',
    })
    // the 6 mm tool fits the 9 mm of region and leaves nothing: ranked first and chosen
    const c = expectOk(
      s.d.query('design.tool.candidates', { partId: s.partId, operationId: 'pocket1' }, ui),
    ).value as { fitting: { toolLibraryItemId: string; reasons: string[] }[] }
    expect(c.fitting.map((f) => f.toolLibraryItemId)).toEqual([s.tools['6'], s.tools['3']])
    expect(c.fitting[0]!.reasons).not.toContain('leaves rest material')
    const snapshot = (s.op('pocket1').tool as { snapshotId: string }).snapshotId
    expect(JSON.stringify(s.d.doc.snapshots[snapshot])).toContain('6 mm flat')
  })

  it('a corner whose leftover reaches into the stock stays a wall corner', async () => {
    // corners 1 mm beyond each side: √2 mm away, under the smallest tool's radius 1.5
    const s = await ringPocket(['102', '62'], ['80', '40'])
    expect(s.warnings().filter((w) => w.code === 'dfm.cornerSharp')).toHaveLength(4)
  })

  it('a shape wholly outside the face warns that it cuts nothing', async () => {
    const s = await setup()
    const r = (await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['150', '30'] },
      depth: '2',
    })) as { warnings: DfmWarning[] }
    expect(r.warnings.find((w) => w.code === 'dfm.shapeOutsideFace')).toMatchObject({
      severity: 'warning',
      params: { wholly: true },
    })
  })
})
