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
 * Machine commands that only stop motion: every source may send them on every connection
 * (docs/modes/run.md#1-emergency-stop-stop-and-reset). `job.pause` and `job.abort` are not machine
 * commands and are never checked.
 */
export const STOP_COMMANDS: ReadonlySet<string> = new Set([
  'run.machine.jogCancel',
  'run.machine.reset',
])

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

/** The target the refusal names: the open connection's, or the one being opened. */
function targetOf(args: unknown, services: Services | undefined): string {
  const open = services?.machine?.target
  if (open !== undefined) return open
  const t = (args as { target?: unknown } | null)?.target
  return typeof t === 'string' ? t : 'unknown'
}

/**
 * Q50 (docs/modes/run.md#2-who-may-command-a-real-connection-q50): UI sources (a person at the
 * app) may run machine commands; other sources (agents, CLI, automation, system) may run them on
 * the virtual machine, and on a real connection only the stop paths (deny by default).
 * Docs: docs/architecture/grbl.md#transport-and-sender, docs/modes/run-v0.1.md#safety-v01
 */
export const defaultPermissionPolicy: PermissionPolicy = {
  check(def, args, source, services) {
    if (source.kind === 'ui') return Ok(undefined)
    if (STOP_COMMANDS.has(def.name)) return Ok(undefined)
    if (virtualOnly(def, args, services)) return Ok(undefined)
    const target = targetOf(args, services)
    return fail(
      'permission.denied',
      target === 'serial'
        ? `${source.kind} sources may not run ${def.name} on a real machine; the user runs it from the app`
        : `${source.kind} sources may not run machine command ${def.name}`,
      {
        where: 'defaultPermissionPolicy',
        data: { command: def.name, source: source.kind, target },
      },
    )
  },
}
