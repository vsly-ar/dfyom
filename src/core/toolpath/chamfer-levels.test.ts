// A circular chamfer wider than the tool's cutting edge, cut in levels (hardening DF142, user TG
// #488): the M6 countersink Ø6.4 → Ø13.84 with a 1/4" 90° V-bit after the hole is bored. The
// heightmap starts with the bore cut through; the sweep checks that the shank (the tool above its
// cone, Ø DC) never meets material, then the surface against the countersink cone (no gouge,
// leftover under tolerance, nothing cut outside it). Refusal when the edge leaves its core; golden.
// Spec: docs/modes/plan-v0.4.md#chamfers-wider-than-the-cutting-edge-hardening-df142
import { describe, expect, it } from 'vitest'
import { chamferLevels, generateChamfer } from './chamfer'
import type { ChamferInput, ChamferOperation, Toolpath, ToolpathTool } from './model'
import { chamferInput, chamferMill } from './testing/fixtures'
import { Heightmap, render, samples, steps, surfaceOf } from './testing/oracles'
import { violations } from './testing/rules'

const stock = { length: 30, width: 30, thickness: 10 }
const QUARTER = 6.35
const m6 = (over: Partial<ChamferOperation> = {}): ChamferOperation => ({
  kind: 'chamfer',
  id: 'hole1_countersink',
  onZ: 0,
  center: [15, 15],
  edgeOf: 'hole1_drill',
  edgeDiameter: 6.4,
  diameter: 13.84,
  angle: 90,
  ...over,
})

/**
 * Sweeps `tp` over a heightmap whose bore (the edge Ø, through) is already cut when `bored`;
 * returns the shank hits (a cell under the tool within DC, before this sample cuts, higher than
 * the top of the cone) and the surface errors against the chamfer cone, at most 3 each.
 */
function sweep(
  input: ChamferInput,
  tp: Toolpath,
  bored: boolean,
  tol: number,
  shankDiameter?: number,
) {
  const op = input.operation
  const tool = input.tool
  const map = new Heightmap(stock.length, stock.width, 0.08)
  const { cell, nx, ny, z } = map
  const rhoOf = (x: number, y: number) => Math.hypot(x - op.center[0], y - op.center[1])
  for (let b = 0; b < ny; b++)
    for (let a = 0; a < nx; a++) {
      const [x, y] = map.center(a, b)
      z[b * nx + a] = bored && rhoOf(x, y) <= op.edgeDiameter / 2 ? -stock.thickness : op.onZ
    }
  const tan = Math.tan((op.angle * Math.PI) / 360)
  const R = tool.diameter / 2
  const S = Math.max(R, (shankDiameter ?? 0) / 2)
  const coneHeight = (tool.diameter - (tool.tipDiameter ?? 0)) / 2 / tan
  const surface = surfaceOf(tool)
  const shank: string[] = []
  for (const s of steps(tp)) {
    if (s.move.kind === 'rapid') continue
    for (const p of samples(s, 0.04)) {
      const a0 = Math.max(0, Math.floor((p[0] - S) / cell))
      const a1 = Math.min(nx - 1, Math.ceil((p[0] + S) / cell))
      const b0 = Math.max(0, Math.floor((p[1] - S) / cell))
      const b1 = Math.min(ny - 1, Math.ceil((p[1] + S) / cell))
      const rub = p[2] + coneHeight + 0.05
      for (let b = b0; b <= b1; b++) {
        const y = (b + 0.5) * cell
        for (let a = a0; a <= a1; a++) {
          const x = (a + 0.5) * cell
          const rho = Math.hypot(x - p[0], y - p[1])
          if (rho > S) continue
          const k = b * nx + a
          if (rho <= S - cell && z[k]! > rub && shank.length < 3)
            shank.push(
              `shank at ${x.toFixed(2)},${y.toFixed(2)} over ${p.map((v) => v.toFixed(3))}`,
            )
          if (rho > R) continue
          const h = p[2] + surface(rho)
          if (h < z[k]!) z[k] = h
        }
      }
    }
  }
  const surfaceErrors: string[] = []
  let left = 0
  for (let b = 0; b < ny; b++)
    for (let a = 0; a < nx; a++) {
      const [x, y] = map.center(a, b)
      const rho = rhoOf(x, y)
      const h = z[b * nx + a]!
      if (rho >= op.diameter / 2) {
        if (h < op.onZ - 1e-9) surfaceErrors.push(`cut outside at ${x},${y}: ${h}`)
      } else if (rho > op.edgeDiameter / 2 + cell) {
        const cone = op.onZ - (op.diameter / 2 - rho) / tan
        if (h < cone - 1e-6) surfaceErrors.push(`gouge at ${x},${y}: ${h} < ${cone}`)
        if (h > cone + tol) surfaceErrors.push(`left at ${x},${y}: ${h} > ${cone}`)
        left = Math.max(left, h - cone)
      }
    }
  return { shank, surface: surfaceErrors.slice(0, 3), left }
}

const pathRules = (input: ChamferInput, tp: Toolpath) =>
  violations(tp, {
    feedRate: input.cutting.feedRate,
    plungeRate: input.cutting.plungeRate,
    rampAngle: input.strategy.rampAngle,
    verticalAtMostPlunge: true,
    retractZ: input.operation.onZ + input.heights.retractHeight,
    clearanceZ: input.heights.clearanceHeight,
    targetZ:
      input.operation.onZ -
      (input.operation.diameter - input.operation.edgeDiameter) /
        2 /
        Math.tan((input.operation.angle * Math.PI) / 360),
    // the tip stays inside the countersink (the hole or the cone)
    contains: (p) =>
      Math.hypot(p[0] - input.operation.center[0], p[1] - input.operation.center[1]) <=
      input.operation.diameter / 2 - (input.tool.tipDiameter ?? 0) / 2 + 1e-9,
  })

describe('chamfer in levels (DF142)', () => {
  const vbit: ToolpathTool = chamferMill(QUARTER, 90, 0)
  const input = chamferInput(stock, m6(), vbit)

  it('the M6 countersink with a 1/4" V-bit: three levels from the hole out to the cone', () => {
    // width 3.72, c = 3.175, cusp 1.5875, Δ = 1.5875 → 3 levels of 1.24 mm; the edge ring and
    // the bevel ring (2.48 then 1.24 into the material, within c), then the one ring
    const levels = chamferLevels(m6(), vbit)
    expect(levels.map((l) => l.length)).toEqual([2, 2, 1])
    expect(levels.map((l) => l[0]!.depth)).toEqual(
      [1.24, 2.48, 3.72].map((v) => expect.closeTo(v, 9)),
    )
    // every level starts on the edge ring (the tip on the edge, offset 0 into the hole)
    for (const l of levels) expect(l[0]!.offset).toBe(0)
    const tp = generateChamfer(input).unwrap()
    expect(pathRules(input, tp)).toEqual([])
    expect(tp.passes.map((p) => p.kind)).toEqual(['rough', 'finish', 'rough', 'finish'])
  })

  it('after the bore: no gouge, leftover under 0.05 mm, the shank never in material', () => {
    const tp = generateChamfer(input).unwrap()
    const r = sweep(input, tp, true, 0.05)
    expect(r.shank).toEqual([])
    expect(r.surface).toEqual([])
    expect(r.left).toBeLessThan(0.05)
  })

  it('a shank wider than the cone would rub the countersink (why the fit has rule shank)', () => {
    const tp = generateChamfer(input).unwrap()
    expect(sweep(input, tp, true, 0.05, 8).shank.length).toBeGreaterThan(0)
  })

  it('a tipped 60° bit, conventional: exact and no shank rub', () => {
    const op = m6({ edgeDiameter: 5, diameter: 12, angle: 60 })
    const i = chamferInput(stock, op, chamferMill(6, 60, 0.5), { direction: 'conventional' })
    expect(chamferLevels(op, i.tool).length).toBeGreaterThan(1)
    const tp = generateChamfer(i).unwrap()
    expect(pathRules(i, tp)).toEqual([])
    const r = sweep(i, tp, true, 0.08)
    expect(r.shank).toEqual([])
    expect(r.surface).toEqual([])
  })

  it('refuses levels when the edge leaves its core (an inside circle profile)', () => {
    const e = generateChamfer(chamferInput(stock, m6({ edgeCore: true }), vbit)).unwrapErr()
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['operation.edgeCore', 'bore'],
    ])
    // in one ring (or a plunge) the core does not matter
    const one = chamferInput(stock, m6({ edgeCore: true, diameter: 10 }), vbit)
    expect(generateChamfer(one).isOk()).toBe(true)
  })

  it('a recut drops the rings inside its as-cut cone', () => {
    const full = generateChamfer(input).unwrap()
    // the first level (1.24 deep) was cut already
    const recut = generateChamfer({ ...input, material: { top: -1.24, bottom: -10 } }).unwrap()
    expect(recut.stats.cutLength).toBeLessThan(full.stats.cutLength)
    const r = sweep(input, recut, true, 0.05)
    expect(r.surface.filter((e) => e.startsWith('gouge'))).toEqual([])
  })

  it('golden: the M6 countersink in levels', async () => {
    await expect(render(generateChamfer(input).unwrap())).toMatchFileSnapshot(
      '__golden__/chamfer-levels-m6.txt',
    )
  })
})
