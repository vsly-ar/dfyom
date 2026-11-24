// Depth levels of a reference mesh (DF60 P1): grouping flat faces by height, both sides, visible
// area under an overhang, minArea / limit / more, and the enclosure's floors.
// Spec: docs/modes/reference-tools.md#test-plans (P1 levels)
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { levelTriangles, meshLevels, type MeshLevel } from './mesh-levels'
import { createStlParser, STL_LIMITS, StlPositions } from './stl'
import { ENCLOSURE_FULL_TRIANGLES, enclosureFullStl } from './stl.testing'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** A flat rectangle at height w, its normal up (+w) or down. */
function quad(u0: number, v0: number, u1: number, v1: number, w: number, up: boolean): number[] {
  const a = [u0, v0, w]
  const b = [u1, v0, w]
  const c = [u1, v1, w]
  const d = [u0, v1, w]
  return up ? [...a, ...b, ...c, ...a, ...c, ...d] : [...a, ...c, ...b, ...a, ...d, ...c]
}

/**
 * A stepped block seen from its top face (w = 0, extent 8): the top at 0 over u 0..10, a floor at
 * −3 over u 10..20, the bottom at −8; a slab over the floor (u 12..16) with its top at −1 and
 * its underside at −2 (an overhang).
 */
const STEPPED = Float32Array.from([
  ...quad(0, 0, 10, 10, 0, true),
  ...quad(10, 0, 20, 10, -3, true),
  ...quad(0, 0, 20, 10, -8, false),
  ...quad(12, 0, 16, 10, -1, true),
  ...quad(12, 0, 16, 10, -2, false),
])
const OPTS = { minArea: 1, limit: 32, sides: 'both' as const, extent: 8 }

const at = (levels: readonly MeshLevel[], depth: number, facing: MeshLevel['facing']) => {
  const l = levels.find((x) => Math.abs(x.depth - depth) < 1e-3 && x.facing === facing)
  expect(l, `${facing} level at ${depth}`).toBeDefined()
  return l!
}

describe('levelTriangles', () => {
  it('gives the triangles of one level and side, in the source positions (the hover highlight)', () => {
    const floor = levelTriangles(STEPPED, IDENTITY, 3, 'face')
    expect(Array.from(floor)).toEqual(quad(10, 0, 20, 10, -3, true))
    // the overhang's underside faces the opposite side; nothing faces the face at −2
    expect(levelTriangles(STEPPED, IDENTITY, 2, 'opposite')).toHaveLength(18)
    expect(levelTriangles(STEPPED, IDENTITY, 2, 'face')).toHaveLength(0)
    // through a matrix (source in cm, ×10): the same triangles come back unchanged
    const cm = STEPPED.map((x) => x / 10)
    const scale = [10, 0, 0, 0, 0, 10, 0, 0, 0, 0, 10, 0, 0, 0, 0, 1]
    expect(Array.from(levelTriangles(cm, scale, 3, 'face'))).toEqual(
      Array.from(Float32Array.from(quad(10, 0, 20, 10, -3, true).map((x) => x / 10))),
    )
  })
})

describe('meshLevels', () => {
  it('finds each floor with its depth and area, from both sides, sorted by depth', () => {
    const { levels, more } = expectOk(meshLevels(STEPPED, IDENTITY, OPTS))
    expect(more).toBeUndefined()
    expect(levels.map((l) => [l.depth, l.facing])).toEqual([
      [0, 'face'],
      [1, 'face'],
      [2, 'opposite'],
      [3, 'face'],
      [8, 'opposite'],
    ])
    expect(at(levels, 0, 'face')).toMatchObject({
      area: 100,
      bounds: [
        [0, 0],
        [10, 10],
      ],
    })
    expect(at(levels, 3, 'face').area).toBe(100)
    expect(at(levels, 8, 'opposite')).toMatchObject({ area: 200, depthFromOpposite: 0 })
    expect(at(levels, 2, 'opposite').depthFromOpposite).toBe(6)
  })

  it('a floor under an overhang is partly visible; the overhang underside not at all from below', () => {
    const { levels } = expectOk(meshLevels(STEPPED, IDENTITY, OPTS))
    expect(at(levels, 0, 'face').visibleArea).toBe(100)
    // the slab covers 40 of the floor's 100 mm² (grid sampling: within a cell row)
    expect(at(levels, 3, 'face').visibleArea).toBeCloseTo(60, 0)
    // below the slab's underside lies the floor: an undercut for work from the bottom
    expect(at(levels, 2, 'opposite').visibleArea).toBe(0)
    expect(at(levels, 8, 'opposite').visibleArea).toBe(200)
  })

  it('sides: face keeps only the levels facing the face', () => {
    const { levels } = expectOk(meshLevels(STEPPED, IDENTITY, { ...OPTS, sides: 'face' }))
    expect(levels.every((l) => l.facing === 'face')).toBe(true)
    expect(levels).toHaveLength(3)
  })

  it('minArea drops small levels; limit keeps the largest and reports more', () => {
    const big = expectOk(meshLevels(STEPPED, IDENTITY, { ...OPTS, minArea: 50 }))
    expect(big.levels.map((l) => l.depth)).toEqual([0, 3, 8])
    const two = expectOk(meshLevels(STEPPED, IDENTITY, { ...OPTS, limit: 2 }))
    expect(two.more).toBe(3)
    expect(two.levels.map((l) => l.depth)).toEqual([3, 8]) // 200 and 100 mm² (of the two 100 mm² levels the lower comes first)
  })

  it('joins faces within 0.005 mm of each other into one level', () => {
    const soup = Float32Array.from([
      ...quad(0, 0, 10, 10, -5, true),
      ...quad(10, 0, 20, 10, -5.004, true),
      ...quad(20, 0, 30, 10, -5.02, true),
    ])
    const { levels } = expectOk(meshLevels(soup, IDENTITY, OPTS))
    expect(levels.map((l) => [l.depth, l.area])).toEqual([
      [5.002, 200],
      [5.02, 100],
    ])
  })

  it('the enclosure from its top: rim, cavity floor and the bottom steps', () => {
    const bytes = enclosureFullStl()
    const keep = new StlPositions(ENCLOSURE_FULL_TRIANGLES)
    const p = expectOk(createStlParser(bytes.length, STL_LIMITS, keep.add))
    expectOk(p.push(bytes))
    expectOk(p.finish())
    const top = 60.523
    const matrix = [...IDENTITY.slice(0, 12), 0, 0, -top, 1]
    const t0 = performance.now()
    const { levels } = expectOk(meshLevels(keep.positions(), matrix, { ...OPTS, extent: top }))
    const ms = performance.now() - t0
    expect(at(levels, 0, 'face').area).toBeGreaterThan(4000) // the rim
    const floor = at(levels, 56.338, 'face') // the cavity floor (black-box: 56.33)
    expect(floor.area).toBeGreaterThan(32_000)
    expect(floor.visibleArea / floor.area).toBeGreaterThan(0.99)
    // from the bottom: the part bottom and the two steps (black-box: 1.77 and 4.19)
    expect(at(levels, 60.523, 'opposite').depthFromOpposite).toBe(0)
    expect(Math.abs(at(levels, 58.752, 'opposite').depthFromOpposite! - 1.77)).toBeLessThan(0.01)
    expect(Math.abs(at(levels, 56.338, 'opposite').depthFromOpposite! - 4.19)).toBeLessThan(0.01)
    expect(ms).toBeLessThan(2000) // ≈ 120 ms on the dev machine; generous for CI load
  })
})
