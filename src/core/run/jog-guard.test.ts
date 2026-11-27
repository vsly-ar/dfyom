// The workholding guard of hand moves (hardening DF133 RW2): a step into an item stops at the
// margin per item kind and envelope part, the WH-F cylinder without a holder, the collet nut over
// a toe clamp beside the tip (tool-holder.md's user case), leaving an item but never going deeper,
// the stock top stopping the nut and not the tip; and the property: for seeded random items and
// moves, `from → allowed` passes the workholding collision check (`checkWorkholding`, the plan's
// own check, as the oracle) and `allowed` is within 0.02 mm of the first contact.
// Doc: docs/modes/run-workholding.md#implementation-rw2
import { describe, expect, it } from 'vitest'
import type { Vec3 } from '../toolpath/model'
import { random } from '../toolpath/testing/region-fixtures'
import { checkWorkholding } from '../plan/workholding/check'
import { toolEnvelope, type HolderSizes } from '../plan/workholding/envelope'
import type { ResolvedItem } from '../plan/workholding/items'
import { itemPrisms, type Footprint, type Prism } from '../plan/workholding/obstacles'
import { itemClearances, jogGuard, nearestClearance, STOCK_TOP } from './jog-guard'

const ER11: HolderSizes = { nutDiameter: 19, nutLength: 12, bodyDiameter: 52, name: 'ER11' }
const FLAT6 = { diameter: 6 }
const tool = toolEnvelope(FLAT6, undefined, undefined)
const er11 = (stickout = 25) => toolEnvelope(FLAT6, stickout, ER11)

const rect = (x0: number, y0: number, x1: number, y1: number): Footprint => ({
  kind: 'polygon',
  points: [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ],
})
/** A block from X10 to X20, Y0 to Y10, 20 tall. */
const BLOCK: Prism = { itemId: 'wh1', footprint: rect(10, 0, 20, 10), zMin: -40, zMax: 20 }
const SCREW: Prism = {
  itemId: 'wh2',
  footprint: { kind: 'circle', center: [50, 50], radius: 4 },
  zMin: -Infinity,
  zMax: 3,
}
const M = 2

describe('jogGuard: a step into an item stops at the margin', () => {
  it('a block, the tool beside it (WH-F, no holder): the axis stops 3 + 2 mm off its side', () => {
    const r = jogGuard({
      from: [0, 5, 5],
      to: [30, 5, 5],
      envelope: tool,
      prisms: [BLOCK],
      margin: M,
    })
    expect(r.allowed[0]).toBeCloseTo(5, 1)
    expect(Math.abs(r.allowed[0] - 5)).toBeLessThanOrEqual(0.02)
    expect(r.allowed[1]).toBe(5)
    expect(r.contact).toMatchObject({ itemId: 'wh1', part: 'tool' })
    expect(r.contact!.gap).toBeCloseTo(2, 1)
    // the tool alone counts to infinity: high above the block's side it still stops
    const high = jogGuard({
      from: [0, 5, 5],
      to: [0, 5, 500],
      envelope: tool,
      prisms: [BLOCK],
      margin: M,
    })
    expect(high.allowed).toEqual([0, 5, 500])
  })

  it('down onto a screw head: the tip stops 2 mm above it; a move that clears is not touched', () => {
    const r = jogGuard({
      from: [50, 50, 30],
      to: [50, 50, -10],
      envelope: tool,
      prisms: [SCREW],
      margin: M,
    })
    expect(Math.abs(r.allowed[2] - 5)).toBeLessThanOrEqual(0.02)
    expect(r.contact).toMatchObject({ itemId: 'wh2', part: 'tool' })
    const by = jogGuard({
      from: [60, 50, 30],
      to: [60, 50, -10],
      envelope: tool,
      prisms: [SCREW],
      margin: M,
    })
    expect(by).toEqual({ allowed: [60, 50, -10] })
  })

  it('the collet nut: over a 25 mm clamp beside a 6 mm deep tip it stops first', () => {
    // tip at Z−6 (in a pocket), nut from 19: it reaches the block 9.5 + 2 mm off its side
    const r = jogGuard({
      from: [-30, 5, -6],
      to: [30, 5, -6],
      envelope: er11(),
      prisms: [BLOCK],
      margin: M,
    })
    expect(Math.abs(r.allowed[0] - (10 - 9.5 - 2))).toBeLessThanOrEqual(0.02)
    expect(r.contact).toMatchObject({ itemId: 'wh1', part: 'nut' })
    // the spindle body: tip at Z−16 puts its bottom (25 + 12 above the tip) at 21, under 20 + 2
    const b = jogGuard({
      from: [-60, 5, -16],
      to: [30, 5, -16],
      envelope: er11(),
      prisms: [BLOCK],
      margin: M,
    })
    expect(Math.abs(b.allowed[0] - (10 - 26 - 2))).toBeLessThanOrEqual(0.02)
    expect(b.contact).toMatchObject({ itemId: 'wh1', part: 'body' })
  })

  it("the user's toe clamp (tool-holder.md § Testing): the nut hits beside the tip, the tool clears", () => {
    const clamp: ResolvedItem = {
      id: 'wh1',
      name: 'Toe clamp 1',
      kind: 'toeClamp',
      edge: 'uMin',
      at: 50,
      width: 28,
      grip: 10,
      reach: 18,
      top: 25,
    }
    const prisms = itemPrisms(clamp, { length: 250, width: 100, thickness: 40 })
    // the pocket at X16–54: the tip 9 mm from the clamp's grip (X10), 6 deep, moving in Y past it
    const from: Vec3 = [19, 0, -6]
    const r = jogGuard({ from, to: [19, 100, -6], envelope: er11(25), prisms, margin: M })
    expect(r.contact).toMatchObject({ itemId: 'wh1', part: 'nut' })
    // the nut disc (9.5 + 2) reaches the clamp's side at Y36 − √(11.5² − 9²)
    expect(r.allowed[1]).toBeCloseTo(36 - Math.sqrt(11.5 ** 2 - 9 ** 2), 1)
    // the tool alone passes
    expect(
      jogGuard({ from, to: [19, 100, -6], envelope: tool, prisms, margin: M }).contact,
    ).toBeUndefined()
    // with 36 mm out (H3's number) the nut passes over it
    expect(
      jogGuard({ from, to: [19, 100, -6], envelope: er11(36), prisms, margin: M }).contact,
    ).toBeUndefined()
  })
})

describe('jogGuard: starting inside an item', () => {
  const inside: Vec3 = [15, 5, 5]
  it('may leave (up, or sideways away), may not go deeper (down)', () => {
    const input = { envelope: tool, prisms: [BLOCK], margin: M }
    expect(jogGuard({ ...input, from: inside, to: [15, 5, 40] })).toEqual({ allowed: [15, 5, 40] })
    const down = jogGuard({ ...input, from: inside, to: [15, 5, -5] })
    expect(down.allowed).toEqual(inside)
    expect(down.contact).toMatchObject({ itemId: 'wh1', part: 'tool', gap: 0 })
    // within the margin beside it: away is free, closer is refused
    const near: Vec3 = [6, 5, 5]
    expect(jogGuard({ ...input, from: near, to: [-20, 5, 5] })).toEqual({ allowed: [-20, 5, 5] })
    expect(jogGuard({ ...input, from: near, to: [9, 5, 5] }).allowed).toEqual(near)
    // up and away at once
    expect(jogGuard({ ...input, from: near, to: [0, 5, 30] })).toEqual({ allowed: [0, 5, 30] })
  })

  it('leaving one item still stops at another', () => {
    const other: Prism = { ...BLOCK, itemId: 'wh3', footprint: rect(-20, 0, -15, 10) }
    const r = jogGuard({
      from: [6, 5, 5],
      to: [-30, 5, 5],
      envelope: tool,
      prisms: [BLOCK, other],
      margin: M,
    })
    expect(r.contact).toMatchObject({ itemId: 'wh3' })
    expect(Math.abs(r.allowed[0] - (-15 + 3 + 2))).toBeLessThanOrEqual(0.02)
  })
})

describe('jogGuard: the stock top (Q188)', () => {
  const stock = { length: 100, width: 50 }
  it('stops the nut at Z0 over the stock; the tip may go in; no holder, no stop', () => {
    const r = jogGuard({
      from: [50, 25, 30],
      to: [50, 25, -30],
      envelope: er11(20),
      prisms: [],
      margin: M,
      stock,
    })
    // the nut 20 mm above the tip: the tip stops 20 mm into the stock
    expect(Math.abs(r.allowed[2] - -20)).toBeLessThanOrEqual(0.02)
    expect(r.contact).toMatchObject({ itemId: STOCK_TOP, part: 'nut' })
    const bare = {
      from: [50, 25, 30] as Vec3,
      to: [50, 25, -30] as Vec3,
      prisms: [],
      margin: M,
      stock,
    }
    expect(jogGuard({ ...bare, envelope: tool })).toEqual({ allowed: [50, 25, -30] })
    // off the stock (beyond the nut's radius + margin), the nut may go below Z0
    expect(
      jogGuard({ ...bare, from: [140, 25, 30], to: [140, 25, -30], envelope: er11(20) }),
    ).toEqual({ allowed: [140, 25, -30] })
  })
})

describe('nearestClearance', () => {
  it('the nearest item to any part, sideways, above or both', () => {
    expect(nearestClearance([0, 5, 5], tool, [BLOCK])).toEqual({
      itemId: 'wh1',
      part: 'tool',
      gap: 7,
    })
    expect(nearestClearance([15, 5, 26], tool, [BLOCK, SCREW])).toMatchObject({
      itemId: 'wh1',
      gap: 6,
    })
    // the nut beside the block while the tip is far
    const c = nearestClearance([-5, 5, -6], er11(), [BLOCK])!
    expect(c).toMatchObject({ part: 'nut' })
    expect(c.gap).toBeCloseTo(5.5, 9)
    expect(nearestClearance([0, 0, 0], tool, [])).toBeUndefined()
  })
})

describe('itemClearances (RW5)', () => {
  it('one entry per item with its nearest part; the nearest of them is nearestClearance', () => {
    const at = [30, 30, 10] as const
    const all = itemClearances(at, tool, [BLOCK, SCREW])
    expect(all.map((c) => c.itemId)).toEqual(['wh1', 'wh2'])
    // the block: 10 off its corner sideways (axis to (20, 10) less the radius 3), at its height
    expect(all[0]!.gap).toBeCloseTo(Math.hypot(10, 20) - 3, 9)
    // the screw: the tip 7 above its top, the axis 20√2 − 4 − 3 off sideways
    expect(all[1]!.gap).toBeCloseTo(Math.hypot(20 * Math.SQRT2 - 7, 7), 9)
    const near = nearestClearance(at, tool, [BLOCK, SCREW])!
    expect(near).toEqual(all.reduce((a, b) => (b.gap < a.gap ? b : a)))
    // two prisms of one item (vise jaws): one entry, the nearer prism
    const jaw2: Prism = { ...BLOCK, footprint: rect(25, 0, 35, 10) }
    const one = itemClearances([0, 5, 5], tool, [BLOCK, jaw2])
    expect(one).toHaveLength(1)
    expect(one[0]!.gap).toBe(7)
  })
})

// ── property: the plan's own check is the oracle ─────────────────────────────────────────────

/** A seeded random prism: a rectangle, a turned rectangle or a circle, 2–30 tall. */
function randomPrism(rnd: () => number, i: number): Prism {
  const cx = rnd() * 200
  const cy = rnd() * 120
  const zMax = -5 + rnd() * 35
  const kind = Math.floor(rnd() * 3)
  if (kind === 2)
    return {
      itemId: `wh${i}`,
      footprint: { kind: 'circle', center: [cx, cy], radius: 2 + rnd() * 10 },
      zMin: -Infinity,
      zMax,
    }
  const hl = 3 + rnd() * 25
  const hw = 3 + rnd() * 25
  const a = kind === 1 ? rnd() * Math.PI : 0
  const [c, s] = [Math.cos(a), Math.sin(a)]
  return {
    itemId: `wh${i}`,
    footprint: {
      kind: 'polygon',
      points: (
        [
          [-hl, -hw],
          [hl, -hw],
          [hl, hw],
          [-hl, hw],
        ] as const
      ).map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c] as const),
    },
    zMin: -Infinity,
    zMax,
  }
}

describe('jogGuard property (checkWorkholding as the oracle)', () => {
  it('every from → allowed passes the check; allowed is within 0.02 mm of the first contact', () => {
    let contacts = 0
    let checked = 0
    for (let seed = 1; seed <= 800; seed++) {
      const rnd = random(seed)
      const prisms = Array.from({ length: 2 + Math.floor(rnd() * 6) }, (_, i) =>
        randomPrism(rnd, i + 1),
      )
      const margin = rnd() < 0.2 ? 0.5 : 2
      const holder = rnd() < 0.6
      const stickout = 10 + rnd() * 30
      const checkTool = holder ? { ...FLAT6, stickout, holder: ER11 } : FLAT6
      const envelope = toolEnvelope(FLAT6, holder ? stickout : undefined, holder ? ER11 : undefined)
      const from: Vec3 = [rnd() * 240 - 20, rnd() * 160 - 20, -10 + rnd() * 50]
      // one axis (a jog), X/Y together or Z alone (a Go to step), or any direction
      const shape = Math.floor(rnd() * 4)
      const d = (k: number) => (rnd() - 0.5) * 2 * k
      const to: Vec3 =
        shape === 0
          ? [from[0] + d(150), from[1], from[2]]
          : shape === 1
            ? [from[0] + d(150), from[1] + d(150), from[2]]
            : shape === 2
              ? [from[0], from[1], from[2] + d(60)]
              : [from[0] + d(100), from[1] + d(100), from[2] + d(40)]
      const check = (a: Vec3, b: Vec3) =>
        checkWorkholding({
          operations: [
            {
              planOperationId: 'jog',
              tool: checkTool,
              moves: [
                { kind: 'rapid', to: a },
                { kind: 'rapid', to: b },
              ],
            },
          ],
          prisms,
          margin,
          clearanceZ: Infinity,
        }).collisionCount
      // a start inside an item has its own rule (tested above)
      if (check(from, from) > 0) continue
      checked++
      const r = jogGuard({ from, to, envelope, prisms, margin })
      expect(check(from, r.allowed), `seed ${seed}`).toBe(0)
      if (r.contact === undefined) {
        expect(r.allowed, `seed ${seed}`).toEqual(to)
        continue
      }
      contacts++
      const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2])
      const done = Math.hypot(
        r.allowed[0] - from[0],
        r.allowed[1] - from[1],
        r.allowed[2] - from[2],
      )
      const t = Math.min(1, (done + 0.02) / len)
      const past: Vec3 = [
        from[0] + t * (to[0] - from[0]),
        from[1] + t * (to[1] - from[1]),
        from[2] + t * (to[2] - from[2]),
      ]
      expect(check(from, past), `seed ${seed}`).toBeGreaterThan(0)
    }
    // the seeds exercise both outcomes
    expect(checked).toBeGreaterThan(400)
    expect(contacts).toBeGreaterThan(60)
  })
})
