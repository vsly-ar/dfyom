/**
 * Literal grammar: `1 1/2"`, `3.175 mm`, `10 ±0.05`, `10 +0.1/−0.05`.
 * Doc: docs/architecture/quantities.md#literal-grammar-task-21
 *
 * Hand-written recursive descent. Errors are `quantity.syntax` / `quantity.unit` with one issue
 * (path `[]`) whose `params` carry `{ offset, expected }` – offset in UTF-16 code units into the
 * source – so the input field can mark the position.
 */
import type { ErrorCode } from '../../shared/errors/codes'
import { fail, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import { Rational } from './rational'
import type { ToleranceProps } from './tolerance'
import { spellingsOf, unitFromSpelling, UNITS, type QuantityKind, type UnitId } from './units'

/** What the field supplies: its kind and the unit a bare number means (e.g. the project unit). */
export interface ParseContext {
  readonly kind: QuantityKind
  readonly defaultUnit: UnitId
}

/** A parsed literal, already converted to the canonical unit of the kind. */
export interface ParsedLiteral {
  readonly exact: Rational
  readonly tolerance: Option<ToleranceProps>
}

/** Maximum source length in UTF-16 code units (`string.length`). */
export const MAX_SOURCE_LENGTH = 256

const UNIT_LETTER = /^[A-Za-zµ]$/
const UNIT_SYMBOLS = new Set(['"', '″', "'", '′', '°', '%'])
const SIGNS = new Set(['+', '-', '−'])
const PLUS_MINUS = ['+/-', '+-', '±'] as const
const HYPHENATED_MIXED = /^[-−]\d+\/\d+/

const isWs = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === ' '
const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9'
const isUnitLetter = (ch: string | undefined): boolean => ch !== undefined && UNIT_LETTER.test(ch)

type Params = { readonly offset: number; readonly expected: readonly string[] } & Readonly<
  Record<string, unknown>
>

function reject(code: ErrorCode, rule: string, message: string, params: Params): AppResult<never> {
  return fail(code, message, {
    issues: [{ path: [], rule, message, params }],
    where: 'parseLiteral',
  })
}

/** Parse a literal for a field. Pure; does not construct the Quantity model. */
export function parseLiteral(source: string, ctx: ParseContext): AppResult<ParsedLiteral> {
  return new LiteralParser(source, ctx).literal()
}

interface Magnitude {
  readonly value: Rational
  /** Unit as written, if any. */
  readonly unit: Option<UnitId>
}

class LiteralParser {
  private pos = 0

  constructor(
    private readonly src: string,
    private readonly ctx: ParseContext,
  ) {}

  literal(): AppResult<ParsedLiteral> {
    if (this.src.length > MAX_SOURCE_LENGTH)
      return reject('quantity.syntax', 'maxLength', `longer than ${MAX_SOURCE_LENGTH} characters`, {
        offset: MAX_SOURCE_LENGTH,
        expected: ['end'],
        max: MAX_SOURCE_LENGTH,
      })
    this.skipWs()
    const v = this.quantityValue()
    if (v.isErr()) return v
    const { value, unit } = v.unwrap()
    const valueUnit = unit.unwrapOr(this.ctx.defaultUnit)
    this.skipWs()
    const exact = value.mul(UNITS[valueUnit].factor)
    if (this.atEnd()) return Ok({ exact, tolerance: None })

    const tol = this.tolerance(valueUnit, unit.isNone())
    if (tol.isErr()) return tol
    this.skipWs()
    if (!this.atEnd()) return this.unexpected(['end'])
    return Ok({ exact, tolerance: Some(tol.unwrap()) })
  }

  // tolerance = pm, ws, dev | sign, dev, ws, "/", ws, [ sign ], dev
  private tolerance(valueUnit: UnitId, unitAllowed: boolean): AppResult<ToleranceProps> {
    const pm = PLUS_MINUS.find((p) => this.src.startsWith(p, this.pos))
    if (pm !== undefined) {
      this.pos += pm.length
      this.skipWs()
      const d = this.deviation(valueUnit)
      if (d.isErr()) return d
      const dev = d.unwrap()
      return Ok({ notation: 'symmetric', upper: dev, lower: dev.neg() })
    }
    if (!SIGNS.has(this.peek() ?? ''))
      return this.unexpected(unitAllowed ? ['unit', 'tolerance', 'end'] : ['tolerance', 'end'])
    const upperNeg = this.sign()
    const upper = this.deviation(valueUnit, true)
    if (upper.isErr()) return upper
    this.skipWs()
    if (this.peek() !== '/') return this.unexpected(['/'])
    this.pos++
    this.skipWs()
    const lowerNeg = SIGNS.has(this.peek() ?? '') ? this.sign() : false
    const lower = this.deviation(valueUnit)
    if (lower.isErr()) return lower
    const u = upper.unwrap()
    const l = lower.unwrap()
    return Ok({
      notation: 'deviations',
      upper: upperNeg ? u.neg() : u,
      lower: lowerNeg ? l.neg() : l,
    })
  }

  // dev = magnitude, [ ws, unit ]; a deviation without a unit takes the value's unit.
  private deviation(valueUnit: UnitId, inPair = false): AppResult<Rational> {
    const m = this.magnitudeWithUnit(inPair)
    if (m.isErr()) return m
    const { value, unit } = m.unwrap()
    return Ok(value.mul(UNITS[unit.unwrapOr(valueUnit)].factor))
  }

  // value = [ sign ], magnitude, [ ws, unit ]
  private quantityValue(): AppResult<Magnitude> {
    const negative = SIGNS.has(this.peek() ?? '') ? this.sign() : false
    const m = this.magnitudeWithUnit(false)
    if (m.isErr()) return m
    const { value, unit } = m.unwrap()
    return Ok({ value: negative ? value.neg() : value, unit })
  }

  private magnitudeWithUnit(inPair: boolean): AppResult<Magnitude> {
    const m = this.magnitude(inPair)
    if (m.isErr()) return m
    const save = this.pos
    this.skipWs()
    const unit = this.unit()
    if (unit.isErr()) return unit
    if (unit.unwrap().isNone()) this.pos = save
    return Ok({ value: m.unwrap(), unit: unit.unwrap() })
  }

  // magnitude = mixed | fraction | decimal
  private magnitude(inPair: boolean): AppResult<Rational> {
    const start = this.pos
    if (this.peek() === '.') {
      this.pos++
      const frac = this.digits()
      if (frac === '') return this.unexpected(['digit'])
      return Ok(decimal('0', frac))
    }
    const whole = this.digits()
    if (whole === '') return this.unexpected(['digit'])

    if (this.peek() === '/') return this.fractionAfter(whole, start, inPair)

    const rest = this.src.slice(this.pos)
    if (HYPHENATED_MIXED.test(rest)) {
      const hint = `${this.src.slice(0, this.pos)} ${this.src.slice(this.pos + 1)}`.trim()
      return reject(
        'quantity.syntax',
        'hyphenatedMixedNumber',
        `write a mixed number with a space, e.g. "${hint}" ("-" means subtraction)`,
        { offset: this.pos, expected: [' '], hint },
      )
    }

    // mixed = digits, ws1, fraction
    if (isWs(this.peek())) {
      const save = this.pos
      this.skipWs()
      const numStart = this.pos
      const num = this.digits()
      if (num !== '' && this.peek() === '/' && isDigit(this.src[this.pos + 1])) {
        const frac = this.fractionAfter(num, numStart, inPair)
        if (frac.isErr()) return frac
        return Ok(Rational.int(BigInt(whole)).add(frac.unwrap()))
      }
      this.pos = save
    }

    if (this.peek() === '.') {
      this.pos++
      return Ok(decimal(whole, this.digits()))
    }
    return Ok(Rational.int(BigInt(whole)))
  }

  // fraction = digits, "/", digits (no spaces inside); `pos` is at the "/".
  private fractionAfter(num: string, start: number, inPair: boolean): AppResult<Rational> {
    this.pos++
    const den = this.digits()
    if (den === '') return this.unexpected(['digit'])
    const r = Rational.create(BigInt(num), BigInt(den))
    if (r.isOk()) return r
    return reject(
      'quantity.syntax',
      'zeroDenominator',
      inPair
        ? 'zero denominator; separate integer deviations with spaces, e.g. "+1 / 0"'
        : 'zero denominator',
      { offset: start, expected: ['digit'] },
    )
  }

  /** A unit token if one starts here; quantity.unit if it is unknown or of another kind. */
  private unit(): AppResult<Option<UnitId>> {
    const start = this.pos
    if (UNIT_SYMBOLS.has(this.peek() ?? '')) this.pos++
    else if (isUnitLetter(this.peek())) {
      this.letters()
      if (this.peek() === '/' && isUnitLetter(this.src[this.pos + 1])) {
        this.pos++
        this.letters()
      }
    } else return Ok(None)

    const spelling = this.src.slice(start, this.pos)
    const expected = spellingsOf(this.ctx.kind)
    const id = unitFromSpelling(spelling)
    if (id.isNone())
      return reject('quantity.unit', 'unknownUnit', `unknown unit "${spelling}"`, {
        offset: start,
        expected,
        actual: spelling,
      })
    const unit = id.unwrap()
    if (UNITS[unit].kind !== this.ctx.kind)
      return reject(
        'quantity.unit',
        'unitKind',
        `"${spelling}" is a ${UNITS[unit].kind} unit, expected ${this.ctx.kind}`,
        { offset: start, expected, actual: spelling },
      )
    return Ok(Some(unit))
  }

  /** Consumes a sign; returns true for minus. */
  private sign(): boolean {
    const ch = this.peek()
    this.pos++
    return ch !== '+'
  }

  private digits(): string {
    const start = this.pos
    while (isDigit(this.peek())) this.pos++
    return this.src.slice(start, this.pos)
  }

  private letters(): void {
    while (isUnitLetter(this.peek())) this.pos++
  }

  private skipWs(): void {
    while (isWs(this.peek())) this.pos++
  }

  private peek(): string | undefined {
    return this.src[this.pos]
  }

  private atEnd(): boolean {
    return this.pos >= this.src.length
  }

  private unexpected(expected: readonly string[]): AppResult<never> {
    const found = this.atEnd() ? 'end of input' : `"${this.peek()}"`
    return reject(
      'quantity.syntax',
      'syntax',
      `expected ${expected.join(' or ')}, found ${found}`,
      {
        offset: this.pos,
        expected,
      },
    )
  }
}

function decimal(whole: string, frac: string): Rational {
  const r = Rational.create(BigInt(whole + frac), 10n ** BigInt(frac.length))
  if (r.isErr()) throw r.unwrapErr() // 10^n is never 0: a bug if reached
  return r.unwrap()
}
