// Chained and fitted reference sections (DF60 P1): loops from a mesh section, orientation by
// nesting, open meshes, a plane that misses, and the enclosure's outline, cavity and holes
// (spike S8's targets measured here).
// Spec: docs/modes/reference-tools.md#test-plans (P1 section and fitting)
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { MIN_ELEMENT } from '../geometry/2d/fit-polyline'
import { arcRadius, arcSweep, signedArea } from '../geometry/2d/model'
import { insideCorners } from '../geometry/shape-measure'
import { sectionChains } from './mesh-section'
import { fitSection } from './reference-section'
import { createStlParser, STL_LIMITS, StlPositions } from './stl'
import { boxSoup, ENCLOSURE_FULL_TRIANGLES, enclosureFullStl } from './stl.testing'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const FIT = { tolerance: 0.01, cornerAngle: 15 }

/** A box with a square hole through it (a frame), as a triangle soup. */
function frameSoup(): Float32Array {
  const out: number[] = []
  const quad = (a: number[], b: number[], c: number[], d: number[]) =>
    out.push(...a, ...b, ...c, ...a, ...c, ...d)
  // outer walls of 40 × 20 × 10 and inner walls of a 10 × 10 hole at (15..25, 5..15)
  const wall = (x0: number, y0: number, x1: number, y1: number) =>
    quad([x0, y0, 0], [x1, y1, 0], [x1, y1, 10], [x0, y0, 10])
  wall(0, 0, 40, 0)
  wall(40, 0, 40, 20)
  wall(40, 20, 0, 20)
  wall(0, 20, 0, 0)
  wall(15, 5, 15, 15)
  wall(15, 15, 25, 15)
  wall(25, 15, 25, 5)
  wall(25, 5, 15, 5)
  return Float32Array.from(out)
}

describe('sectionChains + fitSection', () => {
  it('a box gives one closed loop: outer, counter-clockwise, four sharp convex corners', () => {
    const chains = expectOk(sectionChains(Float32Array.from(boxSoup(40, 20, 10)), IDENTITY, 4))
    expect(chains).toHaveLength(1)
    expect(chains[0]!.closed).toBe(true)
    const [loop] = fitSection(chains, FIT)
    expect(loop).toMatchObject({ role: 'outer', open: false, sharp: [] })
    expect(loop!.minInsideRadius).toBeUndefined() // no concave corner in the material
    expect(loop!.area).toBeCloseTo(800, 6)
    expect(signedArea(loop!.loop)).toBeGreaterThan(0)
    expect(loop!.loop.elements).toHaveLength(4)
  })

  it('a hole is oriented clockwise and its corners are the material’s sharp inside corners', () => {
    const loops = fitSection(expectOk(sectionChains(frameSoup(), IDENTITY, 5)), FIT)
    expect(loops.map((l) => l.role)).toEqual(['outer', 'hole'])
    const hole = loops[1]!
    expect(signedArea(hole.loop)).toBeLessThan(0)
    expect(hole.area).toBeCloseTo(100, 6)
    expect(hole.sharp).toHaveLength(4)
    expect(hole.minInsideRadius).toBeUndefined()
  })

  it('an open mesh gives open chains; a plane that misses gives nothing', () => {
    // without the first triangle the plane crosses (a side face loses half): an open mesh
    const box = boxSoup(40, 20, 10)
    const tris = Array.from({ length: box.length / 9 }, (_, t) => box.slice(9 * t, 9 * t + 9))
    const gone = tris.findIndex(
      (t) => Math.min(t[2]!, t[5]!, t[8]!) < 4 && Math.max(t[2]!, t[5]!, t[8]!) > 4,
    )
    const open = Float32Array.from(tris.filter((_, t) => t !== gone).flat())
    const loops = fitSection(expectOk(sectionChains(open, IDENTITY, 4)), FIT)
    expect(loops.some((l) => l.open)).toBe(true)
    expect(expectOk(sectionChains(frameSoup(), IDENTITY, 11))).toEqual([])
  })

  describe('the enclosure (full body fixture)', () => {
    const bytes = enclosureFullStl()
    const keep = new StlPositions(ENCLOSURE_FULL_TRIANGLES)
    const p = expectOk(createStlParser(bytes.length, STL_LIMITS, keep.add))
    expectOk(p.push(bytes))
    expectOk(p.finish())
    const positions = keep.positions()
    const section = (z: number) => fitSection(expectOk(sectionChains(positions, IDENTITY, z)), FIT)

    it('mid-wall: outline and cavity within the tolerance and S8’s element count', () => {
      const t0 = performance.now()
      const loops = section(20)
      const ms = performance.now() - t0
      expect(loops.map((l) => l.role)).toEqual(['outer', 'hole'])
      const [outline, cavity] = loops as [(typeof loops)[0], (typeof loops)[0]]
      for (const l of loops) {
        expect(l.maxDeviation).toBeLessThanOrEqual(0.01)
        expect(l.loop.elements.length).toBeLessThanOrEqual(300)
      }
      // read as a pocket (what design.shape.get reports), the outline's smallest inside radius is
      // a fitted arc, not 0 (the black-box agent's 0 came from its line paths)
      const pocket = insideCorners([outline.loop], 1)
      expect(Math.min(...pocket.map((c) => c.radius))).toBeGreaterThan(1)
      // the cavity's two real sharp corners where the flat inset meets the oval
      expect(cavity.sharp).toHaveLength(2)
      const xs = cavity.sharp.map((s) => Math.round(Math.abs(s[0]) * 100) / 100)
      expect(xs).toEqual([46.68, 46.68])
      for (const s of cavity.sharp) expect(s[1]).toBeCloseTo(78.06, 1)
      expect(ms).toBeLessThan(2000) // ≈ 6 ms on the dev machine
    })

    // S8's feature-rich heights (slots, ribs, the lid lip and the bottom chamfer), which missed
    // the targets in P1 (up to 510 elements, 92 under 0.05 mm) before the circle tangents, the
    // long-chord alternative and the sliver merge (reference-tools.md § Fitting)
    it.each([2, 5, 40, 50, 55, 59])(
      'feature-rich z %i: ≤ 300 elements per loop, none under 0.05 mm',
      (z) => {
        for (const l of section(z)) {
          expect(l.maxDeviation).toBeLessThanOrEqual(0.01)
          expect(l.loop.elements.length).toBeLessThanOrEqual(300)
          for (const e of l.loop.elements) {
            const length =
              e.kind === 'line'
                ? Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])
                : Math.abs(arcSweep(e)) * arcRadius(e)
            expect(length).toBeGreaterThanOrEqual(MIN_ELEMENT)
          }
        }
      },
    )

    it('near the bottom: the four foot holes are circles of Ø 2.447', () => {
      const holes = section(2).filter((l) => l.role === 'hole')
      expect(holes).toHaveLength(4)
      for (const h of holes) expect(h.circle?.diameter).toBeCloseTo(2.447, 2)
    })
  })
})
