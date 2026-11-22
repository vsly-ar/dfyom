/**
 * 2D port timings against the shapes budgets (docs/architecture/shapes.md#performance), outside
 * `npm run check` because timings are flaky in CI. Run: `npm run perf`. K1 measures the port's
 * share of each budget; resolveShape (K2) and the pocket generator (T-lane) add theirs.
 */
import { expect, it } from 'vitest'
import { loadRegion2dSync } from './cavalier'
import { regionLoops, type Loop, type Region } from './model'
import type { Region2dPort } from './port'
import { circle, hole, rect, star } from './testing/fixtures'
import { nodeCavalierWasm } from './testing/node-wasm'

function median(n: number, fn: () => void): number {
  for (let i = 0; i < 5; i++) fn()
  const times: number[] = []
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    fn()
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(n / 2)]!
}

/** A 200-element shape built as resolveShape will: items folded by the port, then normalised. */
function resolve200(port: Region2dPort): Region {
  const [outer, ...islands] = star(196) as [Loop, ...Loop[]]
  let r = port.normalise([outer]).unwrap()
  r = port.union(r, port.normalise([rect(-120, -10, 40, 20, 2)]).unwrap()).unwrap()
  for (const i of islands) r = port.difference(r, port.normalise([hole(i)]).unwrap()).unwrap()
  return port.normalise(regionLoops(r)).unwrap()
}

/** Parameter checks of one tool radius R: width (offset by R) and rest material (an opening). */
function checks(port: Region2dPort, r: Region, radius: number): void {
  const inner = port.offset(r, radius).unwrap()
  const opened = port.offset(inner, -radius).unwrap()
  port.difference(r, opened).unwrap()
}

it('meets the shapes budgets with the port share', () => {
  const t0 = performance.now()
  const port = loadRegion2dSync(nodeCavalierWasm()).unwrap()
  const load = performance.now() - t0

  const shape = resolve200(port)
  const elements = regionLoops(shape).reduce((s, l) => s + l.elements.length, 0)
  const resolveMs = median(50, () => resolve200(port))
  const checkMs = median(50, () => checks(port, shape, 3))

  // pocket rings of the spike's star (200 + 2 islands): tool r 3, stepover 2.4, until empty
  const pocket = port.normalise(star(200)).unwrap()
  let rings = 0
  const ringsMs = median(20, () => {
    rings = 0
    for (let ring = port.offset(pocket, 3).unwrap(); ring.pieces.length > 0; rings++)
      ring = port.offset(ring, 2.4).unwrap()
  })

  const union2000 = median(5, () => {
    const [outer] = star(2000) as [Loop]
    port
      .union(port.normalise([outer]).unwrap(), port.normalise([circle(95, 0, 10)]).unwrap())
      .unwrap()
  })

  console.log(
    [
      `WASM load (sync compile + instantiate) ${load.toFixed(1)} ms`,
      `resolve of a ${elements}-element shape ${resolveMs.toFixed(2)} ms + checks of one tool ` +
        `${checkMs.toFixed(2)} ms (budget for both 3 ms)`,
      `pocket rings of the star 200 + 2 islands: ${rings} rings in ${ringsMs.toFixed(2)} ms ` +
        `(pocket toolpath budget 500 ms)`,
      `union with a 2000-element star ${union2000.toFixed(1)} ms`,
    ].join('\n'),
  )
  expect(elements).toBeGreaterThanOrEqual(200)
  expect(resolveMs + checkMs).toBeLessThanOrEqual(3)
  expect(ringsMs).toBeLessThanOrEqual(50)
})
