// Number and comment formatting. Spec: docs/architecture/grbl.md#numbers-lines-and-comments
import { describe, expect, it } from 'vitest'
import {
  commentLine,
  fitName,
  formatNumber,
  pauseLine,
  sanitizeComment,
  toolChangeMarker,
} from './format'

describe('formatNumber', () => {
  it.each([
    [1, 3, '1'],
    [0.5, 3, '0.5'],
    [-0.5, 3, '-0.5'],
    [1.25, 3, '1.25'],
    [1.2345, 3, '1.235'], // half away from zero from the decimal value
    [-1.2345, 3, '-1.235'],
    [1.0005, 3, '1.001'], // the double is 1.000499999…; its decimal form rounds up
    [2.675, 2, '2.68'],
    [0.0004, 3, '0'],
    [-0.0004, 3, '0'], // no -0
    [-0.0005, 3, '-0.001'],
    [9.9996, 3, '10'],
    [99999.9999, 3, '100000'],
    [12.3, 4, '12.3'],
    [1e-7, 3, '0'], // no exponent
    [17999.5, 0, '18000'],
    [3, 2, '3'],
    [0.05, 1, '0.1'],
    [0.04, 1, '0'],
  ])('%d at %d decimals → %s', (v, d, s) => {
    expect(formatNumber(v, d)).toBe(s)
  })

  it('never writes an exponent, trailing zeros or a bare dot', () => {
    for (let k = 0; k < 2000; k++) {
      const v = (Math.sin(k * 12.9898) * 43758.5453) % 1000
      const s = formatNumber(v * 10 ** ((k % 9) - 6), 3)
      expect(s).toMatch(/^-?\d+(\.\d*[1-9])?$/)
      expect(s).not.toBe('-0')
    }
  })
})

describe('comments', () => {
  it('keep printable ASCII only and drop realtime and comment characters', () => {
    expect(sanitizeComment('Ø6 mm (2F) end mill; ½″ shank ?!~')).toBe(
      'dia6 mm 2F end mill _in shank',
    )
    expect(sanitizeComment('tab\there\nnew')).toBe('tab here new')
    expect(sanitizeComment('µ')).toBe('_')
    // chamfer mill names (v0.4 C1): the degree sign reads as a word
    expect(sanitizeComment('90° chamfer mill Ø12 mm')).toBe('90 deg chamfer mill dia12 mm')
  })

  it('truncate to 70 bytes', () => {
    const l = commentLine('x'.repeat(100))
    expect(l).toHaveLength(70)
    expect(l).toMatch(/^\(x+\)$/)
  })

  it('a cut comment ends at a word boundary, not mid-word (X2 F10)', () => {
    const l = commentLine(
      'Bolt circle screw - drill, Bolt circle screw - drill - 2, Bolt circle screw - drill - 3',
    )
    expect(l).toBe('(Bolt circle screw - drill, Bolt circle screw - drill - 2, Bolt)')
    expect(l.length).toBeLessThanOrEqual(70)
  })

  it('tool-change marker matches the sender rule, also with a long or odd name', () => {
    const rule = /^\(DFYOM TOOL CHANGE (\d+): ([^()]*)\)$/
    for (const name of ['6 mm flat (2F)', 'y'.repeat(200), '', 'Ø3″ drill'])
      for (const n of [1, 12, 255]) {
        const m = toolChangeMarker(n, name)
        expect(m.length).toBeLessThanOrEqual(70)
        expect(m).toMatch(rule)
        expect(rule.exec(m)?.[1]).toBe(String(n))
      }
  })

  // docs/architecture/grbl.md#pause-messages-hardening-df63
  it('a marker or pause message cuts the name, never the diameter, type or instruction', () => {
    const tail = ', 6.22 mm flat, then zero Z'
    const long = `Wexme ${'very long name '.repeat(8)}(2F)`
    const m = fitName('Install T3 ', long, tail, 66)
    expect(m.length).toBeLessThanOrEqual(66)
    expect(m.startsWith('Install T3 Wexme very long')).toBe(true)
    expect(m.endsWith(tail)).toBe(true)
    expect(m).not.toMatch(/[()]/)
    expect(fitName('Install T3 ', 'Wexme 1/4" 1F', tail, 66)).toBe(
      'Install T3 Wexme 1/4" 1F, 6.22 mm flat, then zero Z',
    )
    expect(toolChangeMarker(3, long, ', 6.22 mm flat')).toMatch(
      /^\(DFYOM TOOL CHANGE 3: Wexme [^()]*, 6\.22 mm flat\)$/,
    )
  })

  it('pause line: M0 with a GRBL-safe ; message of at most 70 bytes', () => {
    expect(pauseLine('Set spindle to 18000 rpm')).toBe('M0 ;Set spindle to 18000 rpm')
    const p = pauseLine(`Stop! (now); ${'x '.repeat(60)}`)
    expect(p.length).toBeLessThanOrEqual(70)
    expect(p).toMatch(/^M0 ;[^()?!~;]+$/)
  })
})
