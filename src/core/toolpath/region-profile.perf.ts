/**
 * Profiles of general loops against the pocket's budget (docs/architecture/shapes.md#performance,
 * ≤ 500 ms): the outside profile of the X0 enclosure outline (SVG import, ≈ 160 elements) with
 * tabs, a 14 mm slot (several passes) and finishing; an `on` groove along the same outline. Outside
 * `npm run check` because timings are flaky in CI. Run: `npm run perf`.
 */
import { expect, it } from 'vitest'
import { loadRegion2dSync } from '../geometry/2d/cavalier'
import { chainLength } from '../geometry/2d/measure'
import type { Loop } from '../geometry/2d/model'
import { nodeCavalierWasm } from '../geometry/2d/testing/node-wasm'
import { tabCentres } from '../geometry/outline'
import { ENCLOSURE_SECTIONS_SVG } from '../design/enclosure-sections.testing'
import { importSvg } from '../import/svg'
import { generateRegionProfile, type RegionProfileInput } from './region-profile'
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

it('generates profiles of the enclosure outline within 500 ms', () => {
  const port = loadRegion2dSync(nodeCavalierWasm()).unwrap()
  const fs = (
    globalThis as unknown as {
      process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, e: 'utf8'): string } }
    }
  ).process.getBuiltinModule('node:fs')
  const shapes = importSvg(fs.readFileSync(ENCLOSURE_SECTIONS_SVG, 'utf8')).unwrap().shapes
  const item = shapes.find((s) => s.name === 'outline')!.items[0]!
  if (item.kind !== 'loop') throw new Error('expected a loop')
  const chain: Loop = item.loop
  const tool = endMill(6)
  const input = (side: 'outside' | 'on', slotWidth: number): RegionProfileInput => ({
    planOperationId: 'perf',
    tool,
    cutting: cutting(tool, { stepdown: 1.5 }),
    heights: HEIGHTS,
    stock: { length: 300, width: 200, thickness: 6 },
    operation: {
      chain,
      closed: true,
      side,
      slotWidth,
      onZ: 0,
      depth: 6,
      through: true,
      tabs: { positions: tabCentres(chainLength(chain), { count: 4 }), width: 8, thickness: 2 },
    },
    strategy: {
      entry: 'ramp',
      rampAngle: 3,
      breakthrough: 0.5,
      finishAllowance: 0.2,
      direction: 'climb',
      leadRadius: 3,
    },
    maxFeedRate: RATES,
  })
  let moves = 0
  const outside = median(9, () => {
    const tp = generateRegionProfile(input('outside', 14), port).unwrap()
    moves = tp.passes.reduce((s, p) => s + p.moves.length, 0)
  })
  const on = median(9, () => generateRegionProfile(input('on', 12), port).unwrap())
  console.log(
    `enclosure outline (${chain.elements.length} elements), D6, 5 levels, 4 tabs: outside 14 mm ` +
      `slot + finishing ${outside.toFixed(1)} ms (${moves} moves), on 12 mm ${on.toFixed(1)} ms ` +
      '(budget 500 ms)',
  )
  expect(outside).toBeLessThanOrEqual(500)
  expect(on).toBeLessThanOrEqual(500)
})
