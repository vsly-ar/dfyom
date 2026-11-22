/**
 * Expression parser: source → AST. Never `eval`.
 * Doc: docs/architecture/quantities.md#expression-grammar
 *
 * Hand-written recursive descent over the literal scanner (src/core/quantity/parse.ts), so
 * numbers inside expressions follow the literal grammar exactly (a fraction token binds tighter
 * than `/`: `1/16"` is a value, `D/2` a division). Errors are `quantity.syntax` /
 * `quantity.unit` with `{ offset, expected }` like literals.
 */
import { None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import {
  isDigit,
  isWs,
  LiteralScanner,
  MAX_SOURCE_LENGTH,
  PLUS_MINUS,
  reject,
  SIGNS,
  unexpectedAt,
  type ParseContext,
} from '../quantity/parse'
import type { ToleranceProps } from '../quantity/tolerance'
import { UNITS } from '../quantity/units'
import type { BinaryOperator, Expression, ExprNode } from './ast'

/** `name { "." name }`, each name optionally indexed: `stock.side[1].x`, `profile1.tab[0].top.z`. */
const IDENTIFIER =
  /[A-Za-z_][A-Za-z0-9_]*(?:\[[0-9]+\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[[0-9]+\])?)*/y
const MUL = new Set(['*', '×'])
const DIV = new Set(['/', '÷'])
const OPERAND = ['number', 'reference', '(', '-']
/** `+0.1/`, `-1 mm/`, `+1/16"/`: a sign glued to a number (optional unit), then the pair's "/". */
const DEVIATION_PAIR_START =
  /[+\-−](?:\d+(?:\.\d*)?|\.\d+)(?:[ \t\u00a0]*(?:[A-Za-zµ]+|["″'′°%]))?[ \t\u00a0]*\//y
/** A fraction or mixed number starts here (`2/5`, `1 1/2`). */
const FRACTION_START = /[ \t\u00a0\-\u2212]*\d+(?:[ \t\u00a0]+\d+)?\/\d/y
const MIXED = /^[-−]?\d+[ \t\u00a0]+\d/

/**
 * Parse an expression for a field. `ctx` is needed only for the trailing tolerance (its units
 * must be of the field kind; a deviation without a unit takes the field's default unit).
 */
export function parseExpression(source: string, ctx: ParseContext): AppResult<Expression> {
  return new ExpressionParser(source, ctx).expression()
}

class ExpressionParser {
  private pos = 0

  constructor(
    private readonly src: string,
    private readonly ctx: ParseContext,
  ) {}

  // expression = ws, sum, [ ws, tolerance ], ws
  expression(): AppResult<Expression> {
    if (this.src.length > MAX_SOURCE_LENGTH)
      return reject('quantity.syntax', 'maxLength', `longer than ${MAX_SOURCE_LENGTH} characters`, {
        offset: MAX_SOURCE_LENGTH,
        expected: ['end'],
        max: MAX_SOURCE_LENGTH,
      })
    const root = this.sum()
    if (root.isErr()) return root
    this.skipWs()
    let tolerance: Option<ToleranceProps> = None
    if (!this.atEnd()) {
      if (!this.atToleranceStart())
        return unexpectedAt(this.src, this.pos, ['operator', 'tolerance', 'end'])
      const scanner = new LiteralScanner(this.src, this.ctx.kind, this.pos)
      const tol = scanner.trailingTolerance(this.ctx.defaultUnit)
      if (tol.isErr()) {
        // The tolerance itself was complete but more text follows (`D ±0.1 * 2`); a
        // malformed deviation (`D ±`, `D +0.1/x`) keeps its own error.
        const issue = tol.unwrapErr().issues[0]
        const expected = issue?.params?.['expected']
        const followed =
          issue?.rule === 'syntax' && Array.isArray(expected) && !expected.includes('digit')
        return followed ? this.tolerancePosition() : tol
      }
      tolerance = Some(tol.unwrap())
    }
    return Ok({ root: root.unwrap(), tolerance })
  }

  // sum = product, { ws, ( "+" | "-" | "−" ), product }
  private sum(): AppResult<ExprNode> {
    let left = this.product()
    for (;;) {
      if (left.isErr()) return left
      this.skipWs()
      const ch = this.peek()
      if (ch === undefined || !SIGNS.has(ch) || this.atToleranceStart()) return left
      const offset = this.pos++
      const right = this.product()
      if (right.isErr()) return right
      left = Ok(binary(ch === '+' ? '+' : '-', offset, left.unwrap(), right.unwrap()))
    }
  }

  // product = unary, { ws, ( "*" | "×" | "/" | "÷" ), unary }
  private product(): AppResult<ExprNode> {
    this.skipWs()
    const start = this.pos
    let left = this.unary()
    for (;;) {
      if (left.isErr()) return left
      this.skipWs()
      const ch = this.peek() ?? ''
      if (!MUL.has(ch) && !DIV.has(ch)) return left
      const offset = this.pos++
      const right = this.unary()
      if (right.isErr()) return right
      if (DIV.has(ch) && this.isFraction(offset + 1)) return this.ambiguousDivision(start, offset)
      left = Ok(binary(MUL.has(ch) ? '*' : '/', offset, left.unwrap(), right.unwrap()))
    }
  }

  // unary = ws, ( "-" | "−" ), unary | primary
  private unary(): AppResult<ExprNode> {
    this.skipWs()
    const ch = this.peek()
    if (ch !== '-' && ch !== '−') return this.primary()
    const offset = this.pos++
    return this.unary().map((operand): ExprNode => ({ type: 'neg', offset, operand }))
  }

  // primary = number | reference | "(", sum, ws, ")"
  private primary(): AppResult<ExprNode> {
    const offset = this.pos
    const ch = this.peek()
    if (ch === '(') {
      this.pos++
      const inner = this.sum()
      if (inner.isErr()) return inner
      this.skipWs()
      if (this.atToleranceStart()) return this.tolerancePosition()
      if (this.peek() !== ')') return unexpectedAt(this.src, this.pos, [')'])
      this.pos++
      return inner
    }
    if (isDigit(ch) || ch === '.') {
      const scanner = new LiteralScanner(this.src, 'any', this.pos)
      const token = scanner.numberToken()
      if (token.isErr()) return token
      this.pos = scanner.pos
      const { value, unit } = token.unwrap()
      if (unit.isNone()) return Ok({ type: 'number', offset, kind: 'bare', value })
      const info = UNITS[unit.unwrap()]
      return Ok({ type: 'number', offset, kind: info.kind, value: value.mul(info.factor) })
    }
    IDENTIFIER.lastIndex = this.pos
    const name = IDENTIFIER.exec(this.src)?.[0]
    if (name !== undefined) {
      this.pos += name.length
      return Ok({ type: 'ref', offset, name })
    }
    return unexpectedAt(this.src, this.pos, OPERAND)
  }

  private atPlusMinus(): boolean {
    return PLUS_MINUS.some((p) => this.src.startsWith(p, this.pos))
  }

  /**
   * A tolerance starts here: `±` (or `+/-`, `+-`), or a sign after whitespace glued to a number
   * and followed by the pair's `/` (`D +0.1/-0.05`). Such a sign is never an operator; the
   * tolerance must end the expression.
   */
  private atToleranceStart(): boolean {
    if (this.atPlusMinus()) return true
    if (!isWs(this.src[this.pos - 1])) return false
    DEVIATION_PAIR_START.lastIndex = this.pos
    return DEVIATION_PAIR_START.test(this.src)
  }

  private tolerancePosition(): AppResult<never> {
    return reject(
      'quantity.syntax',
      'tolerancePosition',
      'a tolerance can only follow the whole expression, at the end',
      { offset: this.pos, expected: ['operator', ')', 'end'] },
    )
  }

  /** The operand at `from` is written as a bare fraction or mixed number, possibly negated. */
  private isFraction(from: number): boolean {
    FRACTION_START.lastIndex = from
    return FRACTION_START.test(this.src)
  }

  /** `D/2/5`: the fraction token would bind first (D ÷ ⅖); ask for parentheses. */
  private ambiguousDivision(start: number, offset: number): AppResult<never> {
    const left = this.src.slice(start, offset).trim()
    const right = this.src.slice(offset + 1, this.pos).trim()
    const hint = [`${left}/(${right})`]
    const slash = right.indexOf('/')
    if (!MIXED.test(right))
      hint.push(`(${left}/${right.slice(0, slash)})/${right.slice(slash + 1)}`)
    const message = `write ${hint.map((h) => `"${h}"`).join(' or ')}: a fraction after "/" is ambiguous`
    return reject('quantity.syntax', 'ambiguousDivision', message, {
      offset,
      expected: ['('],
      hint,
    })
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
}

function binary(op: BinaryOperator, offset: number, left: ExprNode, right: ExprNode): ExprNode {
  return { type: 'binary', offset, op, left, right }
}
