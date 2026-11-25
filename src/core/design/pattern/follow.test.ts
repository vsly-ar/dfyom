// Patterns follow their inputs (P4 follow-up, `design.patternFollow`): a changed stock thickness
// re-expands a through pattern's owned pocket depth, a changed stock size the face rectangle of
// its owned shape record, a changed lower pattern the through depth of the one stacked on it, in
// the same command (one undo step); unrelated commands write nothing. And a split part with a
// stacked pattern: each piece keeps both owned shapes, the stack within the lower cells.
// Spec: docs/modes/patterns.md#implementation-p4
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { regionArea, type Region } from '../../geometry/2d/model'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { uiSource } from '../../commands/testing'
import { checkPartFits } from '../../plan/validity'
import { designSetup, testStock, type DesignSetup } from '../design.fixture'
import { partGeometryInput } from '../load'
import type { PartDTO } from '../part.dto'

const region2d = nodeRegion2d()
const ui = uiSource()
const setup = () => designSetup({ services: { region2d } })

interface Result {
  featureId: string
  cells?: number
}
const add = async (s: DesignSetup, args: object = {}) =>
  (await s.run('design.pattern.add', { partId: s.partId, ...args })) as Result

/** The stored owned pocket's depth (mm, exact source) and the owned shape's record. */
const pocketDepth = (s: DesignSetup, id = 'pattern1_pocket') =>
  (s.op(id) as unknown as { depth: { exact: { num: string; den: string } } }).depth.exact
const record = (s: DesignSetup, id = 'pattern1_cells') =>
  s.part().shapes?.find((x) => x.id === id)?.pattern

/** Changes the library stock and takes it into the part (`design.snapshot.update`). */
async function restock(s: DesignSetup, values: object) {
  const snap = s.d.doc.parts[s.partId]!.stock
  const stockId = s.d.doc.snapshots[snap]!.libraryItemId!
  const item = expectOk(s.d.query('library.stock.get', { id: stockId }, ui)).value as {
    revision: number
  }
  await s.run('library.stock.update', { id: stockId, revision: item.revision, values })
  await s.run('design.snapshot.update', { snapshotId: snap })
}

const GRILLE = {
  lattice: 'hex',
  cell: { kind: 'circle', diameter: '6' },
  spacing: { gap: '2' },
  margin: '5',
}

describe('patterns follow the stock (P4 follow-up)', () => {
  it('a thicker stock deepens the through pocket in the same command; undo restores both', async () => {
    const s = await setup()
    await add(s, { ...GRILLE, through: true })
    expect(pocketDepth(s)).toEqual({ num: '20', den: '1' })
    await restock(s, testStock('25'))
    expect(pocketDepth(s)).toEqual({ num: '25', den: '1' })
    await s.undo()
    expect(pocketDepth(s)).toEqual({ num: '20', den: '1' })
    expect(
      (s.d.doc.snapshots[s.part().stock]!.values as { thickness: { exact: { num: string } } })
        .thickness.exact.num,
    ).toBe('20')
  })

  it('a longer stock widens the face rectangle: more cells', async () => {
    const s = await setup()
    const before = (await add(s, GRILLE)).cells!
    expect(record(s)?.boundary).toEqual({ min: [0, 0], max: [100, 60] })
    await restock(s, { ...testStock(), length: '150' })
    expect(record(s)?.boundary).toEqual({ min: [0, 0], max: [150, 60] })
    const g = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const op = g.operations.find((o) => o.id === 'pattern1_pocket')!
    if (op.kind !== 'pocket' || op.shape.contour.kind !== 'region') throw new Error('no region')
    expect(op.shape.contour.region.pieces.length).toBeGreaterThan(before * 1.4)
    // the blind pocket's depth is the pattern's own: unchanged
    expect(pocketDepth(s)).toEqual({ num: '1', den: '1' })
  })

  it('a command that changes none of its inputs writes nothing of the pattern', async () => {
    const s = await setup()
    await add(s, { ...GRILLE, through: true })
    // with the tool chosen on Apply too
    await s.run('project.apply', {})
    const before = s.part()
    await s.run('design.part.update', { partId: s.partId, name: 'Renamed' })
    await s.run('design.drilling.add', { partId: s.partId, center: ['3', '3'], diameter: '2' })
    const after = s.part()
    expect(after.operations[0]).toBe(before.operations[0])
    expect(after.shapes?.[0]).toBe(before.shapes?.[0])
    expect(after.features?.[0]).toBe(before.features?.[0])
  })

  it('a through pattern stacked on a blind one follows its floor; undo restores', async () => {
    const s = await setup()
    await add(s, {
      lattice: 'square',
      cell: { kind: 'rectangle', length: '20', width: '20', cornerRadius: '2' },
      spacing: { gap: '4' },
      margin: '4',
      depth: '2',
    })
    await add(s, {
      on: 'pattern1_pocket.floor',
      lattice: 'hex',
      cell: { kind: 'circle', diameter: '2' },
      spacing: { gap: '1' },
      margin: '1',
      through: true,
    })
    expect(pocketDepth(s, 'pattern2_pocket')).toEqual({ num: '18', den: '1' })
    await s.run('design.pattern.update', { partId: s.partId, featureId: 'pattern1', depth: '5' })
    expect(pocketDepth(s, 'pattern2_pocket')).toEqual({ num: '15', den: '1' })
    await s.undo()
    expect(pocketDepth(s, 'pattern2_pocket')).toEqual({ num: '18', den: '1' })
    expect(pocketDepth(s)).toEqual({ num: '2', den: '1' })
  })
})

const regionOf = (s: DesignSetup, partId: string, id: string): Region => {
  const g = expectOk(partGeometryInput(s.d.doc, partId, region2d))
  const op = g.operations.find((o) => o.id === id)!
  if (op.kind !== 'pocket' || op.shape.contour.kind !== 'region') throw new Error('no region')
  return op.shape.contour.region
}

describe('a split part with a stacked pattern (P4 follow-up)', () => {
  it('each piece keeps both owned shapes; its lace lies within its grid cells less the margin', async () => {
    const s = await setup()
    await add(s, {
      lattice: 'square',
      cell: { kind: 'rectangle', length: '20', width: '20', cornerRadius: '2' },
      spacing: { gap: '4' },
      margin: '4',
      depth: '2',
    })
    await add(s, {
      on: 'pattern1_pocket.floor',
      lattice: 'hex',
      cell: { kind: 'circle', diameter: '2' },
      spacing: { gap: '1' },
      margin: '1',
      depth: '1',
    })
    const lace = regionArea(regionOf(s, s.partId, 'pattern2_pocket'))
    await s.run('design.split.set', {
      partId: s.partId,
      split: { lines: [{ axis: 'x', at: '50' }] },
    })
    const pieces = Object.values(s.d.doc.parts).filter(
      (p): p is PartDTO => p.derivedFrom?.partId === s.partId,
    )
    expect(pieces).toHaveLength(2)
    let sum = 0
    for (const p of pieces) {
      expect(p.shapes?.find((x) => x.id === 'pattern1_cells')?.pattern?.clip).toBeDefined()
      const upper = p.shapes?.find((x) => x.id === 'pattern2_cells')?.pattern
      expect(upper).toMatchObject({ floor: 'pattern1_cells' })
      expect(upper?.clip).toBeDefined()
      const r = checkPartFits(p, s.d.doc.snapshots[p.stock]!, 'test', region2d)
      expect(r.isOk() ? 'ok' : r.unwrapErr().issues, p.name).toBe('ok')
      const below = regionOf(s, p.id, 'pattern1_pocket')
      const cells = regionOf(s, p.id, 'pattern2_pocket')
      expect(cells.pieces.length).toBeGreaterThan(0)
      // within the piece's grid cells less the margin
      const shrunk = expectOk(region2d.offset(below, 1))
      expect(regionArea(expectOk(region2d.difference(cells, shrunk)))).toBeLessThan(1e-6)
      sum += regionArea(cells)
    }
    // the halves together cover the source's lace (they overlap at the seam)
    expect(sum).toBeGreaterThanOrEqual(lace - 1e-6)
    // a stock change regenerates the pieces from the followed source
    await restock(s, testStock('25'))
    const after = Object.values(s.d.doc.parts).filter((p) => p.derivedFrom?.partId === s.partId)
    expect(after).toHaveLength(2)
  })
})
