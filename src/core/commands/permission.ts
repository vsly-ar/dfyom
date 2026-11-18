/**
 * Permission check for commands with `machine: true` (pipeline step 5).
 * Doc: docs/architecture/commands.md#dispatcher-pipeline · rules: docs/modes/run.md#safety
 */
import { fail, Ok, type AppResult, type AsyncAppResult } from '../../shared/result'
import type { Services, Source } from './context'
import type { AnyCommand } from './define'

/** Injectable port; the real policy (confirmations, watchdogs) comes with run-mode safety. */
export interface PermissionPolicy {
  /** `Ok` allows; `Err('permission.denied')` denies. May be async (e.g. asks the user). */
  check(
    def: AnyCommand,
    args: unknown,
    source: Source,
    services?: Services,
  ): AppResult<void> | AsyncAppResult<void>
}

/**
 * The connection target a machine command affects: the open connection's, or for opening one
 * the requested `target`; `none` without a connection; undefined without a machine port.
 */
function affectedTarget(args: unknown, services: Services | undefined): string | undefined {
  const machine = services?.machine
  if (machine === undefined) return undefined
  if (machine.target !== undefined) return machine.target
  const requested = (args as { target?: unknown } | null)?.target
  return typeof requested === 'string' ? requested : 'none'
}

/**
 * Conservative default until run-mode safety is specified: UI sources (a person at the app) may
 * run machine commands; other sources (agents, CLI, automation, system) only on the virtual
 * machine, or with no connection (nothing to affect; the command answers `run.notConnected`).
 * Docs: docs/architecture/grbl.md#transport-and-sender, docs/modes/run-v0.1.md#safety-v01
 */
export const defaultPermissionPolicy: PermissionPolicy = {
  check(def, args, source, services) {
    if (source.kind === 'ui') return Ok(undefined)
    const target = affectedTarget(args, services)
    if (target === 'virtual' || target === 'none') return Ok(undefined)
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
