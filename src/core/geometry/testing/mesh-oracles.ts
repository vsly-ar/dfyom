/**
 * Mesh oracles for geometry tests: closedness and volume computed straight from the triangles,
 * independent of the code under test. Doc: docs/architecture/geometry.md#testing
 */
import type { LabelledMesh } from '../loft'

/** Every directed edge must have exactly one opposite edge: closed and consistently oriented. */
export function openEdges(mesh: Pick<LabelledMesh, 'triangles'>): number {
  const count = new Map<string, number>()
  const t = mesh.triangles
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = t[i + k]!
      const b = t[i + ((k + 1) % 3)]!
      const key = `${a},${b}`
      count.set(key, (count.get(key) ?? 0) + 1)
    }
  }
  let bad = 0
  for (const [key, n] of count) {
    const [a, b] = key.split(',')
    if (n !== 1 || count.get(`${b},${a}`) !== 1) bad++
  }
  return bad
}

/** Signed volume by the divergence theorem (positive for outward-facing triangles). */
export function signedVolume(mesh: Pick<LabelledMesh, 'positions' | 'triangles'>): number {
  const p = mesh.positions
  const t = mesh.triangles
  let v = 0
  for (let i = 0; i < t.length; i += 3) {
    const a = 3 * t[i]!
    const b = 3 * t[i + 1]!
    const c = 3 * t[i + 2]!
    v +=
      p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
      p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
      p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)
  }
  return v / 6
}

/** Number of triangles per face label. */
export function faceCounts(mesh: Pick<LabelledMesh, 'faces'>): Map<number, number> {
  const m = new Map<number, number>()
  for (const f of mesh.faces) m.set(f, (m.get(f) ?? 0) + 1)
  return m
}

/** Area of a centered rounded rectangle. */
export function roundedRectArea(length: number, width: number, r: number): number {
  return length * width - (4 - Math.PI) * r * r
}
