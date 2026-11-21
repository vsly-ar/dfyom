// Spec: docs/conventions/ui.md#quantity-and-expression-input (echo only when it adds information;
// the user, 2026-11-21: "I enter 15 mm, why would I need to see '15.000 mm'?").
import { describe, expect, it } from 'vitest'
import type { ReferenceResolver } from '../../../../core/expression/evaluate'
import { quantityFromSource } from '../../../../core/expression/quantity'
import type { ParseContext } from '../../../../core/quantity/parse'
import { Rational } from '../../../../core/quantity/rational'
import type { UnitId } from '../../../../core/quantity/units'
import { None, Some } from '../../../../shared/result'
import { describeInherited, echoAddsInformation, readSource } from './reading'

const MM_CTX: ParseContext = { kind: 'length', defaultUnit: 'mm' }
const resolver: ReferenceResolver = {
  resolve: (name) => (name === 'D' ? Some(quantityFromSource('6', MM_CTX, NONE).unwrap()) : None),
}
const NONE: ReferenceResolver = { resolve: () => None }

function adds(source: string, unit: UnitId = 'mm', kind: ParseContext['kind'] = 'length'): boolean {
  const r = readSource(source, { kind, defaultUnit: unit }, resolver).unwrap()
  return echoAddsInformation(r, source, unit)
}

describe('echoAddsInformation', () => {
  it.each([
    '15',
    '15 mm',
    '15mm',
    ' 15 MM ',
    '15.',
    '.5',
    '-2.5',
    '−2.5',
    '+3',
    '10 ±0.05',
    '10mm +/- 0.05 mm',
  ])('hides the echo of a plain value in an mm field: %s', (source) => {
    expect(adds(source)).toBe(false)
  })

  it.each(['0.5 in', '0.5', '0.5"', '0.5 inch', '1 ±0.002 in'])(
    'hides the echo of a plain value in an inch field: %s',
    (source) => {
      expect(adds(source, 'in')).toBe(false)
    },
  )

  it.each(['45', '45°', '45 deg'])('hides a plain angle: %s', (source) => {
    expect(adds(source, 'deg', 'angle')).toBe(false)
  })

  it.each([
    ['fraction', '1/2'],
    ['mixed number', '1 1/2'],
    ['other unit', '0.5 in'],
    ['other unit (cm)', '1.5 cm'],
    ['asymmetric tolerance', '25.4 +0.1/-0.05'],
    ['fraction in the tolerance', '10 ± 1/64'],
    ['expression', '3 + 4'],
    ['reference', 'D'],
    ['formula with a reference', 'D / 2'],
  ])('shows the echo for %s (%s) in an mm field', (_what, source) => {
    expect(adds(source)).toBe(true)
  })

  it('shows the echo for mm typed in an inch field', () => {
    expect(adds('12.7 mm', 'in')).toBe(true)
  })

  it('a plain value still shows its inherited tolerance, a toleranced one does not', () => {
    const inherited = { deviation: Rational.create(1n, 10n).unwrap(), scope: 'part' }
    const plain = readSource('15', MM_CTX, NONE).unwrap()
    expect(describeInherited(plain, 'mm', 3, inherited)).toBe('±0.100 mm from part')
    expect(describeInherited(plain, 'mm', 3)).toBeUndefined()
    const toleranced = readSource('15 ±0.05', MM_CTX, NONE).unwrap()
    expect(describeInherited(toleranced, 'mm', 3, inherited)).toBeUndefined()
  })
})
