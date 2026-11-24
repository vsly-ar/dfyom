// Test-only STL writers and meshes (not app code). Doc: docs/modes/reference-model.md#testing-task-r2
// Node is reached through `process.getBuiltinModule`, so src/core keeps no Node imports
// (as src/core/geometry/testing/node-wasm.ts).

/** A triangle soup: 9 floats per triangle. */
export type Soup = readonly number[] | Float32Array

/** A real binary STL (49 806 triangles, header "MESH-MESH-…", not "solid"; 2.5 MB). */
export const ENCLOSURE_STL = new URL('./__fixtures__/enclosure-wood-base.stl', import.meta.url)
export const ENCLOSURE_TRIANGLES = 49_806

interface NodeProcess {
  getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL): Uint8Array }
}

export function enclosureStl(): Uint8Array {
  const proc = (globalThis as unknown as { process: NodeProcess }).process
  return new Uint8Array(proc.getBuiltinModule('node:fs').readFileSync(ENCLOSURE_STL))
}

/**
 * The black-box test's full enclosure body (DF60 Q71; binary STL, 77 112 triangles, 249.5 ×
 * 177.1 × 60.52 mm, centred in x/y, bottom at z = 0, cavity open upwards; 3.9 MB, kept as is so
 * its facets are the real export's).
 */
export const ENCLOSURE_FULL_STL = new URL('./__fixtures__/enclosure-wood-full.stl', import.meta.url)
export const ENCLOSURE_FULL_TRIANGLES = 77_112

export function enclosureFullStl(): Uint8Array {
  const proc = (globalThis as unknown as { process: NodeProcess }).process
  return new Uint8Array(proc.getBuiltinModule('node:fs').readFileSync(ENCLOSURE_FULL_STL))
}

export function binaryStl(soup: Soup, header = 'binary test'): Uint8Array {
  const n = soup.length / 9
  const out = new Uint8Array(84 + 50 * n)
  out.set(new TextEncoder().encode(header).subarray(0, 80))
  const view = new DataView(out.buffer)
  view.setUint32(80, n, true)
  for (let t = 0; t < n; t++)
    for (let k = 0; k < 9; k++) view.setFloat32(84 + t * 50 + 12 + k * 4, soup[t * 9 + k]!, true)
  return out
}

export function asciiStl(soup: Soup, name = 'test'): Uint8Array {
  const lines = [`solid ${name}`]
  for (let t = 0; t < soup.length / 9; t++) {
    lines.push('  facet normal 0 0 0', '    outer loop')
    for (let v = 0; v < 3; v++) {
      const i = t * 9 + v * 3
      lines.push(`      vertex ${soup[i]} ${soup[i + 1]} ${soup[i + 2]}`)
    }
    lines.push('    endloop', '  endfacet')
  }
  lines.push(`endsolid ${name}`, '')
  return new TextEncoder().encode(lines.join('\r\n'))
}

/** An axis-aligned box `0..x × 0..y × 0..z`, closed and outward oriented (12 triangles). */
export function boxSoup(x: number, y: number, z: number): number[] {
  const p = (i: number) => [i & 1 ? x : 0, i & 2 ? y : 0, i & 4 ? z : 0]
  // quads counter-clockwise seen from outside
  const quads = [
    [0, 2, 3, 1], // bottom (−z)
    [4, 5, 7, 6], // top (+z)
    [0, 1, 5, 4], // front (−y)
    [2, 6, 7, 3], // back (+y)
    [0, 4, 6, 2], // left (−x)
    [1, 3, 7, 5], // right (+x)
  ]
  return quads.flatMap(([a, b, c, d]) => [
    ...p(a!),
    ...p(b!),
    ...p(c!),
    ...p(a!),
    ...p(c!),
    ...p(d!),
  ])
}

/** Triangle soup of an indexed mesh (e.g. an evaluated part). */
export function soupOf(positions: Float32Array, indices: Uint32Array): Float32Array {
  const out = new Float32Array(indices.length * 3)
  for (let i = 0; i < indices.length; i++)
    for (let k = 0; k < 3; k++) out[i * 3 + k] = positions[indices[i]! * 3 + k]!
  return out
}
