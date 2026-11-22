// The v0.3 exit-criteria drawing (src/core/design/__fixtures__/enclosure-sections.svg,
// docs/conventions/testing.md#fixtures) through the whole import: two shapes, each one closed
// counter-clockwise loop within 0.01 mm of the source curves (two-sided, S5's oracle), G1 except at
// the drawing's own corners. Doc: docs/architecture/shapes.md#svg-import
import { describe, expect, it } from 'vitest'
import { checkChain } from '../../geometry/2d/wire'
import { signedArea } from '../../geometry/2d/model'
import { ENCLOSURE_SECTIONS_SVG } from '../../design/enclosure-sections.testing'
import { importSvg } from './import'
import { parsePathData, transformSeg } from './path-data'
import { deviation, kinks } from './testing/oracle'

interface NodeProcess {
  getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL, encoding: 'utf8'): string }
}
const fs = (globalThis as unknown as { process: NodeProcess }).process.getBuiltinModule('node:fs')
const svg = fs.readFileSync(ENCLOSURE_SECTIONS_SVG, 'utf8')

/** The source curves in the shape frame: mm page, y flipped about the page height (178 mm). */
function sourceSegs(id: string) {
  const d = new RegExp(`id="${id}"[^>]*\\sd="([^"]+)"`).exec(svg)![1]!
  const sub = parsePathData(d).subpaths
  expect(sub).toHaveLength(1)
  return sub[0]!.segs.map((s) => transformSeg([1, 0, 0, -1, 0, 178], s))
}

describe('enclosure-sections.svg import', () => {
  const r = importSvg(svg)

  it('gives the two top-level paths as two shapes of one loop each', () => {
    const { shapes, report } = r.unwrap()
    expect(shapes.map((s) => [s.name, s.source.element])).toEqual([
      ['outline', '#outline'],
      ['cavity', '#cavity'],
    ])
    for (const s of shapes) {
      expect(s.items).toHaveLength(1)
      const item = s.items[0]!
      expect(item.kind === 'loop' && item.op).toBe('add')
    }
    expect(report.size).toEqual({ width: 250, height: 178 })
    expect(report.unit).toBe('mm')
    expect(report.unitAssumed).toBe(false)
    expect(report.imported).toEqual({ path: 2 })
    expect(report.beziersFitted).toBe(22)
    expect(report.warnings).toEqual([])
    expect(report.maxDeviation).toBeLessThanOrEqual(0.01)
    // S5 measured 159 elements for the fitted cubics; the 3 lines stay lines
    expect(report.arcs + report.lines).toBeGreaterThan(100)
    expect(report.arcs + report.lines).toBeLessThan(400)
  })

  it('stays within 0.01 mm of the source curves, both ways', () => {
    const { shapes } = r.unwrap()
    for (const s of shapes) {
      const item = s.items[0]!
      if (item.kind !== 'loop') throw new Error('expected a loop')
      expect(checkChain(item.loop.elements, true, 'test').isOk()).toBe(true)
      expect(signedArea(item.loop)).toBeGreaterThan(0)
      expect(deviation(sourceSegs(s.name), item.loop.elements)).toBeLessThanOrEqual(0.01)
    }
  })

  it('is tangent-continuous inside every fitted curve', () => {
    const { shapes } = r.unwrap()
    for (const s of shapes) {
      const item = s.items[0]!
      if (item.kind !== 'loop') throw new Error('expected a loop')
      // joins off G1 only where source segments meet (the drawing's corners, and its own
      // sub-mrad kinks from the 1 µm rounding of the coordinates)
      const off = kinks(item.loop.elements, true).filter((a) => a > 1e-9)
      expect(off.length).toBeLessThanOrEqual(sourceSegs(s.name).length)
      expect(off.filter((a) => a > 0.17)).toHaveLength(s.name === 'cavity' ? 4 : 0)
    }
  })
})
