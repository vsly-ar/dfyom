// Changing a part's stock in Design (hardening DF95): `design.part.update { stock }` or
// `{ stockLibraryItemId }` replaces the part's stock snapshot in place (its id kept) in one undo
// step; operations that no longer fit stay as they are and show through the existing findings
// (no clamp); a split piece refuses it; patterns follow.
// Spec: docs/modes/design.md#changing-the-stock-df95
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { uiSource } from '../commands/testing'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { designSetup, testStock, type DesignSetup } from './design.fixture'
import { loadPart } from './load'

const ui = uiSource()
const region2d = nodeRegion2d()

const stockOf = (s: DesignSetup) => {
  const l = expectOk(loadPart(s.d.doc, s.partId, 'test'))
  return {
    size: [l.stock.length, l.stock.width, l.stock.thickness].map((q) => q.canonical),
    material: l.stock.material.name,
    linked: s.d.doc.snapshots[s.part().stock]!.libraryItemId,
  }
}
const rules = async (s: DesignSetup) =>
  (
    expectOk(s.d.query('design.warning.list', { partId: s.partId }, ui)).value as {
      warnings: { code: string }[]
    }
  ).warnings.map((w) => w.code)

describe('design.part.update { stock } (DF95)', () => {
  it('resizes the own copy in place as one undo step', async () => {
    const s = await designSetup()
    const snapshotId = s.part().stock
    expect(stockOf(s).linked).toBeDefined()
    await s.run('design.part.update', {
      partId: s.partId,
      stock: {
        ...testStock('12'),
        name: 'Aluminium 6061-T6 150 × 80 × 12',
        length: '150',
        width: '80',
      },
    })
    expect(s.part().stock).toBe(snapshotId)
    expect(stockOf(s)).toEqual({ size: [150, 80, 12], material: '6061-T6', linked: undefined })
    await s.undo()
    expect(stockOf(s).size).toEqual([100, 60, 20])
    expect(stockOf(s).linked).toBeDefined()
    await s.redo()
    expect(stockOf(s).size).toEqual([150, 80, 12])
  })

  it('the same library stock again writes nothing (not even a new takenAt)', async () => {
    const s = await designSetup()
    const before = s.d.doc.snapshots[s.part().stock]
    await s.run('design.part.update', {
      partId: s.partId,
      stockLibraryItemId: stockOf(s).linked,
    })
    expect(s.d.doc.snapshots[s.part().stock]).toBe(before)
  })

  it('takes a linked copy of another library stock', async () => {
    const s = await designSetup()
    const other = (await s.run('library.stock.add', {
      values: {
        ...testStock('6'),
        name: 'Walnut 300',
        length: '300',
        material: { name: 'Walnut', class: 'hardwood' },
      },
    })) as { id: string }
    await s.run('design.part.update', { partId: s.partId, stockLibraryItemId: other.id })
    expect(stockOf(s)).toEqual({ size: [300, 60, 6], material: 'Walnut', linked: other.id })
  })

  it('keeps operations that no longer fit and reports them (no clamp)', async () => {
    const s = await designSetup({ services: { region2d } })
    await s.run('design.drilling.add', { partId: s.partId, center: ['90', '50'], diameter: '6' })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'rectangle', center: ['50', '30'], length: '20', width: '10' },
      depth: '15',
    })
    const before = structuredClone(s.part().operations)
    await s.run('design.part.update', {
      partId: s.partId,
      stock: { ...testStock('10'), length: '50', width: '40' },
    })
    // the records are as they were: the hole sits outside, the pocket is deeper than the stock
    expect(s.part().operations).toEqual(before)
    const found = await rules(s)
    expect(found).toContain('dfm.holeOutsideStock')
    expect(found.filter((c) => c === 'dfm.stockLimit')).toHaveLength(1)
  })

  it('a broken operation does not block edits of the others; fixing it clears it', async () => {
    const s = await designSetup({ services: { region2d } })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'rectangle', center: ['50', '30'], length: '20', width: '10' },
      depth: '15',
    })
    await s.run('design.drilling.add', { partId: s.partId, center: ['20', '20'], diameter: '6' })
    const idOf = (kind: string) => s.part().operations.find((o) => o.kind === kind)!.id
    await s.run('design.part.update', { partId: s.partId, stock: testStock('10') })
    expect(await rules(s)).toContain('dfm.stockLimit')
    // another operation's edit that doesn't make things worse passes
    await s.run('design.drilling.update', {
      partId: s.partId,
      operationId: idOf('drilling'),
      diameter: '8',
    })
    // the broken operation keeps its own invariants: only a fix passes
    await s.fail(
      'design.pocket.update',
      { partId: s.partId, operationId: idOf('pocket'), name: 'Deep' },
      'model.invariant',
    )
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: idOf('pocket'),
      depth: '5',
    })
    expect(await rules(s)).not.toContain('dfm.stockLimit')
  })

  it('refuses both sources at once, an unknown stock and a split piece', async () => {
    const s = await designSetup({ services: { region2d } })
    const both = expectErrCode(
      await s.d.dispatch(
        'design.part.update',
        { partId: s.partId, stock: testStock(), stockLibraryItemId: 'nope' },
        ui,
      ),
      'input.malformed',
    )
    expect(both.issues[0]?.rule).toBe('stockSource')
    const unknown = await s.fail(
      'design.part.update',
      { partId: s.partId, stockLibraryItemId: 'missing' },
      'input.malformed',
    )
    expect(unknown.issues[0]?.rule).toBe('unknownItem')
    const bad = await s.fail(
      'design.part.update',
      { partId: s.partId, stock: { ...testStock(), length: '-5' } },
      'model.invariant',
    )
    expect(bad.issues[0]?.path[0]).toBe('stock')

    await s.run('design.split.set', {
      partId: s.partId,
      split: { lines: [{ axis: 'x', at: '50' }], levels: [] },
    })
    const piece = Object.values(s.d.doc.parts).find((p) => p.derivedFrom !== undefined)!
    const refused = await s.fail(
      'design.part.update',
      { partId: piece.id, stock: testStock() },
      'model.invariant',
    )
    expect(refused.issues[0]?.rule).toBe('derivedPart')
  })

  it('a split source regenerates its pieces from the new stock', async () => {
    const s = await designSetup({ services: { region2d } })
    await s.run('design.split.set', {
      partId: s.partId,
      split: { lines: [{ axis: 'x', at: '50' }], levels: [] },
    })
    await s.run('design.part.update', {
      partId: s.partId,
      stock: { ...testStock('20'), length: '120' },
    })
    const pieces = Object.values(s.d.doc.parts).filter((p) => p.derivedFrom !== undefined)
    expect(pieces).toHaveLength(2)
    const lengths = pieces
      .map((p) => expectOk(loadPart(s.d.doc, p.id, 'test')).stock.length.canonical)
      .sort((a, b) => a - b)
    // the line stays at x 50: 50 and 70 long (plus the blank margin each side)
    expect(lengths[1]! - lengths[0]!).toBeCloseTo(20, 6)
  })
})
