// Spec: docs/modes/workholding.md#automatic-arrangement-w6 (v0.4-llm-first W6)
import { describe, expect, it } from 'vitest'
import type { Move, Vec3 } from '../../toolpath/model'
import { arrangeToeClamps, stickoutForRoom, type ArrangeInput, type PlacedClamp } from './arrange'
import { checkWorkholding, type CheckOperation } from './check'
import type { ResolvedItem } from './items'
import { obstacles } from './obstacles'

const STOCK = { length: 200, width: 150, thickness: 20 }
const CLAMP = { width: 30, grip: 10, reach: 50, top: 25 }
const tool = { diameter: 6 }

/** A closed rectangle cut at Z −5 with a rapid in at the retract plane and links at Z10. */
function loop(x0: number, y0: number, x1: number, y1: number, id = 'op1'): CheckOperation {
  const z = -5
  const at = (x: number, y: number, zz = z): Vec3 => [x, y, zz]
  const moves: Move[] = [
    { kind: 'rapid', to: at(x0, y0, 10) },
    { kind: 'rapid', to: at(x0, y0, 2) },
    { kind: 'line', to: at(x0, y0), feed: 500 },
    { kind: 'line', to: at(x1, y0), feed: 500 },
    { kind: 'line', to: at(x1, y1), feed: 500 },
    { kind: 'line', to: at(x0, y1), feed: 500 },
    { kind: 'line', to: at(x0, y0), feed: 500 },
    { kind: 'rapid', to: at(x0, y0, 10) },
  ]
  return { planOperationId: id, tool, moves }
}

const input = (operations: CheckOperation[], extra: Partial<ArrangeInput> = {}): ArrangeInput => ({
  stock: STOCK,
  operations,
  clearanceZ: 10,
  margin: 2,
  clamp: CLAMP,
  others: [],
  step: 1,
  ...extra,
})

/** The placed clamps as items, checked by the exact collision check (clearance raised to 27). */
function exactCheck(clamps: readonly PlacedClamp[], operations: CheckOperation[]) {
  const items: ResolvedItem[] = clamps.map((c, k) => ({
    id: `wh${k + 1}`,
    name: `Toe clamp ${k + 1}`,
    kind: 'toeClamp',
    edge: c.edge,
    at: c.at,
    ...CLAMP,
  }))
  // links rise to the clearance the clamps raise (WH-C): the test lifts them as the program does
  const lifted = operations.map((o) => ({
    ...o,
    moves: o.moves.map((m) =>
      m.kind === 'rapid' && m.to[2] >= 10 ? { ...m, to: [m.to[0], m.to[1], 27] as Vec3 } : m,
    ),
  }))
  return checkWorkholding({
    operations: lifted,
    prisms: obstacles(items, STOCK),
    margin: 2,
    clearanceZ: 27,
  })
}

describe('arrangeToeClamps (W6)', () => {
  it('a central pocket: two clamps on each long edge, 1.5 clamp widths in from the corners', () => {
    const ops = [loop(60, 40, 140, 110)]
    const r = arrangeToeClamps(input(ops))
    expect('clamps' in r && r.clamps).toEqual([
      { edge: 'vMin', at: 45 },
      { edge: 'vMin', at: 155 },
      { edge: 'vMax', at: 45 },
      { edge: 'vMax', at: 155 },
    ])
    if (!('clamps' in r)) return
    const exact = exactCheck(r.clamps, ops)
    expect(exact.collisions).toEqual([])
    expect(exact.close).toEqual([])
  })

  it('a hole near the front-left corner pushes the front clamp along the edge', () => {
    const drill: CheckOperation = {
      planOperationId: 'drill',
      tool,
      moves: [
        { kind: 'rapid', to: [30, 12, 10] },
        {
          kind: 'drill',
          at: [30, 12],
          retract: 2,
          top: 0,
          bottom: -10,
          cycle: 'simple',
          feed: 200,
        } as Move,
        { kind: 'rapid', to: [30, 12, 10] },
      ],
    }
    const ops = [loop(60, 40, 140, 110), drill]
    const r = arrangeToeClamps(input(ops))
    // the hole's rapid keeps 3 + 2 × 2 mm: centres within 30 ± (7 + 15) are blocked
    expect('clamps' in r && r.clamps).toEqual([
      { edge: 'vMin', at: 52 },
      { edge: 'vMin', at: 155 },
      { edge: 'vMax', at: 45 },
      { edge: 'vMax', at: 155 },
    ])
    if ('clamps' in r) expect(exactCheck(r.clamps, ops).collisions).toEqual([])
  })

  it('a cut along a long edge sends the clamps to the short edges; other items are kept clear', () => {
    const ops = [loop(60, 40, 140, 110), loop(20, 8, 180, 8, 'edge')]
    const r = arrangeToeClamps(input(ops))
    // left and right are 150 long: a quarter in from each end (37.5 → the 1 mm grid)
    expect('clamps' in r && r.clamps).toEqual([
      { edge: 'uMin', at: 37 },
      { edge: 'uMin', at: 113 },
      { edge: 'uMax', at: 37 },
      { edge: 'uMax', at: 113 },
    ])
    // a screw beside the left edge moves that clamp
    const screw: ResolvedItem = {
      id: 'wh9',
      name: 'Screw 1',
      kind: 'screw',
      center: [-10, 40],
      headDiameter: 8,
      top: 0,
    }
    const kept = arrangeToeClamps(input(ops, { others: obstacles([screw], STOCK) }))
    // its head 36–44 plus the margin and half the clamp block centres 19–61 (open): 19 is nearer
    expect('clamps' in kept && kept.clamps.slice(0, 2)).toEqual([
      { edge: 'uMin', at: 19 },
      { edge: 'uMin', at: 113 },
    ])
  })

  it('a profile all round near the edges leaves no room: every edge says what it has', () => {
    const r = arrangeToeClamps(input([loop(8, 8, 192, 142)]))
    expect('edges' in r && r.edges).toEqual([
      { edge: 'vMin', fits: 0, free: [] },
      { edge: 'vMax', fits: 0, free: [] },
      { edge: 'uMin', fits: 0, free: [] },
      { edge: 'uMax', fits: 0, free: [] },
    ])
  })

  it('room on one edge only is a refusal that names the free centres', () => {
    // the front is free, the other three edges are cut close
    const ops = [loop(8, 30, 192, 142)]
    const r = arrangeToeClamps(input(ops))
    expect('edges' in r && r.edges.map((e) => [e.edge, e.fits, e.free])).toEqual([
      ['vMin', 2, [[15, 185]]],
      ['vMax', 0, []],
      ['uMin', 0, []],
      ['uMax', 0, []],
    ])
  })

  it('the waste test keeps the grip off the part', () => {
    // pretend the part reaches the front edge left of X 100
    const inWaste = (g: readonly [readonly [number, number], readonly [number, number]]) =>
      g[0][1] > 1 || g[0][0] >= 100
    // the front takes one clamp only (none on its left half): the short edges take the four
    const r = arrangeToeClamps(input([loop(60, 40, 140, 110)], { inWaste }))
    expect('clamps' in r && r.clamps.map((c) => c.edge)).toEqual(['uMin', 'uMin', 'uMax', 'uMax'])
    const both = arrangeToeClamps(
      input([loop(60, 40, 140, 110)], { inWaste: (g) => g[0][0] >= 30 || g[0][1] > 1 }),
    )
    expect('clamps' in both && both.clamps.slice(0, 2)).toEqual([
      { edge: 'vMin', at: 45 },
      { edge: 'vMin', at: 155 },
    ])
  })
})

// hardening DF138 F1 (X3): the automatic placement keeps the collet nut and the spindle body
// clear, not only the tool
describe('arrangeToeClamps with a holder (DF138 F1)', () => {
  const ER11 = { nutDiameter: 19, nutLength: 12, bodyDiameter: 52, name: 'ER11' }
  const held = (op: CheckOperation, stickout: number): CheckOperation => ({
    ...op,
    tool: { ...tool, stickout, holder: ER11 },
  })

  it('the body beside the long edges sends the clamps to the short edges, clear of the envelope', () => {
    // 25 mm from the long edges: the Ø6 tool keeps them free, the Ø52 body (from Z 17) does not
    const ops = [held(loop(40, 25, 160, 125), 10)]
    const plain = arrangeToeClamps(input([loop(40, 25, 160, 125)]))
    expect('clamps' in plain && plain.clamps.map((c) => c.edge)).toEqual([
      'vMin',
      'vMin',
      'vMax',
      'vMax',
    ])
    const r = arrangeToeClamps(input(ops))
    expect('clamps' in r && r.clamps.map((c) => c.edge)).toEqual(['uMin', 'uMin', 'uMax', 'uMax'])
    if (!('clamps' in r) || !('clamps' in plain)) return
    // the exact check with the stepped envelope: no holder collision
    expect(exactCheck(r.clamps, ops).collisions).toEqual([])
    expect(exactCheck(plain.clamps, ops).collisions.map((c) => c.kind)).toContain('holder')
  })

  it('no placement at the planned stickout: the stickout that makes room (exact, 5 mm above)', () => {
    const ops = [held(loop(30, 25, 170, 125), 10)]
    expect('edges' in arrangeToeClamps(input(ops))).toBe(true)
    const room = stickoutForRoom(input(ops))
    expect(room?.clamps.map((c) => c.edge)).toEqual(['vMin', 'vMin', 'vMax', 'vMax'])
    // the body (12 mm above the stickout) must clear the 25 mm clamp from the tip at Z−5 by 5 mm
    expect(room?.stickouts.get('op1')).toBeCloseTo(25 + 5 - 12 + 5, 6)
    // with it the placement passes the exact check
    const longer = [held(loop(30, 25, 170, 125), room!.stickouts.get('op1')!)]
    expect(exactCheck(room!.clamps, longer).collisions).toEqual([])
    // without a holder, or with no room for the tool either: nothing to say
    expect(stickoutForRoom(input([loop(30, 25, 170, 125)]))).toBeUndefined()
    expect(stickoutForRoom(input([held(loop(8, 8, 192, 142), 10)]))).toBeUndefined()
  })
})
