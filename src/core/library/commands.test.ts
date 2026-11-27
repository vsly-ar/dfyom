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
import {
  deg,
  flatEndMillValues,
  len,
  libraryInput,
  machineValues,
  stockValues,
} from './library.fixture'
import { createMemoryLibraryStorage } from './memory-storage'
import { followRecommended } from '../feeds-speeds/preset'

const agent = agentSource()
const doc = newProjectDoc({ name: 'Bracket', unitSystem: 'mm' })

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
    for (const kind of ['stock', 'tool', 'machine', 'workholding'])
      for (const verb of ['add', 'update', 'remove'])
        expect(reg.command(`library.${kind}.${verb}`).unwrap().kind).toBe('effect')
    expect(LIBRARY_COMMANDS).toHaveLength(13)
    expect(LIBRARY_QUERIES.map((q) => q.name)).toContain('library.tool.list')
  })

  it('add stores revision 1 with a generated id; get and list return it', async () => {
    const { d } = await setup()
    const added = await add(d, 'tool', libraryInput(flatEndMillValues()))
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
      await d.dispatch('library.stock.add', { values: libraryInput(stockValues()) }, agent),
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
        { values: { ...libraryInput(stockValues()), width: '0' } },
        agent,
      ),
      'model.invariant',
    )
    expect(e.issues.map((i) => i.path.join('.'))).toEqual(['values.width'])
    expect(expectOk(await storage.list('stock'))).toEqual([])
  })

  it('quantities are strings: bare numbers in units (default mm), stored as entered', async () => {
    const { d } = await setup()
    const inch = await d.dispatch(
      'library.stock.add',
      { values: { ...libraryInput(stockValues()), length: '4', width: '60 mm' }, units: 'inch' },
      agent,
    )
    expect(expectOk(inch).value).toMatchObject({
      length: { source: '4', defaultUnit: 'in', exact: { num: '508', den: '5' } },
      width: { source: '60 mm', defaultUnit: 'in', exact: { num: '60', den: '1' } },
      thickness: { source: '10 ±0.1', defaultUnit: 'in' },
    })
    const mm = expectOk(
      await d.dispatch('library.tool.add', { values: libraryInput(flatEndMillValues()) }, agent),
    )
    expect(mm.value).toMatchObject({
      diameter: len('6'),
      presets: [{ feedRate: { defaultUnit: 'mm/min' } }],
    })
  })

  it('adds and updates a chamfer mill (v0.4 C1): angle and tip as strings; invariants apply', async () => {
    const { d, storage } = await setup()
    const values = {
      ...libraryInput(flatEndMillValues()),
      name: 'V-bit 90',
      type: 'chamferMill',
      diameter: '12',
      angle: '90',
      presets: [],
    }
    const added = await add(d, 'tool', values)
    expect(added).toMatchObject({ type: 'chamferMill', angle: deg('90'), diameter: len('12') })
    expect(added).not.toHaveProperty('tipDiameter')
    const updated = expectOk(
      await d.dispatch(
        'library.tool.update',
        { id: added.id, revision: 1, values: { ...values, tipDiameter: '0.2' } },
        agent,
      ),
    ).value
    expect(updated).toMatchObject({ revision: 2, tipDiameter: len('0.2') })
    const bad = expectErrCode(
      await d.dispatch(
        'library.tool.add',
        { values: { ...values, angle: '9', tipDiameter: '12' } },
        agent,
      ),
      'model.invariant',
    )
    expect(bad.issues.map((i) => i.path.join('.'))).toEqual(['values.angle', 'values.tipDiameter'])
    expect(bad.issues[0]?.params).toMatchObject({ min: 10, max: 150 })
    expect(expectOk(await storage.list('tool'))).toHaveLength(1)
    // DF123 (TG #407): a 15° engraving V-bit is a chamfer mill too
    const v15 = await add(d, 'tool', {
      ...values,
      name: 'V-bit 15°',
      angle: '15',
      diameter: '3.175',
    })
    expect(v15).toMatchObject({ type: 'chamferMill', angle: { source: '15' } })
    expect(expectOk(await storage.list('tool'))).toHaveLength(2)
  })

  it('a bad quantity string fails like in every command: its code, path below values', async () => {
    const { d, storage } = await setup()
    const values = libraryInput(flatEndMillValues()) as { presets: Record<string, unknown>[] }
    const syntax = expectErrCode(
      await d.dispatch('library.tool.add', { values: { ...values, diameter: '6 mm mm' } }, agent),
      'quantity.syntax',
    )
    expect(syntax.issues.map((i) => i.path.join('.'))).toEqual(['values.diameter'])
    const preset = { ...values.presets[0], feedRate: '800 rpm' }
    const unit = expectErrCode(
      await d.dispatch('library.tool.add', { values: { ...values, presets: [preset] } }, agent),
      'quantity.unit',
    )
    expect(unit.issues.map((i) => i.path.join('.'))).toEqual(['values.presets.0.feedRate'])
    expectErrCode(
      await d.dispatch('library.tool.add', { values: { ...values, diameter: len('6') } }, agent),
      'input.malformed',
    )
    expect(expectOk(await storage.list('tool'))).toEqual([])
  })

  it('update needs the revision the caller read; a stale one is command.conflict', async () => {
    const { d } = await setup()
    const { id } = await add(d, 'machine', libraryInput(machineValues()))
    const values = { ...libraryInput(machineValues()), name: 'Shapeoko 5' }
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

  it('a machine holder from a preset id alone; edited sizes; issues below values (DF132 H1)', async () => {
    const { d } = await setup()
    const { id } = await add(d, 'machine', {
      ...libraryInput(machineValues()),
      holder: { preset: 'er11' },
    })
    const got = expectOk(d.query('library.machine.get', { id }, agent)).value as {
      holder: { preset: string; nutDiameter: { source: string }; maxShank: { source: string } }
    }
    expect(got.holder).toMatchObject({
      preset: 'er11',
      nutDiameter: { source: '19', defaultUnit: 'mm' },
      maxShank: { source: '7' },
    })
    const up = expectOk(
      await d.dispatch(
        'library.machine.update',
        {
          id,
          revision: 1,
          values: {
            ...libraryInput(machineValues()),
            holder: { preset: 'er11', nutDiameter: '0.875' },
          },
          units: 'inch',
        },
        agent,
      ),
    ).value as { holder: { nutDiameter: { source: string }; nutLength: { source: string } } }
    expect(up.holder.nutDiameter.source).toBe('0.875')
    expect(up.holder.nutLength.source).toBe('12')
    const bad = expectErrCode(
      await d.dispatch(
        'library.machine.add',
        { values: { ...libraryInput(machineValues()), holder: { nutDiameter: '19' } } },
        agent,
      ),
      'model.invariant',
    )
    expect(bad.issues.map((i) => i.path.join('.'))).toEqual([
      'values.holder.nutLength',
      'values.holder.bodyDiameter',
    ])
  })

  it("a tool's own holder from a preset id alone; issues below values.holder (DF132 H6)", async () => {
    const { d } = await setup()
    const { id } = await add(d, 'tool', {
      ...libraryInput(flatEndMillValues()),
      holder: { preset: 'er16' },
    })
    const got = expectOk(d.query('library.tool.get', { id }, agent)).value as {
      holder: { preset: string; nutDiameter: { source: string } }
    }
    expect(got.holder).toMatchObject({ preset: 'er16', nutDiameter: { source: '32' } })
    const bad = expectErrCode(
      await d.dispatch(
        'library.tool.add',
        { values: { ...libraryInput(flatEndMillValues()), holder: { nutLength: '12' } } },
        agent,
      ),
      'model.invariant',
    )
    expect(bad.issues.map((i) => i.path.join('.'))).toEqual([
      'values.holder.nutDiameter',
      'values.holder.bodyDiameter',
    ])
  })

  it('stock variants (DF13): one level under a root stock; kept on update; block remove', async () => {
    const { d } = await setup()
    const root = await add(d, 'stock', libraryInput(stockValues()))
    const input = { ...libraryInput(stockValues()), name: 'Plate 200 × 150' }
    const variant = expectOk(
      await d.dispatch('library.stock.add', { values: input, parentId: root.id }, agent),
    ).value as { id: string; parentId?: string }
    expect(variant.parentId).toBe(root.id)
    const up = expectOk(
      await d.dispatch(
        'library.stock.update',
        { id: variant.id, revision: 1, values: { ...input, name: 'Plate cut' } },
        agent,
      ),
    ).value as { parentId?: string; revision: number }
    expect(up).toMatchObject({ parentId: root.id, revision: 2 })
    const nested = await d.dispatch(
      'library.stock.add',
      { values: input, parentId: variant.id },
      agent,
    )
    expect(expectErrCode(nested, 'input.malformed').issues[0]?.rule).toBe('nestedVariant')
    const unknown = await d.dispatch(
      'library.stock.add',
      { values: input, parentId: 'nope' },
      agent,
    )
    expect(expectErrCode(unknown, 'input.malformed').issues[0]?.rule).toBe('unknownItem')
    const blocked = await d.dispatch(
      'library.stock.remove',
      { id: root.id, revision: 1, confirm: true },
      uiSource(),
    )
    expect(expectErrCode(blocked, 'input.malformed').issues[0]?.rule).toBe('hasVariants')
    expectOk(
      await d.dispatch(
        'library.stock.remove',
        { id: variant.id, revision: 2, confirm: true },
        uiSource(),
      ),
    )
    expectOk(
      await d.dispatch(
        'library.stock.remove',
        { id: root.id, revision: 1, confirm: true },
        uiSource(),
      ),
    )
  })

  it('remove requires confirm: true', async () => {
    const { d } = await setup()
    const { id } = await add(d, 'stock', libraryInput(stockValues()))
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
      await d.dispatch('library.stock.add', { values: libraryInput(stockValues()) }, agent),
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
    const { id } = await add(d, 'stock', libraryInput(stockValues()))
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

describe('library.machine.settings (GRBL $$ import)', () => {
  const DUMP = [
    'ok',
    '$20=1',
    '$110=6000.000 (x max rate)',
    '$111=5000.000',
    '$130=750',
    '$11=0.02',
    '$999=1',
  ].join('\n')

  it('preview lists the diff without writing; import applies only the accepted settings', async () => {
    const { d, library } = await setup()
    const { id } = await add(d, 'machine', libraryInput(machineValues()))
    const preview = expectOk(
      d.query('library.machine.settings.preview', { id, text: DUMP }, agent),
    ).value
    expect(preview).toEqual({
      read: 6,
      changes: [
        {
          setting: '$110',
          field: 'maxFeedRate.x',
          value: 6000,
          from: '5000 mm/min',
          to: '6000 mm/min',
        },
        { setting: '$11', field: 'junctionDeviation', value: 0.02, from: null, to: '0.02 mm' },
        { setting: '$130', field: 'travel.x', value: 750, from: '800 mm', to: '750 mm' },
      ],
      unchanged: ['$111', '$20'],
      skipped: [],
      ignored: [999],
    })
    expect(library.lookup('machine', id)).toMatchObject({ item: { revision: 1 } })
    const out = expectOk(
      await d.dispatch(
        'library.machine.settings.import',
        { id, revision: 1, text: DUMP, accept: ['$110', '$11'] },
        agent,
      ),
    ).value as { item: Record<string, unknown>; applied: string[] }
    expect(out.applied).toEqual(['$110', '$11'])
    expect(out.item).toMatchObject({
      revision: 2,
      maxFeedRate: { x: { source: '6000' } },
      travel: { x: { source: '800' } },
      junctionDeviation: { source: '0.02', defaultUnit: 'mm' },
    })
  })

  it('writes GRBL units out in an inch machine', async () => {
    const { d } = await setup()
    const added = expectOk(
      await d.dispatch(
        'library.machine.add',
        { values: libraryInput(machineValues()), units: 'inch' },
        agent,
      ),
    ).value as { id: string }
    const out = expectOk(
      await d.dispatch(
        'library.machine.settings.import',
        { id: added.id, revision: 1, text: '$110=6000', accept: ['$110'] },
        agent,
      ),
    ).value as { item: { maxFeedRate: { x: { source: string; defaultUnit: string } } } }
    expect(out.item.maxFeedRate.x).toMatchObject({ source: '6000 mm/min', defaultUnit: 'in/min' })
  })

  it('rejects text without settings, unknown accepts, a stale revision and model issues', async () => {
    const { d } = await setup()
    const { id } = await add(d, 'machine', {
      ...libraryInput(machineValues()),
      spindle: { control: 'gcode', maxSpeed: '24000', minSpeed: '6000' },
    })
    const none = expectErrCode(
      d.query('library.machine.settings.preview', { id, text: 'hello\nok' }, agent),
      'input.malformed',
    )
    expect(none.issues[0]).toMatchObject({ path: ['text'], rule: 'noSettings' })
    expectErrCode(
      d.query('library.machine.settings.preview', { id: 'machine-x', text: DUMP }, agent),
      'input.malformed',
    )
    const run = (args: object) =>
      d.dispatch('library.machine.settings.import', { id, text: DUMP, ...args }, agent)
    const bad = expectErrCode(await run({ revision: 1, accept: ['$120'] }), 'input.malformed')
    expect(bad.issues[0]).toMatchObject({ path: ['accept', 0], rule: 'notAChange' })
    expectErrCode(await run({ revision: 7, accept: ['$110'] }), 'command.conflict')
    // $30 below the stored minimum speed: the machine model refuses it
    const model = expectErrCode(
      await d.dispatch(
        'library.machine.settings.import',
        { id, revision: 1, text: '$30=5000', accept: ['$30'] },
        agent,
      ),
      'model.invariant',
    )
    expect(model.issues[0]?.path).toEqual(['values', 'spindle', 'minSpeed'])
  })
})

describe('library.tool recommended presets', () => {
  it('recommended presets follow the calculator on add and update (library.md#recommended-presets)', async () => {
    const { d } = await setup()
    const values = { ...flatEndMillValues(), toolMaterial: 'carbide' as const }
    const input = libraryInput(values) as { presets: Record<string, unknown>[] }
    const recommended = { ...input, presets: [{ ...input.presets[0], recommended: true }] }
    const added = (await add(d, 'tool', recommended)) as unknown as {
      id: string
      revision: number
      presets: { spindleSpeed: { source: string }; stepover: { source: string } }[]
    }
    const followed = followRecommended(
      { ...values, presets: [{ ...values.presets[0]!, recommended: true }] },
      'mm',
    ).values.presets[0]!
    expect(added.presets[0]).toEqual(followed)
    expect(added.presets[0]!.spindleSpeed.source).not.toBe('18000')
    expect(added.presets[0]!.stepover.source).toBe('3')
    // a bigger diameter: the preset follows
    const bigger = expectOk(
      await d.dispatch(
        'library.tool.update',
        {
          id: added.id,
          revision: 1,
          values: { ...recommended, diameter: '8' },
        },
        agent,
      ),
    ).value as { presets: { spindleSpeed: { source: string } }[] }
    expect(bigger.presets[0]!.spindleSpeed.source).not.toBe(added.presets[0]!.spindleSpeed.source)
    // recommended false: the given values are stored
    const own = expectOk(
      await d.dispatch(
        'library.tool.update',
        {
          id: added.id,
          revision: 2,
          values: { ...input, presets: [{ ...input.presets[0], recommended: false }] },
        },
        agent,
      ),
    ).value as { presets: { spindleSpeed: { source: string }; recommended?: boolean }[] }
    expect(own.presets[0]).toMatchObject({ spindleSpeed: { source: '18000' } })
    expect(own.presets[0]!.recommended).toBeUndefined()
  })

  it('a recommended preset without calculator data or class → model.invariant', async () => {
    const { d } = await setup()
    const input = libraryInput(flatEndMillValues()) as { presets: Record<string, unknown>[] }
    // no tool material: the calculator has no data
    const noData = expectErrCode(
      await d.dispatch(
        'library.tool.add',
        { values: { ...input, presets: [{ ...input.presets[0], recommended: true }] } },
        agent,
      ),
      'model.invariant',
    )
    expect(noData.issues[0]).toMatchObject({
      path: ['values', 'presets', 0, 'recommended'],
      rule: 'noRecommendation',
    })
    const { materialClass: _, ...any } = input.presets[0]!
    const noClass = expectErrCode(
      await d.dispatch(
        'library.tool.add',
        {
          values: {
            ...input,
            toolMaterial: 'carbide',
            presets: [{ ...any, recommended: true }],
          },
        },
        agent,
      ),
      'model.invariant',
    )
    expect(noClass.issues[0]).toMatchObject({
      path: ['values', 'presets', 0, 'recommended'],
      rule: 'recommendedNeedsClass',
    })
  })
})
