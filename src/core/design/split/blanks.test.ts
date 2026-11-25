// Split parts 4c: a piece's blank. The automatic choice with `useStocks` (smallest volume of the
// source's material class, turned 0° or 90°), the user's choice by `design.part.update { blank }`
// (kept by number, refused when too small or unknown, the fallback with `noStock`), and the surplus
// of a thicker blank (the source's top facing deeper, else a generated glue face; dowels deeper).
// Spec: docs/modes/split-parts.md#implementation-4c
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { uiSource } from '../../commands/testing'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { checkPartFits } from '../../plan/validity'
import { designSetup, type DesignSetup } from '../design.fixture'
import type { PartDTO } from '../part.dto'
import { autoStock, holds, resolveBlank, type StockOption } from './blanks'
import { ENCLOSURE_LEVEL, ENCLOSURE_STOCK, enclosureCommands } from './split.fixture'

const region2d = nodeRegion2d()

const mm = (q: { exact: { num: string; den: string } }) =>
  Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))

const board = (
  name: string,
  l: string,
  w: string,
  t: string,
  material: { name: string; class: string } = ENCLOSURE_STOCK.material,
) => ({
  ...ENCLOSURE_STOCK,
  name,
  length: l,
  width: w,
  thickness: t,
  material,
})

async function enclosure(...boards: object[]): Promise<{ s: DesignSetup; ids: string[] }> {
  const s = await designSetup({ stock: ENCLOSURE_STOCK, services: { region2d } })
  for (const [name, args] of enclosureCommands(s.partId)) await s.run(name, args)
  const ids: string[] = []
  for (const b of boards)
    ids.push(((await s.run('library.stock.add', { values: b })) as { id: string }).id)
  return { s, ids }
}

const pieces = (s: DesignSetup): PartDTO[] =>
  Object.values(s.d.doc.parts)
    .filter((p) => p.derivedFrom?.partId === s.partId)
    .sort((a, b) => a.derivedFrom!.index - b.derivedFrom!.index)

type Q = { exact: { num: string; den: string } }
const blankOf = (s: DesignSetup, p: PartDTO) => {
  const v = s.d.doc.snapshots[p.stock]!.values as unknown as {
    name: string
    length: Q
    width: Q
    thickness: Q
  }
  return { name: v.name, size: [mm(v.length), mm(v.width), mm(v.thickness)] }
}

const op = (p: PartDTO, id: string) =>
  p.operations.find((o) => o.id === id) as
    | (PartDTO['operations'][number] & { depth?: { exact: { num: string; den: string } } })
    | undefined

const LINES = [
  { axis: 'x', at: '125' },
  { axis: 'y', at: '100' },
]

describe('the automatic choice (pure)', () => {
  const opt = (id: string, size: [number, number, number], cls = 'hardwood'): StockOption =>
    ({
      id,
      name: id,
      size,
      material: { name: 'Oak', class: cls },
      values: {} as StockOption['values'],
    }) as StockOption
  const oak = { name: 'Oak', class: 'hardwood' as const }
  it('takes the smallest volume of the class that holds the need, turned if needed', () => {
    const need = [134.75, 98.5, 40] as const
    expect(holds(need, [200, 100.1, 40])).toBe(0)
    expect(holds(need, [100.1, 200, 40])).toBe(90)
    expect(holds(need, [98, 200, 40])).toBeUndefined()
    const opts = [
      opt('big', [300, 300, 40]),
      opt('turned', [100.1, 200, 45]),
      opt('ply', [130, 100, 40], 'sheetGood'),
    ]
    expect(autoStock(need, opts, oak)?.id).toBe('turned')
    const r = resolveBlank(need, undefined, true, opts, oak)
    expect([r.stock?.id, r.rotation, r.size]).toEqual(['turned', 90, [200, 100.1, 45]])
    expect(r.record).toEqual({ libraryItemId: 'turned', rotation: 90 })
    // off: the own block; a choice wins either way
    expect(resolveBlank(need, undefined, false, opts, oak).size).toEqual(need)
    const chosen = resolveBlank(need, { kind: 'library', libraryItemId: 'big' }, false, opts, oak)
    expect(chosen.stock?.id).toBe('big')
    const short = resolveBlank(need, { kind: 'library', libraryItemId: 'ply' }, true, opts, oak)
    expect([short.stock, short.fallback?.reason]).toEqual([undefined, 'short'])
    expect(short.record).toEqual({ choice: { kind: 'library', libraryItemId: 'ply' } })
  })
})

describe('pieces on library blanks (4c)', () => {
  it('useStocks nests every piece on the smallest board of the class, centred, unlinked', async () => {
    const { s, ids } = await enclosure(
      board('Block 200 × 100.1 × 40', '200', '100.1', '40'),
      board('Block 300 × 300 × 40', '300', '300', '40'),
      board('Ply 150 × 110 × 40', '150', '110', '40', {
        name: 'Birch plywood',
        class: 'sheetGood',
      }),
    )
    const r = (await s.run('design.split.set', {
      partId: s.partId,
      split: { levels: [ENCLOSURE_LEVEL], lines: LINES, useStocks: true },
    })) as { pieces: { blank: number[] }[] }
    expect(r.pieces.map((p) => p.blank)).toEqual(Array(8).fill([200, 100.1, 40]))
    for (const p of pieces(s)) {
      expect(p.blank).toEqual({ libraryItemId: ids[0] })
      const snap = s.d.doc.snapshots[p.stock]!
      expect(snap.libraryItemId).toBeUndefined()
      expect(blankOf(s, p).name).toBe('Block 200 × 100.1 × 40')
    }
    // piece 1: x 0.25 … 125 centred on 200 (offset 37.375), y 11.5 … 100 on 100.1
    expect(pieces(s)[0]!.offset!.map(mm)).toEqual([37.375, -5.7, 40])
    for (const p of pieces(s)) {
      const fits = checkPartFits(p, s.d.doc.snapshots[p.stock]!, 'test', region2d)
      expect(fits.isOk() ? 'ok' : fits.unwrapErr().issues, p.name).toBe('ok')
    }
    // a later edit without useStocks keeps it; false turns it off
    await s.run('design.split.set', {
      partId: s.partId,
      split: { levels: [ENCLOSURE_LEVEL], lines: LINES },
    })
    expect(s.part().split!.useStocks).toBe(true)
    await s.run('design.split.set', {
      partId: s.partId,
      split: { levels: [ENCLOSURE_LEVEL], lines: LINES, useStocks: false },
    })
    expect(s.part().split!.useStocks).toBeUndefined()
    expect(pieces(s).map((p) => p.blank)).toEqual(Array(8).fill(undefined))
    expect(blankOf(s, pieces(s)[0]!).size).toEqual([134.75, 98.5, 40])
  })

  it('turns a board that holds the piece only at 90°', async () => {
    const { s, ids } = await enclosure(board('Block 100.1 × 200 × 40', '100.1', '200', '40'))
    await s.run('design.split.set', {
      partId: s.partId,
      split: { levels: [ENCLOSURE_LEVEL], lines: LINES, useStocks: true },
    })
    const p = pieces(s)[0]!
    expect(p.blank).toEqual({ libraryItemId: ids[0], rotation: 90 })
    expect(blankOf(s, p).size).toEqual([200, 100.1, 40])
  })

  it("keeps the user's choice by number, refuses a board too small, falls back after an edit", async () => {
    const { s, ids } = await enclosure(
      board('Block 200 × 100.1 × 40', '200', '100.1', '40'),
      board('Block 140 × 104 × 40', '140', '104', '40'),
    )
    const split = { levels: [ENCLOSURE_LEVEL], lines: LINES }
    await s.run('design.split.set', { partId: s.partId, split })
    const third = pieces(s)[2]!
    await s.run('design.part.update', { partId: third.id, blank: { stockLibraryItemId: ids[1] } })
    expect(s.d.doc.parts[third.id]!.blank).toEqual({
      libraryItemId: ids[1],
      choice: { kind: 'library', libraryItemId: ids[1] },
    })
    expect(blankOf(s, s.d.doc.parts[third.id]!).size).toEqual([140, 104, 40])
    // others stay own blocks (useStocks off)
    expect(pieces(s)[0]!.blank).toBeUndefined()
    // a source edit keeps it
    await s.run('design.drilling.add', {
      partId: s.partId,
      on: 'facing2.floor',
      center: ['60', '60'],
      diameter: '3',
      bottom: 'flat',
      depth: '2',
    })
    expect(s.d.doc.parts[third.id]!.blank?.libraryItemId).toBe(ids[1])
    // refused: a board too small, an unknown id, a source part
    const tooSmall = await s.fail(
      'design.part.update',
      { partId: third.id, blank: { stockLibraryItemId: 'nope' } },
      'input.malformed',
    )
    expect(tooSmall.issues[0]!.rule).toBe('unknownItem')
    const tiny = (
      (await s.run('library.stock.add', { values: board('Tiny', '50', '50', '10') })) as {
        id: string
      }
    ).id
    const e = await s.fail(
      'design.part.update',
      { partId: third.id, blank: { stockLibraryItemId: tiny } },
      'input.malformed',
    )
    expect(e.issues[0]!.rule).toBe('blankTooSmall')
    const notPiece = await s.fail(
      'design.part.update',
      { partId: s.partId, blank: 'own' },
      'input.malformed',
    )
    expect(notPiece.issues[0]!.rule).toBe('pieceOnly')
    // a wider margin: 140 no longer holds 134.75 + 2 × 5 → own block, noStock warning, choice kept
    await s.run('design.split.set', { partId: s.partId, split: { ...split, margin: '8' } })
    const p3 = s.d.doc.parts[third.id]!
    expect(p3.blank).toEqual({ choice: { kind: 'library', libraryItemId: ids[1] } })
    expect(blankOf(s, p3).size).toEqual([140.75, 104.5, 40])
    const w = expectOk(s.d.query('design.warning.list', { partId: s.partId }, uiSource()))
      .value as {
      warnings: { severity: string; params: Record<string, unknown> }[]
    }
    const noStock = w.warnings.filter((x) => x.params['rule'] === 'noStock')
    expect(noStock).toEqual([
      expect.objectContaining({
        severity: 'warning',
        params: expect.objectContaining({ piece: 3, reason: 'short', chosen: ids[1] }),
      }),
    ])
    // back to the old margin: on the chosen board again; 'auto' and 'own' clear or pin it
    await s.run('design.split.set', { partId: s.partId, split })
    expect(s.d.doc.parts[third.id]!.blank?.libraryItemId).toBe(ids[1])
    await s.run('design.part.update', { partId: third.id, blank: 'own' })
    expect(s.d.doc.parts[third.id]!.blank).toEqual({ choice: { kind: 'own' } })
    await s.run('design.part.update', { partId: third.id, blank: 'auto' })
    expect(s.d.doc.parts[third.id]!.blank).toBeUndefined()
    // undo restores the choice
    await s.undo()
    expect(s.d.doc.parts[third.id]!.blank).toEqual({ choice: { kind: 'own' } })
  })

  it('faces the surplus off: the top facing deeper, else a glue face; dowels deeper', async () => {
    const { s } = await enclosure(board('Block 280 × 200 × 50', '280', '200', '50'))
    await s.run('design.split.set', {
      partId: s.partId,
      split: { levels: [ENCLOSURE_LEVEL], dowels: {}, useStocks: true },
    })
    const [tray, ring] = pieces(s)
    // the piece's bottom on the blank's bottom, 10 mm surplus above
    expect(tray!.offset!.map(mm)[2]).toBeCloseTo(30, 6)
    expect(ring!.offset!.map(mm)[2]).toBeCloseTo(-10, 6)
    // the ring has the source's top facing: it goes 10 mm deeper, no glue face
    expect(mm(op(ring!, 'facing2')!.depth!)).toBeCloseTo(19.738, 6)
    expect(op(ring!, 'split1_glueFace')).toBeUndefined()
    // the tray: a generated glue face first, its cavity and dowel holes 10 mm deeper
    expect(tray!.operations[0]).toMatchObject({
      id: 'split1_glueFace',
      name: 'Glue face',
      kind: 'facing',
    })
    expect(mm(op(tray!, 'split1_glueFace')!.depth!)).toBeCloseTo(10, 6)
    expect(mm(op(tray!, 'pocket1')!.depth!)).toBeCloseTo(36.028, 6)
    const dowelT = tray!.operations.find((o) => o.id.startsWith('split1_dowel'))!
    const dowelR = ring!.operations.find((o) => o.id.startsWith('split1_dowel'))!
    expect(
      mm((dowelT as unknown as { depth: Q }).depth) - mm((dowelR as unknown as { depth: Q }).depth),
    ).toBeCloseTo(10, 6)
    for (const p of [tray!, ring!]) {
      const fits = checkPartFits(p, s.d.doc.snapshots[p.stock]!, 'test', region2d)
      expect(fits.isOk() ? 'ok' : fits.unwrapErr().issues, p.name).toBe('ok')
    }
  })
})
