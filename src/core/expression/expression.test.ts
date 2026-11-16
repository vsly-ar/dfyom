// Spec: docs/architecture/quantities.md#expressions-and-references (task 2.2)
import { describe, expect, it } from 'vitest'
import { Option } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { Quantity, type ParseContext } from '../quantity/quantity'
import type { ReferenceResolver } from './evaluate'
import { quantityFromSource, reevaluate, referencesOf } from './quantity'

const LENGTH_MM: ParseContext = { kind: 'length', defaultUnit: 'mm' }
const LENGTH_IN: ParseContext = { kind: 'length', defaultUnit: 'in' }
const ANGLE: ParseContext = { kind: 'angle', defaultUnit: 'deg' }
const FEED: ParseContext = { kind: 'feedRate', defaultUnit: 'mm/min' }
const SCALAR: ParseContext = { kind: 'scalar', defaultUnit: '1' }

const q = (source: string, ctx: ParseContext = LENGTH_MM): Quantity =>
  expectOk(Quantity.parse(source, ctx))

/** Fake reference resolver over fixed quantities (real resolvers come with later tasks). */
function refs(values: Record<string, Quantity>): ReferenceResolver {
  return { resolve: (name) => Option.nonNull(values[name]) }
}

const VARS = refs({
  D: q('10'),
  E: q('5'),
  W: q('1 in'),
  T: q('10 ±0.1'),
  U: q('5 +0.2/-0.1'),
  A: q('30', ANGLE),
  F: q('600', FEED),
  'tool.diameter': q('6'),
  'pocket1.floor.z.max': q('-3'),
})

const enter = (source: string, ctx: ParseContext = LENGTH_MM, r = VARS): Quantity =>
  expectOk(quantityFromSource(source, ctx, r))
const exact = (source: string, ctx: ParseContext = LENGTH_MM): string =>
  enter(source, ctx).exact.toString()
function tol(source: string, ctx: ParseContext = LENGTH_MM): string {
  const t = enter(source, ctx).tolerance
  return t.isNone() ? 'none' : `${t.unwrap().notation} ${t.unwrap().upper}..${t.unwrap().lower}`
}
const errorOf = (source: string, ctx: ParseContext = LENGTH_MM) =>
  quantityFromSource(source, ctx, VARS)
function issue(source: string, code: Parameters<typeof expectErrCode>[1], ctx = LENGTH_MM) {
  const e = expectErrCode(errorOf(source, ctx), code)
  expect(e.issues).toHaveLength(1)
  return e.issues[0]!
}

describe('expressions: arithmetic', () => {
  it('evaluates references and the four operators exactly', () => {
    expect(exact('D/2')).toBe('5')
    expect(exact('D + E')).toBe('15')
    expect(exact('D - E')).toBe('5')
    expect(exact('D * 3')).toBe('30')
    expect(exact('D / 3')).toBe('10/3')
  })

  it('accepts the unicode operators − × ÷', () => {
    expect(exact('10 − 2 × 3 ÷ 2')).toBe('7')
  })

  it('applies precedence, parentheses and unary minus', () => {
    expect(exact('2 + 3 * 4')).toBe('14')
    expect(exact('(2 + 3) * 4')).toBe('20')
    expect(exact('-D + 1')).toBe('-9')
    expect(exact('D - -1')).toBe('11')
    expect(exact('−(D + E)')).toBe('-15')
    expect(exact('D / 2 / 5')).toBe('1')
    expect(exact('D - E - 1')).toBe('4')
  })

  it('reads a fraction token before division (1/16" is a value, D/1/2 is D ÷ ½)', () => {
    expect(exact('W + 1/16"')).toBe('2159/80')
    expect(exact('D/1/2')).toBe('20')
    expect(exact('D + 1 1/2')).toBe('23/2')
  })

  it('converts units inside the expression exactly', () => {
    expect(exact('D + 1 in')).toBe('177/5')
    expect(exact('10 mm/D * D', LENGTH_MM)).toBe('10') // "/" here is a division, not mm/D
    expect(exact('F + 10 in/min', FEED)).toBe('854')
  })

  it('accepts dotted references', () => {
    expect(exact('pocket1.floor.z.max - tool.diameter / 2')).toBe('-6')
  })
})

describe('expressions: dimensions', () => {
  it('gives a bare number in + or − the other side’s kind in the field’s unit system', () => {
    expect(exact('D + 0.5')).toBe('21/2')
    expect(exact('W + 1', LENGTH_IN)).toBe('254/5') // 1 in + 1 in
    expect(exact('A + 1', ANGLE)).toBe('31')
  })

  it('treats a bare number in × or ÷ as a scalar and a bare result as the field unit', () => {
    expect(exact('2 * 3')).toBe('6')
    expect(exact('2 * 3', LENGTH_IN)).toBe('762/5')
    expect(exact('D + 2 * 3')).toBe('16')
  })

  it('allows quantity × scalar, ÷ scalar and ÷ same kind → scalar', () => {
    expect(exact('D * 50%')).toBe('5')
    expect(exact('D / E', SCALAR)).toBe('2')
    expect(exact('D / E + 1', SCALAR)).toBe('3')
    expect(exact('F * 2', FEED)).toBe('1200')
  })

  it('rejects kind mismatches, derived units and a result of the wrong kind', () => {
    expect(issue('D + A', 'expression.dimension').rule).toBe('kindMismatch')
    expect(issue('D + 30 deg', 'expression.dimension').params).toMatchObject({ offset: 2 })
    expect(issue('D * D', 'expression.dimension').rule).toBe('unsupportedProduct')
    expect(issue('2 / D', 'expression.dimension').rule).toBe('unsupportedProduct')
    expect(issue('D / E', 'expression.dimension').rule).toBe('resultKind')
    expect(issue('D * 50%', 'expression.dimension', SCALAR).rule).toBe('resultKind')
  })

  it('rejects a bare number whose unit the field cannot tell (no unit system in a scalar field)', () => {
    expect(issue('(D + 1) / D', 'expression.dimension', SCALAR).rule).toBe('bareNumberUnit')
    expect(exact('(D + 1 mm) / D', SCALAR)).toBe('11/10')
  })
})

describe('expressions: tolerance', () => {
  it('leaves a result without toleranced operands untoleranced', () => {
    expect(tol('D + E')).toBe('none')
  })

  it('propagates by worst-case intervals through + and −', () => {
    expect(tol('T + U')).toBe('deviations 3/10..-1/5')
    expect(tol('T - U')).toBe('deviations 1/5..-3/10')
    expect(tol('T + D')).toBe('symmetric 1/10..-1/10')
  })

  it('propagates by worst-case intervals through × and ÷', () => {
    expect(tol('T * 2')).toBe('symmetric 1/5..-1/5')
    expect(tol('T / 2')).toBe('symmetric 1/20..-1/20')
    expect(tol('-T')).toBe('symmetric 1/10..-1/10')
    const vars = refs({ P: q('10 ±1'), Q: q('2 ±1', SCALAR) })
    // [9, 11] × [1, 3] = [9, 33], nominal 20
    expect(enter('P * Q', LENGTH_MM, vars).tolerance.unwrap().upper.toString()).toBe('13')
    expect(enter('P * Q', LENGTH_MM, vars).tolerance.unwrap().lower.toString()).toBe('-11')
    // [9, 11] ÷ [1, 3] = [3, 11], nominal 5
    expect(enter('P / Q', LENGTH_MM, vars).tolerance.unwrap().upper.toString()).toBe('6')
    expect(enter('P / Q', LENGTH_MM, vars).tolerance.unwrap().lower.toString()).toBe('-2')
  })

  it('lets a trailing tolerance override propagation', () => {
    expect(tol('(T/2) ±0.01')).toBe('symmetric 1/100..-1/100')
    expect(tol('T/2 +0.1/-0.05')).toBe('deviations 1/10..-1/20')
    expect(tol('D ±0.001 in')).toBe('symmetric 127/5000..-127/5000')
    expect(tol('D±0.1')).toBe('symmetric 1/10..-1/10')
  })

  it('reads a spaced sign as subtraction and a sign glued to a deviation pair as tolerance', () => {
    expect(exact('D - 1/2')).toBe('19/2')
    expect(tol('D - 1/2')).toBe('none')
    expect(exact('D +0.1/0')).toBe('10')
    expect(tol('D +0.1/0')).toBe('deviations 1/10..0')
  })

  it('accepts a tolerance only at the end of the expression', () => {
    expect(issue('(D ±0.1) * 2', 'quantity.syntax').params).toMatchObject({ offset: 3 })
  })
})

describe('expressions: errors', () => {
  it('rejects an unknown reference with its name and position', () => {
    expect(issue('D + nope', 'expression.reference').params).toMatchObject({
      offset: 4,
      name: 'nope',
    })
  })

  it('rejects division by zero and by a divisor interval containing 0', () => {
    expect(issue('D / 0', 'expression.domain').rule).toBe('divisionByZero')
    expect(issue('D / (E - E)', 'expression.domain').rule).toBe('divisionByZero')
    const vars = refs({ Z: q('0.01 ±0.02', SCALAR), D: q('10') })
    const e = expectErrCode(quantityFromSource('D / Z', LENGTH_MM, vars), 'expression.domain')
    expect(e.issues[0]!.rule).toBe('divisorContainsZero')
  })

  it('reports syntax errors with the offset', () => {
    expect(issue('D +', 'quantity.syntax').params).toMatchObject({ offset: 3 })
    expect(issue('(D', 'quantity.syntax').params).toMatchObject({ offset: 2, expected: [')'] })
    expect(issue('D E', 'quantity.syntax').params).toMatchObject({ offset: 2 })
    expect(issue('', 'quantity.syntax').params).toMatchObject({ offset: 0 })
  })

  it('has no functions: a call is a syntax error', () => {
    expect(issue('abs(D)', 'quantity.syntax').params).toMatchObject({ offset: 3 })
  })

  it('rejects unary plus and a number directly followed by a reference', () => {
    expect(issue('D * +2', 'quantity.syntax').params).toMatchObject({ offset: 4 })
    expect(issue('2D', 'quantity.unit').rule).toBe('unknownUnit')
  })

  it('keeps rejecting hyphenated mixed numbers (write "10 - 1/2" to subtract)', () => {
    expect(issue('D + 1-1/2"', 'quantity.syntax').rule).toBe('hyphenatedMixedNumber')
  })

  it('enforces the source length limit', () => {
    expect(issue(`D${' + 1'.repeat(64)}`, 'quantity.syntax').rule).toBe('maxLength')
  })
})

describe('expressions: literals stay literals', () => {
  it('reads a source that is a valid literal exactly as Quantity.parse does', () => {
    const literal = q('10+0.1/-0.05')
    expect(enter('10+0.1/-0.05').equals(literal)).toBe(true)
    expect(enter('1/16"').equals(q('1/16"'))).toBe(true)
  })

  it('reports the literal error when the literal got further (unit of another kind)', () => {
    expect(issue('10 mm/min', 'quantity.unit').rule).toBe('unitKind')
  })
})

describe('expressions: Quantity integration', () => {
  it('creates a quantity with the source as entered and the field kind and default unit', () => {
    const v = enter('W/2 ±0.01', LENGTH_IN)
    expect(v.source).toBe('W/2 ±0.01')
    expect(v.kind).toBe('length')
    expect(v.defaultUnit).toBe('in')
    expect(v.exact.toString()).toBe('127/10')
    expect(v.tolerance.unwrap().upper.toString()).toBe('127/500') // 0.01 in
  })

  it('keeps the exact value until an input changes, then re-evaluates', () => {
    const v = enter('D/2')
    const loaded = expectOk(Quantity.fromDTO(v.toDTO())) // no resolver needed to load
    expect(loaded.exact.toString()).toBe('5')
    const changed = expectOk(reevaluate(loaded, refs({ D: q('12') })))
    expect(changed.exact.toString()).toBe('6')
    expect(changed.source).toBe('D/2')
  })

  it('re-evaluating a literal returns it unchanged', () => {
    const v = q('1/16"')
    expect(expectOk(reevaluate(v, refs({}))).equals(v)).toBe(true)
  })

  it('extracts dependencies: unique reference names in order of appearance', () => {
    expect(
      expectOk(
        referencesOf(enter('pocket1.floor.z.max - tool.diameter / 2 + pocket1.floor.z.max')),
      ),
    ).toEqual(['pocket1.floor.z.max', 'tool.diameter'])
    expect(expectOk(referencesOf(q('10 ±0.1')))).toEqual([])
  })
})
