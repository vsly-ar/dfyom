/**
 * Expression syntax tree. Doc: docs/architecture/quantities.md#expressions-and-references
 *
 * Produced by `parseExpression` (never `eval`); plain immutable data. Every node carries the
 * UTF-16 `offset` in the source of the token that errors point at (operator or operand start).
 */
import type { Option } from '../../shared/result'
import type { Rational } from '../quantity/rational'
import type { ToleranceProps } from '../quantity/tolerance'
import type { QuantityKind } from '../quantity/units'

export type BinaryOperator = '+' | '-' | '*' | '/'

export type ExprNode =
  /** A number: `kind` 'bare' = no unit written (value as typed), else canonical unit of `kind`. */
  | {
      readonly type: 'number'
      readonly offset: number
      readonly kind: QuantityKind | 'bare'
      readonly value: Rational
    }
  /** A reference (`wall_thickness`, `pocket1.floor.z.max`), resolved at evaluation. */
  | { readonly type: 'ref'; readonly offset: number; readonly name: string }
  | { readonly type: 'neg'; readonly offset: number; readonly operand: ExprNode }
  | {
      readonly type: 'binary'
      readonly offset: number
      readonly op: BinaryOperator
      readonly left: ExprNode
      readonly right: ExprNode
    }

export interface Expression {
  readonly root: ExprNode
  /** Trailing tolerance (canonical unit of the field kind); overrides propagation. */
  readonly tolerance: Option<ToleranceProps>
}

/** Dependency extraction: unique reference names in order of first appearance. */
export function referencesIn(expr: Expression): readonly string[] {
  const names = new Set<string>()
  const walk = (n: ExprNode): void => {
    if (n.type === 'ref') names.add(n.name)
    else if (n.type === 'neg') walk(n.operand)
    else if (n.type === 'binary') {
      walk(n.left)
      walk(n.right)
    }
  }
  walk(expr.root)
  return [...names]
}
