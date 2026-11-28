// A one-sided chamfer along a through Line (DF147 SL4, engraved-patterns.md § One-sided chamfer along
// a line): the rings by level cut as Lines along the kept wall. Heightmap oracles after the slot: the
// kept wall bevelled to the width, the other wall untouched, no gouge; levels when the bevel is wider
// than the cutting edge (each within its pass, DF144 `deepCuts`); an inner end stops short of the
// slot's round end; a cone wider than the slot is refused (`otherWall`).
// Doc: docs/modes/engraved-patterns.md#implementation-sl3sl4
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { line, type Element } from '../geometry/2d/model'
import type { ChamferWall } from '../geometry/wall-chamfer'
import { wallPath } from '../geometry/wall-chamfer'
import { generateLine, type LineOperation } from './line'
import type { Toolpath, ToolpathTool } from './model'
import { chamferMill, endMill, lineInput } from './testing/fixtures'
import { Heightmap } from './testing/oracles'
import { deepCuts } from './testing/region-coverage'
import { wallChamferRings, type WallChamferOperation } from './wall-chamfer'

const STOCK = { length: 100, width: 60, thickness: 10 }
const D = 6.22
const g = D / 2
const flat = endMill(D, 22)

const slotOp = (e: Element): LineOperation => ({
  kind: 'line',
  id: 'line1',
  onZ: 0,
  paths: [{ center: [0, 0], contour: { kind: 'path', path: { elements: [e] } } }],
  depth: { start: 10.4, end: 10.4 },
  cutter: { kind: 'flat', diameter: D },
  through: true,
})

const slot = (e: Element) =>
  expectOk(generateLine(lineInput(STOCK, slotOp(e), flat, {}, { stepdown: 1 })))

const chamfer = (e: Element, width: number, side: ChamferWall['side']): WallChamferOperation => ({
  id: 'chamfer1',
  onZ: 0,
  width,
  angle: 90,
  wall: { elements: [e], halfWidth: g, side },
})

/** Every ring's toolpath, outermost level first. */
function bevel(op: WallChamferOperation, tool: ToolpathTool): Toolpath[] {
  return expectOk(wallChamferRings(op, tool, STOCK)).map((r) =>
    expectOk(
      generateLine(lineInput(STOCK, r.operation, tool, {}, { stepdown: r.depth, plungeRate: 300 })),
    ),
  )
}

describe('one-sided chamfer along a through Line (DF147 SL4)', () => {
  it('a 0.5 × 45° bevel on the left wall: the right wall untouched, no gouge', () => {
    const e = line([0, 30], [100, 30])
    const v = chamferMill(6.35, 90)
    const rings = bevel(chamfer(e, 0.5, 'left'), v)
    expect(rings).toHaveLength(1)
    const hm = new Heightmap(100, 60, 0.05)
    hm.sweep(flat, slot(e), 0.1)
    for (const tp of rings) hm.sweep(v, tp, 0.05)
    let gouge = 0
    let short = 0
    let right = 0
    for (let j = 0; j < hm.ny; j++)
      for (let i = 0; i < hm.nx; i++) {
        const [, y] = hm.center(i, j)
        const z = hm.z[j * hm.nx + i]!
        if (y > 30 + g) {
          const expected = -Math.max(0, 0.5 - (y - 30 - g))
          if (z < expected - 0.06) gouge++
          if (z > expected + 0.06) short++
        } else if (y < 30 - g - 0.05 && z < -1e-6) right++
      }
    expect([gouge, short, right]).toEqual([0, 0, 0])
  })

  it('a 2 mm bevel with a 1/8" V-bit: levels, each within its pass, the bevel reached', () => {
    const e = line([0, 30], [100, 30])
    const v = chamferMill(3.175, 90)
    const op = chamfer(e, 2, 'right')
    const rings = expectOk(wallChamferRings(op, v, STOCK))
    expect(new Set(rings.map((r) => r.depth)).size).toBeGreaterThan(1)
    const tps = bevel(op, v)
    const before = [{ tool: flat, tp: slot(e) }]
    for (const [k, tp] of tps.entries()) {
      // each ring meets at most its own depth of material (its one pass)
      const depth = rings[k]!.depth
      expect(
        deepCuts(tp, v, STOCK, { stepdown: depth, finishRadial: 0 }, { before, cell: 0.1 }),
      ).toEqual([])
      before.push({ tool: v, tp })
    }
    const hm = new Heightmap(100, 60, 0.05)
    for (const b of before) hm.sweep(b.tool, b.tp, 0.05)
    let gouge = 0
    let short = 0
    let left = 0
    for (let j = 0; j < hm.ny; j++)
      for (let i = 0; i < hm.nx; i++) {
        const [, y] = hm.center(i, j)
        const z = hm.z[j * hm.nx + i]!
        if (y < 30 - g) {
          const expected = -Math.max(0, 2 - (30 - g - y))
          if (z < expected - 0.08) gouge++
          if (z > expected + 0.12) short++
        } else if (y > 30 + g + 0.05 && z < -1e-6) left++
      }
    expect([gouge, short, left]).toEqual([0, 0, 0])
  })

  it('an inner end: the wall path stops short by the cone reach; open ends run to the edge', () => {
    const w: ChamferWall = { elements: [line([0, 30], [60, 30])], halfWidth: g, side: 'left' }
    const p = wallPath(w, g, 0.5, STOCK) as Element[]
    expect(p[0]!.a).toEqual([0, 30 + g])
    expect(p.at(-1)!.b[0]).toBeCloseTo(59.5, 9)
    // a slanted cut-off: the wall continues along the tangent to the stock edge
    const slanted: ChamferWall = {
      elements: [line([0, 0], [60, 60])],
      halfWidth: g,
      side: 'right',
    }
    const q = wallPath(slanted, g, 0.5, STOCK) as Element[]
    const a = q[0]!.a
    expect(Math.min(a[0], a[1], 100 - a[0], 60 - a[1])).toBeLessThanOrEqual(1e-9)
  })

  it('refuses a cone that reaches the slot’s other wall', () => {
    const e = line([0, 30], [100, 30])
    const r = wallChamferRings(chamfer(e, 6.5, 'left'), chamferMill(19, 90), STOCK)
    expect(r.isErr()).toBe(true)
    expect(r.unwrapErr().issues?.[0]?.rule).toBe('otherWall')
  })
})
