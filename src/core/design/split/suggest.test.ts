// Split parts 4c: Split to fit. `design.split.suggest` gives the fewest levels, then lines, so every
// piece fits a library stock and the machine travel; the stoutest grid among equals; keys counted.
// Spec: docs/modes/split-parts.md#implementation-4c
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../../shared/testing/result'
import { uiSource } from '../../commands/testing'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { len, libraryInput, machineValues } from '../../library/library.fixture'
import { designSetup, type DesignSetup } from '../design.fixture'
import {
  ENCLOSURE_STOCK,
  enclosureCommands,
  PANEL_LINE,
  PANEL_STOCK,
  panelCommands,
} from './split.fixture'

const region2d = nodeRegion2d()

interface Suggested {
  lines: { axis: 'x' | 'y'; at: string }[]
  levels: string[]
  pieces: number
  need: number[]
}

async function setup(stock: object, commands: (id: string) => [string, object][]) {
  const s = await designSetup({ stock, services: { region2d } })
  for (const [name, args] of commands(s.partId)) await s.run(name, args)
  return s
}

const addStock = async (s: DesignSetup, values: object) =>
  ((await s.run('library.stock.add', { values })) as { id: string }).id

const suggest = (s: DesignSetup, args: object) =>
  s.d.query('design.split.suggest', { partId: s.partId, ...args }, uiSource())

describe('design.split.suggest (4c)', () => {
  it('splits the enclosure to fit 200 × 100.1 × 40: one level, two lines, 2 × 2 (the stoutest)', async () => {
    const s = await setup(ENCLOSURE_STOCK, enclosureCommands)
    const id = await addStock(s, {
      ...ENCLOSURE_STOCK,
      name: 'Block 200 × 100.1 × 40',
      length: '200',
      width: '100.1',
      thickness: '40',
    })
    const r = expectOk(suggest(s, { stockLibraryItemId: id })).value as Suggested
    expect(r).toEqual({
      lines: [
        { axis: 'x', at: '125 mm' },
        { axis: 'y', at: '100 mm' },
      ],
      levels: ['-40 mm'],
      pieces: 8,
      need: [134.75, 98.5, 40],
    })
    // applied with useStocks: every piece on that board
    const set = (await s.run('design.split.set', {
      partId: s.partId,
      split: { lines: r.lines, levels: r.levels, useStocks: true },
    })) as { pieces: { blank: number[] }[] }
    expect(set.pieces.map((p) => p.blank)).toEqual(Array(8).fill([200, 100.1, 40]))
  })

  it('fits the machine travel alone (no stock): the library machine', async () => {
    const s = await setup(ENCLOSURE_STOCK, enclosureCommands)
    await s.run('library.machine.add', {
      values: libraryInput({
        ...machineValues(),
        travel: { x: len('200'), y: len('200'), z: len('50') },
      }),
    })
    const r = expectOk(suggest(s, {})).value as Suggested
    expect([r.levels, r.lines, r.pieces]).toEqual([['-40 mm'], [{ axis: 'x', at: '125 mm' }], 4])
  })

  it('counts the knob of a keyed line in the male blank', async () => {
    const s = await setup(PANEL_STOCK, panelCommands)
    const id = await addStock(s, { ...PANEL_STOCK, name: 'Ply 315', length: '315', width: '420' })
    const butt = expectOk(suggest(s, { stockLibraryItemId: id })).value as Suggested
    expect(butt.lines).toEqual([{ axis: 'x', at: '305 mm' }])
    await s.run('design.split.set', {
      partId: s.partId,
      split: { lines: [PANEL_LINE], joint: 'puzzle' },
    })
    const keyed = expectOk(suggest(s, { stockLibraryItemId: id })).value as Suggested
    expect(keyed.lines.length).toBe(2)
    expect(keyed.levels).toEqual([])
  })

  it('refuses: nothing fits, nothing to fit, a piece, an unknown stock', async () => {
    const s = await setup(ENCLOSURE_STOCK, enclosureCommands)
    const none = expectErrCode(suggest(s, {}), 'input.malformed')
    expect(none.issues[0]!.rule).toBe('nothingToFit')
    const tiny = await addStock(s, {
      ...ENCLOSURE_STOCK,
      name: 'Chip',
      length: '5',
      width: '5',
      thickness: '2',
    })
    expect(
      expectErrCode(suggest(s, { stockLibraryItemId: tiny }), 'input.malformed').issues[0]!.rule,
    ).toBe('noFit')
    expect(
      expectErrCode(suggest(s, { stockLibraryItemId: 'nope' }), 'input.malformed').issues[0]!.rule,
    ).toBe('unknownItem')
    await s.run('design.split.set', { partId: s.partId, split: { levels: ['-40'] } })
    const piece = Object.values(s.d.doc.parts).find((p) => p.derivedFrom !== undefined)!
    expectErrCode(
      s.d.query('design.split.suggest', { partId: piece.id, stockLibraryItemId: tiny }, uiSource()),
      'model.invariant',
    )
  })
})
