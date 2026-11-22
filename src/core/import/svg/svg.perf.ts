/**
 * SVG import timings (docs/architecture/shapes.md#performance), outside `npm run check` because
 * timings are flaky in CI. Run: `npm run perf`. Drawings are generated in memory.
 */
import { expect, it } from 'vitest'
import { importSvg } from './import'

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

const head = 'xmlns="http://www.w3.org/2000/svg" width="300mm" height="300mm" viewBox="0 0 300 300"'

/** One closed path of `count` random G1 cubics on a ~200 mm circle (seeded, as S5's chain). */
function randomCubics(count: number, seed = 1): string {
  let s = seed
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
  const pts: [number, number][] = []
  for (let k = 0; k < count; k++) {
    const th = (2 * Math.PI * k) / count
    const r = 80 + 20 * rnd()
    pts.push([150 + r * Math.cos(th), 150 + r * Math.sin(th)])
  }
  const at = (k: number): [number, number] => pts[((k % count) + count) % count]!
  const f = (v: number): string => v.toFixed(4)
  let d = `M${f(at(0)[0])} ${f(at(0)[1])}`
  for (let k = 0; k < count; k++) {
    const [p0, p1, p2, p3] = [at(k - 1), at(k), at(k + 1), at(k + 2)]
    const w = 0.5 + rnd()
    d += ` C${f(p1[0] + (w * (p2[0] - p0[0])) / 6)} ${f(p1[1] + (w * (p2[1] - p0[1])) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`
  }
  return `<svg ${head}><path d="${d} Z"/></svg>`
}

it('2000 random cubics in one path: fitted within the element limit', () => {
  const svg = randomCubics(2000)
  let elements = 0
  const ms = median(5, () => {
    const r = importSvg(svg).unwrap()
    elements = r.report.lines + r.report.arcs
  })
  console.log(
    `2000 cubics: ${elements} elements, ${ms.toFixed(1)} ms (${((ms / 2000) * 1000).toFixed(0)} µs per cubic)`,
  )
  expect(elements).toBeLessThanOrEqual(20_000)
  expect(ms).toBeLessThan(500)
})

it('a 10 MB file of 2400 rounded rectangles under editor metadata', () => {
  const rects: string[] = []
  for (let k = 0; k < 2400; k++)
    rects.push(
      `<rect id="r${k}" x="${(k % 60) * 5}" y="${Math.floor(k / 60) * 4}" width="3" height="2" rx="0.5"/>`,
    )
  const pad = `<!-- ${'metadata '.repeat(1_120_000)} -->`
  const svg = `<svg ${head}>${pad}<g>${rects.join('\n')}</g></svg>`
  const mb = svg.length / 2 ** 20
  let shapes = 0
  const ms = median(3, () => {
    shapes = importSvg(svg, { split: 'loop' }).unwrap().shapes.length
  })
  console.log(
    `${mb.toFixed(1)} MB, 2400 rounded rects (19 200 elements): ${shapes} shapes, ${ms.toFixed(0)} ms`,
  )
  expect(mb).toBeLessThan(10)
  expect(shapes).toBe(2400)
  expect(ms).toBeLessThan(1500)
})

it('fill repair: 60 overlapping circles in one path (nonzero union)', () => {
  let d = ''
  for (let k = 0; k < 60; k++) {
    const cx = 150 + 60 * Math.cos((2 * Math.PI * k) / 60)
    const cy = 150 + 60 * Math.sin((2 * Math.PI * k) / 60)
    d += `M${cx + 12} ${cy} A12 12 0 1 0 ${cx - 12} ${cy} A12 12 0 1 0 ${cx + 12} ${cy} Z `
  }
  const svg = `<svg ${head}><path d="${d}"/></svg>`
  let items = 0
  const ms = median(5, () => {
    items = importSvg(svg).unwrap().shapes[0]!.items.length
  })
  console.log(`60 overlapping circles repaired into ${items} loops: ${ms.toFixed(1)} ms`)
  expect(items).toBe(2)
  expect(ms).toBeLessThan(500)
})
