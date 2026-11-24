/**
 * Safe links against their budget (docs/modes/safe-links.md#performance: < 1 s per setup for a
 * large program, < 100 ms for the exit-criteria programs), outside `npm run check` because timings
 * are flaky in CI. Run: `npm run perf`.
 */
import { expect, it } from 'vitest'
import { generateFacing } from './facing'
import { planLinks, type LinkOperation, type LinkSettings } from './links'
import type { Toolpath, ToolpathTool } from './model'
import { generatePocket } from './pocket'
import { cutting, endMill, facingInput, pocketInput, RATES } from './testing/fixtures'
import { testPartToolpaths } from './testing/test-part'
import { TEST_STOCK } from '../geometry/testing/test-part'

function median(n: number, fn: () => void): number {
  fn()
  const times: number[] = []
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    fn()
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(n / 2)]!
}

const segments = (tps: readonly Toolpath[]) =>
  tps.reduce((s, tp) => s + tp.passes.reduce((k, p) => k + p.moves.length, 0), 0)

const settings = (stock: { length: number; width: number; thickness: number }): LinkSettings => ({
  retraction: 'minimum',
  clearance: 10,
  margin: 2,
  clampHeight: 0,
  stock: [stock.length, stock.width, stock.thickness],
  rates: [...RATES],
})

it('links a large setup within 1 s and the test part within 100 ms', () => {
  // a 250 × 100 × 20 mm block faced 2 mm deep in 0.25 mm steps with a 3 mm flat at 25 % stepover,
  // then 24 rectangular pockets 12 mm deep in 0.25 mm steps with the same tool (one tool run: 24
  // links): ≈ 77 000 moves, half the lines of the user's largest setup (148 615), arcs included
  const stock = { length: 250, width: 100, thickness: 20 }
  const tool: ToolpathTool = endMill(3)
  const facing = generateFacing(
    facingInput(stock, tool, {
      cutting: cutting(tool, { stepover: 0.75, stepdown: 0.25 }),
      operation: { kind: 'facing', id: 'f', depth: 2 },
    }),
  ).unwrap()
  const pockets: Toolpath[] = []
  for (let i = 0; i < 12; i++)
    for (const y of [30, 70])
      pockets.push(
        generatePocket(
          pocketInput(
            stock,
            {
              kind: 'pocket',
              id: `p${i}${y}`,
              onZ: -2,
              shape: {
                center: [15 + i * 20, y],
                contour: { kind: 'rectangle', length: 16, width: 30, cornerRadius: 2 },
              },
              depth: 12,
              floorRadius: 0,
            },
            tool,
            { cutting: cutting(tool, { stepover: 0.75, stepdown: 0.25 }) },
          ),
        ).unwrap(),
      )
  const large = [facing, ...pockets]
  const ops = (tps: readonly Toolpath[], tools: readonly ToolpathTool[]): LinkOperation[] =>
    tps.map((toolpath, i) => ({
      toolpath,
      tool: tools[i]!,
      pauseBefore: i === 0 || tools[i - 1]!.id !== tools[i]!.id,
    }))
  const largeOps = ops(
    large,
    large.map(() => tool),
  )
  let low = 0
  const ms = median(5, () => {
    low = planLinks(largeOps, settings(stock)).summary.low
  })
  const part = testPartToolpaths()
  const partOps = ops(
    part.map((p) => p.tp),
    part.map((p) => p.tool),
  )
  const partMs = median(9, () => planLinks(partOps, settings(TEST_STOCK)))
  console.log(
    [
      `large setup: ${segments(large)} moves, ${large.length} operations, ${low} links low: ${ms.toFixed(0)} ms (budget 1000 ms)`,
      `geometry test part: ${segments(part.map((p) => p.tp))} moves: ${partMs.toFixed(1)} ms (budget 100 ms)`,
    ].join('\n'),
  )
  expect(low).toBeGreaterThan(0)
  expect(ms).toBeLessThan(1000)
  expect(partMs).toBeLessThan(100)
})
