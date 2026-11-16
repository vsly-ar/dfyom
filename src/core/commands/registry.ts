/**
 * Registry of all commands and queries, with name checks.
 * Doc: docs/architecture/commands.md#naming
 */
import type { Issue } from '../../shared/errors/app-error'
import { fail, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import type { AnyCommand, QueryDef } from './define'
import { historyRedo, historyUndo } from './history'
import { jobAbort, jobPause, jobResume } from './jobs'

/** `<area>.<object>.<verb>` (or `<area>.<verb>` for area-level actions such as `history.undo`). */
export const NAME_PATTERN =
  /^(project|design|plan|run|library|history|job|app)(\.[a-z][a-zA-Z0-9]*){1,2}$/

/** Commands executed by the dispatcher itself; always registered. */
export const BUILTIN_COMMANDS: readonly AnyCommand[] = [
  historyUndo,
  historyRedo,
  jobPause,
  jobResume,
  jobAbort,
]

/** Domain commands and queries of the app; added by their features (none yet). */
export const APP_COMMANDS: readonly AnyCommand[] = []
export const APP_QUERIES: readonly QueryDef[] = []

export interface Registry {
  command(name: string): Option<AnyCommand>
  query(name: string): Option<QueryDef>
  /** Built-ins first, then the given commands, in registration order. */
  readonly commands: readonly AnyCommand[]
  readonly queries: readonly QueryDef[]
}

/** Builds a registry (built-ins included). Invalid definitions are bugs → `internal.unexpected`. */
export function createRegistry(defs: {
  readonly commands?: readonly AnyCommand[]
  readonly queries?: readonly QueryDef[]
}): AppResult<Registry> {
  const commands = [...BUILTIN_COMMANDS, ...(defs.commands ?? [])]
  const queries = [...(defs.queries ?? [])]
  const issues: Issue[] = []
  const seen = new Set<string>()
  for (const d of [...commands, ...queries]) {
    const path = [d.name]
    if (seen.has(d.name)) issues.push({ path, rule: 'unique', message: 'duplicate name' })
    seen.add(d.name)
    if (!NAME_PATTERN.test(d.name))
      issues.push({ path, rule: 'naming', message: 'must be <area>.<object>.<verb>' })
    if (d.summary.trim() === '')
      issues.push({ path, rule: 'summary', message: 'summary must not be empty' })
  }
  if (issues.length > 0)
    return fail('internal.unexpected', `${issues.length} invalid command definition(s)`, {
      issues,
      where: 'createRegistry',
    })
  const byCommand = new Map(commands.map((c) => [c.name, c]))
  const byQuery = new Map(queries.map((q) => [q.name, q]))
  const lookup = <T>(m: Map<string, T>, name: string): Option<T> => {
    const v = m.get(name)
    return v === undefined ? None : Some(v)
  }
  return Ok({
    command: (name) => lookup(byCommand, name),
    query: (name) => lookup(byQuery, name),
    commands,
    queries,
  })
}

/** The app's registry: built-ins plus `APP_COMMANDS` / `APP_QUERIES`. */
export function createAppRegistry(): AppResult<Registry> {
  return createRegistry({ commands: APP_COMMANDS, queries: APP_QUERIES })
}
