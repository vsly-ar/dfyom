// The v0.3 exit-criteria SVG (src/core/design/__fixtures__/enclosure-sections.svg,
// docs/conventions/testing.md#fixtures) through the S5 fitter the import will be built from:
// approach B turns every cubic into G1 arcs within 0.01 mm, as the import report will need.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { elemsOf, fitCurve } from './fit.ts'
import { continuity, deviation } from './oracle.ts'
import { parseSvgPaths } from './svg.ts'

const svg = readFileSync(
  new URL('../../src/core/design/__fixtures__/enclosure-sections.svg', import.meta.url),
  'utf8',
)

describe('enclosure-sections.svg through biarc fitting (B)', () => {
  it('fits both sections within 0.01 mm, G1 inside each curve', () => {
    const subpaths = parseSvgPaths(svg)
    expect(subpaths.map((s) => s.closed)).toEqual([true, true])
    let arcs = 0
    for (const curve of subpaths.flatMap((s) => s.curves)) {
      const fit = fitCurve(curve, 'B', { tol: 0.01 })
      expect(fit.forced).toBe(0)
      expect(deviation(curve, fit)).toBeLessThanOrEqual(0.01)
      expect(continuity(curve, fit).kink).toBeLessThanOrEqual(1e-4 + 1e-9)
      arcs += elemsOf(fit).length
    }
    // 22 cubics and 3 lines: a few hundred elements at most
    expect(arcs).toBeLessThan(400)
  })
})
