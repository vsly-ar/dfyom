/**
 * resolveShape against the command budget (docs/architecture/shapes.md#performance): resolve +
 * parameter checks of a 200-element shape ≤ 3 ms, of which the port takes ≈ 2 ms
 * (geometry/2d/region2d.perf.ts). Outside `npm run check` (timings are flaky in CI): `npm run perf`.
 */
import { expect, it } from 'vitest'
import type { Vec2 } from '../geometry/model'
import { loadRegion2dSync } from '../geometry/2d/cavalier'
import { regionLoops, type Region } from '../geometry/2d/model'
import type { Region2dPort } from '../geometry/2d/port'
import { nodeCavalierWasm } from '../geometry/2d/testing/node-wasm'
import { designSetup } from './design.fixture'
import { mapItem, resolveDefinition, resolveShape, type ShapeDefinition } from './shape'
import type { ShapeItem } from './shape.dto'

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

/**
 * The spike's star as a user would enter it: a closed path of `corners` lines with a 0.6 mm
 * fillet at every vertex (2 elements per corner), plus a rectangle added and two islands.
 */
function starShape(corners: number, scale = 1): ShapeDefinition {
  const pts: Vec2[] = []
  for (let i = 0; i < corners; i++) {
    const a = (2 * i * Math.PI) / corners
    const r = (i % 2 === 0 ? 100 : 88) * scale
    pts.push([r * Math.cos(a), r * Math.sin(a)])
  }
  const star: ShapeItem<number> = {
    kind: 'path',
    op: 'add',
    start: [pts[0]![0], pts[0]![1]],
    segments: pts.slice(1).map((p) => ({ kind: 'line', to: [p[0], p[1]] })),
    closed: true,
    fillets: pts.map((_, vertex) => ({ vertex, radius: 0.6 })),
  }
  return [
    star,
    { kind: 'rectangle', op: 'add', center: [-100, 0], length: 40, width: 20, cornerRadius: 2 },
    { kind: 'circle', op: 'subtract', center: [-30, 0], diameter: 36 },
    {
      kind: 'rectangle',
      op: 'subtract',
      center: [32.5, 0],
      length: 35,
      width: 40,
      cornerRadius: 5,
    },
  ]
}

/** Parameter checks of one tool radius R as K1 measured them: width and rest material. */
function checks(port: Region2dPort, r: Region, radius: number): void {
  const inner = port.offset(r, radius).unwrap()
  const opened = port.offset(inner, -radius).unwrap()
  port.difference(r, opened).unwrap()
}

it('resolves a 200-element shape within the command budget', () => {
  const port = loadRegion2dSync(nodeCavalierWasm()).unwrap()
  const def = starShape(98)
  const r = resolveDefinition(port, def).unwrap()
  if (r.kind !== 'region') throw new Error('expected a region')
  const elements = regionLoops(r.region).reduce((s, l) => s + l.elements.length, 0)
  const resolveMs = median(50, () => resolveDefinition(port, def).unwrap())
  const checkMs = median(50, () => checks(port, r.region, 3))
  // the share of resolveShape itself: items to chains, fillets, the crossing test (no port)
  let k = 0
  const cachedMs = median(50, () => resolveShape(port, starShape(98, 1 + ++k * 1e-9)))
  const hitMs = median(200, () => resolveShape(port, def))
  console.log(
    [
      `resolveShape of a ${elements}-element shape (98-corner filleted path + 3 items) ` +
        `${resolveMs.toFixed(2)} ms uncached, ${cachedMs.toFixed(2)} ms on a cache miss ` +
        `(key included), ${(hitMs * 1000).toFixed(0)} µs on a hit`,
      `+ checks of one tool ${checkMs.toFixed(2)} ms = ${(resolveMs + checkMs).toFixed(2)} ms ` +
        `(budget 3 ms)`,
    ].join('\n'),
  )
  expect(elements).toBeGreaterThanOrEqual(200)
  expect(resolveMs + checkMs).toBeLessThanOrEqual(3)
})

it('edits one item of a 200-element shape through the dispatcher', async () => {
  const port = loadRegion2dSync(nodeCavalierWasm()).unwrap()
  const s = await designSetup({ services: { region2d: port } })
  const src = (v: number) => String(Math.round(v * 1e6) / 1e6)
  const items = starShape(98).map((item) => mapItem(item, (v) => src(v)))
  await s.run('design.shape.add', { partId: s.partId, items })
  let w = 40
  const edit = () =>
    s.run('design.shape.item.update', {
      partId: s.partId,
      shapeId: 'shape1',
      index: 1,
      length: String(++w),
    })
  for (let i = 0; i < 5; i++) await edit()
  const times: number[] = []
  for (let i = 0; i < 30; i++) {
    const t = performance.now()
    await edit()
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  const editMs = times[15]!
  console.log(
    `design.shape.item.update of one item of the 205-element shape: ${editMs.toFixed(2)} ms per ` +
      'command (parse, load of the other items, resolve on a cache miss, warnings, commit)',
  )
  expect(editMs).toBeLessThanOrEqual(10)
})
