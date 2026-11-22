/**
 * Spike S3: the stock box with every face split into tiles of their own face id (all labelled with
 * the face's surface). Manifold re-triangulates each crossed face as one polygon, which is
 * quadratic in the chords of a loop crossing it; tiles bound that polygon. Report:
 * spikes/prisms/results.md. Throwaway code.
 */
import type { LabelledMesh } from '../../src/core/geometry/loft'
import type { StockGeometry } from '../../src/core/geometry/model'

export interface TiledStock {
  readonly mesh: LabelledMesh
  /** Surface per face id: `air`, then one entry per tile (`top`, `bottom`, `side[i]`). */
  readonly surfaces: readonly string[]
}

/** Box 0..L × 0..W × −T..0 (part frame), tiles of at most `tile` mm along each edge. */
export function tiledStock(stock: StockGeometry, tile: number): TiledStock {
  const size = [stock.length, stock.width, stock.thickness]
  const n = size.map((s) => Math.max(1, Math.ceil(s / tile)))
  const coord = (axis: number, i: number) =>
    axis === 2 ? -stock.thickness + (stock.thickness * i) / n[2]! : (size[axis]! * i) / n[axis]!
  const index = new Map<string, number>()
  const pos: number[] = []
  const vertex = (ijk: number[]): number => {
    const key = ijk.join(',')
    let v = index.get(key)
    if (v === undefined) {
      v = pos.length / 3
      pos.push(coord(0, ijk[0]!), coord(1, ijk[1]!), coord(2, ijk[2]!))
      index.set(key, v)
    }
    return v
  }
  const surfaces = ['air']
  const tris: number[] = []
  const faces: number[] = []
  // (fixed axis, at max?, a, b) with a × b = outward normal; side[i] in the stock's wall order
  const sides: [string, number, boolean, number, number][] = [
    ['top', 2, true, 0, 1],
    ['bottom', 2, false, 1, 0],
    ['side[0]', 1, false, 0, 2],
    ['side[1]', 0, true, 1, 2],
    ['side[2]', 1, true, 2, 0],
    ['side[3]', 0, false, 2, 1],
  ]
  for (const [name, fixed, max, a, b] of sides)
    for (let i = 0; i < n[a]!; i++)
      for (let j = 0; j < n[b]!; j++) {
        const face = surfaces.length
        surfaces.push(name)
        const at = (di: number, dj: number) => {
          const ijk = [0, 0, 0]
          ijk[fixed] = max ? n[fixed]! : 0
          ijk[a] = i + di
          ijk[b] = j + dj
          return vertex(ijk)
        }
        const [p, q, r, s] = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)]
        tris.push(p, q, r, p, r, s)
        faces.push(face, face)
      }
  return {
    mesh: {
      positions: Float64Array.from(pos),
      triangles: Uint32Array.from(tris),
      faces: Uint32Array.from(faces),
    },
    surfaces,
  }
}
