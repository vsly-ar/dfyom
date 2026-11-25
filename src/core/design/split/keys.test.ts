// Split parts 4b-2: puzzle and dovetail keys on split lines. The generator's geometry (the socket
// is the knob offset by the clearance, the knob's and the socket's inside corners take the outline
// tool), the keys on the 600 × 400 panel (count, size, placement clear of features, both pieces
// valid on their blanks), the clearance kept and validated, and `keyFit` / `thinJoint`.
// Spec: docs/modes/split-parts.md#implementation-4b
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { regionArea, regionLoops, type Region } from '../../geometry/2d/model'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { checkPartFits } from '../../plan/validity'
import { designSetup, type DesignSetup } from '../design.fixture'
import type { PartDTO } from '../part.dto'
import { resolveShape, smallestInsideRadius } from '../shape'
import { loadPart } from '../load'
import { keyItem, keySize, KEY_CLEARANCE_DEFAULT, type Key, type KeyKind } from './keys'
import type { Cell } from './layout'
import { planPieces } from './pieces'
import {
  ENCLOSURE_LEVEL,
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

const area = regionArea

/** A key on the line x = 100 between two 200 × 200 cells, centred at y = 100. */
function testKey(kind: KeyKind, tool: number, c: number, axis: 'x' | 'y' = 'x'): Key {
  const size = keySize(kind, tool, c, 18, 400)!
  const cell = {} as Cell
  return { axis, at: 100, u: 100, male: cell, female: cell, size, clearance: c, height: 18 }
}

describe('key generator (4b-2)', () => {
  it.each([
    ['puzzle', 'x'],
    ['dovetail', 'x'],
    ['puzzle', 'y'],
    ['dovetail', 'y'],
  ] as const)('%s on %s: the socket is the knob grown by the clearance', (kind, axis) => {
    const c = 0.15
    const key = testKey(kind, 6, c, axis)
    const male = region([keyItem(key, 'male')])
    const female = region([{ ...keyItem(key, 'female'), op: 'add' }])
    // the knob sits inside the socket; the gap is the clearance band, nowhere wider
    expect(area(expectOk(region2d.difference(male, female)))).toBeLessThan(1e-3)
    const grown = expectOk(region2d.offset(male, -(c + 1e-3)))
    expect(area(expectOk(region2d.difference(female, grown)))).toBeLessThan(1e-3)
    // and the band is there: the socket's boundary, away from the line, keeps c from the knob
    const knobLoops = regionLoops(male)
    let far = 0
    for (const loop of regionLoops(female)) {
      const len = region2d.length(loop)
      for (let s = 0; s < len; s += 0.5) {
        const p = expectOk(region2d.pointAt(loop, s, true)).point
        const w = axis === 'x' ? p[0] - 100 : p[1] - 100
        if (w < key.size.fillet + 0.5) continue
        const d = region2d.distance(knobLoops, p)!.distance
        expect(d).toBeGreaterThan(c - 0.005)
        expect(d).toBeLessThan(c / Math.cos((10 * Math.PI) / 180) + 0.005)
        far++
      }
    }
    expect(far).toBeGreaterThan(20)
  })

  it.each(['puzzle', 'dovetail'] as const)(
    '%s: the outline tool cuts every inside corner of both pieces',
    (kind) => {
      for (const tool of [3, 6, 6.35]) {
        const key = testKey(kind, tool, KEY_CLEARANCE_DEFAULT)
        const cellM = {
          kind: 'rectangle' as const,
          op: 'add' as const,
          center: [50, 100] as [number, number],
          length: 100,
          width: 200,
          cornerRadius: 0,
        }
        const cellF = { ...cellM, center: [150, 100] as [number, number] }
        const male = region([cellM, keyItem(key, 'male')])
        const female = region([cellF, keyItem(key, 'female')])
        // an outside profile rounds a piece's inside corners to the tool radius: they are the
        // inside corners of the waste around it (a pocket with round corners holding the piece)
        const around = (piece: Region) =>
          expectOk(
            region2d.difference(
              region([{ ...cellM, center: [100, 100], length: 400, width: 400, cornerRadius: 50 }]),
              piece,
            ),
          )
        expect(smallestInsideRadius(around(male)) ?? Infinity).toBeGreaterThanOrEqual(
          tool / 2 - 1e-6,
        )
        expect(smallestInsideRadius(around(female)) ?? Infinity).toBeGreaterThanOrEqual(
          tool / 2 - 1e-6,
        )
        // the socket's neck lets the tool in; the key says which tool it needs
        expect(key.size.neck + 2 * KEY_CLEARANCE_DEFAULT).toBeGreaterThan(tool)
        expect(key.size.maxTool).toBeGreaterThanOrEqual(tool)
        // the knob is one bump on the male piece: its area grows by the knob
        expect(area(male)).toBeGreaterThan(100 * 200 + 0.5 * key.size.neck * key.size.depth)
      }
    },
  )

  it('sizes keys from the tool and the thickness, shrinks them to fit, else none', () => {
    const big = keySize('puzzle', 6, 0.15, 18, 400)!
    expect(big.neck).toBe(18) // 3 × the tool Ø
    expect(keySize('puzzle', 6, 0.15, 60, 400)!.neck).toBe(30) // half the thickness
    const small = keySize('puzzle', 6, 0.15, 18, 90)!
    expect(small.neck).toBeLessThan(18)
    expect(small.neck).toBeGreaterThanOrEqual(8)
    expect(keySize('puzzle', 6, 0.15, 18, 30)).toBeUndefined()
  })
})

describe('keys on the 600 × 400 panel (4b-2)', () => {
  it.each(['puzzle', 'dovetail'] as const)(
    '%s: two keys on the line, valid pieces',
    async (kind) => {
      const s = await panel()
      const r = await split(s, { lines: [PANEL_LINE], joint: kind })
      expect(r.pieces).toHaveLength(2)
      expect(mm(s.part().split!.joint.clearance!)).toBe(0.15)
      const loaded = expectOk(loadPart(s.d.doc, s.partId, 'test'))
      const planned = expectOk(planPieces(loaded, s.part().split!, region2d))
      expect(planned.keys.keys.map((k) => k.u)).toEqual([105, 305])
      expect(planned.keys.issues).toEqual([])
      expect(byRule(r, 'keyFit')).toEqual([])
      expect(byRule(r, 'thinJoint')).toEqual([])
      for (const p of pieces(s)) {
        const fit = checkPartFits(p, s.d.doc.snapshots[p.stock]!, 'test', region2d)
        expect(fit.isOk() ? 'ok' : fit.unwrapErr().issues, p.name).toBe('ok')
      }
      // the male piece's blank holds its knobs
      const depth = planned.keys.keys[0]!.size.depth
      expect(r.pieces[0]!.blank[0]).toBeCloseTo(300 + depth + 10, 3)
      expect(r.pieces[1]!.blank[0]).toBe(310)
    },
  )
})

describe('keys: findings and args (4b-2)', () => {
  it('reports keyFit where the cavity leaves no room for a key (the enclosure)', async () => {
    const s = await setup(ENCLOSURE_STOCK, enclosureCommands)
    const r = await split(s, {
      levels: [ENCLOSURE_LEVEL],
      lines: [{ axis: 'x', at: '125' }],
      joint: 'puzzle',
    })
    const fits = byRule(r, 'keyFit')
    // one per pair of pieces across the line (below and above the level)
    expect(fits.map((f) => [f.params['reason'], f.params['axis'], f.params['at']])).toEqual([
      ['near', 'x', 125],
      ['near', 'x', 125],
    ])
    // no key: the pieces keep the butt outline (four straight sides)
    for (const p of pieces(s))
      expect(p.shapes?.some((x) => x.items.some((i) => i.kind === 'path'))).toBeFalsy()
  })

  it('without an outline: a keyed rectangle; a short run shrinks the key (thinJoint), else keyFit', async () => {
    const block = (width: string) => ({ ...PANEL_STOCK, length: '100', width, thickness: '10' })
    // 80 mm: the key shrinks below the 18 mm neck of a 6 mm tool
    let s = await setup(block('80'), () => [])
    let r = await split(s, { lines: [{ axis: 'x', at: '50' }], joint: 'dovetail' })
    const thin = byRule(r, 'thinJoint').filter((f) => f.params['what'] === 'keyNeck')
    expect(thin).toHaveLength(1)
    expect(thin[0]!.params['width'] as number).toBeLessThan(18)
    for (const p of pieces(s)) {
      const fit = checkPartFits(p, s.d.doc.snapshots[p.stock]!, 'test', region2d)
      expect(fit.isOk() ? 'ok' : fit.unwrapErr().issues, p.name).toBe('ok')
    }
    // 50 mm: a key fits only a smaller tool; 15 mm: none at all
    s = await setup(block('50'), () => [])
    r = await split(s, { lines: [{ axis: 'x', at: '50' }], joint: 'puzzle' })
    const tool = byRule(r, 'keyFit')
    expect(tool.map((f) => f.params['reason'])).toEqual(['tool'])
    expect(tool[0]!.params['maxTool'] as number).toBeLessThan(6)
    expect(tool[0]!.message).toMatch(/Ø\d/)
    s = await setup(block('15'), () => [])
    r = await split(s, { lines: [{ axis: 'x', at: '50' }], joint: 'puzzle' })
    expect(byRule(r, 'keyFit').map((f) => f.params['reason'])).toEqual(['short'])
  })

  it('keeps the clearance across edits and validates it', async () => {
    const s = await panel()
    await split(s, { lines: [PANEL_LINE], joint: 'puzzle', clearance: '0.3' })
    expect(mm(s.part().split!.joint.clearance!)).toBe(0.3)
    // a later edit without the clearance keeps it
    await split(s, { lines: [{ axis: 'x', at: '300' }], joint: 'puzzle' })
    expect(mm(s.part().split!.joint.clearance!)).toBe(0.3)
    const loaded = expectOk(loadPart(s.d.doc, s.partId, 'test'))
    const planned = expectOk(planPieces(loaded, s.part().split!, region2d))
    expect(planned.keys.keys.every((k) => k.clearance === 0.3)).toBe(true)
    // butt drops it
    await split(s, { lines: [PANEL_LINE] })
    expect(s.part().split!.joint).toEqual({ kind: 'butt' })
    const e = await s.fail(
      'design.split.set',
      { partId: s.partId, split: { lines: [PANEL_LINE], joint: 'puzzle', clearance: '2' } },
      'model.invariant',
    )
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([['split.clearance', 'range']])
    const b = await s.fail(
      'design.split.set',
      { partId: s.partId, split: { lines: [PANEL_LINE], clearance: '0.2' } },
      'model.invariant',
    )
    expect(b.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['split.clearance', 'keysOnly'],
    ])
  })
})
