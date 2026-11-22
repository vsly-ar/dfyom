import { describe, expect, it } from 'vitest'
import { expectErrCode } from '../../../shared/testing/result'
import { parseXml } from './xml'

const ruleOf = (r: ReturnType<typeof parseXml>): string | undefined =>
  expectErrCode(r, 'input.malformed').issues[0]?.rule

describe('parseXml', () => {
  it('reads elements, attributes, nesting and lines', () => {
    const root = parseXml(
      `<?xml version="1.0"?>\n<!-- c -->\n<svg a="1" b='two'>\n  <g>\n    <path d="M0 0"/>\n  </g>\n</svg>\n`,
      10,
    ).unwrap()
    expect(root.name).toBe('svg')
    expect([...root.attrs]).toEqual([
      ['a', '1'],
      ['b', 'two'],
    ])
    const g = root.children[0]!
    expect(g.name).toBe('g')
    expect(g.line).toBe(4)
    expect(g.children[0]!.attrs.get('d')).toBe('M0 0')
    expect(g.children[0]!.line).toBe(5)
  })

  it('decodes entities, character references and DOCTYPE entities', () => {
    const root = parseXml(
      `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd" [\n<!ENTITY ns_svg "http://www.w3.org/2000/svg">\n]>\n<svg xmlns="&ns_svg;" t="a&amp;b&lt;&#65;&#x42;"/>`,
      10,
    ).unwrap()
    expect(root.attrs.get('xmlns')).toBe('http://www.w3.org/2000/svg')
    expect(root.attrs.get('t')).toBe('a&b<AB')
  })

  it('notes text and CDATA, skips comments and processing instructions', () => {
    const root = parseXml(
      '﻿<svg><style><![CDATA[ .a{} ]]></style><title>T</title><?pi x?><g/></svg>',
      10,
    ).unwrap()
    expect(root.children.map((c) => [c.name, c.hasText])).toEqual([
      ['style', true],
      ['title', true],
      ['g', false],
    ])
  })

  it('refuses malformed XML with rule svgSyntax and the line', () => {
    const cases = [
      '<svg>',
      '<svg></g>',
      '<svg><g></svg>',
      '<svg a=1/>',
      '<svg a="1" a="2"/>',
      '<svg a/>',
      '<svg a="x<y"/>',
      '<svg t="&nope;"/>',
      '<svg/><svg/>',
      'text<svg/>',
      '<svg><!-- open',
      '<svg><![CDATA[ x',
      '',
      '<svg <g/>',
      '<svg/>trailing',
    ]
    for (const c of cases) expect(ruleOf(parseXml(c, 10)), c).toBe('svgSyntax')
    const e = expectErrCode(parseXml('<svg>\n\n<g></svg>', 10), 'input.malformed')
    expect(e.issues[0]!.params).toMatchObject({ line: 3 })
  })

  it('refuses nesting deeper than the limit (svgLimit)', () => {
    const deep = '<g>'.repeat(20) + '</g>'.repeat(20)
    expect(ruleOf(parseXml(`<svg>${deep}</svg>`, 10))).toBe('svgLimit')
    expect(parseXml(`<svg>${deep}</svg>`, 30).isOk()).toBe(true)
  })
})
