// A one-sided chamfer along a groove with capped ends or corners (DF147 SL4 follow-up,
// engraved-patterns.md § Implementation (SL3–SL4)): a Line with a depth (one Straight / Arc) and a
// profile `on` (an open path with corners, a closed loop). The groove is cut first (a flat end mill
// along the centre path), then the rings. Heightmap oracles: nowhere is cut deeper than the bevel
// of the groove's wall (no gouge), the other side is untouched, the kept wall is bevelled away from
// the ends, nothing beyond a capped end is cut inside the stock; every ring meets at most its pass
// of uncut material (DF144 `deepCuts`). Refusals: a bevel below the groove's floor, a curve tighter
// than the groove, a path that comes back within the groove of itself.
// Doc: docs/modes/engraved-patterns.md#implementation-sl3sl4
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { elementClosest } from '../geometry/2d/measure'
import { arc, line, type Element } from '../geometry/2d/model'
import type { Vec2 } from '../geometry/model'
import type { ChamferWall } from '../geometry/wall-chamfer'
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
const vbit = chamferMill(6.35, 90)

/** The groove: a flat end mill `depth` deep along the centre path (as a Line or a profile `on`). */
function groove(elements: readonly Element[], depth: number): Toolpath {
  const op: LineOperation = {
    kind: 'line',
    id: 'groove',
    onZ: 0,
    paths: [{ center: [0, 0], contour: { kind: 'path', path: { elements } } }],
    depth: { start: depth, end: depth },
    cutter: { kind: 'flat', diameter: D },
  }
  return expectOk(generateLine(lineInput(STOCK, op, flat, {}, { stepdown: 1 })))
}

const wallOp = (wall: Omit<ChamferWall, 'halfWidth'>, width = 0.5): WallChamferOperation => ({
  id: 'chamfer1',
  onZ: 0,
  width,
  angle: 90,
  wall: { halfWidth: g, ...wall },
})

/** Distance from `p` to the path, the nearest point's tangent and whether it is an end. */
function nearest(elements: readonly Element[], closed: boolean, p: Vec2) {
  let best = { d: Infinity, q: [0, 0] as Vec2, t: [1, 0] as Vec2, end: false }
  elements.forEach((e, i) => {
    const q = elementClosest(e, p)
    const d = Math.hypot(p[0] - q[0], p[1] - q[1])
    if (d >= best.d) return
    let t: Vec2
    if (e.kind === 'line') {
      const l = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])
      t = [(e.b[0] - e.a[0]) / l, (e.b[1] - e.a[1]) / l]
    } else {
      const r: Vec2 = [q[0] - e.centre[0], q[1] - e.centre[1]]
      const l = Math.hypot(r[0], r[1])
      t = e.ccw ? [-r[1] / l, r[0] / l] : [r[1] / l, -r[0] / l]
    }
    const at = (x: Vec2) => Math.hypot(q[0] - x[0], q[1] - x[1]) < 1e-9
    const end = !closed && ((i === 0 && at(e.a)) || (i === elements.length - 1 && at(e.b)))
    best = { d, q, t, end }
  })
  return best
}

interface Tally {
  gouge: number
  other: number
  short: number
  beyond: number
}

/**
 * The heightmap of the groove and the rings against the kept wall's bevel (`h` deep, 90°): `gouge`
 * cells cut deeper than the bevel (or the groove's floor), `other` cells of the other side cut,
 * `short` kept cells left above the bevel at least `margin` from the ends (along the path), `beyond`
 * stock cells past a capped end cut.
 */
function tally(
  elements: readonly Element[],
  closed: boolean,
  side: 'left' | 'right',
  h: number,
  floor: number,
  tps: readonly { tool: ToolpathTool; tp: Toolpath }[],
  margin: number,
): Tally {
  const hm = new Heightmap(STOCK.length, STOCK.width, 0.05)
  for (const { tool, tp } of tps) hm.sweep(tool, tp, 0.05)
  const ends: Vec2[] = closed ? [] : [elements[0]!.a, elements.at(-1)!.b]
  const out: Tally = { gouge: 0, other: 0, short: 0, beyond: 0 }
  for (let j = 0; j < hm.ny; j++)
    for (let i = 0; i < hm.nx; i++) {
      const p = hm.center(i, j)
      const z = hm.z[j * hm.nx + i]!
      const n = nearest(elements, closed, p)
      if (n.d <= g - 0.05) {
        if (z < -floor - 0.06) out.gouge++
        continue
      }
      if (n.d <= g + 0.05) continue
      if (n.end) {
        if (z < -1e-6) out.beyond++
        continue
      }
      const left = n.t[0] * (p[1] - n.q[1]) - n.t[1] * (p[0] - n.q[0]) > 0
      const expected = -Math.max(0, h - (n.d - g))
      if (z < expected - 0.06) out.gouge++
      if ((side === 'left') !== left) {
        if (z < -1e-6) out.other++
        continue
      }
      const far = ends.every((e) => Math.hypot(n.q[0] - e[0], n.q[1] - e[1]) > margin)
      if (far && z > expected + 0.06) out.short++
    }
  return out
}

/** Rings of `op` generated, each checked by `deepCuts` after the groove and the rings before it. */
function rings(op: WallChamferOperation, grooveTp: Toolpath): Toolpath[] {
  const rs = expectOk(wallChamferRings(op, vbit, STOCK))
  const before = [{ tool: flat, tp: grooveTp }]
  const out: Toolpath[] = []
  for (const r of rs) {
    const tp = expectOk(
      generateLine(lineInput(STOCK, r.operation, vbit, {}, { stepdown: r.depth, plungeRate: 300 })),
    )
    expect(
      deepCuts(tp, vbit, STOCK, { stepdown: r.depth, finishRadial: 0 }, { before, cell: 0.1 }),
    ).toEqual([])
    before.push({ tool: vbit, tp })
    out.push(tp)
  }
  return out
}

function run(
  elements: Element[],
  side: 'left' | 'right',
  opts: { closed?: boolean; depth?: number; capped?: boolean } = {},
): Tally {
  const closed = opts.closed === true
  const depth = opts.depth ?? 3
  const gTp = groove(elements, depth)
  const op = wallOp({
    elements,
    side,
    ...(closed ? { closed: true as const } : {}),
    ...(opts.capped === false ? {} : { capped: true as const }),
    floor: depth,
  })
  const tps = rings(op, gTp)
  expect(tps.length).toBeGreaterThan(0)
  return tally(
    elements,
    closed,
    side,
    0.5,
    depth,
    [{ tool: flat, tp: gTp }, ...tps.map((tp) => ({ tool: vbit, tp }))],
    g + 0.5 + 1,
  )
}

describe('one-sided chamfer along a capped groove (DF147 SL4 follow-up)', () => {
  it('a Line with a depth inside the stock: the kept wall bevelled, round ends left', () => {
    expect(run([line([20, 30], [80, 30])], 'left')).toEqual({
      gouge: 0,
      other: 0,
      short: 0,
      beyond: 0,
    })
  })

  it('a Line square across the stock: the bevel runs to both edges', () => {
    // margin 0: no end is spared (the ends lie on the stock edges)
    const elements = [line([0, 30], [100, 30])]
    const gTp = groove(elements, 3)
    const tps = rings(wallOp({ elements, side: 'right', capped: true, floor: 3 }), gTp)
    const t = tally(
      elements,
      false,
      'right',
      0.5,
      3,
      [{ tool: flat, tp: gTp }, ...tps.map((tp) => ({ tool: vbit, tp }))],
      0,
    )
    expect(t).toEqual({ gouge: 0, other: 0, short: 0, beyond: 0 })
  })

  it('a slanted Line ending on the stock edge: nothing cut past its ends', () => {
    expect(run([line([0, 10], [100, 50])], 'left')).toEqual({
      gouge: 0,
      other: 0,
      short: 0,
      beyond: 0,
    })
  })

  it('an arc Line, either side', () => {
    const a = arc([20, 15], [80, 15], [50, -5], false)
    for (const side of ['left', 'right'] as const)
      expect(run([a], side)).toEqual({ gouge: 0, other: 0, short: 0, beyond: 0 })
  })

  it('a profile on an open path with corners, either side (rounded outside, mitred inside)', () => {
    const path = [line([10, 10], [50, 10]), line([50, 10], [50, 45]), line([50, 45], [90, 45])]
    for (const side of ['left', 'right'] as const)
      expect(run(path, side, { depth: 4 })).toEqual({ gouge: 0, other: 0, short: 0, beyond: 0 })
  })

  it('a profile on a closed loop: inside (left) and outside (right)', () => {
    const loop = [
      line([30, 15], [70, 15]),
      line([70, 15], [70, 45]),
      line([70, 45], [30, 45]),
      line([30, 45], [30, 15]),
    ]
    for (const side of ['left', 'right'] as const)
      expect(run(loop, side, { closed: true, depth: 4 })).toEqual({
        gouge: 0,
        other: 0,
        short: 0,
        beyond: 0,
      })
  })

  it('refuses a bevel below the floor, a curve too tight and a path too close to itself', () => {
    const floor = wallChamferRings(
      wallOp({ elements: [line([20, 30], [80, 30])], side: 'left', capped: true, floor: 1 }, 2),
      vbit,
      STOCK,
    )
    expect(floor.unwrapErr().issues?.[0]?.rule).toBe('belowGroove')
    // an arc of radius 2 bevelled on its inside (left of a counter-clockwise arc)
    const tight = wallChamferRings(
      wallOp({ elements: [arc([48, 30], [52, 30], [50, 30], true)], side: 'left', capped: true }),
      vbit,
      STOCK,
    )
    expect(tight.unwrapErr().issues?.[0]?.rule).toBe('tooTight')
    // a hairpin 5 mm wide bevelled between its legs
    const pin = wallChamferRings(
      wallOp({
        elements: [line([10, 10], [60, 10]), line([60, 10], [60, 15]), line([60, 15], [10, 15])],
        side: 'left',
        capped: true,
      }),
      vbit,
      STOCK,
    )
    expect(['tooTight', 'selfNear']).toContain(pin.unwrapErr().issues?.[0]?.rule)
  })
})
