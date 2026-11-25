// Split parts 4b-3: the Test fit coupon. From the 600 × 400 panel's puzzle split, a coupon part
// (an ordinary split source) whose one line carries the panel's key at the coupon's clearance,
// both pieces valid on their blanks; several clearances; a shrunk key keeps its neck; the nominal
// key when none fits yet; one undo step; the refusals.
// Spec: docs/modes/split-parts.md#implementation-4b
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { checkPartFits } from '../../plan/validity'
import { designSetup, type DesignSetup } from '../design.fixture'
import { loadPart } from '../load'
import type { PartDTO } from '../part.dto'
import { keySize } from './keys'
import { splitKeys } from './pieces'
import {
  ENCLOSURE_LEVEL,
  ENCLOSURE_STOCK,
  enclosureCommands,
  PANEL_LINE,
  PANEL_STOCK,
  panelCommands,
} from './split.fixture'
import { couponName, couponSize } from './test-fit'

const region2d = nodeRegion2d()

interface TestFitResult {
  parts: {
    partId: string
    name: string
    clearance: number
    size: number[]
    neck: number
    pieces: { partId: string; name: string; index: number; blank: number[] }[]
  }[]
}

async function setup(stock: object, commands: (id: string) => [string, object][]) {
  const s = await designSetup({ stock, services: { region2d } })
  for (const [name, args] of commands(s.partId)) await s.run(name, args)
  return s
}

const mm = (q: { exact: { num: string; den: string } }) =>
  Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))

const testFit = (s: DesignSetup, args: object = {}) =>
  s.run('design.split.testFit', { partId: s.partId, ...args }) as Promise<TestFitResult>

/** The keys a part's split places now. */
const keysOf = (s: DesignSetup, partId: string) => {
  const part = s.d.doc.parts[partId]!
  const loaded = expectOk(loadPart(s.d.doc, partId, 'test'))
  return expectOk(splitKeys(loaded, part.split!, region2d)).keys
}

const piecesOf = (s: DesignSetup, partId: string): PartDTO[] =>
  Object.values(s.d.doc.parts).filter((p) => p.derivedFrom?.partId === partId)

describe('Test fit coupon (4b-3)', () => {
  it.each(['puzzle', 'dovetail'] as const)(
    '%s: a coupon part with the panel key, two valid pieces',
    async (kind) => {
      const s = await setup(PANEL_STOCK, panelCommands)
      await s.run('design.split.set', {
        partId: s.partId,
        split: { lines: [PANEL_LINE], joint: kind },
      })
      const source = keysOf(s, s.partId).keys[0]!
      const r = await testFit(s)
      expect(r.parts).toHaveLength(1)
      const c = r.parts[0]!
      expect(c.name).toBe('Bracket · test fit 0.15 mm')
      expect(c.clearance).toBe(0.15)
      expect(c.pieces).toHaveLength(2)
      const coupon = s.d.doc.parts[c.partId]!
      // an ordinary split source: one outline, the source's key kind and clearance
      expect(coupon.derivedFrom).toBeUndefined()
      expect(coupon.operations.map((o) => o.kind)).toEqual(['profile'])
      expect(coupon.split!.joint.kind).toBe(kind)
      expect(mm(coupon.split!.joint.clearance!)).toBe(0.15)
      // the same key as the panel's: one key on the coupon's line, the same neck and depth
      const keys = keysOf(s, c.partId)
      expect(keys.issues).toEqual([])
      expect(keys.keys).toHaveLength(1)
      expect(keys.keys[0]!.size.neck).toBeCloseTo(source.size.neck, 6)
      expect(keys.keys[0]!.size.depth).toBeCloseTo(source.size.depth, 6)
      expect(c.neck).toBeCloseTo(source.size.neck, 6)
      // the panel's thickness; small next to the panel
      expect(c.size[2]).toBe(18)
      // the panel's puzzle key: a 90 × 100 mm outline (split-parts.md § Implementation (4b))
      if (kind === 'puzzle') expect(c.size).toEqual([100, 110, 18])
      expect(c.size[0]! * c.size[1]!).toBeLessThan(120 * 120)
      for (const p of piecesOf(s, c.partId)) {
        const fit = checkPartFits(p, s.d.doc.snapshots[p.stock]!, 'test', region2d)
        expect(fit.isOk() ? 'ok' : fit.unwrapErr().issues, p.name).toBe('ok')
        expect(p.shapes?.some((x) => x.items.some((i) => i.kind === 'path'))).toBe(true)
      }
      // the coupon's block keeps the panel's material, not its library link
      const block = s.d.doc.snapshots[coupon.stock]!
      expect(block.values.name).toMatch(/^Coupon /)
      expect((block as { libraryItemId?: string }).libraryItemId).toBeUndefined()
    },
  )

  it('makes one coupon per clearance, side by side; one undo step', async () => {
    const s = await setup(PANEL_STOCK, panelCommands)
    await s.run('design.split.set', {
      partId: s.partId,
      split: { lines: [PANEL_LINE], joint: 'puzzle', clearance: '0.2' },
    })
    const parts = Object.keys(s.d.doc.parts).length
    const r = await testFit(s, { clearances: ['0.1', '0.15', '0.25 mm'] })
    expect(r.parts.map((p) => p.clearance)).toEqual([0.1, 0.15, 0.25])
    expect(r.parts.map((p) => p.name)).toEqual([
      'Bracket · test fit 0.1 mm',
      'Bracket · test fit 0.15 mm',
      'Bracket · test fit 0.25 mm',
    ])
    for (const p of r.parts) {
      const keys = keysOf(s, p.partId)
      expect(keys.keys.map((k) => k.clearance)).toEqual([p.clearance])
    }
    // the source keeps its own clearance: the user changes it after the fit
    expect(mm(s.part().split!.joint.clearance!)).toBe(0.2)
    expect(Object.keys(s.d.doc.parts)).toHaveLength(parts + 9)
    await s.undo()
    expect(Object.keys(s.d.doc.parts)).toHaveLength(parts)
  })

  it('keeps a shrunk key on the source shrunk on the coupon', async () => {
    // an 80 mm block: the key shrinks below the 18 mm neck (keys.test.ts)
    const s = await setup({ ...PANEL_STOCK, length: '100', width: '80', thickness: '10' }, () => [])
    await s.run('design.split.set', {
      partId: s.partId,
      split: { lines: [{ axis: 'x', at: '50' }], joint: 'dovetail' },
    })
    const source = keysOf(s, s.partId).keys[0]!
    expect(source.size.neck).toBeLessThan(keySize('dovetail', 6, 0.15, 10, Infinity)!.neck)
    const r = await testFit(s)
    const keys = keysOf(s, r.parts[0]!.partId)
    expect(keys.keys).toHaveLength(1)
    expect(keys.keys[0]!.size.neck).toBeCloseTo(source.size.neck, 1)
  })

  it('without a key on the source yet: the nominal key (the enclosure)', async () => {
    const s = await setup(ENCLOSURE_STOCK, enclosureCommands)
    await s.run('design.split.set', {
      partId: s.partId,
      split: { levels: [ENCLOSURE_LEVEL], lines: [{ axis: 'y', at: '100' }], joint: 'puzzle' },
    })
    expect(keysOf(s, s.partId).keys).toEqual([])
    const r = await testFit(s)
    const c = r.parts[0]!
    // the band between the facings and the level: 30.262 mm
    expect(c.size[2]).toBeCloseTo(30.262, 3)
    const keys = keysOf(s, c.partId)
    expect(keys.keys).toHaveLength(1)
    expect(keys.keys[0]!.axis).toBe('y')
    expect(keys.keys[0]!.size.neck).toBeCloseTo(keySize('puzzle', 6, 0.15, 30.262, Infinity)!.neck)
  })

  it('refuses a split without keys, a piece and a clearance out of range', async () => {
    const s = await setup(PANEL_STOCK, panelCommands)
    const none = await s.fail('design.split.testFit', { partId: s.partId }, 'model.invariant')
    expect(none.issues.map((i) => i.rule)).toEqual(['keysOnly'])
    await s.run('design.split.set', { partId: s.partId, split: { lines: [PANEL_LINE] } })
    const butt = await s.fail('design.split.testFit', { partId: s.partId }, 'model.invariant')
    expect(butt.issues.map((i) => i.rule)).toEqual(['keysOnly'])
    await s.run('design.split.set', {
      partId: s.partId,
      split: { lines: [PANEL_LINE], joint: 'puzzle' },
    })
    const range = await s.fail(
      'design.split.testFit',
      { partId: s.partId, clearances: ['0.1', '1.5'] },
      'model.invariant',
    )
    expect(range.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([['clearances.1', 'range']])
    const piece = piecesOf(s, s.partId)[0]!
    const derived = await s.fail('design.split.testFit', { partId: piece.id }, 'model.invariant')
    expect(derived.issues.map((i) => i.rule)).toEqual(['derivedPart'])
  })
})

describe('coupon sizing (4b-3)', () => {
  it('holds the nominal key unshrunk with room for its depth and a wall', () => {
    const c = couponSize('puzzle', 6, 0.15, 18, undefined)
    expect(c.key.neck).toBe(18)
    expect(c.along).toBeGreaterThanOrEqual(6 * c.key.half)
    expect(c.along % 5).toBe(0)
    expect(c.side).toBeGreaterThanOrEqual(c.key.depth + 0.15 + 6 + 2)
  })

  it('cuts the name to fit', () => {
    expect(couponName('x'.repeat(200), '0.15 mm')).toHaveLength(120)
    expect(couponName('Panel', '0.15 mm')).toBe('Panel · test fit 0.15 mm')
  })
})
