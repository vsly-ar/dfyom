/**
 * Expression-sourced quantities: what a field does on edit, and on an input change.
 * Doc: docs/architecture/quantities.md#expression-sourced-quantities
 *
 * The stored exact value is the source of truth: it is computed here only when the user edits
 * the source (`quantityFromSource`) or an input changes (`reevaluate`); loading never evaluates.
 */
import type { AppError } from '../../shared/errors/app-error'
import { ctx, Err, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import { parseLiteral, type ParseContext } from '../quantity/parse'
import { Quantity } from '../quantity/quantity'
import { Tolerance } from '../quantity/tolerance'
import { referencesIn } from './ast'
import { evaluate, type ReferenceResolver } from './evaluate'
import { parseExpression } from './parse'

/**
 * Parse and evaluate what the user typed. A source that is a valid literal is read as a literal
 * (`Quantity.parse`), so literals mean the same with or without expressions. If neither reading
 * works, the error that got further into the source wins (ties: the expression's).
 */
export function quantityFromSource(
  source: string,
  context: ParseContext,
  resolver: ReferenceResolver,
): AppResult<Quantity> {
  const literal = parseLiteral(source, context)
  if (literal.isOk()) return Quantity.parse(source, context)
  const expr = parseExpression(source, context)
  const evaluated = expr.andThen((e) => evaluate(e, context, resolver))
  if (evaluated.isErr()) {
    const le = literal.unwrapErr()
    const ee = evaluated.unwrapErr()
    const err = offsetOf(le) > offsetOf(ee) ? le : ee
    return Err(err.withContext('quantityFromSource', { kind: context.kind }))
  }
  const { exact, tolerance } = evaluated.unwrap()
  let tol: Option<Tolerance> = None
  if (tolerance.isSome()) {
    const t = Tolerance.create(tolerance.unwrap())
    if (t.isErr()) return t.mapErr((e) => e.prefixIssues('tolerance'))
    tol = Some(t.unwrap())
  }
  return Quantity.create({
    kind: context.kind,
    source,
    defaultUnit: context.defaultUnit,
    exact,
    tolerance: tol,
  })
}

/**
 * Re-evaluate a stored quantity after one of its inputs changed (see `DependencyGraph.affectedBy`).
 * Keeps source, kind and default unit; a literal comes back unchanged.
 */
export function reevaluate(q: Quantity, resolver: ReferenceResolver): AppResult<Quantity> {
  const context: ParseContext = { kind: q.kind, defaultUnit: q.defaultUnit }
  if (parseLiteral(q.source, context).isOk()) return Ok(q)
  return quantityFromSource(q.source, context, resolver)
}

/** Dependency extraction from a stored quantity's source (parsed, not evaluated). */
export function referencesOf(q: Quantity): AppResult<readonly string[]> {
  const context: ParseContext = { kind: q.kind, defaultUnit: q.defaultUnit }
  if (parseLiteral(q.source, context).isOk()) return Ok([])
  return parseExpression(q.source, context)
    .map(referencesIn)
    .mapErr(ctx('referencesOf', { source: q.source }))
}

function offsetOf(e: AppError): number {
  const offset = e.issues[0]?.params?.['offset']
  return typeof offset === 'number' ? offset : -1
}
