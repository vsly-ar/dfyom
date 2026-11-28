// DF145 facing region: rows clipped to the region, open and inner sides, entry, oracles.
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { planOperationInputs } from '../plan/inputs'
import { planSetup } from '../plan/plan.fixture'
import { toGeneratorInputs } from './inputs'
import { bandShape } from '../design/geometry-input'
import type { Region } from '../geometry/2d/model'
import { rect } from '../geometry/2d/testing/fixtures'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import type { Shape } from '../geometry/model'
import { shapeOutline } from '../geometry/outline'
import type { FacingInput, ToolpathTool } from './model'
import { generateRegionFacing } from './region-facing'
import { generateRequest } from './request'
import { endMill, facingInput } from './testing/fixtures'
import { render, steps } from './testing/oracles'
import { pocketDeepCuts, regionCoverage } from './testing/region-coverage'
import { cuttingLevels, stepsWithin, violations } from './testing/rules'

const port = nodeRegion2d()
/** The user's plate (TG #492): 100 mm, a 22 mm band faced along one edge. */
const plate = { length: 100, width: 60, thickness: 12 }

const regionOf = (s: Shape): Region => {
  const o = shapeOutline(s)
  return o.kind === 'region' ? o.region : { pieces: [] }
}

function input(
  region: Shape,
  tool: ToolpathTool,
  over: Partial<FacingInput['strategy']> = {},
  depth = 1.3,
  stock = plate,
): FacingInput {
  return facingInput(stock, tool, {
    operation: { kind: 'facing', id: 'facing1', depth, region },
    strategy: { pattern: 'zigzag', axis: 'x', overshoot: 1, direction: 'climb', ...over },
  })
}

/**
 * Coverage over the stock against the region grown well past the stock on its open sides (so
 * the oracle's own tool-centre region C0 = offset(region, R) is not cut short there), deep cuts.
 */
function check(inp: FacingInput, test: Region) {
  const tp = generateRegionFacing(inp, port).unwrap()
  const R = inp.tool.diameter / 2
  const c0 = port.offset(test, R).unwrap()
  const cov = regionCoverage(test, c0, tp, inp.tool, inp.stock, -inp.operation.depth, 0.1)
  const deep = pocketDeepCuts(
    tp,
    { ...inp, strategy: { finishAllowance: 0 }, operation: { region: test, onZ: 0 } },
    { cell: 0.1 },
  )
  const zs = cuttingLevels(tp)
  return { tp, cov, deep, zs }
}

describe('generateRegionFacing (DF145)', () => {
  it('golden and oracles: the user case, a 22 mm band along the front of a 100 mm plate', async () => {
    const tool = endMill(6)
    const inp = input(bandShape('front', 22, plate), tool)
    // the band, reaching 20 mm past the stock on its three open sides
    const test = port.normalise([rect(-20, -20, 140, 42)]).unwrap()
    const { tp, cov, deep, zs } = check(inp, test)
    await expect(render(tp)).toMatchFileSnapshot('__golden__/facing-band-front.txt')
    expect(cov.leftover).toBeLessThan(0.05)
    expect(cov.gouge).toBe(0)
    expect(cov.belowFloor).toBe(0)
    expect(deep).toEqual([])
    expect(zs.at(-1)).toBeCloseTo(-1.3, 9)
    expect(stepsWithin(zs, 0, inp.cutting.stepdown)).toBe(true)
    // the open sides run off the stock: every plunge has the tool clear of it
    for (const s of steps(tp))
      if (s.move.kind === 'line' && s.move.to[2] < s.from[2] && s.move.to[2] < 0)
        expect(s.move.to[0] < -3 || s.move.to[0] > 103 || s.move.to[1] < -3).toBe(true)
    // the inner side: the tool's edge on the boundary, never past it
    const maxY = Math.max(
      ...steps(tp).map((s) => (s.move.kind === 'rapid' ? -Infinity : s.move.to[1])),
    )
    expect(maxY).toBeCloseTo(22 - 3, 6)
    expect(
      violations(tp, {
        feedRate: inp.cutting.feedRate,
        plungeRate: inp.cutting.plungeRate,
        retractZ: 2,
        clearanceZ: 10,
        targetZ: -1.3,
        contains: (p) => p[2] >= -1.3 - 1e-9,
      }),
    ).toEqual([])
  })

  for (const edge of ['back', 'left', 'right'] as const)
    for (const axis of ['x', 'y'] as const)
      it(`a band from the ${edge} edge, rows along ${axis}: covered, no gouge, no deep cut`, () => {
        const tool = endMill(6)
        const inp = input(bandShape(edge, 22, plate), tool, { axis })
        const test = port
          .normalise([
            edge === 'back'
              ? rect(-20, 60 - 22, 140, 42)
              : edge === 'left'
                ? rect(-20, -20, 42, 100)
                : rect(100 - 22, -20, 42, 100),
          ])
          .unwrap()
        const { cov, deep } = check(inp, test)
        expect(cov.leftover).toBeLessThan(0.05)
        expect(cov.gouge).toBe(0)
        expect(cov.belowFloor).toBe(0)
        expect(deep).toEqual([])
      })

  it('a circle inside the face (no open side) ramps in and keeps the tool inside', () => {
    const tool = endMill(6)
    const shape: Shape = { center: [50, 30], contour: { kind: 'circle', radius: 15 } }
    const inp = input(shape, tool, { pattern: 'oneWay' })
    const { tp, cov, deep } = check(inp, regionOf(shape))
    expect(cov.leftover).toBeLessThan(0.05)
    expect(cov.gouge).toBe(0)
    expect(cov.belowFloor).toBe(0)
    expect(deep).toEqual([])
    // the first level enters by a ramp: no vertical move below the stock top before the boundary
    // pass (whose plunge meets only what the rows left, checked by the deep-cut oracle)
    const s = steps(tp).find((x) => x.move.kind === 'line' && x.move.to[2] < -1e-9)!
    const to = s.move.kind === 'line' ? s.move.to : s.from
    expect(to[0] !== s.from[0] || to[1] !== s.from[1]).toBe(true)
  })

  it('a slanted shape across a stock edge: open where it leaves the stock, inner elsewhere', () => {
    const tool = endMill(6)
    const tri = port
      .normalise([
        {
          elements: [
            { kind: 'line', a: [-10, -10], b: [70, -10] },
            { kind: 'line', a: [70, -10], b: [20, 45] },
            { kind: 'line', a: [20, 45], b: [-10, -10] },
          ],
        },
      ])
      .unwrap()
    const inp = input({ center: [0, 0], contour: { kind: 'region', region: tri } }, tool, {
      axis: 'y',
    })
    const { cov, deep } = check(inp, tri)
    expect(cov.leftover).toBeLessThan(0.05)
    expect(cov.gouge).toBe(0)
    expect(cov.belowFloor).toBe(0)
    expect(deep).toEqual([])
  })

  it('design to toolpath: a band facing of the design cuts only its band', async () => {
    const s = await planSetup()
    await s.run('design.facing.add', {
      partId: s.partId,
      depth: '0.5',
      region: { band: { edge: 'front', width: '22' } },
    })
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const id = s
      .plan(planId)
      .setups.flatMap((x) => x.operations)
      .find((o) => o.designOperationIds.includes(s.part().operations.at(-1)!.id))!.id
    const facing = expectOk(planOperationInputs(s.d.doc, planId, [id]))[0]!
    const req = expectOk(toGeneratorInputs(facing, port))
    expect(req.kind).toBe('facing')
    const tp = expectOk(generateRequest(req, undefined, () => Ok(port)))
    const cutYs = steps(tp).flatMap((x) => (x.move.kind === 'rapid' ? [] : [x.move.to[1]]))
    // the tool stays in front of the band's inner side (its radius inside it)
    expect(Math.max(...cutYs)).toBeLessThan(22)
  })

  it('a whole-face request keeps the plain rows; a region request needs the port', () => {
    const req = {
      kind: 'facing' as const,
      inputs: [input(bandShape('front', 22, plate), endMill(6))],
    }
    expect(generateRequest(req).isErr()).toBe(true)
    expect(generateRequest(req, undefined, () => Ok(port)).isOk()).toBe(true)
  })
})
