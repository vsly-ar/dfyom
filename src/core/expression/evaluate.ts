/**
 * Expression evaluation: exact value, dimensional check and worst-case tolerance propagation.
 * Doc: docs/architecture/quantities.md#expressions-and-references
 *
 * Every value is an interval [lo, hi] around an exact nominal (untoleranced = degenerate).
 * Errors: `expression.reference`, `expression.dimension`, `expression.domain`; issue path `[]`,
 * params `{ offset, … }` pointing at the operator or operand in the source.
 */
import type { ErrorCode } from '../../shared/errors/codes'
import { fail, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import type { ParseContext } from '../quantity/parse'
import type { Quantity } from '../quantity/quantity'
import { Rational } from '../quantity/rational'
import type { ToleranceProps } from '../quantity/tolerance'
import { UNITS, type QuantityKind, type UnitId } from '../quantity/units'
import type { Expression, ExprNode } from './ast'

/**
 * Port to the values an expression may reference (project variables, surfaces, tool, machine).
 * Real resolvers come with the design/library models; tests use a fake.
 */
export interface ReferenceResolver {
  /** Current value of a reference; None if there is no such reference. */
  resolve(name: string): Option<Quantity>
}

/** Result in the canonical unit of the field kind. */
export interface Evaluated {
  readonly exact: Rational
  /** Trailing tolerance, else the propagated one; None if no operand was toleranced. */
  readonly tolerance: Option<ToleranceProps>
}

/** `bare` = a number without unit whose kind is not decided yet (value as typed). */
interface Value {
  readonly kind: QuantityKind | 'bare'
  readonly nominal: Rational
  readonly lo: Rational
  readonly hi: Rational
  readonly toleranced: boolean
}

export function evaluate(
  expr: Expression,
  ctx: ParseContext,
  resolver: ReferenceResolver,
): AppResult<Evaluated> {
  const result = new Evaluator(ctx, resolver).value(expr.root)
  if (result.isErr()) return result
  let v = result.unwrap()
  if (v.kind === 'bare') v = scale(v, ctx.kind, UNITS[ctx.defaultUnit].factor)
  if (v.kind !== ctx.kind)
    return reject(
      'expression.dimension',
      'resultKind',
      `result is ${v.kind}, expected ${ctx.kind}`,
      {
        offset: 0,
        expected: ctx.kind,
        actual: v.kind,
      },
    )
  if (expr.tolerance.isSome()) return Ok({ exact: v.nominal, tolerance: expr.tolerance })
  return Ok({ exact: v.nominal, tolerance: v.toleranced ? Some(deviations(v)) : None })
}

class Evaluator {
  constructor(
    private readonly ctx: ParseContext,
    private readonly resolver: ReferenceResolver,
  ) {}

  value(n: ExprNode): AppResult<Value> {
    switch (n.type) {
      case 'number':
        return Ok(exactValue(n.kind, n.value))
      case 'ref':
        return this.reference(n.name, n.offset)
      case 'neg':
        return this.value(n.operand).map((v) => ({
          ...v,
          nominal: v.nominal.neg(),
          lo: v.hi.neg(),
          hi: v.lo.neg(),
        }))
      case 'binary': {
        const l = this.value(n.left)
        if (l.isErr()) return l
        const r = this.value(n.right)
        if (r.isErr()) return r
        if (n.op === '+' || n.op === '-') return this.addSub(n.op, l.unwrap(), r.unwrap(), n.offset)
        return n.op === '*'
          ? mul(l.unwrap(), r.unwrap(), n.offset)
          : div(l.unwrap(), r.unwrap(), n.offset)
      }
    }
  }

  private reference(name: string, offset: number): AppResult<Value> {
    const found = this.resolver.resolve(name)
    if (found.isNone())
      return reject('expression.reference', 'unknownReference', `unknown reference "${name}"`, {
        offset,
        name,
      })
    const q = found.unwrap()
    if (q.tolerance.isNone()) return Ok(exactValue(q.kind, q.exact))
    const t = q.tolerance.unwrap()
    return Ok({
      kind: q.kind,
      nominal: q.exact,
      lo: q.exact.add(t.lower),
      hi: q.exact.add(t.upper),
      toleranced: true,
    })
  }

  // +/−: equal kinds; a bare number takes the other side's kind (bare + bare stays bare).
  private addSub(op: '+' | '-', a: Value, b: Value, offset: number): AppResult<Value> {
    if (a.kind === 'bare' && b.kind !== 'bare') {
      const adopted = this.adopt(a, b.kind, offset)
      if (adopted.isErr()) return adopted
      a = adopted.unwrap()
    } else if (b.kind === 'bare' && a.kind !== 'bare') {
      const adopted = this.adopt(b, a.kind, offset)
      if (adopted.isErr()) return adopted
      b = adopted.unwrap()
    }
    if (a.kind !== b.kind)
      return reject(
        'expression.dimension',
        'kindMismatch',
        `cannot ${verb(op)} ${a.kind} and ${b.kind}`,
        {
          offset,
          left: a.kind,
          right: b.kind,
        },
      )
    const toleranced = a.toleranced || b.toleranced
    return Ok(
      op === '+'
        ? {
            kind: a.kind,
            nominal: a.nominal.add(b.nominal),
            lo: a.lo.add(b.lo),
            hi: a.hi.add(b.hi),
            toleranced,
          }
        : {
            kind: a.kind,
            nominal: a.nominal.sub(b.nominal),
            lo: a.lo.sub(b.hi),
            hi: a.hi.sub(b.lo),
            toleranced,
          },
    )
  }

  /** A bare number in the unit the field implies for `kind`; error if it cannot tell. */
  private adopt(v: Value, kind: QuantityKind, offset: number): AppResult<Value> {
    const unit = bareUnit(kind, this.ctx.defaultUnit)
    if (unit.isNone())
      return reject('expression.dimension', 'bareNumberUnit', `give the number a ${kind} unit`, {
        offset,
        kind,
      })
    return Ok(scale(v, kind, UNITS[unit.unwrap()].factor))
  }
}

/**
 * Unit of a bare number that adopts `kind`: the field's default unit if of that kind; the only
 * unit of angle/spindle speed/scalar; for length and feed rate the unit system the field's
 * default unit implies (mm or inch). None when the field does not tell the unit system.
 */
function bareUnit(kind: QuantityKind, fieldUnit: UnitId): Option<UnitId> {
  if (UNITS[fieldUnit].kind === kind) return Some(fieldUnit)
  const inch = fieldUnit === 'in' || fieldUnit === 'ft' || fieldUnit === 'in/min'
  const metric = ['mm', 'cm', 'm', 'um', 'mm/min'].includes(fieldUnit)
  switch (kind) {
    case 'angle':
      return Some('deg')
    case 'spindleSpeed':
      return Some('rpm')
    case 'scalar':
      return Some('1')
    case 'length':
      return inch ? Some('in') : metric ? Some('mm') : None
    case 'feedRate':
      return inch ? Some('in/min') : metric ? Some('mm/min') : None
  }
}

// ×: quantity × scalar; bare counts as scalar (bare × bare stays bare).
function mul(a: Value, b: Value, offset: number): AppResult<Value> {
  const kind = productKind(a.kind, b.kind)
  if (kind.isNone())
    return reject(
      'expression.dimension',
      'unsupportedProduct',
      `cannot multiply ${a.kind} by ${b.kind}`,
      {
        offset,
        left: a.kind,
        right: b.kind,
      },
    )
  const products = [a.lo.mul(b.lo), a.lo.mul(b.hi), a.hi.mul(b.lo), a.hi.mul(b.hi)]
  return Ok({
    kind: kind.unwrap(),
    nominal: a.nominal.mul(b.nominal),
    lo: min(products),
    hi: max(products),
    toleranced: a.toleranced || b.toleranced,
  })
}

// ÷: quantity ÷ scalar, quantity ÷ same kind → scalar; the divisor interval must exclude 0.
function div(a: Value, b: Value, offset: number): AppResult<Value> {
  const kind = quotientKind(a.kind, b.kind)
  if (kind.isNone())
    return reject(
      'expression.dimension',
      'unsupportedProduct',
      `cannot divide ${a.kind} by ${b.kind}`,
      {
        offset,
        left: a.kind,
        right: b.kind,
      },
    )
  if (b.nominal.num === 0n)
    return reject('expression.domain', 'divisionByZero', 'division by zero', { offset })
  if (b.lo.num <= 0n && b.hi.num >= 0n)
    return reject(
      'expression.domain',
      'divisorContainsZero',
      'the divisor’s tolerance range includes 0',
      {
        offset,
        lo: b.lo.toString(),
        hi: b.hi.toString(),
      },
    )
  // Divisor nonzero, checked above: the reciprocals cannot fail.
  const inv = (r: Rational): Rational => Rational.ONE.div(r).unwrapOr(Rational.ZERO)
  const recip: Value = { ...b, nominal: inv(b.nominal), lo: inv(b.hi), hi: inv(b.lo) }
  return mul({ ...a, kind: 'scalar' }, { ...recip, kind: 'scalar' }, offset).map((v) => ({
    ...v,
    kind: kind.unwrap(),
  }))
}

type Kind = QuantityKind | 'bare'

function productKind(a: Kind, b: Kind): Option<Kind> {
  if (a === 'bare') return Some(b)
  if (b === 'bare' || b === 'scalar') return Some(a)
  if (a === 'scalar') return Some(b)
  return None
}

function quotientKind(a: Kind, b: Kind): Option<Kind> {
  if (b === 'bare') return Some(a)
  if (a === 'bare' && b === 'scalar') return Some('scalar')
  if (b === 'scalar') return Some(a)
  if (a === b) return Some('scalar')
  return None
}

function exactValue(kind: Kind, value: Rational): Value {
  return { kind, nominal: value, lo: value, hi: value, toleranced: false }
}

function scale(v: Value, kind: Kind, factor: Rational): Value {
  return {
    kind,
    nominal: v.nominal.mul(factor),
    lo: v.lo.mul(factor),
    hi: v.hi.mul(factor),
    toleranced: v.toleranced,
  }
}

/** Result interval minus the nominal; `±` when symmetric. */
function deviations(v: Value): ToleranceProps {
  const upper = v.hi.sub(v.nominal)
  const lower = v.lo.sub(v.nominal)
  const symmetric = upper.equals(lower.neg()) && upper.num >= 0n
  return { notation: symmetric ? 'symmetric' : 'deviations', upper, lower }
}

const min = (rs: Rational[]): Rational => rs.reduce((m, r) => (r.compare(m) < 0 ? r : m))
const max = (rs: Rational[]): Rational => rs.reduce((m, r) => (r.compare(m) > 0 ? r : m))
const verb = (op: '+' | '-'): string => (op === '+' ? 'add' : 'subtract')

function reject(
  code: ErrorCode,
  rule: string,
  message: string,
  params: { readonly offset: number } & Readonly<Record<string, unknown>>,
): AppResult<never> {
  return fail(code, message, {
    issues: [{ path: [], rule, message, params }],
    where: 'evaluateExpression',
  })
}
