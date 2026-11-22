import { describe, expect, it } from 'vitest'
import { expectErrCode } from '../../../shared/testing/result'
import { arcRadius, arcSweep, chainBounds, signedArea, type Loop } from '../../geometry/2d/model'
import { checkChain } from '../../geometry/2d/wire'
import { crossings } from '../../geometry/2d/testing/oracles'
import { importSvg, type SvgImport, type SvgImportOptions, type SvgShape } from './import'

interface NodeProcess {
  getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL, encoding: 'utf8'): string }
}
const fs = (globalThis as unknown as { process: NodeProcess }).process.getBuiltinModule('node:fs')
const fixture = (name: string): string =>
  fs.readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')

const MM = 'xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"'
const doc = (body: string, attrs = MM): string => `<svg ${attrs}>${body}</svg>`
const ok = (svg: string, o: SvgImportOptions = {}): SvgImport => importSvg(svg, o).unwrap()
const rule = (svg: string, o: SvgImportOptions = {}): string | undefined =>
  expectErrCode(importSvg(svg, o), 'input.malformed').issues[0]?.rule

const loops = (s: SvgShape): Loop[] => s.items.flatMap((i) => (i.kind === 'loop' ? [i.loop] : []))
const area = (s: SvgShape): number => loops(s).reduce((a, l) => a + signedArea(l), 0)
const kinds = (s: SvgShape): string[] =>
  s.items.flatMap((i) => (i.kind === 'loop' ? i.loop.elements : i.path.elements)).map((e) => e.kind)

function validShapes(r: SvgImport): void {
  for (const s of r.shapes) {
    for (const i of s.items) {
      const ch = i.kind === 'loop' ? i.loop : i.path
      expect(checkChain(ch.elements, i.kind === 'loop', 'test').isOk(), s.name).toBe(true)
      if (i.kind === 'loop') expect(Math.sign(signedArea(i.loop))).toBe(i.op === 'add' ? 1 : -1)
    }
    if (s.items.some((i) => i.kind === 'path')) expect(s.items).toHaveLength(1)
    expect(crossings(loops(s))).toBe(0)
  }
}

describe('basic shapes', () => {
  it('rect, circle, ellipse, polygon as closed loops; line and polyline as open paths', () => {
    const r = ok(
      doc(
        '<rect id="r" x="10" y="10" width="20" height="10"/>' +
          '<circle id="c" cx="50" cy="50" r="5"/>' +
          '<ellipse id="e" cx="50" cy="20" rx="10" ry="4"/>' +
          '<polygon id="pg" points="0,0 10,0 10,10"/>' +
          '<line id="l" x1="0" y1="90" x2="50" y2="90"/>' +
          '<polyline id="pl" points="0 95 10 95 10 99"/>',
      ),
    )
    validShapes(r)
    const by = Object.fromEntries(r.shapes.map((s) => [s.name, s]))
    expect(Object.keys(by)).toEqual(['r', 'c', 'e', 'pg', 'l', 'pl'])
    expect(area(by['r']!)).toBeCloseTo(200, 9)
    expect(kinds(by['c']!)).toEqual(['arc', 'arc'])
    expect(area(by['c']!)).toBeCloseTo(25 * Math.PI, 9)
    expect(area(by['e']!)).toBeCloseTo(40 * Math.PI, 1)
    expect(kinds(by['e']!).every((k) => k === 'arc')).toBe(true)
    expect(area(by['pg']!)).toBeCloseTo(50, 9)
    expect(by['l']!.items[0]!.kind).toBe('path')
    expect(kinds(by['pl']!)).toEqual(['line', 'line'])
    expect(r.report.imported).toEqual({
      rect: 1,
      circle: 1,
      ellipse: 1,
      polygon: 1,
      line: 1,
      polyline: 1,
    })
    expect(r.report.ellipticalArcsFitted).toBe(2)
    expect(r.report.openPaths).toBe(2)
  })

  it('rounds rect corners with exact quarter arcs (rx alone sets ry, each clamped to half the side)', () => {
    const r = ok(doc('<rect x="0" y="0" width="20" height="10" rx="2"/>'))
    const s = r.shapes[0]!
    expect(kinds(s).filter((k) => k === 'arc')).toHaveLength(4)
    expect(kinds(s).filter((k) => k === 'line')).toHaveLength(4)
    expect(area(s)).toBeCloseTo(200 - (4 - Math.PI) * 4, 9)
    const pill = ok(doc('<rect x="0" y="0" width="20" height="10" ry="50" rx="5"/>')).shapes[0]!
    expect(kinds(pill).filter((k) => k === 'arc')).toHaveLength(4)
    expect(kinds(pill).filter((k) => k === 'line')).toHaveLength(2)
  })

  it('skips invalid shapes with a warning and keeps the rest', () => {
    const r = ok(
      doc(
        '<circle r="-1"/><rect width="0" height="5"/><ellipse rx="abc"/><polygon points="0 0 5 x"/><circle cx="5" cy="5" r="2"/>',
      ),
    )
    expect(r.shapes).toHaveLength(1)
    expect(r.report.skipped).toEqual({ circle: 1, rect: 1, ellipse: 1, polygon: 1 })
    expect(r.report.warnings.filter((w) => w.rule === 'attributeInvalid')).toHaveLength(4)
  })
})

describe('coordinates, units and transforms', () => {
  it('flips y about the page bottom and reads units', () => {
    const r = ok(doc('<rect x="10" y="0" width="5" height="5"/>'))
    expect(r.report.bounds).toEqual({ min: [10, 95], max: [15, 100] })
    const inch = ok(
      doc('<rect width="1" height="1"/>', 'width="2in" height="2in" viewBox="0 0 2 2"'),
    )
    expect(inch.report.unit).toBe('in')
    expect(inch.report.bounds!.max[0]).toBeCloseTo(25.4, 12)
  })

  it('assumes 96 dpi for unitless files, overridable', () => {
    const svg = doc('<rect width="96" height="96"/>', 'width="96" height="96"')
    const a = ok(svg)
    expect(a.report.unitAssumed).toBe(true)
    expect(a.report.unit).toBe('px96')
    expect(a.report.bounds!.max[0]).toBeCloseTo(25.4, 12)
    expect(ok(svg, { unit: 'px72' }).report.bounds!.max[0]).toBeCloseTo(33.8667, 3)
    expect(ok(svg, { unit: 'mm' }).report.bounds!.max[0]).toBe(96)
  })

  it('flattens nested group transforms into the coordinates', () => {
    const r = ok(
      doc(
        '<g transform="translate(50 50)"><g transform="scale(2)"><rect x="0" y="0" width="5" height="5" transform="translate(1,1)"/></g></g>',
      ),
    )
    // user (52..62, 52..62) → shape frame y = 100 − y
    expect(r.report.bounds).toEqual({ min: [52, 38], max: [62, 48] })
  })

  it('keeps circles exact under rotation and uniform scale; fits them under skew', () => {
    const rot = ok(doc('<circle cx="10" cy="10" r="5" transform="rotate(30) scale(2)"/>'))
    expect(kinds(rot.shapes[0]!)).toEqual(['arc', 'arc'])
    const e = loops(rot.shapes[0]!)[0]!.elements[0]!
    if (e.kind !== 'arc') throw new Error('kind')
    expect(arcRadius(e)).toBeCloseTo(10, 9)
    const skew = ok(doc('<circle cx="10" cy="10" r="5" transform="skewX(20)"/>'))
    expect(skew.report.ellipticalArcsFitted).toBe(2)
    // skew keeps the area; the fit may move the outline by 0.01 mm (perimeter ≈ 33 mm)
    expect(Math.abs(area(skew.shapes[0]!) - 25 * Math.PI)).toBeLessThan(0.33)
    // a reflection keeps the loop counter-clockwise (fill decides orientation)
    const flip = ok(doc('<rect width="10" height="5" transform="scale(-1 1) translate(-20 0)"/>'))
    expect(area(flip.shapes[0]!)).toBeCloseTo(50, 9)
  })

  it('warns about and ignores a malformed transform', () => {
    const r = ok(doc('<rect width="10" height="5" transform="rotate("/>'))
    expect(r.report.warnings.map((w) => w.rule)).toEqual(['transformInvalid'])
  })
})

describe('fill rule and grouping', () => {
  it('evenodd and nonzero from attributes, style and inheritance', () => {
    const two = 'M0 0 H40 V40 H0 Z M10 10 H30 V30 H10 Z' // both the same sense
    const nz = ok(doc(`<path d="${two}"/>`))
    expect(nz.shapes[0]!.items.map((i) => i.kind === 'loop' && i.op)).toEqual(['add'])
    const eo = ok(doc(`<path fill-rule="evenodd" d="${two}"/>`))
    expect(eo.shapes[0]!.items.map((i) => i.kind === 'loop' && i.op)).toEqual(['add', 'subtract'])
    const st = ok(doc(`<g style="fill-rule:evenodd"><path d="${two}"/></g>`))
    expect(st.shapes[0]!.items).toHaveLength(2)
    expect(area(st.shapes[0]!)).toBeCloseTo(1600 - 400, 9)
  })

  it('letter D: the counter, drawn the other way round, is a hole', () => {
    const r = ok(fixture('letter-d.svg'))
    validShapes(r)
    expect(r.shapes).toHaveLength(1)
    expect(r.shapes[0]!.items.map((i) => i.kind === 'loop' && i.op)).toEqual(['add', 'subtract'])
  })

  it('one shape per top-level element, per file or per outer loop', () => {
    const svg = fixture('bracket.svg')
    const el = ok(svg)
    expect(el.shapes.map((s) => s.name)).toEqual(['Path 1', 'Circle 2', 'Circle 3', 'Path 4'])
    expect(el.shapes.map((s) => s.source.element)).toEqual([
      'path[1]',
      'circle[2]',
      'circle[3]',
      'path[4]',
    ])
    // one shape: the bolt holes and the slot drawn inside the outline become holes
    const file = ok(svg, { split: 'file' })
    validShapes(file)
    expect(file.shapes).toHaveLength(1)
    expect(file.shapes[0]!.items.map((i) => i.kind === 'loop' && i.op)).toEqual([
      'add',
      'subtract',
      'subtract',
      'subtract',
    ])
    const loop = ok(svg, { split: 'loop' })
    expect(loop.shapes).toHaveLength(4)
    const islands = ok(
      doc('<path fill-rule="evenodd" d="M0 0H50V50H0Z M5 5H45V45H5Z M10 10H20V20H10Z"/>'),
      { split: 'loop' },
    )
    expect(islands.shapes.map((s) => s.items.length)).toEqual([2, 1])
  })

  it('a top-level group is one shape; names come from labels or ids', () => {
    const r = ok(
      doc(
        '<g id="g1" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" inkscape:label="Base"><rect width="40" height="40"/><circle cx="20" cy="20" r="5"/></g><g><rect x="60" width="5" height="5"/></g>',
      ),
    )
    expect(r.shapes.map((s) => [s.name, s.source.element])).toEqual([
      ['Base', '#g1'],
      ['Group 2', 'g[2]'],
    ])
    expect(r.shapes[0]!.items.map((i) => i.kind === 'loop' && i.op)).toEqual(['add', 'subtract'])
  })

  it('splits open paths of an element into shapes of their own', () => {
    const r = ok(doc('<path id="p" d="M0 0H10V10H0Z M20 0 L30 0 M40 0 L50 5"/>'))
    expect(r.shapes.map((s) => [s.name, s.items[0]!.kind])).toEqual([
      ['p', 'loop'],
      ['p path 1', 'path'],
      ['p path 2', 'path'],
    ])
  })

  it('repairs a self-crossing path and says so', () => {
    const r = ok(doc('<path d="M0 0 L10 10 L10 0 L0 10 Z"/>'))
    validShapes(r)
    expect(r.shapes[0]!.items).toHaveLength(2)
    expect(r.report.loopsRepaired).toBe(1)
    expect(r.report.warnings.map((w) => w.rule)).toContain('loopsRepaired')
  })
})

describe('clean-up and report', () => {
  it('closes subpaths whose ends meet within 0.01 mm, merges tiny segments', () => {
    const r = ok(doc('<path d="M0 0 L10 0 L10 10 L0 10 L0.005 0.00001"/>'))
    expect(r.shapes[0]!.items[0]!.kind).toBe('loop')
    expect(r.report.gapsClosed).toBe(1)
    const t = ok(doc('<path d="M0 0 L10 0 L10.00001 0 L10 10 L0 10 Z"/>'))
    expect(t.report.tinySegmentsMerged).toBe(1)
    expect(kinds(t.shapes[0]!)).toHaveLength(4)
  })

  it('merges micro corners left at near-cusps', () => {
    const r = ok(doc('<path d="M0 0 C30 30 0 30.001 30 0"/>'))
    expect(r.report.microCornersMerged).toBe(2)
    for (const e of r.shapes[0]!.items[0]!.kind === 'path'
      ? r.shapes[0]!.items[0]!.path.elements
      : [])
      if (e.kind === 'arc') expect(Math.abs(arcSweep(e))).toBeGreaterThan(0)
    const c = ok(doc('<path d="M0 0 C30 30 0 30 30 0"/>'))
    expect(c.report.cornersAtCusps).toBe(1)
  })

  it('counts skipped elements and warns about ignored features', () => {
    const r = ok(
      doc(
        '<style>.a{fill:red}</style><defs><path id="d" d="M0 0H5V5Z"/></defs>' +
          '<text>hi</text><image href="x.png"/><use href="#d"/><svg/>' +
          '<rect width="5" height="5" display="none"/><rect width="5" height="5" style="visibility:hidden"/>' +
          '<rect width="5" height="5" clip-path="url(#c)"/>' +
          '<foo:bar xmlns:foo="urn:x"/>',
      ),
    )
    expect(r.shapes).toHaveLength(1)
    expect(r.report.skipped).toEqual({ text: 1, image: 1, use: 1, svg: 1, hidden: 2 })
    expect(r.report.warnings.map((w) => w.rule).sort()).toEqual([
      'clipIgnored',
      'nestedSvg',
      'styleSheetIgnored',
    ])
  })

  it('imports path data up to an error and warns', () => {
    const r = ok(doc('<path d="M0 0 H10 V10 H0 Z M20 20 L30 x"/>'))
    expect(r.shapes).toHaveLength(1)
    expect(r.report.warnings.map((w) => w.rule)).toEqual(['pathData'])
  })

  it('reads prefixed SVG elements and skips other namespaces', () => {
    const r = ok(
      '<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"><svg:rect width="5" height="5"/></svg:svg>',
    )
    expect(r.shapes).toHaveLength(1)
  })

  it('reads the S1 corpus: heart (cusp corner), gear (exact arcs)', () => {
    const heart = ok(fixture('heart.svg'))
    validShapes(heart)
    expect(heart.report.beziersFitted).toBe(6)
    expect(heart.report.arcs).toBe(40)
    const gear = ok(fixture('gear.svg'))
    validShapes(gear)
    expect(gear.report.beziersFitted + gear.report.ellipticalArcsFitted).toBe(0)
    expect(gear.report.maxDeviation).toBe(0)
    const b = chainBounds(gear.shapes.flatMap((s) => loops(s)).flatMap((l) => l.elements))!
    expect(b.max[0] - b.min[0]).toBeCloseTo(90, 3)
  })
})

describe('errors and limits', () => {
  it('refuses malformed files with rules', () => {
    expect(rule('<svg')).toBe('svgSyntax')
    expect(rule('<html/>')).toBe('svgNotSvg')
    expect(rule(doc('<rect width="5" height="5"/>', 'viewBox="0 0 -1 5"'))).toBe('svgViewport')
    expect(rule(doc('<text>only text</text>'))).toBe('svgEmpty')
    expect(rule(doc(''))).toBe('svgEmpty')
  })

  it('enforces the size, element and nesting limits (svgLimit)', () => {
    const svg = doc('<path d="M0 0 C10 10 20 10 30 0 S50 -10 60 0"/>')
    expect(rule(svg, { limits: { maxBytes: 50 } })).toBe('svgLimit')
    expect(rule(svg, { limits: { maxElements: 1 } })).toBe('svgLimit')
    expect(rule(svg, { limits: { maxElements: 5 } })).toBe('svgLimit')
    expect(importSvg(svg, { limits: { maxElements: 500 } }).isOk()).toBe(true)
    expect(rule(doc('<g>'.repeat(300) + '</g>'.repeat(300)))).toBe('svgLimit')
    // multi-byte text counts in UTF-8 bytes
    expect(
      rule(doc(`<!-- ${'é'.repeat(40)} --><rect width="1" height="1"/>`), {
        limits: { maxBytes: 150 },
      }),
    ).toBe('svgLimit')
  })

  it('never throws on truncated or garbled input', () => {
    const base = fixture('letter-d.svg') + fixture('bracket.svg').slice(0, 200)
    let seed = 7
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    const src = fixture('bracket.svg')
    for (let k = 0; k < 300; k++) {
      let s = k < 150 ? src.slice(0, Math.floor(rnd() * src.length)) : src
      if (k >= 150) {
        const at = Math.floor(rnd() * s.length)
        const junk = ['<', '>', '"', 'Z', 'A', '-', 'e', '&', '/', ' 1e999 ', 'NaN'][k % 11]!
        s = s.slice(0, at) + junk + s.slice(at + 1)
      }
      expect(() => importSvg(s)).not.toThrow()
    }
    expect(() => importSvg(base)).not.toThrow()
  })
})
