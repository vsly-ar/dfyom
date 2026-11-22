import { describe, expect, it } from 'vitest'
import { offsetContour } from '../geometry/contour'
import { CHORD_TOLERANCE, type AnalyticContour as Contour } from '../geometry/model'
import type { PocketOperation, ToolpathTool } from './model'
import { generatePocket, inradius, ringOffsets } from './pocket'
import { bullNose, endMill, pocketInput } from './testing/fixtures'
import { Heightmap, insideDistance, render, samples, steps, toolSurface } from './testing/oracles'
import { cuttingLevels, stepsWithin, violations } from './testing/rules'

const stock = { length: 60, width: 40, thickness: 20 }
const pocket = (contour: Contour, depth: number, floorRadius = 0, onZ = 0): PocketOperation => ({
  kind: 'pocket',
  id: 'pocket1',
  onZ,
  shape: { center: [30, 20], contour },
  depth,
  floorRadius,
})
const rect = (length: number, width: number, cornerRadius: number): Contour => ({
  kind: 'rectangle',
  length,
  width,
  cornerRadius,
})

/** Seeded pseudo-random numbers in [0, 1). */
function random(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31
    return s / 2 ** 31
  }
}

/** Expected floor height of a (filleted) pocket at signed distance `d` inside its wall. */
function expectedHeight(op: PocketOperation, d: number): number {
  const floor = op.onZ - op.depth
  const f = op.floorRadius
  if (d < 0) return op.onZ
  if (d >= f) return floor
  return floor + f - Math.sqrt(f * f - (f - d) * (f - d))
}

function checkPocket(op: PocketOperation, tool: ToolpathTool, over = {}) {
  const input = pocketInput(stock, op, tool, over)
  const tp = generatePocket(input).unwrap()
  const R = tool.diameter / 2
  const floor = op.onZ - op.depth
  const c = op.shape.center
  expect(
    violations(tp, {
      feedRate: input.cutting.feedRate,
      plungeRate: input.cutting.plungeRate,
      rampAngle: input.strategy.rampAngle,
      retractZ: op.onZ + 2,
      clearanceZ: 10,
      targetZ: floor,
      contains: (p) =>
        p[2] > op.onZ + 1e-9 ||
        (p[2] >= floor - 1e-9 && insideDistance(op.shape.contour, c, [p[0], p[1]]) >= R - 1e-9),
    }),
  ).toEqual([])
  // roughing leaves the finishing allowance on the walls (clamped to the inradius)
  const keep = Math.min(R + input.strategy.finishAllowance, inradius(op.shape.contour)) - 1e-9
  const roughIntoAllowance = steps(tp)
    .filter((s) => tp.passes[s.pass]!.kind === 'rough' && s.move.kind !== 'rapid')
    .flatMap((s) => samples(s, 0.1))
    .filter((p) => p[2] < op.onZ - 1e-9 && insideDistance(op.shape.contour, c, [p[0], p[1]]) < keep)
  expect(roughIntoAllowance.slice(0, 3)).toEqual([])
  const rough = cuttingLevels(tp, 'rough')
  expect(rough.at(-1)).toBeCloseTo(floor, 12)
  expect(stepsWithin(rough, op.onZ, input.cutting.stepdown)).toBe(true)

  // material removal by sampling: no gouge anywhere, the full pocket away from its wall
  const map = new Heightmap(stock.length, stock.width, 0.25)
  map.sweep(tool, tp, 0.1)
  const problems: string[] = []
  let interior = 0
  // a corner radius below the tool radius leaves the tool radius there: compare with what the
  // tool reaches from the contour inset by R
  const inset = offsetContour(op.shape.contour, Math.min(R, inradius(op.shape.contour))).unwrap()
  for (let i = 0; i < map.nx; i++)
    for (let j = 0; j < map.ny; j++) {
      const p = map.center(i, j)
      const d = insideDistance(op.shape.contour, c, p)
      const h = Math.min(map.z[j * map.nx + i]!, op.onZ)
      const e = expectedHeight(op, d)
      if (h < e - 1e-6) problems.push(`gouge at ${p}: ${h} < ${e}`)
      // the tool swept over the inset at the floor: what a round (bull-nose) tool can reach
      const reach = floor + toolSurface(tool, Math.max(0, -insideDistance(inset, c, p)))
      if (!Number.isFinite(reach)) continue
      const target = Math.max(e, reach)
      if (d > op.floorRadius + 0.05 && target === floor) {
        interior++
        if (Math.abs(h - floor) > 1e-6) problems.push(`left at ${p}: ${h}`)
      }
      // the wall is cut to size; in the fillet zone the bull nose matches the fillet
      if (d >= 0.05 && h > target + 0.02) problems.push(`wall at ${p} (d ${d}): ${h} > ${target}`)
    }
  expect(problems.slice(0, 5)).toEqual([])
  expect(interior).toBeGreaterThan(0)
  return { input, tp }
}

describe('generatePocket', () => {
  it('golden: circle, helix entry, finishing pass', async () => {
    const input = pocketInput(stock, pocket({ kind: 'circle', radius: 8 }, 3), endMill(6))
    await expect(render(generatePocket(input).unwrap())).toMatchFileSnapshot(
      '__golden__/pocket-circle-helix.txt',
    )
  })

  it('golden: rounded rectangle, plunge entry, no finishing', async () => {
    const op = pocket(rect(20, 12, 3), 2)
    const input = pocketInput(stock, op, endMill(6), {
      strategy: {
        ...pocketInput(stock, op, endMill(6)).strategy,
        entry: 'plunge',
        finishAllowance: 0,
      },
    })
    await expect(render(generatePocket(input).unwrap())).toMatchFileSnapshot(
      '__golden__/pocket-rect-plunge.txt',
    )
  })

  // three pockets checked on a heightmap: ~1 s alone, several times that
  // under a loaded parallel `npm test` (docs/conventions/testing.md#commands)
  it('clears a circle and a rounded rectangle exactly (flat end mill)', { timeout: 60_000 }, () => {
    checkPocket(pocket({ kind: 'circle', radius: 9 }, 5), endMill(6))
    checkPocket(pocket(rect(40, 25, 4), 8, 0, -0.5), endMill(6))
    checkPocket(pocket(rect(25, 40, 3), 4), endMill(6))
  })

  // two pockets checked on a heightmap: ~1 s alone, several times that
  // under a loaded parallel `npm test` (docs/conventions/testing.md#commands)
  it('leaves the floor fillet with a matching bull nose', { timeout: 60_000 }, () => {
    checkPocket(pocket(rect(40, 25, 4), 8, 2, -0.5), bullNose(6, 2))
    checkPocket(pocket({ kind: 'circle', radius: 10 }, 4, 1), bullNose(8, 1))
  })

  it('30 seeded random pockets keep every property', { timeout: 60_000 }, () => {
    const rnd = random(7)
    for (let n = 0; n < 30; n++) {
      const D = [3, 4, 6, 8][Math.floor(rnd() * 4)]!
      const f = rnd() < 0.4 ? Math.round(rnd() * 0.4 * D * 10) / 10 : 0
      const contour: Contour =
        rnd() < 0.3
          ? { kind: 'circle', radius: D / 2 + 0.5 + rnd() * 12 }
          : rect(
              D + 1 + rnd() * 30,
              D + 1 + rnd() * 20,
              // some corners below the tool radius (the tool leaves its radius there)
              rnd() < 0.3 ? f + rnd() * (D / 2) : Math.max(D / 2, f) + rnd() * 3,
            )
      const fixed: Contour =
        contour.kind === 'rectangle'
          ? {
              ...contour,
              cornerRadius: Math.min(
                contour.cornerRadius,
                Math.min(contour.length, contour.width) / 2,
              ),
            }
          : contour
      const tool = f > 0 ? bullNose(D, f) : endMill(D)
      const entry = (['helix', 'ramp', 'plunge'] as const)[n % 3]!
      const base = pocketInput(stock, pocket(fixed, f + 1 + rnd() * 6, f), tool)
      checkPocket(pocket(fixed, base.operation.depth, f), tool, {
        strategy: {
          ...base.strategy,
          entry,
          rampAngle: 1 + rnd() * 10,
          finishAllowance: rnd() < 0.5 ? 0 : 0.3,
          finishStepdown: 1 + rnd() * 3,
        },
        cutting: { ...base.cutting, stepover: (0.2 + rnd() * 0.7) * D, stepdown: 0.5 + rnd() * 2 },
      })
    }
  })

  it('falls back from helix to ramp to plunge when the entry does not fit', () => {
    const entryOf = (contour: Contour) => {
      const tp = generatePocket(pocketInput(stock, pocket(contour, 2), endMill(6))).unwrap()
      const s = steps(tp)
      if (s.some((x) => x.move.kind === 'arc' && x.move.to[2] < x.from[2])) return 'helix'
      if (s.some((x) => x.move.kind === 'line' && x.move.to[2] < x.from[2] && x.move.feed === 1200))
        return 'ramp'
      return 'plunge'
    }
    expect(entryOf(rect(20, 12, 3))).toBe('helix') // 4.8 + 6 ≤ 12
    expect(entryOf(rect(20, 10, 3))).toBe('ramp') // 20 − 6 ≥ 6
    expect(entryOf(rect(10, 10, 3))).toBe('plunge')
  })

  it('golden: rectangle, ramp entry', async () => {
    const op = pocket(rect(30, 10, 3), 2)
    const base = pocketInput(stock, op, endMill(6))
    const input = { ...base, strategy: { ...base.strategy, entry: 'ramp' as const } }
    await expect(render(generatePocket(input).unwrap())).toMatchFileSnapshot(
      '__golden__/pocket-rect-ramp.txt',
    )
  })

  it('ramp and helix entries respect the finishing allowance', () => {
    const op = pocket(rect(30, 12, 3), 3)
    for (const entry of ['ramp', 'helix'] as const) {
      const base = pocketInput(stock, op, endMill(6))
      checkPocket(op, endMill(6), { strategy: { ...base.strategy, entry, finishAllowance: 0.5 } })
    }
  })

  it('clamps the helix to the tool diameter: no center post, no full-width link', () => {
    const op = pocket(rect(40, 30, 4), 2)
    const tool = endMill(6)
    const base = pocketInput(stock, op, tool)
    const tp = generatePocket({
      ...base,
      strategy: { ...base.strategy, helixDiameter: 12, finishAllowance: 0 },
    }).unwrap()
    const all = steps(tp).filter((s) => s.pass === 0)
    const helixEnd = all.findLastIndex((s) => s.move.kind === 'arc' && s.move.to[2] < s.from[2])
    const entry = all.slice(0, helixEnd + 3) // helix, the flat circle (two halves)
    const link = all[helixEnd + 3]!
    expect(link.move.kind).toBe('line')
    const map = new Heightmap(stock.length, stock.width, 0.1)
    for (const s of entry)
      if (s.move.kind !== 'rapid') for (const p of samples(s, 0.05)) map.stamp(tool, p)
    const z = link.move.to[2]
    const at = (p: readonly number[]) =>
      map.z[Math.floor(p[1]! / 0.1) * map.nx + Math.floor(p[0]! / 0.1)]!
    // the entry clears the center
    expect(at([30, 20])).toBeCloseTo(z, 9)
    // along the link at least one side of the tool is already cut
    const [dx, dy] = [link.move.to[0] - link.from[0], link.move.to[1] - link.from[1]]
    const len = Math.hypot(dx, dy)
    for (const p of samples(link, 0.1)) {
      const side = (k: number): number[] => [
        p[0] + (k * 2.9 * -dy) / len,
        p[1] + (k * 2.9 * dx) / len,
      ]
      expect(Math.min(at(side(1)), at(side(-1)))).toBeLessThanOrEqual(z + 1e-9)
    }
  })

  it('rejects a tool that cannot make the floor fillet', () => {
    const op = pocket(rect(40, 25, 4), 8, 2, -0.5)
    const rule = (tool: ToolpathTool) =>
      generatePocket(pocketInput(stock, op, tool)).unwrapErr().issues[0]!.rule
    expect(rule(endMill(6))).toBe('floorRadiusTool')
    expect(rule(bullNose(6, 1.5))).toBe('floorRadiusTool')
    expect(generatePocket(pocketInput(stock, op, bullNose(6, 2.005))).isOk()).toBe(true)
  })

  it('rejects a tool wider than the pocket and invalid strategy values', () => {
    const tooWide = generatePocket(pocketInput(stock, pocket(rect(10, 5, 2), 2), endMill(6)))
    expect(tooWide.unwrapErr().code).toBe('plan.check')
    const base = pocketInput(stock, pocket(rect(20, 12, 3), 2), endMill(6))
    const bad = generatePocket({ ...base, strategy: { ...base.strategy, rampAngle: 45 } })
    expect(bad.unwrapErr().code).toBe('model.invariant')
  })
})

describe('ringOffsets', () => {
  it('steps by at most the spacing and covers the center', () => {
    for (const [outer, m, s] of [
      [3.2, 12.5, 2.4],
      [3, 3.5, 2],
      [3, 3, 2],
      [3.2, 20, 5.4],
    ] as const) {
      const o = ringOffsets(outer, m, s)
      expect(o.at(-1)).toBe(outer)
      expect(o[0]!).toBeGreaterThanOrEqual(m - s / 2 - 1e-12)
      expect(o[0]!).toBeLessThanOrEqual(m + 1e-12)
      for (let i = 1; i < o.length; i++) expect(o[i - 1]! - o[i]!).toBeLessThanOrEqual(s + 1e-12)
    }
  })

  it('inradius is half the narrowest size', () => {
    expect(inradius(rect(40, 25, 4))).toBe(12.5)
    expect(inradius({ kind: 'circle', radius: 3 })).toBe(3)
    expect(CHORD_TOLERANCE).toBeGreaterThan(0)
  })
})
