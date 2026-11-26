// library.workholding.* commands and queries (workholding-library.md#agent-api, slice WL1).
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createDispatcher } from '../commands/dispatcher'
import { inProcessWorkers } from '../commands/jobs'
import { createAppRegistry } from '../commands/registry'
import { agentSource, fakeClock, fakeIds } from '../commands/testing'
import { newProjectDoc } from '../project/document'
import { Library } from './library'
import { libraryInput, toeClampValues } from './library.fixture'
import { createMemoryLibraryStorage } from './memory-storage'

const agent = agentSource()

async function setup() {
  const storage = createMemoryLibraryStorage()
  const library = expectOk(await Library.open(storage))
  const d = createDispatcher({
    registry: expectOk(createAppRegistry()),
    doc: newProjectDoc({ name: 'Fixture', unitSystem: 'mm' }),
    ids: fakeIds(),
    clock: fakeClock(Date.UTC(2026, 10, 26, 10)),
    services: { workers: inProcessWorkers, library },
  })
  return { d, storage }
}

type D = Awaited<ReturnType<typeof setup>>['d']
type Item = { id: string; revision: number; builtIn?: true; isDefault?: true; type: string }
const add = async (d: D, values: object, units?: string) =>
  expectOk(
    await d.dispatch(
      'library.workholding.add',
      { values, ...(units === undefined ? {} : { units }) },
      agent,
    ),
  ).value as Item
const list = (d: D, args: object = {}) =>
  expectOk(d.query('library.workholding.list', args, agent)).value as {
    items: Item[]
    errors: unknown[]
  }

describe('library.workholding commands', () => {
  it('add stores a device with quantity strings; get returns it', async () => {
    const { d, storage } = await setup()
    const added = await add(d, libraryInput(toeClampValues()))
    expect(added).toMatchObject({ id: 'workholding-1', revision: 1, ...toeClampValues() })
    const stored = expectOk(await storage.get('workholding', 'workholding-1')).unwrap()
    expect(expectOk(stored.content)).toEqual(added)
    expect(expectOk(d.query('library.workholding.get', { id: added.id }, agent)).value).toEqual(
      added,
    )
  })

  it('fills the type defaults: a vise is not soft, a spoilboard is sacrificial', async () => {
    const { d } = await setup()
    const vise = await add(
      d,
      { name: 'Kurt', type: 'vise', jawWidth: '6', jawThickness: '0.75' },
      'inch',
    )
    expect(vise).toMatchObject({ soft: false, jawWidth: { source: '6', defaultUnit: 'in' } })
    const board = await add(d, { name: 'MDF', type: 'base', baseType: 'spoilboard' })
    expect(board).toMatchObject({ sacrificial: true })
  })

  it('reports model issues under values (notForKind, required)', async () => {
    const { d } = await setup()
    const e = expectErrCode(
      await d.dispatch(
        'library.workholding.add',
        { values: { name: 'Vise', type: 'vise', jawWidth: '150', width: '30' } },
        agent,
      ),
      'model.invariant',
    )
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['values.width', 'notForKind'],
      ['values.jawThickness', 'required'],
    ])
  })

  it('list: the user items, then the built-ins, with builtIn and isDefault; a type filter', async () => {
    const { d } = await setup()
    const mine = await add(d, libraryInput(toeClampValues()))
    const all = list(d)
    expect(all.items.map((i) => [i.id, i.builtIn, i.isDefault])).toEqual([
      ['workholding-1', undefined, undefined],
      ['builtin-toe-clamp', true, true],
      ['builtin-vise', true, true],
      ['builtin-screw', true, true],
      ['builtin-spoilboard', true, true],
      ['builtin-fixture-plate', true, undefined],
      ['builtin-tape', true, true],
      ['builtin-vacuum', true, undefined],
      ['builtin-glue', true, undefined],
    ])
    expect(all.errors).toEqual([])
    // marking the user clamp default takes it from the built-in
    expectOk(
      await d.dispatch(
        'library.workholding.update',
        {
          id: mine.id,
          revision: 1,
          values: { ...libraryInput(toeClampValues()), default: true },
        },
        agent,
      ),
    )
    const clamps = list(d, { type: 'toeClamp' })
    expect(clamps.items.map((i) => [i.id, i.isDefault])).toEqual([
      ['workholding-1', true],
      ['builtin-toe-clamp', undefined],
    ])
  })

  it('the units arg picks the built-ins’ value set', async () => {
    const { d } = await setup()
    const inch = expectOk(
      d.query('library.workholding.get', { id: 'builtin-toe-clamp', units: 'inch' }, agent),
    ).value as { width: { source: string }; builtIn: true }
    expect(inch.width.source).toBe('1 1/4"')
    expect(inch.builtIn).toBe(true)
    const mm = list(d, { type: 'vise' }).items[0] as Item & { jawWidth: { source: string } }
    expect(mm.jawWidth.source).toBe('150 mm')
  })

  it('built-ins are read-only: update and remove refuse them (rule builtIn)', async () => {
    const { d } = await setup()
    const values = libraryInput(toeClampValues())
    for (const [name, args] of [
      ['library.workholding.update', { id: 'builtin-toe-clamp', revision: 1, values }],
      ['library.workholding.remove', { id: 'builtin-toe-clamp', revision: 1, confirm: true }],
    ] as const) {
      const e = expectErrCode(await d.dispatch(name, args, agent), 'input.malformed')
      expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([['id', 'builtIn']])
    }
  })

  it('remove deletes a user item; get of an unknown id is unknownItem', async () => {
    const { d } = await setup()
    const mine = await add(d, libraryInput(toeClampValues()))
    expectOk(
      await d.dispatch(
        'library.workholding.remove',
        { id: mine.id, revision: 1, confirm: true },
        agent,
      ),
    )
    expect(list(d, { type: 'toeClamp' }).items.map((i) => i.id)).toEqual(['builtin-toe-clamp'])
    const e = expectErrCode(
      d.query('library.workholding.get', { id: mine.id }, agent),
      'input.malformed',
    )
    expect(e.issues[0]!.rule).toBe('unknownItem')
  })
})
