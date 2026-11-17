/**
 * Plan status: which commands each status allows and the transitions of `plan.status.set`.
 * Doc: docs/modes/plan-v0.1.md#plan-status
 */
import { fail, Ok, type AppResult } from '../../shared/result'
import type { PlanStatus } from './plan.dto'

/** Transitions of `plan.status.set` with a `status` (un-archiving is separate). */
export const TRANSITIONS: Readonly<Record<PlanStatus, readonly PlanStatus[]>> = {
  draft: ['settledDesign', 'archived'],
  settledDesign: ['draft', 'finalized', 'archived'],
  finalized: ['settledDesign', 'inUse', 'archived'],
  inUse: ['archived'],
  archived: [],
}

const EDITABLE: readonly PlanStatus[] = ['draft', 'settledDesign']

/**
 * Statuses in which each plan command (except `plan.create` and `plan.status.set`) is allowed.
 * `finalized` and `inUse` are read-only except their status; an `inUse` plan never steps back
 * (only archive, and un-archive returns it to `inUse`): it is changed through `plan.duplicate`. A plan can be duplicated in any status and removed in any but `inUse`.
 */
export const ALLOWED: Readonly<Record<string, readonly PlanStatus[]>> = {
  'plan.duplicate': ['draft', 'settledDesign', 'finalized', 'inUse', 'archived'],
  'plan.update': EDITABLE,
  'plan.remove': ['draft', 'settledDesign', 'finalized', 'archived'],
  'plan.rebuild': EDITABLE,
  'plan.libraryItem.update': EDITABLE,
  'plan.design.operation.update': ['settledDesign'],
  'plan.machine.set': EDITABLE,
  'plan.setup.update': EDITABLE,
  'plan.operation.update': EDITABLE,
  'plan.operation.move': EDITABLE,
  'plan.tool.assign': EDITABLE,
}

/** `plan.status` naming the status and the command. */
export function statusError(
  planId: string,
  status: PlanStatus,
  command: string,
  detail?: string,
): AppResult<never> {
  return fail(
    'plan.status',
    `${command} is not allowed for plan ${planId} in status ${status}${detail === undefined ? '' : `: ${detail}`}`,
    {
      issues: [
        {
          path: ['planId'],
          rule: 'status',
          message: detail ?? `not allowed in status ${status}`,
          params: { status, command },
        },
      ],
      where: command,
      data: { planId, status, command },
    },
  )
}

/** Ok when `command` is allowed in `status`. */
export function checkAllowed(planId: string, status: PlanStatus, command: string): AppResult<void> {
  const allowed = ALLOWED[command]
  if (allowed === undefined || allowed.includes(status)) return Ok(undefined)
  return statusError(planId, status, command)
}

/**
 * The status after `plan.status.set`: `target` undefined = un-archive (restores
 * `statusBeforeArchive`); an archived plan can also be set to that status explicitly. Setting
 * the current status is a no-op.
 */
export function nextStatus(
  planId: string,
  current: PlanStatus,
  before: PlanStatus | undefined,
  target: PlanStatus | undefined,
): AppResult<PlanStatus> {
  const where = 'plan.status.set'
  if (current === 'archived') {
    const restore = before ?? 'draft'
    if (target === undefined || target === restore) return Ok(restore)
    if (target === 'archived') return Ok(current)
    return statusError(planId, current, where, `un-archive first (restores ${restore})`)
  }
  if (target === undefined) return statusError(planId, current, where, 'the plan is not archived')
  if (target === current || TRANSITIONS[current].includes(target)) return Ok(target)
  return statusError(planId, current, where, `cannot change to ${target}`)
}
