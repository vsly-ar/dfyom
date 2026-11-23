// Records parsed once (hardening P5): memos keyed by a committed document's frozen records, and
// what a design command reuses through them (unchanged operations load to the same model and are
// written back as the same record; the Clones follow hook leaves an unrelated edit alone).
// Doc: docs/architecture/shapes.md#design-commands-p5
import { createDraft, finishDraft, freeze } from 'immer'
import { describe, expect, it } from 'vitest'
import { baseOf, memoByRecord } from './frozen-memo'
import { designSetup } from './design.fixture'
import { loadPart } from './load'
import { recordOf } from './operation'

describe('memoByRecord', () => {
  it('computes a frozen record once and other records every time', () => {
    let calls = 0
    const f = memoByRecord((r: { n: number }) => ({ n: r.n, call: ++calls }))
    const frozen = freeze({ n: 1 })
    expect(f(frozen)).toBe(f(frozen))
    expect(calls).toBe(1)
    const open = { n: 2 }
    expect(f(open)).not.toBe(f(open))
    expect(calls).toBe(3)
  })

  it("reads a draft's unmodified record as its frozen base, a modified one as a copy", () => {
    let calls = 0
    const f = memoByRecord((r: { n: number }) => ({ n: r.n, call: ++calls }))
    const doc = freeze({ a: { n: 1 }, b: { n: 2 } }, true)
    const first = f(doc.a)
    const draft = createDraft(doc)
    draft.b.n = 3
    expect(baseOf(draft.a)).toBe(doc.a)
    expect(f(draft.a)).toBe(first)
    expect(baseOf(draft.b)).toEqual({ n: 3 })
    expect(f(draft.b).n).toBe(3)
    finishDraft(draft)
    expect(calls).toBe(2)
  })
})

describe('design commands reuse unchanged records', () => {
  async function part() {
    const s = await designSetup()
    await s.run('design.facing.add', { partId: s.partId, depth: '0.5' })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['20', '20'], diameter: '10' },
      depth: '3',
    })
    await s.run('design.drilling.add', {
      partId: s.partId,
      on: 'pocket1.floor',
      center: ['20', '20'],
      diameter: '5',
    })
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['pocket1', 'drill1'] },
      rows: [{ kind: 'offset', count: 2, du: '20', dv: '0' }],
    })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'rectangle', center: ['80', '45'], length: '10', width: '10' },
      depth: '2',
    })
    return s
  }

  it('loads an unchanged operation to the same model, which writes back as its record', async () => {
    const s = await part()
    const a = loadPart(s.d.doc, s.partId, 'test').unwrap()
    const b = loadPart(s.d.doc, s.partId, 'test').unwrap()
    expect(b.part.operations).toHaveLength(8)
    b.part.operations.forEach((op, i) => {
      expect(op).toBe(a.part.operations[i])
      expect(recordOf(op)).toBe(s.part().operations[i])
    })
  })

  it('an edit after the Clones keeps every other record and the Clones block as they were', async () => {
    const s = await part()
    const before = s.part()
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket2', depth: '2.5' })
    const after = s.part()
    expect(after.operations.map((o) => o.id)).toEqual(before.operations.map((o) => o.id))
    after.operations.forEach((o, i) => {
      if (o.id === 'pocket2') expect(o).not.toBe(before.operations[i])
      else expect(o).toBe(before.operations[i])
    })
    expect(after.features).toBe(before.features)
  })

  it('a source edit still moves its instances (the follow hook is not skipped)', async () => {
    const s = await part()
    const before = s.part()
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '4' })
    const after = s.part()
    const depth = (id: string) =>
      (after.operations.find((o) => o.id === id) as { depth: { source: string } }).depth.source
    expect(['pocket1', 'clones1_2_pocket1', 'clones1_3_pocket1'].map(depth)).toEqual([
      '4',
      '4',
      '4',
    ])
    expect(after.operations.find((o) => o.id === 'pocket2')).toBe(
      before.operations.find((o) => o.id === 'pocket2'),
    )
  })
})
