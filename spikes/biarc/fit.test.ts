// Spike S5 (docs/research/s5-biarc-fitting.md): every approach on every corpus case stays within
// 0.01 mm (two-sided, sampled against the curve flattened to 0.1 µm) and is tangent-continuous
// inside each chain and against the source tangent at chain ends.

import { describe, expect, it } from 'vitest'
import { CORPUS, randomChain } from './corpus.ts'
import { elemLength, elemRadius, elemsOf, fitCurve, type Approach } from './fit.ts'
import { continuity, deviation } from './oracle.ts'

const TOL = 0.01
/** The line fallback leaves at most this kink (half sweep ≤ 0.1 mrad); otherwise ~1e-12. */
const KINK = 1e-4 + 1e-9

const curvesOf = (name: string) =>
  CORPUS.find((c) => c.name === name)!.paths.flatMap((p) => [...p.curves])

// The oracle is brute force (dense polyline × elements): ~1 s per approach for the corpus alone,
// a few seconds under load; C on the thin ellipse alone takes ~4 s (6000 elements), so it is left
// to the harness.
describe('biarc fitting within 0.01 mm, G1', { timeout: 60_000 }, () => {
  for (const approach of ['A', 'B', 'C'] as const satisfies readonly Approach[])
    for (const c of CORPUS) {
      if (approach === 'C' && c.name === 'thin ellipse') continue
      it(`${approach}: ${c.name}`, () => {
        for (const curve of c.paths.flatMap((p) => p.curves)) {
          const fit = fitCurve(curve, approach, { tol: TOL })
          expect(fit.forced).toBe(0)
          expect(deviation(curve, fit)).toBeLessThanOrEqual(TOL)
          const g = continuity(curve, fit)
          expect(g.kink).toBeLessThanOrEqual(KINK)
          expect(g.gap).toBeLessThan(1e-9)
          // CavalierContours bulges stay within ±1 (sweep ≤ 180°)
          for (const e of elemsOf(fit)) expect(Math.abs(e.bulge)).toBeLessThanOrEqual(1)
        }
      })
    }
})

describe('random G1 cubics (A, B)', { timeout: 60_000 }, () => {
  // 100 curves × oracle ≈ 1 s per approach alone. C is left out: it breaks down on these
  // (thousands of tiny arcs per curve, see results.md).
  const curves = randomChain(100)[0]!.curves
  for (const approach of ['A', 'B'] as const)
    it(approach, () => {
      for (const curve of curves) {
        const fit = fitCurve(curve, approach, { tol: TOL })
        expect(fit.forced).toBe(0)
        expect(deviation(curve, fit)).toBeLessThanOrEqual(TOL)
        expect(continuity(curve, fit).kink).toBeLessThanOrEqual(KINK)
      }
    })
})

describe('special cases (approach B)', () => {
  const fit = (name: string) => curvesOf(name).map((c) => fitCurve(c, 'B'))

  it('a cusp splits the chain (a corner); a near-cusp turns inside micro corners', () => {
    expect(fit('cusp')[0]!.chains).toHaveLength(2)
    const near = fit('near-cusp')[0]!.chains
    const micro = near.filter((ch) => ch.micro)
    expect(micro.length).toBeGreaterThan(0)
    for (const ch of micro) expect(elemLength(ch.elems[0]!)).toBeLessThanOrEqual(TOL)
  })

  it('straight and backtracking cubics become lines', () => {
    expect(elemsOf(fit('line in disguise')[0]!)).toEqual([
      { a: { x: 0, y: 0 }, b: { x: 60, y: 10 }, bulge: 0 },
    ])
    const back = fit('collinear backtrack')[0]!
    expect(back.chains).toHaveLength(3)
    expect(elemsOf(back).every((e) => e.bulge === 0)).toBe(true)
  })

  it('a huge radius with a sagitta above the tolerance stays an arc (no radius rule)', () => {
    const elems = elemsOf(fit('huge radius 50 µm')[0]!)
    expect(elems.every((e) => e.bulge !== 0)).toBe(true)
    expect(Math.min(...elems.map(elemRadius))).toBeGreaterThan(10_000)
  })

  it('circular arcs stay exact, ellipses are fitted', () => {
    const elems = fit('gear').flatMap(elemsOf)
    expect(elems).toHaveLength(curvesOf('gear').length)
    expect(fit('ellipse').flatMap(elemsOf).length).toBeGreaterThan(2)
  })
})
