// Clones view helpers (v0.4 task U3): the draft's first row (footprint + the source tool's
// diameter, at least 3 mm / 1/8"), Source options, new rows, the read-out with the 100-instance
// limit (D36), skip toggling and instance ids, on parts built through the real commands.
// Doc: docs/conventions/ui.md#clones
import { describe, expect, it } from 'vitest'
import type { Dispatcher } from '../../../../core/commands/dispatcher'
import { designDispatcher } from '../../test/bridge'
import {
  draftSource,
  draftSourceOptions,
  featurePathData,
  firstRow,
  firstRowGap,
  instanceOfOperation,
  newRow,
  parseInstanceId,
  readoutOf,
  rowArgsOf,
  skippedNumbers,
  toggleSkip,
} from './clones-view'
import { clonesSource } from './feature-view'
import { designPart } from './model'

const ui = { kind: 'ui', id: 'test' } as const

async function part(build: (d: Dispatcher, partId: string) => Promise<void>) {
  const d = await designDispatcher()
  const stock = await d.dispatch(
    'library.stock.add',
    {
      values: {
        name: 'Block',
        shape: 'block',
        length: '100',
        width: '60',
        thickness: '20',
        material: { name: '6061-T6', class: 'aluminum' },
      },
    },
    ui,
  )
  await d.dispatch(
    'design.part.add',
    { name: 'Bracket', stockLibraryItemId: (stock.unwrap().value as { id: string }).id },
    ui,
  )
  const partId = Object.keys(d.doc.parts)[0]!
  await build(d, partId)
  return designPart(d.doc)!
}

const ok = async (d: Dispatcher, name: string, args: object) => {
  ;(await d.dispatch(name, args, ui)).unwrap()
}

const pocket = (partId: string, center: string[], extra: object = {}) => ({
  partId,
  shape: { kind: 'circle', center, diameter: '10' },
  depth: '5',
  ...extra,
})

const clone = { at: [0, 0] as const, kind: 'clone' as const }

describe('clones view', () => {
  it("the first row's gap is the source tool's diameter, never under 3 mm", async () => {
    const p = await part(async (d, partId) => {
      await ok(d, 'design.pocket.add', pocket(partId, ['20', '30']))
      await ok(
        d,
        'design.pocket.add',
        pocket(partId, ['60', '30'], {
          tool: { kind: 'generalized', type: 'flatEndMill', diameter: '6' },
        }),
      )
      await ok(
        d,
        'design.pocket.add',
        pocket(partId, ['80', '30'], {
          tool: { kind: 'generalized', type: 'flatEndMill', diameter: '2' },
        }),
      )
    })
    expect(firstRowGap(p, { operationIds: ['pocket1'] })).toBe(3)
    expect(firstRowGap(p, { operationIds: ['pocket2'] })).toBe(6)
    expect(firstRowGap(p, { operationIds: ['pocket3'] })).toBe(3)
    expect(firstRowGap({ ...p, units: 'inch' }, { operationIds: ['pocket3'] })).toBe(3.175)
    expect(firstRow(10, 6, 'mm')).toEqual({ kind: 'offset', count: 1, du: '16 mm', dv: '0 mm' })
  })

  it('offers what sits on the source, transitively; unchecking a host drops what is on it', async () => {
    const p = await part(async (d, partId) => {
      await ok(d, 'design.pocket.add', pocket(partId, ['20', '30']))
      await ok(d, 'design.pocket.add', {
        partId,
        shape: { kind: 'circle', center: ['20', '30'], diameter: '6' },
        depth: '2',
        on: 'pocket1.floor',
      })
      await ok(d, 'design.drilling.add', {
        partId,
        center: ['20', '30'],
        diameter: '2',
        on: 'pocket2.floor',
      })
      await ok(d, 'design.drilling.add', { partId, center: ['70', '30'], diameter: '2' })
    })
    const choice = clonesSource(p, 'pocket1')
    if (!choice.ok) throw new Error(choice.reason)
    const options = draftSourceOptions(p, choice)
    expect(options.map((o) => [o.id, o.fixed, o.host])).toEqual([
      ['pocket1', true, undefined],
      ['pocket2', false, 'pocket1'],
      ['drill1', false, 'pocket2'],
    ])
    expect(draftSource(options, new Set(), false)).toEqual({
      operationIds: ['pocket1', 'pocket2', 'drill1'],
    })
    expect(draftSource(options, new Set(['pocket2']), false)).toEqual({
      operationIds: ['pocket1'],
    })
  })

  it('new rows start a step from the reference point; along needs a path shape', () => {
    expect(newRow('grid', 10, 'mm', { u: 0, v: 0 }, [])).toEqual({
      kind: 'grid',
      cols: 2,
      rows: 2,
      du: '10 mm',
      dv: '10 mm',
    })
    expect(newRow('point', 10, 'mm', { u: 5, v: 7 }, [])).toEqual({
      kind: 'point',
      u: '15 mm',
      v: '7 mm',
    })
    expect(newRow('along', 10, 'mm', { u: 0, v: 0 }, [])).toBeUndefined()
  })

  it('the read-out, skip toggling, instance ids and the 100-instance limit', async () => {
    const p = await part(async (d, partId) => {
      await ok(d, 'design.pocket.add', pocket(partId, ['10', '10']))
      await ok(d, 'design.clones.add', {
        partId,
        source: { operationIds: ['pocket1'] },
        rows: [{ kind: 'grid', cols: 2, rows: 2, du: '15', dv: '15', skip: [1] }],
      })
    })
    const feature = p.dto.features![0]!
    const data = featurePathData(p, feature.id)!
    expect(readoutOf(data)).toEqual({ instances: 3, clones: 2, skipped: 1 })
    expect(skippedNumbers(data, 0)).toEqual([3])
    const rows = rowArgsOf(feature)
    expect(toggleSkip(rows, data, 3)[0]).not.toHaveProperty('skip')
    expect(toggleSkip(rows, data, 2)[0]!.skip).toEqual([0, 1])
    expect(parseInstanceId(p, `${feature.id}_3`)).toEqual({ feature, n: 3 })
    expect(parseInstanceId(p, 'pocket1')).toBeUndefined()
    const op = p.dto.operations.find((o) => o.featureId === feature.id)!
    expect(instanceOfOperation(p, op.id)?.n).toBe(2)
    // over the limit: the row that crossed it and how many to remove
    const big = {
      instances: Array.from({ length: 104 }, (_, i) => ({ n: i + 1, at: [i, 0] as const })),
      rows: [
        { path: [], points: Array.from({ length: 50 }, () => clone) },
        { path: [], points: Array.from({ length: 53 }, () => clone) },
      ],
    }
    expect(readoutOf(big).over).toEqual({ actual: 104, excess: 4, row: 1 })
  })
})
