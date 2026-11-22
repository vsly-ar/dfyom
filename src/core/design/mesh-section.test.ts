// The reference section and the ghost's feature edges (task U3).
// Doc: docs/modes/design-v0.3.md#implementation-u3
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createInProcessWorkers, memoryFiles } from '../commands/jobs'
import { aborted } from '../workers/steps'
import { referenceSection, stlMesh } from '../workers/tasks'
import { featureEdges, meshSection } from './mesh-section'
import { parseStl } from './stl'
import { binaryStl, boxSoup, ENCLOSURE_TRIANGLES, enclosureStl } from './stl.testing'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** Segments as rounded `[[u0, v0], [u1, v1]]` pairs, each pair and the list sorted. */
function pairs(s: Float32Array): number[][][] {
  const out: number[][][] = []
  for (let i = 0; i < s.length; i += 4) {
    const a = [+s[i]!.toFixed(4), +s[i + 1]!.toFixed(4)]
    const b = [+s[i + 2]!.toFixed(4), +s[i + 3]!.toFixed(4)]
    out.push([a, b].sort((p, q) => p[0]! - q[0]! || p[1]! - q[1]!))
  }
  return out.sort((p, q) => JSON.stringify(p).localeCompare(JSON.stringify(q)))
}

describe('meshSection', () => {
  const box = Float32Array.from(boxSoup(40, 20, 10))

  it('cuts a box into its rectangle at any level inside it', () => {
    const s = expectOk(meshSection(box, IDENTITY, 4))
    expect(s.length / 4).toBe(8) // two triangles per side face
    let len = 0
    for (let i = 0; i < s.length; i += 4)
      len += Math.hypot(s[i + 2]! - s[i]!, s[i + 3]! - s[i + 1]!)
    expect(len).toBeCloseTo(120, 4)
    for (const v of s) expect([0, 20, 40].some((x) => Math.abs(v - x) < 1e-4) || v > 0).toBe(true)
  })

  it('gives nothing above or below the mesh, and no duplicates at a vertex level', () => {
    expect(expectOk(meshSection(box, IDENTITY, 11)).length).toBe(0)
    expect(expectOk(meshSection(box, IDENTITY, -1)).length).toBe(0)
    // the top face's level gives its border once, through the side faces; the bottom face's
    // level touches the mesh from above (on the plane counts as above): nothing
    expect(expectOk(meshSection(box, IDENTITY, 0)).length).toBe(0)
    const s = expectOk(meshSection(box, IDENTITY, 10))
    let len = 0
    for (let i = 0; i < s.length; i += 4)
      len += Math.hypot(s[i + 2]! - s[i]!, s[i + 3]! - s[i + 1]!)
    expect(len).toBeCloseTo(120, 4)
  })

  it('applies the matrix first: a turned and moved box cut in the new frame', () => {
    // rotate +90° about x (y → z) and move by (5, 0, 0): the box stands 20 high, 10 deep
    const m = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 5, 0, 0, 1]
    const s = expectOk(meshSection(box, m, 15))
    expect(
      pairs(s)
        .flat()
        .flat()
        .every((v) => v >= -10 - 1e-4 && v <= 45 + 1e-4),
    ).toBe(true)
    const us = [...s].filter((_, i) => i % 2 === 0)
    const vs = [...s].filter((_, i) => i % 2 === 1)
    expect(Math.min(...us)).toBeCloseTo(5)
    expect(Math.max(...us)).toBeCloseTo(45)
    expect(Math.min(...vs)).toBeCloseTo(-10)
    expect(Math.max(...vs)).toBeCloseTo(0)
  })

  it('stops between steps when aborted', () => {
    const big = new Float32Array(9 * 120_000)
    let calls = 0
    const r = meshSection(big, IDENTITY, 0, {
      step: () => (++calls > 1 ? aborted() : Ok(undefined)),
    })
    expectErrCode(r, 'op.aborted')
  })

  it('sections the enclosure at mid-wall height into its outline and cavity', () => {
    const bytes = enclosureStl()
    const summary = expectOk(parseStl(bytes))
    const positions = readPositions(bytes)
    const mid = (summary.bounds.min.z + summary.bounds.max.z) / 2
    const s = expectOk(meshSection(positions, IDENTITY, mid))
    expect(s.length).toBeGreaterThan(400)
    const us = [...s].filter((_, i) => i % 2 === 0)
    const span = Math.max(...us) - Math.min(...us)
    // 249.5 mm long, less the bevel at the bottom edge
    expect(span).toBeGreaterThan(240)
    expect(span).toBeLessThanOrEqual(summary.bounds.max.x - summary.bounds.min.x + 1e-3)
  })
})

function readPositions(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const n = view.getUint32(80, true)
  const out = new Float32Array(n * 9)
  for (let t = 0; t < n; t++)
    for (let k = 0; k < 9; k++) out[t * 9 + k] = view.getFloat32(84 + t * 50 + 12 + k * 4, true)
  return out
}

describe('featureEdges', () => {
  it('finds the 12 edges of a box, not the face diagonals', () => {
    const e = expectOk(featureEdges(Float32Array.from(boxSoup(40, 20, 10))))
    expect(e.length / 6).toBe(12)
  })

  it('keeps open borders and skips degenerate faces', () => {
    // one square of two triangles: 4 border edges, the diagonal is smooth
    const quad = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0])
    expect(expectOk(featureEdges(quad)).length / 6).toBe(4)
    const degenerate = Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0])
    expect(expectOk(featureEdges(degenerate)).length).toBe(0)
  })

  it('sends edges with the ghost mesh and sections the stored file in the worker', async () => {
    const bytes = enclosureStl()
    const workers = createInProcessWorkers({ files: memoryFiles(new Map([['/e.stl', bytes]])) })
    const ctl = { signal: new AbortController().signal, progress: () => undefined }
    const t0 = performance.now()
    const mesh = expectOk(
      await workers.run(stlMesh, { path: '/e.stl', triangles: ENCLOSURE_TRIANGLES }, ctl),
    )
    expect(performance.now() - t0).toBeLessThan(5_000)
    expect(mesh.edges.length % 6).toBe(0)
    expect(mesh.edges.length / 6).toBeGreaterThan(100)
    const section = expectOk(
      await workers.run(
        referenceSection,
        { path: '/e.stl', triangles: ENCLOSURE_TRIANGLES, matrix: IDENTITY, level: 20 },
        ctl,
      ),
    )
    expect(section.segments.length).toBeGreaterThan(400)
    // a second depth comes from the kept mesh: an unreadable path is not read again
    const again = expectOk(
      await workers.run(
        referenceSection,
        { path: '/e.stl', triangles: ENCLOSURE_TRIANGLES, matrix: IDENTITY, level: 100 },
        ctl,
      ),
    )
    expect(again.segments.length).toBe(0)
  })

  it('a small binary file round-trips through the section task', async () => {
    const workers = createInProcessWorkers({
      files: memoryFiles(new Map([['/b.stl', binaryStl(boxSoup(40, 20, 10))]])),
    })
    const ctl = { signal: new AbortController().signal, progress: () => undefined }
    const r = expectOk(
      await workers.run(
        referenceSection,
        { path: '/b.stl', triangles: 12, matrix: IDENTITY, level: 5 },
        ctl,
      ),
    )
    expect(r.segments.length / 4).toBe(8)
  })
})
