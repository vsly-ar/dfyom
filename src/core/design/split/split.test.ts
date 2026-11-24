// Split parts 4a: design.split.set on the enclosure (a level; the level and two lines), pieces as
// derived parts regenerated in the same command as a source edit, read-only pieces, removing
// pieces with plans, and the split's findings.
// Spec: docs/modes/split-parts.md#model, docs/modes/split-parts.md#dfm-near-a-split
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { uiSource } from '../../commands/testing'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { checkPartFits } from '../../plan/validity'
import { designSetup, type DesignSetup } from '../design.fixture'
import type { PartDTO } from '../part.dto'
import { ENCLOSURE_LEVEL, ENCLOSURE_STOCK, enclosureCommands } from './split.fixture'

const region2d = nodeRegion2d()

interface SplitResult {
  pieces: { partId: string; name: string; index: number; blank: number[] }[]
  removedPlans: string[]
  findings: { severity: string; message: string; params: { rule: string } }[]
}

async function enclosure(): Promise<DesignSetup> {
  const s = await designSetup({ stock: ENCLOSURE_STOCK, services: { region2d } })
  for (const [name, args] of enclosureCommands(s.partId)) await s.run(name, args)
  return s
}

const pieces = (s: DesignSetup): PartDTO[] =>
  Object.values(s.d.doc.parts)
    .filter((p) => p.derivedFrom?.partId === s.partId)
    .sort((a, b) => a.derivedFrom!.index - b.derivedFrom!.index)

const mm = (q: { exact: { num: string; den: string } }) =>
  Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))

const rules = (r: SplitResult) => r.findings.map((f) => f.params.rule)

/** Every piece is a valid part on its blank (what a plan checks, `stockFit`). */
function expectValidPieces(s: DesignSetup): void {
  for (const p of pieces(s)) {
    const r = checkPartFits(p, s.d.doc.snapshots[p.stock]!, 'test', region2d)
    expect(r.isOk() ? 'ok' : r.unwrapErr().issues, p.name).toBe('ok')
  }
}

describe('design.split.set (4a)', () => {
  it('splits the enclosure by one level: a tray and a ring, each in its own blank', async () => {
    const s = await enclosure()
    const r = (await s.run('design.split.set', {
      partId: s.partId,
      split: { levels: [ENCLOSURE_LEVEL] },
    })) as SplitResult
    expect(r.pieces.map((p) => [p.name, p.index, p.blank])).toEqual([
      ['Bracket · 1', 1, [259.5, 187, 40]],
      ['Bracket · 2', 2, [259.5, 187, 40]],
    ])
    const [tray, ring] = pieces(s)
    expect(tray!.derivedFrom).toEqual({ partId: s.partId, splitId: 'split1', index: 1 })
    expect(tray!.offset!.map(mm)).toEqual([4.75, -6.5, 40])
    expect(ring!.offset!.map(mm)).toEqual([4.75, -6.5, 0])
    // the tray: the bottom facing, the cavity from its top (26.03 deep), the outline
    expect(tray!.operations.map((o) => o.id)).toEqual(['facing1', 'pocket1', 'split1_outline'])
    const cavity = tray!.operations[1] as Extract<PartDTO['operations'][number], { kind: 'pocket' }>
    expect(cavity.on).toBe('stock.top')
    expect(mm(cavity.depth)).toBeCloseTo(26.028, 6)
    // the ring: the top facing, the cavity through, the four holes, the outline
    expect(ring!.operations.map((o) => o.id)).toEqual([
      'facing2',
      'pocket1',
      'drill1',
      'drill2',
      'drill3',
      'drill4',
      'split1_outline',
    ])
    // through the ring: an inside profile (a pocket must end above the stock bottom)
    expect(ring!.operations[1]).toMatchObject({
      kind: 'profile',
      side: 'inside',
      on: 'stock.top',
      shape: { kind: 'rectangle' },
    })
    expect(ring!.operations[1]).not.toHaveProperty('depth')
    expect(s.d.doc.snapshots[ring!.stock]).toMatchObject({
      kind: 'stock',
      values: { name: 'Blank 259.5 × 187 × 40', material: { class: 'hardwood' } },
    })
    expect(rules(r)).not.toContain('noOutline')
    expectValidPieces(s)
    // one undo step removes split and pieces
    await s.undo()
    expect(pieces(s)).toEqual([])
    expect(s.part().split).toBeUndefined()
  })

  it('splits by the level and two lines into 8 pieces; thin joints on the lines', async () => {
    const s = await enclosure()
    const r = (await s.run('design.split.set', {
      partId: s.partId,
      split: {
        levels: [ENCLOSURE_LEVEL],
        lines: [
          { axis: 'x', at: '125' },
          { axis: 'y', at: '100' },
        ],
      },
    })) as SplitResult
    expect(r.pieces).toHaveLength(8)
    expectValidPieces(s)
    expect(r.pieces[0]!.blank).toEqual([134.75, 98.5, 40])
    expect(rules(r).filter((x) => x === 'thinJoint')).toHaveLength(3)
    // pieces with a cavity corner get a clipped cavity as their own named shape
    const first = pieces(s)[0]!
    const cavity = first.operations.find((o) => o.id === 'pocket1')!
    expect(cavity).toMatchObject({ shape: { kind: 'named' } })
    expect(first.shapes?.at(-1)?.items.at(-1)).toMatchObject({ kind: 'rectangle', op: 'intersect' })
  })

  it('pieces follow a source edit in the same command (one undo step)', async () => {
    const s = await enclosure()
    await s.run('design.split.set', { partId: s.partId, split: { levels: [ENCLOSURE_LEVEL] } })
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '50' })
    const cavity = pieces(s)[0]!.operations.find((o) => o.id === 'pocket1') as unknown as {
      depth: never
    }
    expect(mm(cavity.depth)).toBeCloseTo(50 - 30.262, 6)
    await s.undo()
    const back = pieces(s)[0]!.operations.find((o) => o.id === 'pocket1') as unknown as {
      depth: never
    }
    expect(mm(back.depth)).toBeCloseTo(26.028, 6)
  })

  it('pieces are read-only: operation edits fail with derivedPart, renames are kept', async () => {
    const s = await enclosure()
    await s.run('design.split.set', { partId: s.partId, split: { levels: [ENCLOSURE_LEVEL] } })
    const [tray, ring] = pieces(s)
    const e = await s.fail(
      'design.pocket.update',
      { partId: tray!.id, operationId: 'pocket1', depth: '3' },
      'model.invariant',
    )
    expect(e.issues[0]).toMatchObject({ rule: 'derivedPart' })
    expect(e.message).toMatch(/Pocket 1 belongs to Bracket · 1; it is derived from Bracket/)
    await s.run('design.part.update', { partId: ring!.id, name: 'Ring' })
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '50' })
    expect(pieces(s)[1]!.name).toBe('Ring')
    expect(pieces(s)[0]!.name).toBe('Bracket · 1')
  })

  it('removing a piece with plans asks for confirm; null removes the split', async () => {
    const s = await enclosure()
    await s.run('design.split.set', { partId: s.partId, split: { levels: [ENCLOSURE_LEVEL] } })
    await s.run('library.machine.add', {
      values: {
        name: 'Router',
        controller: 'grbl',
        travel: { x: '800', y: '800', z: '100' },
        maxFeedRate: { x: '5000', y: '5000', z: '1000' },
        spindle: { control: 'manual', maxSpeed: '24000' },
        programUnits: 'mm',
        toolChanger: 'none',
      },
    })
    const ring = pieces(s)[1]!
    const { planId } = (await s.run('plan.create', { partId: ring.id })) as { planId: string }
    const e = await s.fail('design.split.set', { partId: s.partId, split: null }, 'input.malformed')
    expect(e.issues[0]).toMatchObject({ rule: 'pieceHasPlans' })
    const r = (await s.run('design.split.set', {
      partId: s.partId,
      split: null,
      confirm: true,
    })) as SplitResult
    expect(r.removedPlans).toEqual([planId])
    expect(pieces(s)).toEqual([])
    expect(s.d.doc.snapshots[ring.stock]).toBeUndefined()
  })

  it('refuses lines and levels outside the stock and splitting a piece', async () => {
    const s = await enclosure()
    const e = await s.fail(
      'design.split.set',
      { partId: s.partId, split: { levels: ['-90'], lines: [{ axis: 'x', at: '0' }] } },
      'model.invariant',
    )
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['split.lines.0.at', 'range'],
      ['split.levels.0', 'range'],
    ])
    await s.run('design.split.set', { partId: s.partId, split: { levels: [ENCLOSURE_LEVEL] } })
    const p = pieces(s)[0]!
    const d = await s.fail(
      'design.split.set',
      { partId: p.id, split: { levels: ['-10'] } },
      'model.invariant',
    )
    expect(d.issues[0]).toMatchObject({ rule: 'derivedPart' })
  })

  it('without an outline: noOutline and pieces cut along the stock edges', async () => {
    const s = await enclosure()
    await s.run('design.operation.remove', { partId: s.partId, operationId: 'profile1' })
    const r = (await s.run('design.split.set', {
      partId: s.partId,
      split: { levels: [ENCLOSURE_LEVEL] },
    })) as SplitResult
    expect(rules(r)).toContain('noOutline')
    expect(r.pieces[0]!.blank).toEqual([260, 210, 40])
  })

  it('removing the source removes its pieces; a piece alone is not removed', async () => {
    const s = await enclosure()
    await s.run('design.split.set', { partId: s.partId, split: { levels: [ENCLOSURE_LEVEL] } })
    const [tray] = pieces(s)
    const e = await s.fail('design.part.remove', { partId: tray!.id }, 'model.invariant')
    expect(e.issues[0]).toMatchObject({ rule: 'derivedPart' })
    await s.run('design.part.add', { name: 'Other', stock: ENCLOSURE_STOCK })
    await s.run('design.part.remove', { partId: s.partId })
    expect(Object.values(s.d.doc.parts).map((p) => p.name)).toEqual(['Other'])
    expect(s.d.doc.snapshots[tray!.stock]).toBeUndefined()
  })

  it('design.warning.list carries the split findings', async () => {
    const s = await enclosure()
    await s.run('design.split.set', {
      partId: s.partId,
      split: { levels: [ENCLOSURE_LEVEL], lines: [{ axis: 'x', at: '50' }] },
    })
    const r = expectOk(s.d.query('design.warning.list', { partId: s.partId }, uiSource()))
      .value as {
      warnings: { code: string; params: { rule?: string } }[]
    }
    const split = r.warnings.filter((w) => w.code === 'design.split').map((w) => w.params.rule)
    // x = 50 runs within 2 × Ø of the rim hole at x = 44.5
    expect(split).toContain('featureNear')
  })
})
