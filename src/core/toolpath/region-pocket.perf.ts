/**
 * Pocket of a region against its budget (docs/architecture/shapes.md#performance: the pocket
 * toolpath of the spike's star, 200 + 2 islands, ≤ 500 ms), outside `npm run check` because
 * timings are flaky in CI. Run: `npm run perf`.
 */
import { expect, it } from 'vitest'
import { loadRegion2dSync } from '../geometry/2d/cavalier'
import { star } from '../geometry/2d/testing/fixtures'
import { nodeCavalierWasm } from '../geometry/2d/testing/node-wasm'
import { generateRegionPocket, type RegionPocketInput } from './region-pocket'
import { findRestMaterial } from '../geometry/2d/rest-material'
import { cutting, endMill, HEIGHTS, RATES } from './testing/fixtures'

function median(n: number, fn: () => void): number {
  for (let i = 0; i < 3; i++) fn()
  const times: number[] = []
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    fn()
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(n / 2)]!
}

it('generates the star pocket within 500 ms', () => {
  const port = loadRegion2dSync(nodeCavalierWasm()).unwrap()
  const region = port.normalise(star(200)).unwrap()
  const tool = endMill(6)
  const input = (stepover: number): RegionPocketInput => ({
    planOperationId: 'perf',
    tool,
    cutting: cutting(tool, { stepover, stepdown: 1.5 }),
    heights: HEIGHTS,
    stock: { length: 250, width: 250, thickness: 20 },
    operation: { region, onZ: 0, depth: 6 },
    strategy: {
      entry: 'helix',
      helixDiameter: 4.8,
      rampAngle: 3,
      finishAllowance: 0.2,
      finishStepdown: 6,
      direction: 'climb',
    },
    maxFeedRate: RATES,
  })
  let moves = 0
  const ms = median(9, () => {
    const tp = generateRegionPocket(input(2.4), port).unwrap()
    moves = tp.passes.reduce((s, p) => s + p.moves.length, 0)
  })
  const clamped = median(9, () => generateRegionPocket(input(5.4), port).unwrap())
  const rest = median(9, () => findRestMaterial(port, region, 3).unwrap())
  console.log(
    [
      `star 200 + 2 islands, D6, 4 levels + finishing: 0.4 D ${ms.toFixed(1)} ms (${moves} moves), ` +
        `0.9 D (clamped to R) ${clamped.toFixed(1)} ms (budget 500 ms)`,
      `rest material finding ${rest.toFixed(2)} ms`,
    ].join('\n'),
  )
  expect(ms).toBeLessThanOrEqual(500)
  expect(clamped).toBeLessThanOrEqual(500)
})
