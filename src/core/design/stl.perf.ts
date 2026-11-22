/**
 * STL parser timings behind the reference-model limits (docs/modes/reference-model.md#performance),
 * outside `npm run check` because timings are flaky in CI. Run: `npm run perf`.
 * Files are generated in memory and fed in 1 MB chunks, as the worker reads them.
 */
import { expect, it } from 'vitest'
import { createStlParser, type StlSummary } from './stl'
import { enclosureStl } from './stl.testing'

const MB = 2 ** 20
const CHUNK = MB

interface NodeProcess {
  memoryUsage(): { rss: number; heapUsed: number; arrayBuffers: number }
}
const proc = (globalThis as unknown as { process: NodeProcess }).process

/** A binary STL of `n` triangles on a grid (an open sheet; content does not matter for speed). */
function binary(n: number): Uint8Array {
  const out = new Uint8Array(84 + 50 * n)
  const v = new DataView(out.buffer)
  v.setUint32(80, n, true)
  for (let t = 0; t < n; t++) {
    const x = t % 1000
    const y = Math.floor(t / 1000)
    const p = [x, y, 0, x + 1, y, 0, x, y + 1, 0.5]
    for (let k = 0; k < 9; k++) v.setFloat32(84 + t * 50 + 12 + k * 4, p[k]!, true)
  }
  return out
}

function ascii(n: number): Uint8Array {
  const parts: string[] = ['solid perf\n']
  for (let t = 0; t < n; t++) {
    const x = t % 1000
    const y = Math.floor(t / 1000)
    parts.push(
      `facet normal 0 0 1\n outer loop\n  vertex ${x}.125 ${y}.25 0\n  vertex ${x + 1}.125 ${y}.25 0\n  vertex ${x}.125 ${y + 1}.25 0.5\n endloop\nendfacet\n`,
    )
  }
  parts.push('endsolid perf\n')
  return new TextEncoder().encode(parts.join(''))
}

function measure(label: string, bytes: Uint8Array): { ms: number; s: StlSummary } {
  const heap0 = proc.memoryUsage().heapUsed
  const t0 = performance.now()
  const p = createStlParser(bytes.length).unwrap()
  for (let i = 0; i < bytes.length; i += CHUNK) p.push(bytes.subarray(i, i + CHUNK)).unwrap()
  const s = p.finish().unwrap()
  const ms = performance.now() - t0
  const heap = (proc.memoryUsage().heapUsed - heap0) / MB
  console.log(
    `${label}: ${s.triangles} triangles, ${(bytes.length / MB).toFixed(1)} MB, ${ms.toFixed(0)} ms, ` +
      `heap +${heap.toFixed(1)} MB (parser state is constant; the file is the caller's)`,
  )
  return { ms, s }
}

it('binary STL: 1 M triangles under 1 s; the 5 M limit stays usable', () => {
  measure('enclosure (real file)', enclosureStl())
  const one = measure('binary 1 M', binary(1_000_000))
  const five = measure('binary 5 M', binary(5_000_000))
  measure('ascii 1 M', ascii(1_000_000))
  expect(one.ms).toBeLessThan(1000)
  expect(five.s.triangles).toBe(5_000_000)
})
