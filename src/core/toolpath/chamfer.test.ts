// The chamfer generator (v0.4 T1): plunge and contour, checked by the heightmap oracle with a cone
// tip (the swept surface is the chamfer's cone from d to D, nothing outside D is touched), path
// rules, the edge case of a cutting edge that just covers the slant, refusals, and the request.
// Spec: docs/modes/plan-v0.4.md#chamfer-toolpath, #tests
import { describe, expect, it } from 'vitest'
import { chamferCut, generateChamfer } from './chamfer'
import type { ChamferInput, ChamferOperation, ToolpathTool } from './model'
import { generateRequest, GeneratorRequestSchema } from './request'
import { chamferInput, chamferMill } from './testing/fixtures'
import { Heightmap, render, steps } from './testing/oracles'
import { violations } from './testing/rules'

const stock = { length: 30, width: 30, thickness: 10 }
const chamfer = (over: Partial<ChamferOperation> = {}): ChamferOperation => ({
  kind: 'chamfer',
  id: 'chamfer1',
  onZ: -0.5,
  center: [15, 15],
  edgeOf: 'drill1',
  edgeDiameter: 6,
  diameter: 8,
  angle: 90,
  ...over,
})

/**
 * Sweeps the toolpath over a heightmap and compares it with the chamfer's cone: between the edge
 * and the chamfer Ø the cut is the cone (within `tol`), outside the chamfer Ø nothing is cut.
 * Inside the edge Ø is the hole (air): any depth.
 */
function checkSurface(input: ChamferInput, tol: number): void {
  const op = input.operation
  const tp = generateChamfer(input).unwrap()
  const { tipZ } = chamferCut(input)
  expect(
    violations(tp, {
      feedRate: input.cutting.feedRate,
      plungeRate: input.cutting.plungeRate,
      rampAngle: input.strategy.rampAngle,
      verticalAtMostPlunge: true,
      retractZ: op.onZ + input.heights.retractHeight,
      clearanceZ: input.heights.clearanceHeight,
      targetZ: tipZ,
      // the tip stays inside the edge Ø: it never cuts the hole's wall
      contains: (p) =>
        Math.hypot(p[0] - op.center[0], p[1] - op.center[1]) <=
        (op.edgeDiameter - (input.tool.tipDiameter ?? 0)) / 2 + 1e-9,
    }),
  ).toEqual([])
  // a map around the chamfer only (the tool never leaves it)
  const map = new Heightmap(2 * op.center[0], 2 * op.center[1], 0.08)
  map.z.fill(op.onZ)
  map.sweep(input.tool, tp, 0.04)
  const tan = Math.tan((op.angle * Math.PI) / 360)
  const wrong: string[] = []
  for (let i = 0; i < map.nx; i++)
    for (let j = 0; j < map.ny; j++) {
      const [x, y] = map.center(i, j)
      const rho = Math.hypot(x - op.center[0], y - op.center[1])
      const h = map.z[j * map.nx + i]!
      if (rho >= op.diameter / 2) {
        if (h < op.onZ - 1e-9) wrong.push(`cut outside the chamfer at ${x},${y}: ${h}`)
      } else if (rho >= op.edgeDiameter / 2) {
        const cone = op.onZ - (op.diameter / 2 - rho) / tan
        if (h < cone - 1e-9) wrong.push(`gouge at ${x},${y}: ${h} < ${cone}`)
        if (h > cone + tol) wrong.push(`left at ${x},${y}: ${h} > ${cone}`)
      }
    }
  expect(wrong.slice(0, 3)).toEqual([])
}

describe('generateChamfer', () => {
  it('golden: contour on one ring at the chamfer depth (DC < D)', async () => {
    const tp = generateChamfer(chamferInput(stock, chamfer(), chamferMill(6))).unwrap()
    await expect(render(tp)).toMatchFileSnapshot('__golden__/chamfer-contour.txt')
  })

  it('golden: plunge at the centre (DC ≥ D)', async () => {
    const tp = generateChamfer(
      chamferInput(stock, chamfer(), chamferMill(12), { entry: 'plunge' }),
    ).unwrap()
    await expect(render(tp)).toMatchFileSnapshot('__golden__/chamfer-plunge.txt')
  })

  it('golden: inch sizes (1/4" hole, 1/32" wider, 1/4" 90° mill with a 0.01" tip)', async () => {
    const inch = 25.4
    const op = chamfer({ edgeDiameter: inch / 4, diameter: inch * (1 / 4 + 1 / 32), onZ: 0 })
    const tp = generateChamfer(chamferInput(stock, op, chamferMill(inch / 4, 90, 0.01 * inch)))
    await expect(render(tp.unwrap())).toMatchFileSnapshot('__golden__/chamfer-contour-inch.txt')
  })

  it('contour: the ring of radius (d − dt) / 2 at the chamfer depth cuts the cone exactly', () => {
    const input = chamferInput(stock, chamfer({ center: [7, 7] }), chamferMill(6))
    expect(chamferCut(input).ringRadius).toBe(3)
    expect(chamferCut(input).tipZ).toBeCloseTo(-1.5, 12)
    checkSurface(input, 0.02)
    // with a tip, another angle, conventional
    checkSurface(
      chamferInput(
        stock,
        chamfer({ center: [7, 7], angle: 60, diameter: 9 }),
        chamferMill(8, 60, 1),
        {
          direction: 'conventional',
        },
      ),
      0.03,
    )
  })

  it('contour: a cutting edge that just covers the slant still reaches the chamfer Ø', () => {
    // DC − dt = D − d: the cone's top edge runs exactly on the chamfer Ø at the face
    const tool: ToolpathTool = chamferMill(4, 90, 2)
    const input = chamferInput(stock, chamfer({ center: [7, 7] }), tool)
    expect(chamferCut(input).ringRadius + tool.diameter / 2).toBeCloseTo(4, 12)
    checkSurface(input, 0.02)
    // DF142: a shorter edge cuts it in levels
    const shorter = chamferInput(stock, chamfer(), chamferMill(3.9, 90, 2))
    expect(
      generateChamfer(shorter)
        .unwrap()
        .passes.map((p) => p.kind),
    ).toEqual(['rough', 'finish'])
  })

  it('contour: enters inside the hole, ramps at most at the ramp angle, climbs, leaves to the centre', () => {
    const tp = generateChamfer(chamferInput(stock, chamfer(), chamferMill(6))).unwrap()
    const all = steps(tp)
    // climb inside a hole: counter-clockwise
    expect(all.every((s) => s.move.kind !== 'arc' || !s.move.cw)).toBe(true)
    // the first feed move goes down to the face inside the hole, touching nothing
    expect(all.find((s) => s.move.kind === 'line')!.move.to).toEqual([15, 12, -0.5])
    // the last feed move ends at the centre at the chamfer depth
    const lastFeed = all.filter((s) => s.move.kind !== 'rapid').at(-1)!
    expect(lastFeed.move.to.map((v) => Number(v.toFixed(9)))).toEqual([15, 15, -1.5])
  })

  it('plunge: down to where the cone has the chamfer Ø at the face, at the plunge rate', () => {
    const input = chamferInput(stock, chamfer({ center: [7, 7] }), chamferMill(12, 90, 0.5), {
      entry: 'plunge',
    })
    expect(chamferCut(input).tipZ).toBeCloseTo(-0.5 - 3.75, 12)
    checkSurface(input, 0.02)
    const feeds = steps(generateChamfer(input).unwrap()).filter((s) => s.move.kind === 'line')
    expect(feeds.map((s) => s.move.kind === 'line' && s.move.feed)).toEqual([200])
  })

  it('refuses unfit tools and impossible entries', () => {
    const rule = (input: ChamferInput) =>
      generateChamfer(input)
        .unwrapErr()
        .issues.map((i) => i.rule)
    expect(rule(chamferInput(stock, chamfer(), chamferMill(6, 60)))).toEqual(['angle'])
    expect(rule(chamferInput(stock, chamfer(), chamferMill(12, 90, 6)))).toEqual(['tip'])
    expect(rule(chamferInput(stock, chamfer(), chamferMill(6), { entry: 'plunge' }))).toEqual([
      'plungeSize',
    ])
    const flat = { ...chamferMill(6), type: 'flatEndMill' } as const
    expect(rule(chamferInput(stock, chamfer(), flat))).toEqual(['toolType'])
    expect(rule(chamferInput(stock, chamfer({ diameter: 5 }), chamferMill(6)))).toEqual([
      'greaterThanEdge',
    ])
    expect(rule(chamferInput(stock, chamfer(), chamferMill(6), { rampAngle: 45 }))).toEqual([
      'range',
    ])
    // within 0.5° the angle matches
    expect(generateChamfer(chamferInput(stock, chamfer(), chamferMill(6, 90.4))).isOk()).toBe(true)
  })

  it('a request joins its chamfers (each from and back to clearance) and crosses the boundary', () => {
    const inputs = [
      chamferInput(stock, chamfer(), chamferMill(6)),
      chamferInput(stock, chamfer({ id: 'chamfer2', center: [5, 25] }), chamferMill(6)),
    ]
    const request = GeneratorRequestSchema.parse({ kind: 'chamfer', inputs })
    const tp = generateRequest(request).unwrap()
    const one = generateChamfer(inputs[0]!).unwrap()
    expect(tp.passes).toHaveLength(2)
    expect(tp.passes[0]).toEqual({ ...one.passes[0], operationId: 'chamfer1' })
    expect(tp.passes[1]!.operationId).toBe('chamfer2')
    expect(tp.stats.cutLength).toBeCloseTo(
      one.stats.cutLength + generateChamfer(inputs[1]!).unwrap().stats.cutLength,
      9,
    )
  })
})
