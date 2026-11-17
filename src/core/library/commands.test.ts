import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import type { ActionEvent } from '../commands/action-log'
import { createDispatcher } from '../commands/dispatcher'
import { inProcessWorkers } from '../commands/jobs'
import { createAppRegistry } from '../commands/registry'
import { agentSource, fakeClock, fakeIds, uiSource } from '../commands/testing'
import { newProjectDoc } from '../project/document'
import { LIBRARY_COMMANDS, LIBRARY_QUERIES } from './commands'
import { Library } from './library'
import { flatEndMillValues, len, machineValues, stockValues } from './library.fixture'
import { createMemoryLibraryStorage } from './memory-storage'

const agent = agentSource()
const doc = newProjectDoc({ name: 'Bracket', unitSystem: 'mm' })
const omitKind = <T extends { kind: string }>({ kind: _, ...rest }: T) => rest

async function setup(withLibrary = true) {
  const storage = createMemoryLibraryStorage()
  const library = expectOk(await Library.open(storage))
  const d = createDispatcher({
    registry: expectOk(createAppRegistry()),
    doc,
    ids: fakeIds(),
    clock: fakeClock(Date.UTC(2026, 10, 17, 10)),
    services: withLibrary ? { workers: inProcessWorkers, library } : { workers: inProcessWorkers },
  })
  const events: ActionEvent[] = []
  d.log.subscribe({}, (e) => events.push(e))
  return { d, storage, library, events }
}

type D = Awaited<ReturnType<typeof setup>>['d']
const add = async (d: D, kind: string, values: object) =>
  expectOk(await d.dispatch(`library.${kind}.add`, { values }, agent)).value as {
    id: string
    revision: number
  }

describe('library commands', () => {
  it('are registered in the app registry: add/update/remove and get/list per kind', () => {
    const reg = expectOk(createAppRegistry())
    for (const kind of ['stock', 'tool', 'machine'])
      for (const verb of ['add', 'update', 'remove'])
        expect(reg.command(`library.${kind}.${verb}`).unwrap().kind).toBe('effect')
    expect(LIBRARY_COMMANDS).toHaveLength(9)
    expect(LIBRARY_QUERIES.map((q) => q.name)).toContain('library.tool.list')
  })

  it('add stores revision 1 with a generated id; get and list return it', async () => {
    const { d } = await setup()
    const added = await add(d, 'tool', omitKind(flatEndMillValues()))
    expect(added).toEqual({
      id: 'tool-1',
      revision: 1,
      updatedAt: '2026-11-17T10:00:00.000Z',
      ...flatEndMillValues(),
    })
    const got = expectOk(d.query('library.tool.get', { id: 'tool-1' }, agent)).value
    expect(got).toEqual(added)
    const list = expectOk(d.query('library.tool.list', {}, agent)).value
    expect(list).toEqual({ items: [added], errors: [] })
  })

  it('effects are not undoable and leave the project untouched, but are logged', async () => {
    const { d, events } = await setup()
    const out = expectOk(
      await d.dispatch('library.stock.add', { values: omitKind(stockValues()) }, agent),
    )
    expect(out.revision).toBe(0)
    expect(d.history.undoable).toEqual([])
    expect(events.map((e) => e.type === 'command' && e.name)).toEqual(['library.stock.add'])
  })

  it('invalid values → model.invariant with field paths; nothing is written', async () => {
    const { d, storage } = await setup()
    const e = expectErrCode(
      await d.dispatch(
        'library.stock.add',
        { values: { ...omitKind(stockValues()), width: len('0') } },
        agent,
      ),
      'model.invariant',
    )
    expect(e.issues.map((i) => i.path.join('.'))).toEqual(['values.width'])
    expect(expectOk(await storage.list('stock'))).toEqual([])
  })

  it('update needs the revision the caller read; a stale one is command.conflict', async () => {
    const { d } = await setup()
    const { id } = await add(d, 'machine', omitKind(machineValues()))
    const values = { ...omitKind(machineValues()), name: 'Shapeoko 5' }
    const up = expectOk(
      await d.dispatch('library.machine.update', { id, revision: 1, values }, agent),
    )
    expect(up.value).toMatchObject({ id, revision: 2, name: 'Shapeoko 5' })
    expectErrCode(
      await d.dispatch('library.machine.update', { id, revision: 1, values }, agent),
      'command.conflict',
    )
    expectErrCode(
      await d.dispatch('library.machine.update', { id, values }, agent),
      'input.malformed',
    )
  })

  it('remove requires confirm: true', async () => {
    const { d } = await setup()
    const { id } = await add(d, 'stock', omitKind(stockValues()))
    expectErrCode(await d.dispatch('library.stock.remove', { id }, agent), 'input.malformed')
    expectErrCode(
      await d.dispatch('library.stock.remove', { id, confirm: false }, agent),
      'input.malformed',
    )
    expectOk(
      await d.dispatch('library.stock.remove', { id, revision: 1, confirm: true }, uiSource()),
    )
    expectErrCode(d.query('library.stock.get', { id }, agent), 'input.malformed')
  })

  it('get of an unreadable item returns its load error', async () => {
    const storage = createMemoryLibraryStorage([
      { kind: 'stock', id: 'bad', content: { id: 'bad', kind: 'stock' } },
    ])
    const library = expectOk(await Library.open(storage))
    const d = createDispatcher({
      registry: expectOk(createAppRegistry()),
      doc,
      services: { workers: inProcessWorkers, library },
    })
    expectErrCode(d.query('library.stock.get', { id: 'bad' }, agent), 'input.malformed')
    const list = expectOk(d.query('library.stock.list', {}, agent)).value as {
      errors: { id: string; code: string }[]
    }
    expect(list.errors.map((e) => [e.id, e.code])).toEqual([['bad', 'input.malformed']])
  })

  it('without a library service the commands fail as a bug, not silently', async () => {
    const { d } = await setup(false)
    expectErrCode(
      await d.dispatch('library.stock.add', { values: omitKind(stockValues()) }, agent),
      'internal.unexpected',
    )
    expectErrCode(d.query('library.stock.list', {}, agent), 'internal.unexpected')
  })

  it('library queries are not project reads: they give an agent no baseline for undo', async () => {
    const { d } = await setup()
    expectOk(d.query('library.stock.list', {}, agent))
    expectErrCode(await d.dispatch('history.undo', {}, agent), 'command.conflict')
  })

  it('a wrong-case id is rejected before it reaches storage', async () => {
    const { d } = await setup()
    const { id } = await add(d, 'stock', omitKind(stockValues()))
    expectErrCode(
      await d.dispatch(
        'library.stock.remove',
        { id: id.toUpperCase(), revision: 1, confirm: true },
        agent,
      ),
      'input.malformed',
    )
    expect(expectOk(d.query('library.stock.get', { id }, agent)).value).toMatchObject({ id })
  })
})
