// What an edit may leave broken as it was (design.md#changing-the-stock-df95): an operation that a
// stock change broke shows a `dfm.stockLimit` warning and does not refuse edits of the others.
import { type Issue, issueSummary } from '../../shared/errors/app-error'
import { fail, Ok, type AppResult } from '../../shared/result'
import type { Stock } from '../library/stock'
import type { ShapeEnv } from './commands'
import { shapesOf, type Operation } from './operation'
import { shapeFacts } from './placement'
import { checkOperations } from './validate'

/** Issues of `ops` before the edit, all at `operations.<id>.<path>`; none when they don't load. */
export function knownIssues(
  ops: readonly Operation[],
  stock: Stock,
  env: ShapeEnv,
): readonly Issue[] {
  const shapes = shapesOf(ops, env.dto)
  if (shapes.isErr()) return []
  const facts = shapeFacts(ops, shapes.unwrap(), env.port)
  if (facts.isErr()) return []
  const checked = checkOperations(ops, stock, undefined, facts.unwrap(), shapes.unwrap())
  return checked.isErr() ? checked.unwrapErr().issues : []
}

const keyOf = (is: Issue) => `${is.rule} ${JSON.stringify(is.path)}`

/**
 * `checked` (a `checkOperations` result) without the issues of other operations that `known`
 * already had (same rule, same path): edits that don't make things worse pass. The edited
 * operation's own issues (unprefixed paths) always refuse. `known` runs only on a refusal.
 */
export function withoutKnown(
  checked: AppResult<void>,
  known: () => readonly Issue[],
): AppResult<void> {
  if (checked.isOk()) return checked
  const e = checked.unwrapErr()
  if (e.code !== 'model.invariant') return checked
  const had = new Set(known().map(keyOf))
  const left = e.issues.filter((is) => !(is.path[0] === 'operations' && had.has(keyOf(is))))
  if (left.length === e.issues.length) return checked
  if (left.length === 0) return Ok(undefined)
  return fail('model.invariant', issueSummary(left), { issues: left, where: 'checkOperations' })
}
