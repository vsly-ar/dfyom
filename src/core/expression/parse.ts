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

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/y
const MUL = new Set(['*', '×'])
const DIV = new Set(['/', '÷'])
const OPERAND = ['number', 'reference', '(', '-']

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
      if (!this.atPlusMinus() && !this.atDeviationPair())
        return unexpectedAt(this.src, this.pos, ['operator', 'tolerance', 'end'])
      const scanner = new LiteralScanner(this.src, this.ctx.kind, this.pos)
      const tol = scanner.trailingTolerance(this.ctx.defaultUnit)
      if (tol.isErr()) return tol
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
      if (ch === undefined || !SIGNS.has(ch) || this.atPlusMinus() || this.atDeviationPair())
        return left
      const offset = this.pos++
      const right = this.product()
      if (right.isErr()) return right
      left = Ok(binary(ch === '+' ? '+' : '-', offset, left.unwrap(), right.unwrap()))
    }
  }

  // product = unary, { ws, ( "*" | "×" | "/" | "÷" ), unary }
  private product(): AppResult<ExprNode> {
    let left = this.unary()
    for (;;) {
      if (left.isErr()) return left
      this.skipWs()
      const ch = this.peek() ?? ''
      if (!MUL.has(ch) && !DIV.has(ch)) return left
      const offset = this.pos++
      const right = this.unary()
      if (right.isErr()) return right
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
   * `D +0.1/-0.05`: a sign after whitespace, glued to a number, that starts a deviation pair
   * running to the end is the trailing tolerance; otherwise the sign is an operator.
   */
  private atDeviationPair(): boolean {
    const next = this.src[this.pos + 1]
    if (!SIGNS.has(this.peek() ?? '') || !isWs(this.src[this.pos - 1])) return false
    if (!isDigit(next) && next !== '.') return false
    return new LiteralScanner(this.src, this.ctx.kind, this.pos)
      .trailingTolerance(this.ctx.defaultUnit)
      .isOk()
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
