// Spec: docs/architecture/quantities.md (task 2.1)
import { describe, expect, it } from 'vitest'
import { parseWith } from '../../shared/parse'
import { None, Some } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { parseLiteral } from './parse'
import { Quantity, type ParseContext } from './quantity'
import { QuantityDtoSchema, type QuantityDTO } from './quantity.dto'
import { Rational } from './rational'
import { Tolerance } from './tolerance'

const LENGTH_MM: ParseContext = { kind: 'length', defaultUnit: 'mm' }
const LENGTH_IN: ParseContext = { kind: 'length', defaultUnit: 'in' }
const SCALAR: ParseContext = { kind: 'scalar', defaultUnit: '1' }
const POWER: ParseContext = { kind: 'power', defaultUnit: 'W' }

const parse = (source: string, ctx: ParseContext = LENGTH_MM): Quantity =>
  expectOk(Quantity.parse(source, ctx))

/** Exact value as "num/den" for readable assertions. */
const exact = (source: string, ctx: ParseContext = LENGTH_MM): string =>
  parse(source, ctx).exact.toString()

/** Tolerance as "upper..lower" (canonical, exact) or "none". */
function tol(source: string, ctx: ParseContext = LENGTH_MM): string {
  const t = parse(source, ctx).tolerance
  return t.isNone() ? 'none' : `${t.unwrap().notation} ${t.unwrap().upper}..${t.unwrap().lower}`
}

const rat = (num: bigint, den = 1n): Rational => expectOk(Rational.create(num, den))

describe('Quantity.parse: exact values', () => {
  it('keeps decimals exact (0.1 is 1/10)', () => {
    expect(exact('0.1', SCALAR)).toBe('1/10')
  })

  it('converts inch exactly (1 in = 127/5 mm)', () => {
    expect(exact('1 in')).toBe('127/5')
    expect(exact('1/16"')).toBe('127/80')
  })

  it('reads the grammar examples', () => {
    expect(exact('1 1/2"')).toBe('381/10') // 38.1 mm
    expect(exact('3.175 mm')).toBe('127/40')
    expect(exact('1/2')).toBe('1/2')
    expect(exact('.5')).toBe('1/2')
    expect(exact('5.')).toBe('5')
    expect(exact('  12\t')).toBe('12')
    expect(exact('7 mm')).toBe('7')
  })

  it('accepts every unit spelling of the kind, alphabetic ones case-insensitively', () => {
    const cases: [string, string, ParseContext?][] = [
      ['1 mm', '1'],
      ['1 MM', '1'],
      ['1cm', '10'],
      ['1 m', '1000'],
      ['1 um', '1/1000'],
      ['1 µm', '1/1000'],
      ['1 INCH', '127/5'],
      ['1″', '127/5'],
      ['1 ft', '1524/5'],
      ["1'", '1524/5'],
      ['1′', '1524/5'],
      ['30 deg', '30', { kind: 'angle', defaultUnit: 'deg' }],
      ['30°', '30', { kind: 'angle', defaultUnit: 'deg' }],
      ['600 mm/min', '600', { kind: 'feedRate', defaultUnit: 'mm/min' }],
      ['10 in/min', '254', { kind: 'feedRate', defaultUnit: 'mm/min' }],
      ['10 IPM', '254', { kind: 'feedRate', defaultUnit: 'mm/min' }],
      ['18000 rpm', '18000', { kind: 'spindleSpeed', defaultUnit: 'rpm' }],
      ['50%', '1/2', SCALAR],
      ['800 W', '800', POWER],
      ['2.2 kW', '2200', POWER],
      ['2.2 KW', '2200', POWER],
      ['1 hp', '37284993579113511/50000000000000', POWER], // mechanical hp, exact
      ['1 HP', '37284993579113511/50000000000000', POWER],
    ]
    for (const [source, value, ctx] of cases) expect(exact(source, ctx), source).toBe(value)
  })

  it('gives a bare number the field default unit', () => {
    expect(exact('2', LENGTH_IN)).toBe('254/5')
    expect(exact('10', { kind: 'feedRate', defaultUnit: 'in/min' })).toBe('254')
    expect(parse('2', LENGTH_IN).defaultUnit).toBe('in')
    expect(exact('1500', POWER)).toBe('1500')
  })

  it('rejects a unit of another kind in a power field', () => {
    expectErrCode(Quantity.parse('1 rpm', POWER), 'quantity.unit')
    expectErrCode(Quantity.parse('1 kW', LENGTH_MM), 'quantity.unit')
  })

  it('accepts signs including the unicode minus (U+2212)', () => {
    expect(exact('-1 1/2"')).toBe('-381/10')
    expect(exact('−3')).toBe('-3')
    expect(exact('+3')).toBe('3')
  })

  it('keeps the source as entered', () => {
    expect(parse(' 1/16" ').source).toBe(' 1/16" ')
  })
})

describe('Quantity.parse: canonical float64', () => {
  it('is the nearest float64 to the exact value', () => {
    expect(parse('1/16"').canonical).toBe(1.5875)
    expect(parse('0.1').canonical).toBe(0.1)
    expect(parse('1/3').canonical).toBe(1 / 3)
  })

  it('rounds long decimals exactly like the platform decimal parser', () => {
    // Number(string) is correctly rounded: an independent oracle.
    const samples = [
      '0.30000000000000004441',
      '123456789012345678901234567890.123456789',
      '9007199254740993', // 2^53 + 1: tie, rounds to even
      '9007199254740995',
      '0.00000000000000000000000000000000000000000000000000000000000000001234567890123',
      '1' + '0'.repeat(200) + '.5',
    ]
    for (const s of samples) expect(parse(s, SCALAR).canonical, s).toBe(Number(s))
    let seed = 42
    for (let i = 0; i < 200; i++) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      const digits = String(seed) + String(seed * 7)
      const s = `${digits.slice(0, (seed % 15) + 1)}.${digits.slice((seed % 15) + 1)}`
      expect(parse(s, SCALAR).canonical, s).toBe(Number(s))
    }
  })

  it('converts huge and tiny rationals without overflow in between', () => {
    expect(rat(10n ** 300n + 1n, 10n ** 300n).toNumber()).toBe(1)
    expect(rat(1n, 10n ** 320n).toNumber()).toBe(1e-320) // subnormal
    expect(rat(-(10n ** 400n)).toNumber()).toBe(Number.NEGATIVE_INFINITY)
  })
})

describe('Quantity.parse: tolerance', () => {
  it('reads symmetric tolerances (±, +/-, +-)', () => {
    expect(tol('10 ±0.05')).toBe('symmetric 1/20..-1/20')
    expect(tol('10 +/-0.05')).toBe('symmetric 1/20..-1/20')
    expect(tol('10+-0.05')).toBe('symmetric 1/20..-1/20')
  })

  it('reads bilateral and unilateral deviations', () => {
    expect(tol('10 +0.1/−0.05')).toBe('deviations 1/10..-1/20')
    expect(tol('10 +0.1/-0.05')).toBe('deviations 1/10..-1/20')
    expect(tol('10 +0.1/0')).toBe('deviations 1/10..0')
    expect(tol('10 +0.1 / 0')).toBe('deviations 1/10..0')
    expect(tol('10 −0.02/−0.05')).toBe('deviations -1/50..-1/20')
    expect(tol('10 +1 / 0')).toBe('deviations 1..0')
  })

  it('separates integer deviations at "/" unless a digit follows (unilateral +0/−x)', () => {
    expect(tol('10 +0/-0.05')).toBe('deviations 0..-1/20')
    expect(tol('10 +1/-0.05')).toBe('deviations 1..-1/20')
    expect(tol('10 +0/−0.05')).toBe('deviations 0..-1/20')
    expect(tol('10 +0.1/-0.05')).toBe('deviations 1/10..-1/20')
  })

  it('reads digits/digits as a fraction deviation when the pair still completes', () => {
    expect(tol('1" +1/16"/-0')).toBe('deviations 127/80..0')
    expect(tol('1 +1/16/-1/32', LENGTH_IN)).toBe('deviations 127/80..-127/160')
    expect(tol('10 +1/2/0')).toBe('deviations 1/2..0')
  })

  it('falls back to integer deviations when the fraction reading cannot complete the pair', () => {
    expect(tol('10 +1/0')).toBe('deviations 1..0') // not a zero denominator
    expect(tol('10 +1/0 mm')).toBe('deviations 1..0')
    // "+1/2": as a fraction the lower deviation is missing; as integers lower (+2) > upper (+1).
    const e = expectErrCode(Quantity.parse('10 +1/2', LENGTH_MM), 'model.invariant')
    expect(e.issues.map((i) => i.rule)).toEqual(['order'])
  })

  it('gives deviations without a unit the value unit, else their own unit', () => {
    expect(tol('1" ±0.001')).toBe('symmetric 127/5000..-127/5000') // 0.001 in
    expect(tol('1 ±0.001', LENGTH_IN)).toBe('symmetric 127/5000..-127/5000')
    expect(tol('25 mm ±0.001"')).toBe('symmetric 127/5000..-127/5000')
    expect(tol('25 +0.1 mm/-0.02 mm')).toBe('deviations 1/10..-1/50')
  })

  it('stores no tolerance for untoleranced values', () => {
    expect(tol('10')).toBe('none')
  })

  it('rejects upper < lower as a tolerance invariant', () => {
    const e = expectErrCode(Quantity.parse('10 +0.05/+0.1', LENGTH_MM), 'model.invariant')
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([['tolerance.lower', 'order']])
  })
})

describe('Quantity.parse: rejections', () => {
  function rejects(source: string, code: 'quantity.syntax' | 'quantity.unit', rule: string) {
    const e = expectErrCode(Quantity.parse(source, LENGTH_MM), code)
    expect(
      e.issues.map((i) => i.rule),
      source,
    ).toEqual([rule])
    expect(e.issues[0]?.params, source).toHaveProperty('offset')
    expect(e.issues[0]?.params, source).toHaveProperty('expected')
    return e.issues[0]?.params ?? {}
  }

  it('rejects a hyphenated mixed number with a hint', () => {
    const p = rejects('1-1/2"', 'quantity.syntax', 'hyphenatedMixedNumber')
    expect(p).toMatchObject({ offset: 1, hint: '1 1/2"' })
  })

  it('rejects a zero denominator', () => {
    expect(rejects('1/0', 'quantity.syntax', 'zeroDenominator')).toMatchObject({ offset: 0 })
    rejects('2 3/0', 'quantity.syntax', 'zeroDenominator')
    rejects('10 ±1/0', 'quantity.syntax', 'zeroDenominator')
    rejects('10 +1/0/-1', 'quantity.syntax', 'zeroDenominator')
  })

  it('rejects text outside the grammar, with the offset', () => {
    const cases: [string, number][] = [
      ['', 0],
      ['   ', 3],
      ['mm', 0], // a unit without a number: offset of the missing digit
      ['1,5', 1], // decimal comma
      ['1 000', 2],
      ['1 / 2', 2],
      ['1/ 2', 1], // "/" without a digit after it is not a fraction
      ['- 1', 1], // no space between sign and number
      ['.', 1],
      ['1.5/2', 3],
      ['10 ±-0.05', 4],
      ['10 +0.1', 7],
      ['10 +1/', 6],
      ['10 +1/2/', 8],
      ['10 +/−0.05', 4], // only ASCII "+/-" is a ± spelling
      ['10 ±0.05 mm x', 12],
      ['10 mm mm', 6],
    ]
    for (const [source, offset] of cases) {
      const e = Quantity.parse(source, LENGTH_MM)
      expect(e.isErr(), source).toBe(true)
      const err = e.unwrapErr()
      expect(err.code, source).toBe('quantity.syntax')
      expect(err.issues[0]?.params?.['offset'], source).toBe(offset)
    }
  })

  it('rejects unknown units and units of another kind', () => {
    expect(rejects('10 furlong', 'quantity.unit', 'unknownUnit')).toMatchObject({ offset: 3 })
    expect(rejects('10 mm/min', 'quantity.unit', 'unitKind')).toMatchObject({
      offset: 3,
      expected: expect.arrayContaining(['mm', 'in', '"']) as unknown,
    })
    rejects('10 ±1°', 'quantity.unit', 'unitKind')
    rejects('10 rad', 'quantity.unit', 'unknownUnit')
    rejects('1e3', 'quantity.unit', 'unknownUnit') // no exponent notation
  })

  it('caps the source at 256 characters', () => {
    const ok = '1'.padStart(256, ' ')
    expect(parse(ok).source).toHaveLength(256)
    const tooLong = '1'.padStart(257, ' ')
    expect(
      expectErrCode(Quantity.parse(tooLong, LENGTH_MM), 'quantity.syntax').issues[0],
    ).toMatchObject({ rule: 'maxLength', params: { offset: 256 } })
  })

  it('rejects a default unit of another kind (field bug) as an invariant', () => {
    const e = expectErrCode(
      Quantity.parse('10', { kind: 'length', defaultUnit: 'deg' }),
      'model.invariant',
    )
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([['defaultUnit', 'unitKind']])
  })
})

describe('Quantity: equality', () => {
  it('compares kind, exact value and tolerance deviations, not source', () => {
    expect(parse('1"').equals(parse('25.4 mm'))).toBe(true)
    expect(parse('1"').equals(parse('25.4', LENGTH_IN))).toBe(false)
    expect(parse('10 ±0.05').equals(parse('10 +0.05/-0.05'))).toBe(true) // notation is display
    expect(parse('10 ±0.05').equals(parse('10'))).toBe(false)
    expect(parse('10 ±0.05').equals(parse('10 ±0.06'))).toBe(false)
    expect(parse('10').equals(parse('10'))).toBe(true)
    expect(parse('10', SCALAR).equals(parse('10'))).toBe(false)
  })

  it('distinguishes values whose float64 is equal', () => {
    const a = parse('0.1000000000000000000001', SCALAR)
    const b = parse('0.1', SCALAR)
    expect(a.canonical).toBe(b.canonical)
    expect(a.equals(b)).toBe(false)
  })
})

describe('Tolerance invariants', () => {
  it('accepts upper ≥ lower, including both deviations sharing a sign', () => {
    expectOk(Tolerance.create({ notation: 'deviations', upper: rat(0n), lower: rat(0n) }))
    expectOk(Tolerance.create({ notation: 'deviations', upper: rat(-2n), lower: rat(-5n) }))
    expectOk(Tolerance.create({ notation: 'symmetric', upper: rat(1n), lower: rat(-1n) }))
  })

  it('rejects every violated rule at once', () => {
    const e = expectErrCode(
      Tolerance.create({ notation: 'symmetric', upper: rat(-1n), lower: rat(2n) }),
      'model.invariant',
    )
    expect(e.issues.map((i) => i.rule)).toEqual(['order', 'symmetric', 'nonNegative'])
  })

  it('rejects an asymmetric "symmetric" tolerance', () => {
    const e = expectErrCode(
      Tolerance.create({ notation: 'symmetric', upper: rat(1n), lower: rat(-1n, 2n) }),
      'model.invariant',
    )
    expect(e.issues.map((i) => i.rule)).toEqual(['symmetric'])
  })
})

describe('Rational', () => {
  it('normalizes and rejects a zero denominator', () => {
    expect(rat(6n, -4n).toString()).toBe('-3/2')
    expect(rat(0n, 7n).toDTO()).toEqual({ num: '0', den: '1' })
    const e = expectErrCode(Rational.create(1n, 0n), 'model.invariant')
    expect(e.issues[0]?.rule).toBe('denominatorNonZero')
  })

  it('formats exactly at a fixed precision, rounding half away from zero', () => {
    expect(rat(127n, 80n).toFixed(3)).toBe('1.588') // 1.5875
    expect(rat(-127n, 80n).toFixed(3)).toBe('-1.588')
    expect(rat(1n, 3n).toFixed(4)).toBe('0.3333')
    expect(rat(-1n, 10000n).toFixed(3)).toBe('0.000') // no -0
    expect(rat(25n).toFixed(0)).toBe('25')
    expect(rat(1n, 20n).toFixed(1)).toBe('0.1')
  })

  it('finds the fewest decimal digits that write a value exactly', () => {
    expect(rat(1n, 16n).decimalDigits(6).unwrapOr(-1)).toBe(4)
    expect(rat(3n).decimalDigits(6).unwrapOr(-1)).toBe(0)
    expect(rat(1n, 3n).decimalDigits(6).isNone()).toBe(true)
  })
})

describe('parseLiteral: nominal as written (input field, task 3.4)', () => {
  const nominal = (source: string, ctx: ParseContext = LENGTH_MM) =>
    expectOk(parseLiteral(source, ctx)).nominal

  it('spans the signed number without the unit and keeps the written unit', () => {
    const n = nominal(' -1 1/2" ±0.01')
    expect([n.start, n.end]).toEqual([1, 7])
    expect(n.value.toString()).toBe('-3/2')
    expect(n.unit.isSome() && n.unit.unwrap()).toBe('in')
  })

  it('has no unit for a bare number', () => {
    const n = nominal('3.5 +0.1/-0.05')
    expect([n.start, n.end, n.unit.isNone()]).toEqual([0, 3, true])
  })
})

describe('Quantity DTO', () => {
  const load = (raw: unknown) => {
    const dto = parseWith(QuantityDtoSchema, raw, 'test')
    if (dto.isErr()) return dto
    return Quantity.fromDTO(dto.unwrap())
  }

  it('round-trips through JSON, with and without tolerance', () => {
    for (const source of ['1/16"', '10 +0.1/−0.05', '10 ±0.05', '-3.175']) {
      const q = parse(source)
      const back = expectOk(load(JSON.parse(JSON.stringify(q.toDTO()))))
      expect(back.equals(q), source).toBe(true)
      expect(back.toDTO(), source).toEqual(q.toDTO())
    }
    expect(parse('10').toDTO()).toEqual({
      kind: 'length',
      source: '10',
      defaultUnit: 'mm',
      exact: { num: '10', den: '1' },
    })
    expect(parse('1/16" ±0.001').toDTO().tolerance).toEqual({
      notation: 'symmetric',
      upper: { num: '127', den: '5000' },
      lower: { num: '-127', den: '5000' },
    })
  })

  it('loads a DTO whose source disagrees with exact: exact wins, source is not re-parsed', () => {
    const q = expectOk(
      load({ kind: 'length', source: '1"', defaultUnit: 'mm', exact: { num: '3', den: '1' } }),
    )
    expect(q.exact.toString()).toBe('3')
    expect(q.source).toBe('1"')
    // Not even a parseable source is required.
    expectOk(
      load({ kind: 'length', source: 'garbage', defaultUnit: 'mm', exact: { num: '3', den: '1' } }),
    )
  })

  it('normalizes rationals on load', () => {
    const q = expectOk(
      load({ kind: 'scalar', source: '0.5', defaultUnit: '1', exact: { num: '10', den: '20' } }),
    )
    expect(q.exact.toDTO()).toEqual({ num: '1', den: '2' })
  })

  it('reports every invariant violation with DTO paths', () => {
    const dto: QuantityDTO = {
      kind: 'length',
      source: '10',
      defaultUnit: 'deg',
      exact: { num: '1', den: '0' },
      tolerance: { notation: 'deviations', upper: { num: '1', den: '0' }, lower: rat(0n).toDTO() },
    }
    const e = expectErrCode(Quantity.fromDTO(dto), 'model.invariant')
    expect(e.issues.map((i) => i.path.join('.'))).toEqual(['exact.den', 'tolerance.upper.den'])
    const tolErr = expectErrCode(
      Quantity.fromDTO({
        ...dto,
        defaultUnit: 'mm',
        exact: rat(1n).toDTO(),
        tolerance: { notation: 'symmetric', upper: rat(-1n).toDTO(), lower: rat(1n).toDTO() },
      }),
      'model.invariant',
    )
    expect(tolErr.issues.map((i) => `${i.path.join('.')}:${i.rule}`)).toEqual([
      'tolerance.lower:order',
      'tolerance.upper:nonNegative',
    ])
    expect(
      expectErrCode(
        Quantity.fromDTO({ ...dto, exact: rat(1n).toDTO(), tolerance: undefined }),
        'model.invariant',
      ).issues[0]?.rule,
    ).toBe('unitKind')
  })

  it('rejects malformed shapes before the model (input.malformed)', () => {
    const base = { kind: 'length', source: '1', defaultUnit: 'mm', exact: { num: '1', den: '1' } }
    for (const bad of [
      { ...base, exact: { num: '1.5', den: '1' } },
      { ...base, exact: { num: '1', den: '-1' } },
      { ...base, kind: 'area' },
      { ...base, defaultUnit: 'rad' },
      { ...base, source: '' },
      { ...base, source: 'x'.repeat(257) },
    ])
      expectErrCode(load(bad), 'input.malformed')
  })

  it('rejects a value outside float64 range', () => {
    const e = expectErrCode(
      Quantity.create({
        kind: 'scalar',
        source: 'huge',
        defaultUnit: '1',
        exact: rat(10n ** 400n),
        tolerance: None,
      }),
      'model.invariant',
    )
    expect(e.issues[0]?.rule).toBe('finite')
  })

  it('creates directly from typed props', () => {
    const t = expectOk(Tolerance.create({ notation: 'symmetric', upper: rat(1n), lower: rat(-1n) }))
    const q = expectOk(
      Quantity.create({
        kind: 'angle',
        source: '45°',
        defaultUnit: 'deg',
        exact: rat(45n),
        tolerance: Some(t),
      }),
    )
    expect(Object.isFrozen(q)).toBe(true)
    expect(q.canonical).toBe(45)
  })
})
