/**
 * Shared input checks, levels and toolpath assembly for the generators.
 * Doc: docs/modes/plan-v0.1.md#toolpath-generators-task-210
 */
import type { Issue } from '../../shared/errors/app-error'
import { fail, Ok, type AppResult } from '../../shared/result'
import type { GeneratorInput, Pass, Toolpath } from './model'
import { toolpathStats } from './stats'

/** Collects violated input rules; `model.invariant` (constraints) or `plan.check` (tool fit). */
export class InputIssues {
  readonly invariant: Issue[] = []
  readonly check: Issue[] = []

  positive(path: string, value: number): void {
    if (!(Number.isFinite(value) && value > 0))
      this.invariant.push({
        path: path.split('.'),
        rule: 'positive',
        message: `${path} must be > 0`,
        params: { value },
      })
  }

  nonNegative(path: string, value: number): void {
    if (!(Number.isFinite(value) && value >= 0))
      this.invariant.push({
        path: path.split('.'),
        rule: 'nonNegative',
        message: `${path} must be ≥ 0`,
        params: { value },
      })
  }

  rule(
    kind: 'invariant' | 'check',
    path: string,
    rule: string,
    message: string,
    params: Record<string, unknown> = {},
  ): void {
    this[kind].push({ path: path.split('.'), rule, message, params })
  }

  /** Invariant violations first: a check on invalid numbers means nothing. */
  result(where: string, planOperationId: string): AppResult<void> {
    const data = { planOperationId }
    if (this.invariant.length > 0)
      return fail('model.invariant', this.invariant.map((i) => i.message).join('; '), {
        issues: this.invariant,
        where,
        data,
      })
    if (this.check.length > 0)
      return fail('plan.check', this.check.map((i) => i.message).join('; '), {
        issues: this.check,
        where,
        data,
      })
    return Ok(undefined)
  }
}

/** Checks every generator shares: tool size, feeds and safe heights. */
export function commonIssues(input: GeneratorInput<unknown, unknown, object>): InputIssues {
  const issues = new InputIssues()
  issues.positive('tool.diameter', input.tool.diameter)
  issues.nonNegative('tool.cornerRadius', input.tool.cornerRadius)
  const c = input.cutting as Record<string, number>
  for (const key of ['spindleSpeed', 'feedRate', 'plungeRate', 'stepdown', 'stepover'])
    if (key in c) issues.positive(`cutting.${key}`, c[key]!)
  issues.positive('heights.retractHeight', input.heights.retractHeight)
  if (!(input.heights.clearanceHeight > input.heights.retractHeight))
    issues.rule(
      'invariant',
      'heights.clearanceHeight',
      'greaterThan',
      'clearanceHeight must be > retractHeight',
      {
        clearanceHeight: input.heights.clearanceHeight,
        retractHeight: input.heights.retractHeight,
      },
    )
  return issues
}

/**
 * Levels from `top` down to `bottom` in equal steps of at most `stepdown` (the last one is
 * `bottom` exactly); empty if there is nothing to cut.
 */
export function levels(top: number, bottom: number, stepdown: number): number[] {
  const depth = top - bottom
  if (depth <= 1e-9) return []
  const n = Math.max(1, Math.ceil(depth / stepdown - 1e-9))
  return Array.from({ length: n }, (_, k) => (k === n - 1 ? bottom : top - (depth * (k + 1)) / n))
}

export function toolpath(
  input: GeneratorInput<unknown, unknown, { spindleSpeed: number }>,
  passes: Pass[],
): Toolpath {
  return {
    planOperationId: input.planOperationId,
    tool: input.tool.id,
    spindleSpeed: input.cutting.spindleSpeed,
    passes,
    stats: toolpathStats(passes, input.maxFeedRate),
  }
}
