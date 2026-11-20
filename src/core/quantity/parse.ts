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
import {
  spellingsOf,
  unitFromSpelling,
  UNIT_IDS,
  UNITS,
  type QuantityKind,
  type UnitId,
} from './units'

/** What the field supplies: its kind and the unit a bare number means (e.g. the project unit). */
export interface ParseContext {
  readonly kind: QuantityKind
  readonly defaultUnit: UnitId
}

/** A parsed literal, already converted to the canonical unit of the kind. */
export interface ParsedLiteral {
  readonly exact: Rational
  readonly tolerance: Option<ToleranceProps>
  /** The nominal as written, for the input field (steppers, unit suffix; task 3.4). */
  readonly nominal: LiteralNominal
}

/** Where the signed number of a literal's value sits in the source and what it says. */
export interface LiteralNominal {
  /** Offsets of the signed number in the source (`start` at the sign, `end` before the unit). */
  readonly start: number
  readonly end: number
  /** Signed value in the written unit (not converted). */
  readonly value: Rational
  /** Unit written after the number; None = the field's bare-number default. */
  readonly unit: Option<UnitId>
}

/** Maximum source length in UTF-16 code units (`string.length`). */
export const MAX_SOURCE_LENGTH = 256

const UNIT_LETTER = /^[A-Za-zµ]$/
const UNIT_SYMBOLS = new Set(['"', '″', "'", '′', '°', '%'])
export const SIGNS: ReadonlySet<string> = new Set(['+', '-', '−'])
export const PLUS_MINUS = ['+/-', '+-', '±'] as const
const HYPHENATED_MIXED = /^[-−]\d+\/\d+/

export const isWs = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === ' '
export const isDigit = (ch: string | undefined): boolean =>
  ch !== undefined && ch >= '0' && ch <= '9'
const isUnitLetter = (ch: string | undefined): boolean => ch !== undefined && UNIT_LETTER.test(ch)

type Params = { readonly offset: number; readonly expected: readonly string[] } & Readonly<
  Record<string, unknown>
>

/** A `quantity.syntax` / `quantity.unit` error with one issue at path `[]` (see header). */
export function reject(
  code: ErrorCode,
  rule: string,
  message: string,
  params: Params,
): AppResult<never> {
  return fail(code, message, {
    issues: [{ path: [], rule, message, params }],
    where: 'parseLiteral',
  })
}

/** Parse a literal for a field. Pure; does not construct the Quantity model. */
export function parseLiteral(source: string, ctx: ParseContext): AppResult<ParsedLiteral> {
  return new LiteralScanner(source, ctx.kind).literal(ctx.defaultUnit)
}

/** `quantity.syntax` "expected …, found …" at `pos`. */
export function unexpectedAt(
  src: string,
  pos: number,
  expected: readonly string[],
): AppResult<never> {
  const found = pos >= src.length ? 'end of input' : `"${src[pos]}"`
  return reject('quantity.syntax', 'syntax', `expected ${expected.join(' or ')}, found ${found}`, {
    offset: pos,
    expected,
  })
}

export interface Magnitude {
  readonly value: Rational
  /** Unit as written, if any. */
  readonly unit: Option<UnitId>
  /** Offset just after the number (before any unit). */
  readonly end: number
}

/**
 * Scanner for the literal grammar, also used token-wise by the expression parser
 * (src/core/expression/parse.ts). `kind: 'any'` accepts units of every kind (numbers inside
 * expressions); a kind restricts units to that kind (a field's literal or trailing tolerance).
 */
export class LiteralScanner {
  constructor(
    private readonly src: string,
    private readonly kind: QuantityKind | 'any',
    public pos = 0,
  ) {}

  literal(defaultUnit: UnitId): AppResult<ParsedLiteral> {
    if (this.src.length > MAX_SOURCE_LENGTH)
      return reject('quantity.syntax', 'maxLength', `longer than ${MAX_SOURCE_LENGTH} characters`, {
        offset: MAX_SOURCE_LENGTH,
        expected: ['end'],
        max: MAX_SOURCE_LENGTH,
      })
    this.skipWs()
    const start = this.pos
    const v = this.quantityValue()
    if (v.isErr()) return v
    const { value, unit, end } = v.unwrap()
    const nominal: LiteralNominal = { start, end, value, unit }
    const valueUnit = unit.unwrapOr(defaultUnit)
    this.skipWs()
    const exact = value.mul(UNITS[valueUnit].factor)
    if (this.atEnd()) return Ok({ exact, tolerance: None, nominal })

    const tol = this.tolerance(valueUnit, unit.isNone())
    if (tol.isErr()) return tol
    this.skipWs()
    if (!this.atEnd()) return this.unexpected(['end'])
    return Ok({ exact, tolerance: Some(tol.unwrap()), nominal })
  }

  /** `magnitude, [ ws, unit ]` at `pos`: one number token of an expression. */
  numberToken(): AppResult<Magnitude> {
    return this.magnitudeWithUnit(true)
  }

  /** A tolerance at `pos` that runs to the end of the source (trailing ws allowed). */
  trailingTolerance(valueUnit: UnitId): AppResult<ToleranceProps> {
    const tol = this.tolerance(valueUnit, false)
    if (tol.isErr()) return tol
    this.skipWs()
    if (!this.atEnd()) return this.unexpected(['end'])
    return tol
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
    // `+1/16/-0`: "1/16" is a fraction; `+1/0`, `+1/-0.05`: "/" separates integer deviations.
    // Read an upper `digits/digits` as a fraction first; if the pair then cannot complete, read
    // it as an integer followed by the separator. If both fail, report the fraction reading.
    const start = this.pos
    const asFraction = this.deviationPair(valueUnit, true)
    if (asFraction.isOk() || asFraction.unwrapErr().code !== 'quantity.syntax') return asFraction
    this.pos = start
    const asIntegers = this.deviationPair(valueUnit, false)
    return asIntegers.isOk() ? asIntegers : asFraction
  }

  /** `sign, dev, ws, "/", ws, [sign], dev` up to the end of the source. */
  private deviationPair(valueUnit: UnitId, upperFraction: boolean): AppResult<ToleranceProps> {
    const upperNeg = this.sign()
    const upper = this.deviation(valueUnit, upperFraction)
    if (upper.isErr()) return upper
    this.skipWs()
    if (this.peek() !== '/') return this.unexpected(['/'])
    this.pos++
    this.skipWs()
    const lowerNeg = SIGNS.has(this.peek() ?? '') ? this.sign() : false
    const lower = this.deviation(valueUnit)
    if (lower.isErr()) return lower
    this.skipWs()
    if (!this.atEnd()) return this.unexpected(['end'])
    const u = upper.unwrap()
    const l = lower.unwrap()
    return Ok({
      notation: 'deviations',
      upper: upperNeg ? u.neg() : u,
      lower: lowerNeg ? l.neg() : l,
    })
  }

  // dev = magnitude, [ ws, unit ]; a deviation without a unit takes the value's unit.
  private deviation(valueUnit: UnitId, fraction = true): AppResult<Rational> {
    const m = this.magnitudeWithUnit(fraction)
    if (m.isErr()) return m
    const { value, unit } = m.unwrap()
    return Ok(value.mul(UNITS[unit.unwrapOr(valueUnit)].factor))
  }

  // value = [ sign ], magnitude, [ ws, unit ]
  private quantityValue(): AppResult<Magnitude> {
    const negative = SIGNS.has(this.peek() ?? '') ? this.sign() : false
    const m = this.magnitudeWithUnit(true)
    if (m.isErr()) return m
    const { value, unit, end } = m.unwrap()
    return Ok({ value: negative ? value.neg() : value, unit, end })
  }

  private magnitudeWithUnit(fraction: boolean): AppResult<Magnitude> {
    const m = this.magnitude(fraction)
    if (m.isErr()) return m
    const end = this.pos
    this.skipWs()
    const unit = this.unit()
    if (unit.isErr()) return unit
    if (unit.unwrap().isNone()) this.pos = end
    return Ok({ value: m.unwrap(), unit: unit.unwrap(), end })
  }

  // magnitude = mixed | fraction | decimal. `fraction: false` reads `1/…` as the integer 1.
  private magnitude(fraction: boolean): AppResult<Rational> {
    const start = this.pos
    if (this.peek() === '.') {
      this.pos++
      const frac = this.digits()
      if (frac === '') return this.unexpected(['digit'])
      return Ok(decimal('0', frac))
    }
    const whole = this.digits()
    if (whole === '') return this.unexpected(['digit'])

    // A fraction needs a digit right after "/"; otherwise "/" is left for the deviation pair.
    if (fraction && this.peek() === '/' && isDigit(this.src[this.pos + 1]))
      return this.fractionAfter(whole, start)

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
        const frac = this.fractionAfter(num, numStart)
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

  // fraction = digits, "/", digits (no spaces inside); `pos` is at the "/", a digit follows.
  private fractionAfter(num: string, start: number): AppResult<Rational> {
    this.pos++
    const den = this.digits()
    const r = Rational.create(BigInt(num), BigInt(den))
    if (r.isOk()) return r
    return reject('quantity.syntax', 'zeroDenominator', 'zero denominator', {
      offset: start,
      expected: ['digit'],
    })
  }

  /** A unit token if one starts here; quantity.unit if it is unknown or of another kind. */
  private unit(): AppResult<Option<UnitId>> {
    const start = this.pos
    if (UNIT_SYMBOLS.has(this.peek() ?? '')) this.pos++
    else if (isUnitLetter(this.peek())) {
      this.letters()
      if (this.peek() === '/' && isUnitLetter(this.src[this.pos + 1])) {
        const save = this.pos
        this.pos++
        this.letters()
        // In expressions `10 mm/D` is a division: keep "/" only if it forms a known unit.
        if (this.kind === 'any' && unitFromSpelling(this.src.slice(start, this.pos)).isNone())
          this.pos = save
      }
    } else return Ok(None)

    const spelling = this.src.slice(start, this.pos)
    const expected = this.kind === 'any' ? allSpellings() : spellingsOf(this.kind)
    const id = unitFromSpelling(spelling)
    if (id.isNone())
      return reject('quantity.unit', 'unknownUnit', `unknown unit "${spelling}"`, {
        offset: start,
        expected,
        actual: spelling,
      })
    const unit = id.unwrap()
    if (this.kind !== 'any' && UNITS[unit].kind !== this.kind)
      return reject(
        'quantity.unit',
        'unitKind',
        `"${spelling}" is a ${UNITS[unit].kind} unit, expected ${this.kind}`,
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
    return unexpectedAt(this.src, this.pos, expected)
  }
}

function allSpellings(): string[] {
  return UNIT_IDS.flatMap((id) => UNITS[id].spellings)
}

function decimal(whole: string, frac: string): Rational {
  const r = Rational.create(BigInt(whole + frac), 10n ** BigInt(frac.length))
  if (r.isErr()) throw r.unwrapErr() // 10^n is never 0: a bug if reached
  return r.unwrap()
}
