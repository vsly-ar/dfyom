/**
 * Permission check for commands with `machine: true` (pipeline step 5).
 * Doc: docs/architecture/commands.md#dispatcher-pipeline · rules: docs/modes/run.md#safety
 */
import { fail, Ok, type AppResult, type AsyncAppResult } from '../../shared/result'
import type { Source } from './context'
import type { AnyCommand } from './define'

/** Injectable port; the real policy (confirmations, watchdogs) comes with run-mode safety. */
export interface PermissionPolicy {
  /** `Ok` allows; `Err('permission.denied')` denies. May be async (e.g. asks the user). */
  check(def: AnyCommand, args: unknown, source: Source): AppResult<void> | AsyncAppResult<void>
}

/**
 * Conservative default until run-mode safety is specified: only UI sources (a person at the app)
 * may run machine commands; agents, CLI, automation and system sources are denied.
 */
export const defaultPermissionPolicy: PermissionPolicy = {
  check(def, _args, source) {
    if (source.kind === 'ui') return Ok(undefined)
    return fail(
      'permission.denied',
      `${source.kind} sources may not run machine command ${def.name}`,
      {
        where: 'defaultPermissionPolicy',
        data: { command: def.name, source: source.kind },
      },
    )
  },
}
