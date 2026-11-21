// Pure logic of QuantityInput: read a source with the core parser/evaluator, describe the reading
// (echo, muted value), step a plain literal, and turn an AppError into an in-place message with an
// optional fix. Parsing and evaluation stay in src/core (quantityFromSource, parseLiteral); this
// module only formats and splices at offsets the core reports.
// Doc: docs/conventions/ui.md#quantity-and-expression-input, docs/architecture/quantities.md
import { quantityFromSource, referencesOf } from '../../../../core/expression/quantity'
import type { ReferenceResolver } from '../../../../core/expression/evaluate'
import {
  parseLiteral,
  type LiteralNominal,
  type ParseContext,
} from '../../../../core/quantity/parse'
import type { Quantity } from '../../../../core/quantity/quantity'
import { Rational } from '../../../../core/quantity/rational'
import { UNITS, type UnitId } from '../../../../core/quantity/units'
import type { AppError, Issue } from '../../../../shared/errors/app-error'
import { None, Ok, Some, type AppResult, type Option } from '../../../../shared/result'
import { quantityText } from '../../messages/quantity'

/** What the field made of its text: the value, and how it was written. */
export interface Reading {
  readonly quantity: Quantity
  /** The literal's nominal as written; None for an expression. */
  readonly nominal: Option<LiteralNominal>
  /** References an expression uses (empty for a literal). */
  readonly references: readonly string[]
}

export const NO_REFERENCES: ReferenceResolver = { resolve: () => None }

/** Literal or expression via the core, then the field's own rules (`validate`). */
export function readSource(
  source: string,
  ctx: ParseContext,
  resolver: ReferenceResolver,
  validate?: (q: Quantity) => AppResult<Quantity>,
): AppResult<Reading> {
  const q = quantityFromSource(source, ctx, resolver)
  if (q.isErr()) return q
  const checked = validate ? validate(q.unwrap()) : q
  if (checked.isErr()) return checked
  const quantity = checked.unwrap()
  const literal = parseLiteral(source, ctx)
  const nominal: Option<LiteralNominal> = literal.isOk() ? Some(literal.unwrap().nominal) : None
  const references = nominal.isSome() ? [] : referencesOf(quantity).unwrapOr([])
  return Ok({ quantity, nominal, references })
}

/** Display label of a unit ("mm", "°", "in"); the dimensionless unit has none. */
export const UNIT_LABEL: Readonly<Record<UnitId, string>> = {
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  um: 'µm',
  in: 'in',
  ft: 'ft',
  deg: '°',
  'mm/min': 'mm/min',
  'in/min': 'in/min',
  rpm: 'rpm',
  W: 'W',
  kW: 'kW',
  hp: 'hp',
  '1': '',
  '%': '%',
}

/** Field precision when the field does not set one (quantities.md: 3 decimals mm, 4 inch). */
export function defaultPrecision(unit: UnitId): number {
  switch (unit) {
    case 'mm':
    case '1':
      return 3
    case 'in':
    case 'cm':
      return 4
    case 'm':
    case 'ft':
      return 5
    case 'um':
    case 'mm/min':
    case 'rpm':
    case 'W':
      return 0
    case 'deg':
    case 'in/min':
    case 'kW':
    case 'hp':
    case '%':
      return 2
    default:
      return 3
  }
}

const MINUS = '−' // U+2212 for display

/** A canonical value in `unit`, at `precision` (`trim`: fewest exact digits up to it). */
export function formatNumber(
  canonical: Rational,
  unit: UnitId,
  precision: number,
  opts: { sign?: boolean; trim?: boolean } = {},
): string {
  const v = inUnit(canonical, unit)
  const digits = opts.trim ? v.decimalDigits(precision).unwrapOr(precision) : precision
  const text = v.toFixed(digits)
  if (text.startsWith('-')) return MINUS + text.slice(1)
  return opts.sign ? `+${text}` : text
}

/** "1.588 mm", "45.00°". */
export function formatValue(canonical: Rational, unit: UnitId, precision: number): string {
  const label = UNIT_LABEL[unit]
  const n = formatNumber(canonical, unit, precision)
  return label === '' ? n : unit === 'deg' ? `${n}${label}` : `${n} ${label}`
}

function inUnit(canonical: Rational, unit: UnitId): Rational {
  return canonical.div(UNITS[unit].factor).unwrapOr(canonical) // factors are never 0
}

/**
 * The echo under the field: "= 1.588 mm", "= 10.000 mm ±0.050",
 * "= 25.400 mm, upper +0.100, lower −0.050", "= 3.000 mm (from pocket1.floor.z)", and the
 * inherited general tolerance of an untoleranced value ("· ±0.100 mm from part").
 */
export function describeReading(
  r: Reading,
  unit: UnitId,
  precision: number,
  inherited?: InheritedTolerance,
): string {
  const q = r.quantity
  let text = `= ${formatValue(q.exact, unit, precision)}`
  if (q.tolerance.isSome()) {
    const t = q.tolerance.unwrap()
    text +=
      t.notation === 'symmetric'
        ? ` ±${formatNumber(t.upper, unit, precision)}`
        : `, ${quantityText.deviations({
            upper: formatNumber(t.upper, unit, precision, { sign: true }),
            lower: formatNumber(t.lower, unit, precision, { sign: true }),
          })}`
  }
  if (r.references.length > 0) text += ` ${quantityText.from({ references: r.references })}`
  if (q.tolerance.isNone() && inherited)
    text += ` · ${quantityText.inherited({
      tolerance: `±${formatValue(inherited.deviation, unit, precision)}`,
      scope: inherited.scope,
    })}`
  return text
}

/** The inherited general tolerance alone ("±0.100 mm from part"), for a plain value's echo. */
export function describeInherited(
  r: Reading,
  unit: UnitId,
  precision: number,
  inherited?: InheritedTolerance,
): string | undefined {
  if (r.quantity.tolerance.isSome() || !inherited) return undefined
  return quantityText.inherited({
    tolerance: `±${formatValue(inherited.deviation, unit, precision)}`,
    scope: inherited.scope,
  })
}

const DECIMAL = String.raw`(?:\d+(?:\.\d*)?|\.\d+)`
const PLUS_MINUS_RE = String.raw`(?:±|\+\/-|\+-)`

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/**
 * Whether the echo ("= 15.000 mm") tells the user something the text does not: false for a plain
 * decimal number with no unit or the display unit's own spelling (`15`, `15 mm`, `15mm`,
 * `0.5 in` in an inch field), also with a symmetric decimal tolerance in that unit (`10 ±0.05`).
 * True for an expression or reference, a fraction or mixed number, a unit other than the display
 * unit, an asymmetric tolerance (which deviation is upper) and anything else the pattern does not
 * cover. Doc: docs/conventions/ui.md#quantity-and-expression-input
 */
export function echoAddsInformation(r: Reading, source: string, displayUnit: UnitId): boolean {
  if (r.nominal.isNone()) return true
  const unit = r.nominal.unwrap().unit
  if (unit.isSome() && unit.unwrap() !== displayUnit) return true
  const spellings = UNITS[displayUnit].spellings.map(escapeRe)
  const u = spellings.length > 0 ? String.raw`(?:\s*(?:${spellings.join('|')}))?` : ''
  const plain = new RegExp(
    String.raw`^\s*[+\-−]?${DECIMAL}${u}(?:\s*${PLUS_MINUS_RE}\s*${DECIMAL}${u})?\s*$`,
    'i',
  )
  return !plain.test(source)
}

/** The general tolerance an untoleranced value inherits (resolved by the design model). */
export interface InheritedTolerance {
  /** ± deviation, canonical unit. */
  readonly deviation: Rational
  /** Where it comes from: "part", "project". */
  readonly scope: string
}

/**
 * Whether the unfocused field shows the computed value after the source (`1/16" · 1.588 mm`):
 * for an expression, or a literal written in a unit other than the display unit.
 */
export function showsComputedValue(r: Reading, displayUnit: UnitId): boolean {
  if (r.nominal.isNone()) return true
  const unit = r.nominal.unwrap().unit
  return unit.isSome() && unit.unwrap() !== displayUnit
}

const MAX_STEP_DIGITS = 6

/**
 * Step a plain literal by `delta` in the unit it is written in: the number between the core's
 * nominal offsets is replaced, unit and tolerance stay as typed. None for an expression or an
 * unreadable source (steppers are off for them).
 */
export function stepSource(
  source: string,
  ctx: ParseContext,
  delta: Rational,
  precision: number,
): Option<string> {
  const literal = parseLiteral(source, ctx)
  if (literal.isErr()) return None
  const { start, end, value } = literal.unwrap().nominal
  const written = source.slice(start, end)
  const point = written.indexOf('.')
  const writtenDigits = point < 0 ? 0 : written.length - point - 1
  const deltaDigits = delta.decimalDigits(MAX_STEP_DIGITS).unwrapOr(precision)
  const next = value.add(delta)
  const digits = Math.max(
    writtenDigits,
    next.decimalDigits(MAX_STEP_DIGITS).unwrapOr(Math.max(precision, deltaDigits)),
  )
  return Some(source.slice(0, start) + next.toFixed(digits) + source.slice(end))
}

/** A decimal step ("0.1") as an exact rational. */
export function stepRational(step: string): Rational {
  return parseLiteral(step, { kind: 'scalar', defaultUnit: '1' })
    .map((p) => p.exact)
    .unwrapOr(Rational.ONE)
}

/** An error explained in place: message, the part of the text to mark, a verified fix. */
export interface Explained {
  readonly text: string
  /** Offsets to underline; `start === end` marks the end of the text. */
  readonly mark?: { readonly start: number; readonly end: number }
  /** A corrected source that reads without error. */
  readonly fix?: string
}

/** Deviation pair the user probably meant as arithmetic: ` +1/2`, ` -1/2` at the end. */
const FRACTION_PAIR = /(\s)([+\-−])(\d+)\/(\d+)(\s*)$/

/**
 * Message for the first issue of `err` (catalogue by rule), the text position to mark and, where
 * a corrected spelling is known (a `hint` param, `+1/2` → `+ 1/2`, Greek mu), that spelling –
 * offered only when `reads` accepts it.
 */
export function explainError(
  err: AppError,
  source: string,
  ctx: ParseContext,
  reads: (source: string) => boolean,
): Explained {
  if (source.trim() === '') return { text: quantityText.empty() }
  const issue = err.issues[0]
  const verified = (s: string | undefined): string | undefined =>
    s !== undefined && s !== source && reads(s) ? s : undefined

  // Greek mu (U+03BC) instead of the micro sign: the core knows only µ (plan known issue).
  if (source.includes('μ')) {
    const fix = verified(source.replaceAll('μ', 'µ'))
    if (fix !== undefined) {
      const at = source.indexOf('μ')
      return { text: quantityText.greekMu(), mark: { start: at, end: at + 1 }, fix }
    }
  }
  if (issue === undefined) return { text: err.userMessage }

  const params = issue.params ?? {}
  const mark = markAt(source, params['offset'])
  const withMark = (text: string, fix?: string): Explained => ({
    text,
    ...(mark ? { mark } : {}),
    ...(fix !== undefined ? { fix } : {}),
  })

  switch (issue.rule) {
    case 'syntax': {
      const offset = typeof params['offset'] === 'number' ? params['offset'] : source.length
      const found = offset < source.length ? source[offset] : undefined
      return withMark(quantityText.syntax({ found, expected: strings(params['expected']) }))
    }
    case 'hyphenatedMixedNumber':
      return withMark(quantityText.hyphenatedMixedNumber(), verified(str(params['hint'])))
    case 'zeroDenominator':
      return withMark(quantityText.zeroDenominator())
    case 'maxLength':
      return withMark(quantityText.maxLength({ max: Number(params['max'] ?? 256) }))
    case 'unknownUnit':
      return withMark(
        quantityText.unknownUnit({ actual: str(params['actual']) ?? '', kind: ctx.kind }),
      )
    case 'unitKind':
      return withMark(
        quantityText.unitKind({ actual: str(params['actual']) ?? '', kind: ctx.kind }),
      )
    case 'order':
      return explainOrder(issue, source, ctx, verified)
    case 'symmetric':
    case 'nonNegative':
      return withMark(quantityText.nonNegative())
    case 'finite':
      return withMark(quantityText.finite())
    case 'unknownReference':
      return withMark(quantityText.unknownReference({ name: str(params['name']) ?? '' }))
    case 'kindMismatch':
      return withMark(quantityText.kindMismatch({ left: params['left'], right: params['right'] }))
    case 'unsupportedProduct':
      return withMark(
        quantityText.unsupportedProduct({ left: params['left'], right: params['right'] }),
      )
    case 'resultKind':
      return {
        text: quantityText.resultKind({ expected: params['expected'], actual: params['actual'] }),
      }
    case 'bareNumberUnit':
      return withMark(quantityText.bareNumberUnit({ kind: params['kind'] }))
    case 'divisionByZero':
      return withMark(quantityText.divisionByZero())
    case 'divisorContainsZero':
      return withMark(quantityText.divisorContainsZero())
    case 'cycle':
      return { text: quantityText.cycle({ cycle: strings(params['cycle']) }) }
    case 'tolerancePosition':
      return withMark(quantityText.tolerancePosition())
    case 'ambiguousDivision': {
      const hints = strings(params['hint'])
      return withMark(
        quantityText.ambiguousDivision({ hints }),
        hints.map(verified).find((h) => h !== undefined),
      )
    }
    default:
      return withMark(issue.message || err.userMessage)
  }
}

/** `order`: if the pair is a trailing ` ±n/d`, explain the tolerance reading and offer `± n/d`. */
function explainOrder(
  issue: Issue,
  source: string,
  ctx: ParseContext,
  verified: (s: string | undefined) => string | undefined,
): Explained {
  const p = issue.params ?? {}
  const unit = ctx.defaultUnit
  const fmt = (v: unknown): string => {
    const r = rationalOf(v)
    return r.isSome() ? formatNumber(r.unwrap(), unit, 6, { sign: true, trim: true }) : String(v)
  }
  const upper = fmt(p['upper'])
  const lower = fmt(p['lower'])
  const m = FRACTION_PAIR.exec(source)
  if (m) {
    const start = m.index + (m[1]?.length ?? 0)
    const end = source.length - (m[5]?.length ?? 0)
    const text = source.slice(start, end)
    const spaced = `${source.slice(0, start)}${m[2]} ${m[3]}/${m[4]}`
    return {
      text: quantityText.deviationPair({ text, upper, lower }),
      mark: { start, end },
      ...optionalFix(verified(spaced)),
    }
  }
  return { text: quantityText.order({ upper, lower }) }
}

function optionalFix(fix: string | undefined): { fix?: string } {
  return fix === undefined ? {} : { fix }
}

/** The token at `offset` (up to the next space), at least one character; end → empty mark. */
function markAt(source: string, offset: unknown): { start: number; end: number } | undefined {
  if (typeof offset !== 'number' || offset < 0) return undefined
  if (offset >= source.length) return { start: source.length, end: source.length }
  let end = offset + 1
  while (end < source.length && !/\s/.test(source[end] ?? '')) end++
  return { start: offset, end }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined
}

function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** "127/80" or "2" (Rational.toString, as invariant params carry it). */
function rationalOf(v: unknown): Option<Rational> {
  if (typeof v !== 'string') return None
  const m = /^(-?\d+)(?:\/(\d+))?$/.exec(v)
  if (!m?.[1]) return None
  const r = Rational.create(BigInt(m[1]), BigInt(m[2] ?? '1'))
  return r.isOk() ? Some(r.unwrap()) : None
}

/** The reference name being typed at `caret` (letters, digits, `_`, `.`; starts with a letter). */
export function referenceAt(
  text: string,
  caret: number,
): { start: number; prefix: string } | undefined {
  let start = caret
  while (start > 0 && /[A-Za-z0-9_.]/.test(text[start - 1] ?? '')) start--
  const prefix = text.slice(start, caret)
  if (!/^[A-Za-z_]/.test(prefix)) return undefined
  return { start, prefix }
}
