// The stepped chamfer (v0.4 F7, D41): terraces by a flat end mill. The heightmap oracle checks
// the cut against the cone: every top step corner lies on it, no stock is left inside it (the
// screw head seats), and the cut goes past it by at most one terrace and never outside the
// terraces or the chamfer Ø; the swept volume is the evaluated solid's (the terrace sum); path
// rules, rings, refusals and a golden.
// Spec: docs/modes/plan-v0.4.md#stepped-chamfer-f7,
// docs/modes/design-v0.4.md#stepped-countersink-f7-d41
import { describe, expect, it } from 'vitest'
import { chamferTerraces } from '../geometry/model'
import { terraceVolume } from '../geometry/testing/analytic'
import { generateChamfer, terraceRings } from './chamfer'
import type { ChamferInput, ChamferOperation } from './model'
import { chamferInput, endMill } from './testing/fixtures'
import { Heightmap, render, steps } from './testing/oracles'
import { violations } from './testing/rules'

const stock = { length: 30, width: 30, thickness: 10 }
/** An M3 countersink: Ø3.4 hole, Ø7.12 × 90°, 1 mm stepdown (2 terraces of 0.93 mm). */
const sink = (over: Partial<ChamferOperation> = {}): ChamferOperation => ({
  kind: 'chamfer',
  id: 'hole1_countersink',
  onZ: 0,
  center: [15, 15],
  edgeOf: 'hole1_drill',
  edgeDiameter: 3.4,
  diameter: 7.12,
  angle: 90,
  stepdown: 1,
  ...over,
})
const stepped = (op: ChamferOperation, diameter: number, over: object = {}) =>
  chamferInput(stock, op, endMill(diameter), { entry: 'stepped', ...over })

/**
 * Sweeps the toolpath and compares the stock with the cone between the hole and the chamfer Ø
 * (inside the hole is air: any depth). `tol` covers the sweep's sampling.
 */
function checkTerraces(input: ChamferInput, tol = 0.01): void {
  const op = input.operation
  const t = chamferTerraces(op, op.stepdown!)!
  const tp = generateChamfer(input).unwrap()
  const bottom = op.onZ - t.count * t.height
  expect(
    violations(tp, {
      feedRate: input.cutting.feedRate,
      plungeRate: input.cutting.plungeRate,
      rampAngle: input.strategy.rampAngle,
      verticalAtMostPlunge: true,
      retractZ: op.onZ + input.heights.retractHeight,
      clearanceZ: input.heights.clearanceHeight,
      targetZ: bottom,
      // the tool's edge never passes the chamfer Ø
      contains: (p) =>
        Math.hypot(p[0] - op.center[0], p[1] - op.center[1]) + input.tool.diameter / 2 <=
        op.diameter / 2 + 1e-9,
    }),
  ).toEqual([])
  const map = new Heightmap(2 * op.center[0], 2 * op.center[1], 0.05)
  map.z.fill(op.onZ)
  map.sweep(input.tool, tp, 0.02)
  const tan = Math.tan((op.angle * Math.PI) / 360)
  const cone = (rho: number) => op.onZ - (op.diameter / 2 - rho) / tan
  /** The terraces' floor at `rho`: the deepest terrace whose wall is outside it. */
  const envelope = (rho: number) => {
    let z = op.onZ
    t.radii.forEach((r, k) => {
      if (rho < r) z = op.onZ - (k + 1) * t.height
    })
    return z
  }
  const wrong: string[] = []
  let removed = 0
  for (let i = 0; i < map.nx; i++)
    for (let j = 0; j < map.ny; j++) {
      const [x, y] = map.center(i, j)
      const rho = Math.hypot(x - op.center[0], y - op.center[1])
      if (rho < op.edgeDiameter / 2) continue
      const h = map.z[j * map.nx + i]!
      removed += (op.onZ - h) * map.cell ** 2
      const at = `${x.toFixed(3)},${y.toFixed(3)}`
      if (rho >= op.diameter / 2) {
        if (h < op.onZ - 1e-9) wrong.push(`cut outside the chamfer at ${at}: ${h}`)
        continue
      }
      // the head seats: no stock inside the cone
      if (h > cone(rho) + tol) wrong.push(`stock inside the cone at ${at}: ${h} > ${cone(rho)}`)
      // nothing cut below the terraces, and at most one terrace past the cone
      if (h < envelope(rho) - 1e-9) wrong.push(`cut below the terrace at ${at}: ${h}`)
      if (h < cone(rho) - t.height - 1e-9) wrong.push(`more than a terrace past at ${at}: ${h}`)
    }
  expect(wrong.slice(0, 3)).toEqual([])
  // the cut is the evaluated solid's terraces (geometry/operations.ts): the swept volume outside
  // the hole matches the analytic terrace sum the solid is tested against (evaluate.test.ts)
  const exact = terraceVolume(op.edgeDiameter, op.diameter, op.angle, op.stepdown!)
  expect(Math.abs(removed - exact)).toBeLessThan(0.02 * exact)
  // every top step corner lies on the cone: just outside each wall the stock stands at the
  // cone's height there (the level of the terrace above)
  t.radii.forEach((r, k) => {
    for (const a of [0, 1, 2, 3, 4, 5].map((n) => (n * Math.PI) / 3)) {
      const rho = r + 0.08
      const [x, y] = [op.center[0] + rho * Math.cos(a), op.center[1] + rho * Math.sin(a)]
      const i = Math.floor(x / map.cell)
      const j = Math.floor(y / map.cell)
      const h = map.z[j * map.nx + i]!
      expect(h, `corner ${k}`).toBeCloseTo(op.onZ - k * t.height, 9)
      expect(cone(r)).toBeCloseTo(op.onZ - k * t.height, 9)
    }
  })
}

describe('generateChamfer, stepped (F7)', () => {
  it('golden: an M3 countersink in 2 terraces with a 2.5 mm end mill', async () => {
    const tp = generateChamfer(stepped(sink(), 2.5)).unwrap()
    await expect(render(tp)).toMatchFileSnapshot('__golden__/chamfer-stepped.txt')
  })

  it('terraces: corners on the cone, the cone cleared, at most one terrace past it', () => {
    expect(chamferTerraces(sink(), 1)).toMatchObject({ count: 2 })
    checkTerraces(stepped(sink(), 2.5))
    // a stepdown that divides the cone unevenly, a smaller tool (several rings), 82°, conventional
    checkTerraces(stepped(sink({ stepdown: 0.4, onZ: -0.5 }), 1.8))
    checkTerraces(
      stepped(sink({ edgeDiameter: 6.4, diameter: 14, angle: 82, stepdown: 1.2 }), 3.5, {
        direction: 'conventional',
      }),
    )
  })

  it('rings: one when the end mill spans the terrace, else spaced at most DC / 2', () => {
    expect(terraceRings(3.56, 3.4, 2.5)).toEqual([2.31])
    const rings = terraceRings(8, 6.4, 3.5)
    expect(rings).toHaveLength(2)
    expect(rings.at(-1)).toBeCloseTo(6.25, 12)
    // the innermost reaches into the hole
    expect(rings[0]! - 1.75).toBeLessThan(3.2)
    for (let k = 1; k < rings.length; k++)
      expect(rings[k]! - rings[k - 1]!).toBeLessThanOrEqual(1.75 + 1e-12)
  })

  it('moves: down to the face inside the hole, ramps per terrace, climbs, ends in the hole', () => {
    const input = stepped(sink(), 2.5)
    const tp = generateChamfer(input).unwrap()
    expect(tp.passes.map((p) => p.kind)).toEqual(['rough'])
    const all = steps(tp)
    expect(all.every((s) => s.move.kind !== 'arc' || !s.move.cw)).toBe(true)
    expect(all.find((s) => s.move.kind === 'line')!.move.to).toEqual([15, 15 - 2.31, 0])
    const feeds = all.filter((s) => s.move.kind !== 'rapid')
    const last = feeds.at(-1)!.move.to.map((v) => Number(v.toFixed(9)))
    expect(last).toEqual([15, 15, -1.86])
    // each terrace's floor is reached by a ramp on an arc, never by a straight plunge
    const levels = new Set(
      feeds.filter((s) => s.move.kind === 'arc').map((s) => Number(s.move.to[2].toFixed(9))),
    )
    expect([...levels].filter((z) => z === -0.93 || z === -1.86)).toEqual([-0.93, -1.86])
  })

  it('refuses a chamfer mill, an end mill as wide as the hole, too many terraces', () => {
    const rule = (input: ChamferInput) =>
      generateChamfer(input)
        .unwrapErr()
        .issues.map((i) => i.rule)
    const vbit = { ...endMill(6), type: 'chamferMill', angle: 90, tipDiameter: 0 } as const
    expect(rule(chamferInput(stock, sink(), vbit, { entry: 'stepped' }))).toEqual(['toolType'])
    expect(rule(stepped(sink(), 3.4))).toEqual(['diameter'])
    expect(rule(stepped(sink({ stepdown: 0.001 }), 2.5))).toEqual(['range'])
    // a stepped operation needs the stepped entry
    expect(rule(chamferInput(stock, sink(), endMill(2.5)))).toEqual(['stepped'])
  })
})
