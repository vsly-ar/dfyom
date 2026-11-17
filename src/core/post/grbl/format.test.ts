// Number and comment formatting. Spec: docs/architecture/grbl.md#numbers-lines-and-comments
import { describe, expect, it } from 'vitest'
import { commentLine, formatNumber, sanitizeComment, toolChangeMarker } from './format'

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
  })

  it('truncate to 70 bytes', () => {
    const l = commentLine('x'.repeat(100))
    expect(l).toHaveLength(70)
    expect(l).toMatch(/^\(x+\)$/)
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
})
