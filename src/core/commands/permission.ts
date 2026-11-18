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

/** The command opening a connection; its `target` arg is the only one the policy reads. */
const OPEN_CONNECTION = 'run.connection.open'

/**
 * Whether a non-UI source may run `def`: on an open connection whose host reported it virtual,
 * or to open a virtual connection when none is open. Everything else is denied by default:
 * an unknown or real target, a connection still opening, no machine port.
 */
function virtualOnly(def: AnyCommand, args: unknown, services: Services | undefined): boolean {
  const machine = services?.machine
  if (machine === undefined) return false
  if (machine.target !== undefined) return machine.target === 'virtual'
  if (def.name !== OPEN_CONNECTION || machine.status().connection.state !== 'closed') return false
  return (args as { target?: unknown } | null)?.target === 'virtual'
}

/**
 * Conservative default until run-mode safety is specified: UI sources (a person at the app) may
 * run machine commands; other sources (agents, CLI, automation, system) only on the virtual
 * machine (deny by default). Docs: docs/architecture/grbl.md#transport-and-sender,
 * docs/modes/run-v0.1.md#safety-v01
 */
export const defaultPermissionPolicy: PermissionPolicy = {
  check(def, args, source, services) {
    if (source.kind === 'ui') return Ok(undefined)
    if (virtualOnly(def, args, services)) return Ok(undefined)
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
