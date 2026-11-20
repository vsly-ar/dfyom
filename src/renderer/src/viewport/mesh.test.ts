import { describe, expect, it } from 'vitest'
import {
  expandMesh,
  meshBounds,
  meshOperations,
  surfaceAtFace,
  surfaceOwner,
  unionBox,
  type ViewportMesh,
} from './mesh'
import { sampleMesh, sampleVolume, SAMPLE_STOCK } from './sample-mesh'

/** Two triangles of one plane (surface 0) and one perpendicular triangle (surface 1) sharing vertices 1 and 2. */
const tiny: ViewportMesh = {
  // prettier-ignore
  positions: new Float32Array([
    0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0, // z = 0 square
    1, 0, -1, // below vertex 1
  ]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3, 1, 4, 2]),
  triangleSurface: new Uint32Array([0, 0, 1]),
  surfaces: ['pocket1.floor', 'profile1.tab[0].top'],
}

describe('surface ids', () => {
  it('owner is the operation id before the first dot', () => {
    expect(surfaceOwner('pocket1.floor')).toBe('pocket1')
    expect(surfaceOwner('profile1.tab[0].top')).toBe('profile1')
    expect(surfaceOwner('stock.side[2]')).toBe('stock')
  })

  it('maps a raycast faceIndex through triangleSurface', () => {
    expect(surfaceAtFace(tiny, 0)).toEqual({ surface: 'pocket1.floor', operation: 'pocket1' })
    expect(surfaceAtFace(tiny, 1)?.surface).toBe('pocket1.floor')
    expect(surfaceAtFace(tiny, 2)).toEqual({
      surface: 'profile1.tab[0].top',
      operation: 'profile1',
    })
  })

  it('ignores missing and stale face indices', () => {
    expect(surfaceAtFace(tiny, undefined)).toBeUndefined()
    expect(surfaceAtFace(tiny, null)).toBeUndefined()
    expect(surfaceAtFace(tiny, -1)).toBeUndefined()
    expect(surfaceAtFace(tiny, 3)).toBeUndefined()
  })

  it('lists owning operations in mesh order', () => {
    expect(meshOperations(sampleMesh())).toEqual(['stock', 'drill1', 'drill2', 'pocket1'])
  })
})

describe('expandMesh', () => {
  it('is non-indexed in triangle order, so faceIndex = mesh triangle', () => {
    const b = expandMesh(tiny)
    expect(b.triangles).toBe(3)
    expect(b.positions.length).toBe(27)
    // triangle 2, corner 1 = vertex 4
    expect([...b.positions.subarray(21, 24)]).toEqual([1, 0, -1])
  })

  it('keeps normals per surface: no smoothing across surfaces', () => {
    const b = expandMesh(tiny)
    // the floor's corners stay +Z although triangle 2 (another surface) shares vertices 1 and 2
    for (let i = 0; i < 6; i++) expect([...b.normals.subarray(3 * i, 3 * i + 3)]).toEqual([0, 0, 1])
  })

  it('keeps a 90° edge inside one surface sharp', () => {
    const sharp: ViewportMesh = { ...tiny, triangleSurface: new Uint32Array([0, 0, 0]) }
    const s = expandMesh(sharp)
    expect([...s.normals.subarray(3, 6)]).toEqual([0, 0, 1])
    expect([...s.normals.subarray(18, 21)].map((x) => Math.round(x) + 0)).toEqual([1, 0, 0])
  })

  it('smooths a fine cylinder (drill wall normals are radial, not per face)', () => {
    const mesh = sampleMesh()
    const b = expandMesh(mesh)
    const wall = mesh.surfaces.indexOf('drill1.wall')
    let corners = 0
    for (let t = 0; t < b.triangles; t++) {
      if (mesh.triangleSurface[t] !== wall) continue
      for (let k = 0; k < 3; k++) {
        const o = 9 * t + 3 * k
        const [x, y, z] = [b.normals[o]!, b.normals[o + 1]!, b.normals[o + 2]!]
        expect(Math.abs(z)).toBeLessThan(1e-6)
        // radial: points from the vertex towards the hole axis (15, 30)
        const rx = 15 - b.positions[o]!
        const ry = 30 - b.positions[o + 1]!
        expect((x * rx + y * ry) / Math.hypot(rx, ry)).toBeCloseTo(1, 2)
        corners++
      }
    }
    expect(corners).toBeGreaterThan(0)
  })
})

describe('bounds', () => {
  it('measures the mesh and unites boxes', () => {
    expect(meshBounds(sampleMesh())).toEqual(SAMPLE_STOCK)
    expect(meshBounds({ ...tiny, positions: new Float32Array() })).toBeUndefined()
    expect(
      unionBox({ min: [0, 0, 0], max: [1, 1, 1] }, { min: [-1, 0, 0.5], max: [0.5, 2, 0.5] }),
    ).toEqual({ min: [-1, 0, 0], max: [1, 2, 1] })
    expect(unionBox(undefined, SAMPLE_STOCK)).toBe(SAMPLE_STOCK)
  })
})

describe('sample mesh', () => {
  it('is closed and outward-facing: its signed volume equals the analytic one', () => {
    const m = sampleMesh()
    const p = (i: number): [number, number, number] => [
      m.positions[3 * i]!,
      m.positions[3 * i + 1]!,
      m.positions[3 * i + 2]!,
    ]
    let v = 0
    for (let t = 0; t < m.indices.length / 3; t++) {
      const [a, b, c] = [p(m.indices[3 * t]!), p(m.indices[3 * t + 1]!), p(m.indices[3 * t + 2]!)]
      v +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6
    }
    expect(v).toBeCloseTo(sampleVolume(), 0)
  })

  it('labels every triangle with a design.md surface id', () => {
    const m = sampleMesh()
    expect(m.triangleSurface.length).toBe(m.indices.length / 3)
    expect(new Set(m.triangleSurface).size).toBe(m.surfaces.length)
    expect(m.surfaces).toEqual(
      expect.arrayContaining([
        'stock.top',
        'stock.bottom',
        'stock.side[0]',
        'pocket1.floor',
        'pocket1.wall[0]',
        'pocket1.corner[3]',
        'drill1.wall',
        'drill2.bottom',
      ]),
    )
  })
})
