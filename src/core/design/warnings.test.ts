import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createDispatcher } from '../commands/dispatcher'
import { inProcessWorkers } from '../commands/jobs'
import { createAppRegistry } from '../commands/registry'
import { fakeClock, fakeIds, uiSource } from '../commands/testing'
import type { DfmWarning } from '../geometry/model'
import { Library } from '../library/library'
import { parseValues } from '../library/library-item'
import { deg, flatEndMillValues, len, stockValues } from '../library/library.fixture'
import { createMemoryLibraryStorage } from '../library/memory-storage'
import type { ToolType } from '../library/tool.dto'
import { designSetup, type DesignSetup } from './design.fixture'
import { DfmWarningSchema, libraryTools } from './warnings'

const ui = uiSource()

/** Tool values for `library.tool.add` (no presets). */
function toolValues(type: ToolType, diameter: string, extra: object = {}) {
  const { kind: _kind, presets: _presets, ...base } = flatEndMillValues()
  return {
    ...base,
    name: `${type} ${diameter}`,
    type,
    diameter: len(diameter),
    ...(type === 'drill' && { pointAngle: deg('118') }),
    ...extra,
  }
}

const addTool = (s: DesignSetup, type: ToolType, diameter: string, extra: object = {}) =>
  s.run('library.tool.add', { values: toolValues(type, diameter, extra) })

const warningList = (s: DesignSetup, partId = s.partId) =>
  expectOk(s.d.query('design.warning.list', { partId }, ui)).value as { warnings: DfmWarning[] }

const codes = (ws: readonly DfmWarning[]) => ws.map((w) => `${w.operation} ${w.code}`)

const sharpPocket = {
  shape: { kind: 'rectangle', center: ['50', '30'], length: '40', width: '20', cornerRadius: '0' },
  depth: '5',
}

describe('libraryTools: library items → DfmTool (mm)', () => {
  it('converts every readable tool to mm, keeps the bull-nose radius, skips other kinds', async () => {
    const lib = expectOk(
      await Library.open(
        createMemoryLibraryStorage([
          { kind: 'tool', id: 'broken', content: { id: 'broken', revision: 1, kind: 'tool' } },
        ]),
      ),
    )
    const add = async (values: object, id: string) =>
      expectOk(
        await lib.add(expectOk(parseValues(values, 'test')), {
          id,
          updatedAt: '2026-11-17T10:00:00.000Z',
        }),
      )
    const tool = (...a: Parameters<typeof toolValues>) => ({ kind: 'tool', ...toolValues(...a) })
    await add(tool('flatEndMill', '1/4 in'), 'flat')
    await add(tool('bullNoseEndMill', '10', { cornerRadius: len('1') }), 'bull')
    await add(tool('ballEndMill', '6'), 'ball')
    await add(tool('drill', '5'), 'drill')
    await add(stockValues(), 'stock')
    expect(lib.list('tool').errors.map((e) => e.id)).toEqual(['broken'])
    expect(libraryTools(lib)).toEqual([
      { type: 'flatEndMill', diameter: 6.35 },
      { type: 'bullNoseEndMill', diameter: 10, cornerRadius: 1 },
      { type: 'ballEndMill', diameter: 6 },
      { type: 'drill', diameter: 5 },
    ])
  })
})

describe('design.warning.list', () => {
  it('returns the parameter warnings of the document; with an empty library only geometric ones', async () => {
    const s = await designSetup()
    expect(warningList(s)).toEqual({ warnings: [] })
    await s.run('design.facing.add', { partId: s.partId, depth: '4' })
    await s.run('design.pocket.add', { partId: s.partId, ...sharpPocket })
    const { warnings } = warningList(s)
    expect(codes(warnings)).toEqual(['facing1 dfm.facingDeep', 'pocket1 dfm.cornerSharp'])
    expect(warnings[1]).toEqual({
      code: 'dfm.cornerSharp',
      severity: 'warning',
      message: 'pocket1: a sharp inside corner cannot be cut by a round tool',
      operation: 'pocket1',
      parameter: 'shape.cornerRadius',
      params: { cornerRadius: 0 },
    })
    for (const w of warnings) expect(DfmWarningSchema.parse(w)).toEqual(w)
  })

  it('is computed fresh: a library edit changes the warnings without a document change', async () => {
    const s = await designSetup()
    await s.run('design.drilling.add', { partId: s.partId, center: ['20', '20'], diameter: '6' })
    expect(warningList(s).warnings).toEqual([])
    const revision = s.d.revision
    await addTool(s, 'flatEndMill', '8')
    // no drill of Ø6 and no end mill smaller than it
    expect(codes(warningList(s).warnings)).toEqual(['drill1 dfm.holeNoTool'])
    await addTool(s, 'drill', '6')
    expect(warningList(s).warnings).toEqual([])
    expect(s.d.revision).toBe(revision)
  })

  it('uses the project unit system for the unit-dependent thresholds', async () => {
    // 0.12" = 3.048 mm: over the metric 3 mm, under the inch 1/8" limit
    const metric = await designSetup()
    await metric.run('design.facing.add', { partId: metric.partId, depth: '3.048' })
    expect(codes(warningList(metric).warnings)).toEqual(['facing1 dfm.facingDeep'])
    const inch = await designSetup({ units: 'inch' })
    await inch.run('design.facing.add', { partId: inch.partId, depth: '0.12' })
    expect(warningList(inch).warnings).toEqual([])
  })

  it('fails for an unknown part (input.malformed) and without a library service', async () => {
    const s = await designSetup()
    const unknown = expectErrCode(
      s.d.query('design.warning.list', { partId: 'part-x' }, ui),
      'input.malformed',
    )
    expect(unknown.issues[0]?.rule).toBe('unknownPart')
    const noLibrary = createDispatcher({
      registry: expectOk(createAppRegistry()),
      doc: s.d.doc,
      ids: fakeIds(),
      clock: fakeClock(0),
      services: { workers: inProcessWorkers },
    })
    expectErrCode(
      noLibrary.query('design.warning.list', { partId: s.partId }, ui),
      'internal.unexpected',
    )
  })
})

describe('design command results carry the warnings of the edited part', () => {
  it('add and update return them; a warning never fails the command', async () => {
    const s = await designSetup()
    await addTool(s, 'flatEndMill', '8')
    const added = (await s.run('design.pocket.add', { partId: s.partId, ...sharpPocket })) as {
      operationId: string
      warnings: DfmWarning[]
    }
    expect(added.operationId).toBe('pocket1')
    expect(added.warnings).toEqual(warningList(s).warnings)
    expect(codes(added.warnings)).toEqual(['pocket1 dfm.cornerSharp'])
    expect(added.warnings[0]?.suggestion).toEqual({ relation: 'atLeast', value: 4 })

    const updated = (await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      shape: { ...sharpPocket.shape, cornerRadius: '3' },
    })) as { warnings: DfmWarning[] }
    expect(codes(updated.warnings)).toEqual(['pocket1 dfm.cornerTooSmall'])
  })

  it('part.update, operation.move and operation.remove return them too', async () => {
    const s = await designSetup()
    const partId = s.partId
    await s.run('design.facing.add', { partId, depth: '4' })
    await s.run('design.pocket.add', { partId, on: 'stock.top', ...sharpPocket })
    const both = ['facing1 dfm.facingDeep', 'pocket1 dfm.cornerSharp']
    const part = (await s.run('design.part.update', { partId, name: 'B2' })) as {
      warnings: DfmWarning[]
    }
    expect(codes(part.warnings)).toEqual(both)
    const moved = (await s.run('design.operation.move', {
      partId,
      operationId: 'pocket1',
      toIndex: 0,
    })) as { warnings: DfmWarning[] }
    expect(codes(moved.warnings)).toEqual([...both].reverse())
    const removed = (await s.run('design.operation.remove', {
      partId,
      operationId: 'pocket1',
    })) as { warnings: DfmWarning[] }
    expect(codes(removed.warnings)).toEqual(['facing1 dfm.facingDeep'])
  })

  it('without a library service the commands still succeed, with the geometric checks only', async () => {
    const s = await designSetup()
    const d = createDispatcher({
      registry: expectOk(createAppRegistry()),
      doc: s.d.doc,
      ids: fakeIds(),
      clock: fakeClock(0),
      services: { workers: inProcessWorkers },
    })
    const r = expectOk(
      await d.dispatch('design.pocket.add', { partId: s.partId, ...sharpPocket }, ui),
    ).value as { warnings: DfmWarning[] }
    expect(codes(r.warnings)).toEqual(['pocket1 dfm.cornerSharp'])
    expect(r.warnings[0]?.suggestion).toBeUndefined()
  })
})
