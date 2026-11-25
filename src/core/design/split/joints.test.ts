// Split parts 4d: finger joints (square fingers with T-bones) and half laps on split lines, and
// Detach. The finger generator's inside corners all take the outline tool; fingers and laps on the
// 600 × 400 panel (count, sizes, both pieces valid on their blanks, the lap pockets from the top
// and the bottom); `keyFit` for both; `lapCrossing`; Detach turns a piece into a plain part.
// Spec: docs/modes/split-parts.md#implementation-4d
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { regionArea, type Region } from '../../geometry/2d/model'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { checkPartFits } from '../../plan/validity'
import { designSetup, type DesignSetup } from '../design.fixture'
import type { PartDTO } from '../part.dto'
import { resolveShape, smallestInsideRadius } from '../shape'
import { loadPart } from '../load'
import { fingerLayout, keyItems, KEY_CLEARANCE_DEFAULT, type Key } from './keys'
import { lapLength } from './laps'
import type { Cell } from './layout'
import { planPieces } from './pieces'
import {
  ENCLOSURE_STOCK,
  enclosureCommands,
  PANEL_LINE,
  PANEL_STOCK,
  panelCommands,
} from './split.fixture'

const region2d = nodeRegion2d()

interface SplitResult {
  pieces: { partId: string; name: string; index: number; blank: number[] }[]
  findings: { severity: string; message: string; params: Record<string, unknown> }[]
}

async function setup(stock: object, commands: (id: string) => [string, object][]) {
  const s = await designSetup({ stock, services: { region2d } })
  for (const [name, args] of commands(s.partId)) await s.run(name, args)
  return s
}
const panel = () => setup(PANEL_STOCK, panelCommands)

const pieces = (s: DesignSetup): PartDTO[] =>
  Object.values(s.d.doc.parts)
    .filter((p) => p.derivedFrom?.partId === s.partId)
    .sort((a, b) => a.derivedFrom!.index - b.derivedFrom!.index)

const mm = (q: { exact: { num: string; den: string } }) =>
  Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))

const split = (s: DesignSetup, args: object) =>
  s.run('design.split.set', { partId: s.partId, split: args }) as Promise<SplitResult>

const byRule = (r: SplitResult, rule: string) => r.findings.filter((f) => f.params['rule'] === rule)

function region(items: Parameters<typeof resolveShape>[1]): Region {
  const r = expectOk(resolveShape(region2d, items))
  if (r.kind !== 'region') throw new Error('not a region')
  return r.region
}

const valid = (s: DesignSetup) => {
  for (const p of pieces(s)) {
    const fit = checkPartFits(p, s.d.doc.snapshots[p.stock]!, 'test', region2d)
    expect(fit.isOk() ? 'ok' : fit.unwrapErr().issues, p.name).toBe('ok')
  }
}

describe('finger generator (4d)', () => {
  it('lays out n fingers with a female finger at each end, else one of a third, else none', () => {
    const a = fingerLayout(6, 0.15, 18, 400)!
    // nominal 18 mm: ⌊(400 / 18 − 1) / 2⌋ = 10 fingers of 400 / 21
    expect(a.at).toHaveLength(10)
    expect(a.size.neck).toBeCloseTo(19.04, 2)
    expect(a.at[0]).toBeCloseTo(1.5 * a.size.neck + 0.08, 6)
    const b = fingerLayout(6, 0.15, 18, 40)!
    expect(b.at).toHaveLength(1)
    expect(b.size.neck).toBeCloseTo(13.33, 2)
    expect(fingerLayout(6, 0.15, 18, 20)).toBeUndefined()
  })

  it.each([3, 6, 6.35])('the outline tool Ø%s cuts every inside corner of both pieces', (tool) => {
    const c = KEY_CLEARANCE_DEFAULT
    const { size, at } = fingerLayout(tool, c, 18, 200)!
    const cell = {} as Cell
    const keys: Key[] = at.map((d) => ({
      axis: 'x',
      at: 100,
      u: d,
      male: cell,
      female: cell,
      size,
      clearance: c,
      height: 18,
    }))
    const cellM = {
      kind: 'rectangle' as const,
      op: 'add' as const,
      center: [50, 100] as [number, number],
      length: 100,
      width: 200,
      cornerRadius: 0,
    }
    const cellF = { ...cellM, center: [150, 100] as [number, number] }
    const male = region([cellM, ...keys.flatMap((k) => keyItems(k, 'male'))])
    const female = region([cellF, ...keys.flatMap((k) => keyItems(k, 'female'))])
    const around = (piece: Region) =>
      expectOk(
        region2d.difference(
          region([{ ...cellM, center: [100, 100], length: 400, width: 400, cornerRadius: 50 }]),
          piece,
        ),
      )
    expect(smallestInsideRadius(around(male)) ?? Infinity).toBeGreaterThanOrEqual(tool / 2 - 1e-6)
    expect(smallestInsideRadius(around(female)) ?? Infinity).toBeGreaterThanOrEqual(tool / 2 - 1e-6)
    // never overlapping; the fingers add to the male what the sockets take from the female
    expect(regionArea(expectOk(region2d.intersect(male, female)))).toBeLessThan(1e-3)
    expect(regionArea(male)).toBeGreaterThan(100 * 200 + 0.9 * at.length * size.neck * size.depth)
    expect(size.maxTool).toBeGreaterThanOrEqual(tool)
  })
})

describe('fingers and half laps on the 600 × 400 panel (4d)', () => {
  it('finger: fingers along the whole line, valid pieces, the male blank holds them', async () => {
    const s = await panel()
    const r = await split(s, { lines: [PANEL_LINE], joint: 'finger' })
    expect(r.pieces).toHaveLength(2)
    const loaded = expectOk(loadPart(s.d.doc, s.partId, 'test'))
    const planned = expectOk(planPieces(loaded, s.part().split!, region2d))
    expect(planned.keys.issues).toEqual([])
    expect(planned.keys.keys.length).toBe(10)
    expect(byRule(r, 'keyFit')).toEqual([])
    expect(byRule(r, 'thinJoint')).toEqual([])
    valid(s)
    const depth = planned.keys.keys[0]!.size.depth
    expect(r.pieces[0]!.blank[0]).toBeCloseTo(300 + depth + 10, 3)
    expect(mm(s.part().split!.joint.clearance!)).toBe(0.15)
  })

  it('half lap: the tongues and their pockets, the female cut from its bottom', async () => {
    const s = await panel()
    const r = await split(s, { lines: [PANEL_LINE], joint: 'halfLap' })
    expect(byRule(r, 'keyFit')).toEqual([])
    const loaded = expectOk(loadPart(s.d.doc, s.partId, 'test'))
    const planned = expectOk(planPieces(loaded, s.part().split!, region2d))
    expect(planned.laps).toHaveLength(1)
    const l = planned.laps[0]!
    expect(l.length).toBe(lapLength(6, 18)) // 36 mm: 2 × the panel's 18 mm
    expect(l.plane).toBeCloseTo(-9, 6)
    // the male reaches ℓ/2 past the line, the female ℓ/2 − c back
    expect(r.pieces[0]!.blank[0]).toBeCloseTo(300 + 18 + 10, 3)
    expect(r.pieces[1]!.blank[0]).toBeCloseTo(300 + 18 - 0.15 + 10, 3)
    const [male, female] = pieces(s)
    const lap = (p: PartDTO) =>
      p.operations.find((o) => o.id === 'split1_lap1') as Extract<
        PartDTO['operations'][number],
        { kind: 'pocket' }
      >
    expect(lap(male!)).toMatchObject({ kind: 'pocket', on: 'stock.top' })
    expect(lap(female!)).toMatchObject({ kind: 'pocket', on: 'stock.bottom' })
    expect(mm(lap(male!).depth)).toBeCloseTo(9, 6)
    expect(mm(lap(female!).depth)).toBeCloseTo(9, 6)
    // before the outline
    const ids = male!.operations.map((o) => o.id)
    expect(ids.indexOf('split1_lap1')).toBeLessThan(ids.indexOf('split1_outline'))
    valid(s)
  })

  it('half lap: refused with lines on both axes (lapCrossing)', async () => {
    const s = await panel()
    const e = await s.fail(
      'design.split.set',
      {
        partId: s.partId,
        split: { lines: [PANEL_LINE, { axis: 'y', at: '205' }], joint: 'halfLap' },
      },
      'model.invariant',
    )
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['split.joint', 'lapCrossing'],
    ])
  })
})

describe('fingers and half laps: findings (4d)', () => {
  it('the enclosure: no room for fingers or a lap in its 7 mm walls (keyFit, named)', async () => {
    const s = await setup(ENCLOSURE_STOCK, enclosureCommands)
    let r = await split(s, { lines: [{ axis: 'x', at: '125' }], joint: 'finger' })
    let fit = byRule(r, 'keyFit')
    expect(fit.length).toBeGreaterThan(0)
    expect(fit.every((f) => f.params['joint'] === 'finger')).toBe(true)
    expect(fit[0]!.message).toMatch(/finger/)
    r = await split(s, { lines: [{ axis: 'x', at: '125' }], joint: 'halfLap' })
    fit = byRule(r, 'keyFit')
    expect(fit.map((f) => [f.params['joint'], f.params['reason']])).toEqual([['halfLap', 'near']])
    expect(fit[0]!.message).toMatch(/^No half lap on x = 125 .*: a butt joint there$/)
    // a butt joint there: no lap pocket in either piece
    expect(
      pieces(s)
        .flatMap((p) => p.operations)
        .some((o) => o.id.includes('_lap')),
    ).toBe(false)
    valid(s)
  })

  it('a clearance needs a joint other than butt; halfLap and finger keep it', async () => {
    const s = await panel()
    await split(s, { lines: [PANEL_LINE], joint: 'halfLap', clearance: '0.3' })
    expect(mm(s.part().split!.joint.clearance!)).toBe(0.3)
    await split(s, { lines: [PANEL_LINE], joint: 'finger' })
    expect(mm(s.part().split!.joint.clearance!)).toBe(0.3)
    const e = await s.fail(
      'design.split.set',
      { partId: s.partId, split: { lines: [PANEL_LINE], clearance: '0.2' } },
      'model.invariant',
    )
    expect(e.issues[0]!.message).toBe('a clearance needs a keyed, finger or half-lap joint')
  })

  it('Test fit on fingers: one finger and two gaps, no keyFit', async () => {
    const s = await panel()
    await split(s, { lines: [PANEL_LINE], joint: 'finger' })
    const r = (await s.run('design.split.testFit', { partId: s.partId })) as {
      parts: { partId: string; neck: number }[]
    }
    expect(r.parts).toHaveLength(1)
    const coupon = s.d.doc.parts[r.parts[0]!.partId]!
    const loaded = expectOk(loadPart(s.d.doc, coupon.id, 'test'))
    const planned = expectOk(planPieces(loaded, coupon.split!, region2d))
    expect(planned.keys.keys).toHaveLength(1)
    expect(planned.keys.issues).toEqual([])
    expect(planned.keys.keys[0]!.size.neck).toBeGreaterThanOrEqual(18)
  })
})

describe('Detach (4d)', () => {
  it('turns a piece into a plain part; the source no longer makes it; undo brings it back', async () => {
    const s = await panel()
    await split(s, { lines: [PANEL_LINE], joint: 'finger' })
    const [first, second] = pieces(s)
    await s.run('plan.create', { partId: second!.id })
    await s.run('design.part.update', { partId: second!.id, detach: true })
    const part = s.d.doc.parts[second!.id]!
    expect(part.derivedFrom).toBeUndefined()
    expect(part.offset).toBeUndefined()
    expect(part.name).toBe(second!.name)
    expect(part.operations.map((o) => o.id)).toEqual(second!.operations.map((o) => o.id))
    expect(s.part().split!.detached).toEqual([2])
    expect(pieces(s).map((p) => p.id)).toEqual([first!.id])
    // its plan stays; it is editable like any part
    expect(Object.values(s.d.doc.plans).some((p) => p.design.partId === second!.id)).toBe(true)
    await s.run('design.part.update', { partId: second!.id, name: 'Right half' })
    // a source edit regenerates the remaining piece only
    await s.run('design.drilling.add', {
      partId: s.partId,
      center: ['100', '100'],
      diameter: '8',
      bottom: 'through',
    })
    expect(pieces(s).map((p) => p.id)).toEqual([first!.id])
    expect(s.d.doc.parts[second!.id]!.derivedFrom).toBeUndefined()
    // the margin keeps it detached; new lines drop it and the cell makes a piece again
    await split(s, { lines: [PANEL_LINE], joint: 'finger', margin: '6' })
    expect(s.part().split!.detached).toEqual([2])
    await split(s, { lines: [{ axis: 'x', at: '300' }], joint: 'finger' })
    expect(s.part().split!.detached).toBeUndefined()
    expect(pieces(s)).toHaveLength(2)
    expect(s.d.doc.parts[second!.id]!.name).toBe('Right half')
    // undo back to before the detach: the piece again
    for (let i = 0; i < 5; i++) await s.undo()
    expect(s.d.doc.parts[second!.id]!.derivedFrom?.index).toBe(2)
    expect(s.part().split!.detached).toBeUndefined()
  })

  it('a plain part refuses Detach (pieceOnly)', async () => {
    const s = await panel()
    const e = await s.fail(
      'design.part.update',
      { partId: s.partId, detach: true },
      'input.malformed',
    )
    expect(e.issues.map((i) => i.rule)).toEqual(['pieceOnly'])
  })
})
