// SVG paint → engraving levels (engraved-patterns.md E2): colour parsing (named, hex, rgb(),
// percentages, alpha ignored), level = 1 − Rec. 709 luma, data-level (one value, stops, invalid),
// inheritance from groups, open paths (one level or per vertex, elements split at the stops),
// closed loops (stroke, else fill), and the warnings (opacity, gradient, white, invalid).
// Doc: docs/modes/engraved-patterns.md#svg-encoding
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { elementLength } from '../../geometry/2d/model'
import { importSvg, type SvgShapeItem } from './import'
import { levelOfColour, parseColour, parseDataLevel, stopsAt } from './paint'

const svg = (body: string, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="60mm" viewBox="0 0 100 60" fill="none" ${attrs}>${body}</svg>`

const items = (text: string): SvgShapeItem[] =>
  expectOk(importSvg(text)).shapes.flatMap((s) => s.items)

const rules = (text: string): string[] =>
  expectOk(importSvg(text)).report.warnings.map((w) => w.rule)

describe('colour → level', () => {
  it('parses named, hex, rgb() and percentage colours', () => {
    expect(parseColour('black')).toEqual({ r: 0, g: 0, b: 0, alpha: false })
    expect(parseColour(' Grey ')).toEqual({ r: 128, g: 128, b: 128, alpha: false })
    expect(parseColour('#fff')).toEqual({ r: 255, g: 255, b: 255, alpha: false })
    expect(parseColour('#808080')).toEqual({ r: 128, g: 128, b: 128, alpha: false })
    expect(parseColour('rgb(192, 192, 192)')).toEqual({ r: 192, g: 192, b: 192, alpha: false })
    expect(parseColour('rgb(50% 50% 50%)')).toEqual({ r: 127.5, g: 127.5, b: 127.5, alpha: false })
    expect(parseColour('none')).toBeUndefined()
    expect(parseColour('url(#g)')).toBeUndefined()
    expect(parseColour('notacolour')).toBeUndefined()
  })

  it('flags an alpha below 1 (ignored for the level)', () => {
    expect(parseColour('#0008')!.alpha).toBe(true)
    expect(parseColour('#000000ff')!.alpha).toBe(false)
    expect(parseColour('rgba(0,0,0,0.5)')).toEqual({ r: 0, g: 0, b: 0, alpha: true })
    expect(parseColour('rgb(0 0 0 / 50%)')!.alpha).toBe(true)
    expect(levelOfColour('rgba(0,0,0,0.5)')).toBe(1)
  })

  it('is 1 − Rec. 709 luma: black deepest, white 0', () => {
    expect(levelOfColour('black')).toBe(1)
    expect(levelOfColour('#ffffff')).toBe(0)
    expect(levelOfColour('#808080')).toBeCloseTo(1 - 128 / 255, 12)
    // pure red is lighter than pure blue in luma
    expect(levelOfColour('red')).toBeCloseTo(1 - 0.2126, 12)
    expect(levelOfColour('blue')).toBeCloseTo(1 - 0.0722, 12)
    expect(levelOfColour(undefined)).toBeUndefined()
  })

  it('reads data-level values and stops', () => {
    expect(parseDataLevel('0.5')).toEqual([0.5])
    expect(parseDataLevel(' 0, 1  0 ')).toEqual([0, 1, 0])
    expect(parseDataLevel('1.2')).toBeUndefined()
    expect(parseDataLevel('a')).toBeUndefined()
    expect(stopsAt([0, 1, 0], 0.25)).toBeCloseTo(0.5, 12)
    expect(stopsAt([0, 1, 0], 0.5)).toBe(1)
    expect(stopsAt([0.3], 0.9)).toBe(0.3)
  })
})

describe('levels on imported items', () => {
  it('gives an open path its stroke level; black (level 1) is left out', () => {
    const [grey, black] = items(
      svg(
        '<path id="a" d="M 10 10 L 50 10" stroke="#808080"/><path id="b" d="M 10 20 L 50 20" stroke="#000"/>',
      ),
    )
    expect((grey as { levels: number }).levels).toBeCloseTo(1 - 128 / 255, 11)
    expect(black).toEqual({ kind: 'path', path: expect.anything() })
  })

  it('inherits the stroke from groups and the root, style winning over the attribute', () => {
    const [a, b] = items(
      svg(
        '<g stroke="#808080"><path d="M 10 10 L 50 10"/><path d="M 10 20 L 50 20" style="stroke: #404040" stroke="#000"/></g>',
        'stroke="black"',
      ),
    )
    expect((a as { levels: number }).levels).toBeCloseTo(1 - 128 / 255, 12)
    expect((b as { levels: number }).levels).toBeCloseTo(1 - 64 / 255, 12)
  })

  it('lets data-level override the colour, inherited from a group', () => {
    const [one] = items(svg('<g data-level="0.25"><path d="M 10 10 L 50 10" stroke="#000"/></g>'))
    expect(one).toMatchObject({ levels: 0.25 })
  })

  it('splits elements at data-level stops so vertex levels are exact', () => {
    // 40 mm line, stops 0 → 1 → 0: split at 20 mm, levels per vertex
    const [p] = items(svg('<path d="M 10 10 L 50 10" stroke="#000" data-level="0 1 0"/>'))
    expect(p!.kind).toBe('path')
    const it0 = p as Extract<SvgShapeItem, { kind: 'path' }>
    expect(it0.path.elements).toHaveLength(2)
    expect(it0.levels).toEqual([0, 1, 0])
    expect(elementLength(it0.path.elements[0]!)).toBeCloseTo(20, 9)
  })

  it('interpolates stops linearly by arc length at the vertices between them', () => {
    // a polyline of 10 + 30 mm, stops 0 → 1: the inner vertex at a quarter of the length
    const [p] = items(svg('<polyline points="10,10 20,10 50,10" stroke="#000" data-level="0 1"/>'))
    const it0 = p as Extract<SvgShapeItem, { kind: 'path' }>
    expect(it0.levels).toHaveLength(3)
    expect((it0.levels as number[])[1]).toBeCloseTo(0.25, 9)
    expect((it0.levels as number[])[2]).toBe(1)
  })

  it('splits an arc at a stop on the circle', () => {
    const [p] = items(
      svg('<path d="M 10 30 A 10 10 0 0 1 30 30" stroke="#000" data-level="1 0 1"/>'),
    )
    const it0 = p as Extract<SvgShapeItem, { kind: 'path' }>
    expect(it0.path.elements.every((e) => e.kind === 'arc')).toBe(true)
    expect(it0.levels).toEqual([1, 0, 1])
    const [a, b] = it0.path.elements
    expect(elementLength(a!)).toBeCloseTo(elementLength(b!), 6)
  })

  it('gives a loop the stroke level, else the fill, and leaves level 1 out', () => {
    const loops = items(
      svg(
        '<circle cx="20" cy="20" r="5" stroke="#808080"/><circle cx="50" cy="20" r="5" fill="#404040"/><circle cx="80" cy="20" r="5" fill="black"/>',
        'fill="none"',
      ).replace('fill="none" ', ''),
    )
    const levels = loops.map((l) => (l.kind === 'loop' ? l.level : undefined))
    expect(levels[0]).toBeCloseTo(1 - 128 / 255, 12)
    expect(levels[1]).toBeCloseTo(1 - 64 / 255, 12)
    expect(levels[2]).toBe(1)
  })

  it('warns about opacity, gradients, white strokes and invalid data-level', () => {
    expect(rules(svg('<path d="M 0 0 L 10 0" stroke="#000" stroke-opacity="0.5"/>'))).toContain(
      'opacityIgnored',
    )
    expect(rules(svg('<path d="M 0 0 L 10 0" stroke="rgba(0,0,0,.3)"/>'))).toContain(
      'opacityIgnored',
    )
    expect(rules(svg('<path d="M 0 0 L 10 0" stroke="url(#g)"/>'))).toContain(
      'strokeGradientIgnored',
    )
    expect(rules(svg('<path d="M 0 0 L 10 0" stroke="white"/>'))).toContain('levelWhite')
    expect(rules(svg('<path d="M 0 0 L 10 0" stroke="#000" data-level="2"/>'))).toContain(
      'levelInvalid',
    )
  })
})
