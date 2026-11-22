/**
 * Registry of all commands and queries, with name checks.
 * Doc: docs/architecture/commands.md#naming
 */
import type { Issue } from '../../shared/errors/app-error'
import { fail, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import { DESIGN_COMMANDS, DESIGN_QUERIES } from '../design/commands'
import { DESIGN_TOOL_COMMANDS, DESIGN_TOOL_QUERIES } from '../design/tool-commands'
import { FEEDS_SPEEDS_QUERIES } from '../feeds-speeds/commands'
import { LIBRARY_COMMANDS, LIBRARY_QUERIES } from '../library/commands'
import { draftPlanAutoRebuild, PLAN_COMMANDS, PLAN_QUERIES } from '../plan/commands'
import type {
  AnyCommand,
  ApplyHook,
  ApplyJob,
  ApplyWarnings,
  DocumentHook,
  QueryDef,
} from './define'
import { projectApply, projectPendingGet } from './apply'
import { projectSave } from '../project/commands'
import { toolpathGenerateJob, toolpathGet } from '../toolpath/generate'
import { planExport } from '../post/plan-export'
import { RUN_COMMANDS, RUN_QUERIES } from '../run/commands'
import { LIFECYCLE_COMMANDS, LIFECYCLE_QUERIES } from '../project/lifecycle'
import { historyList, historyRedo, historyUndo } from './history'
import { jobAbort, jobGet, jobList, jobPause, jobResume } from './jobs'

/** `<area>.<object>.<verb>` (or `<area>.<verb>` for area-level actions such as `history.undo`). */
export const NAME_PATTERN =
  /^(project|design|plan|run|library|feedsSpeeds|history|job|app)(\.[a-z][a-zA-Z0-9]*){1,3}$/

/** Commands executed by the dispatcher itself; always registered. */
export const BUILTIN_COMMANDS: readonly AnyCommand[] = [
  projectApply,
  historyUndo,
  historyRedo,
  jobPause,
  jobResume,
  jobAbort,
]

/** Queries answered from dispatcher state (`ctx.jobs`, `ctx.history`); always registered. */
export const BUILTIN_QUERIES: readonly QueryDef[] = [
  jobGet,
  jobList,
  historyList,
  projectPendingGet,
]

/**
 * Project scope: commands and queries of one open project (its dispatcher); added by their
 * features. Doc: docs/architecture/llm-api.md#app-scope-and-project-scope
 */
export const PROJECT_COMMANDS: readonly AnyCommand[] = [
  projectSave,
  ...DESIGN_COMMANDS,
  ...DESIGN_TOOL_COMMANDS,
  ...PLAN_COMMANDS,
  toolpathGenerateJob,
  planExport,
  ...RUN_COMMANDS,
]
export const PROJECT_QUERIES: readonly QueryDef[] = [
  ...DESIGN_QUERIES,
  ...DESIGN_TOOL_QUERIES,
  ...PLAN_QUERIES,
  toolpathGet,
  ...RUN_QUERIES,
]

/** App scope: the instance's app-scope dispatcher (empty document); usable without a project. */
export const APP_SCOPE_COMMANDS: readonly AnyCommand[] = [
  ...LIBRARY_COMMANDS,
  ...LIFECYCLE_COMMANDS,
]
export const APP_SCOPE_QUERIES: readonly QueryDef[] = [
  ...LIBRARY_QUERIES,
  ...FEEDS_SPEEDS_QUERIES,
  ...LIFECYCLE_QUERIES,
]
/** Document hooks of the app (docs/architecture/commands.md#document-hooks). */
export const APP_HOOKS: readonly DocumentHook[] = [draftPlanAutoRebuild]

/**
 * Apply hooks of the app, in this order (docs/architecture/apply.md#apply-hooks). Empty until
 * task P2 moves the deferred reactions here: `design.toolAutoChoice`, then `plan.draftFollow`.
 */
export const APPLY_HOOKS: readonly ApplyHook[] = []

/** Apply jobs of the app (docs/architecture/apply.md#apply-jobs); toolpaths of kept-current plans join in P2. */
export const APPLY_JOBS: readonly ApplyJob[] = []

/** `ApplyOutcome.warnings`: `design.warning.list` of each affected part (parts it cannot read are left out). */
export const designApplyWarnings: ApplyWarnings = (doc, partIds, ctx) => {
  const query = DESIGN_QUERIES.find((q) => q.name === 'design.warning.list')
  if (query === undefined) return []
  return partIds.flatMap((partId) => {
    if (!Object.hasOwn(doc.parts, partId)) return []
    const r = query.run(doc, { partId }, ctx)
    if (r.isErr()) return []
    const value = r.unwrap() as { warnings?: unknown[] }
    return [{ partId, warnings: value.warnings ?? [] }]
  })
}

/** Hooks, apply hooks, apply jobs and apply warnings of a project registry. */
const APPLY_DEFS = {
  hooks: APP_HOOKS,
  applyHooks: APPLY_HOOKS,
  applyJobs: APPLY_JOBS,
  applyWarnings: designApplyWarnings,
}

export interface Registry {
  command(name: string): Option<AnyCommand>
  query(name: string): Option<QueryDef>
  /** Built-ins first, then the given commands (queries likewise), in registration order. */
  readonly commands: readonly AnyCommand[]
  readonly queries: readonly QueryDef[]
  /** Run after every successful document command, in this order (commands.md#document-hooks). */
  readonly hooks: readonly DocumentHook[]
  /** Run by `project.apply`, in this order (docs/architecture/apply.md#apply-hooks). */
  readonly applyHooks: readonly ApplyHook[]
  readonly applyJobs: readonly ApplyJob[]
  /** Computes `ApplyOutcome.warnings`; absent = none. */
  readonly applyWarnings?: ApplyWarnings
}

/** Builds a registry (built-ins included). Invalid definitions are bugs → `internal.unexpected`. */
export function createRegistry(defs: {
  readonly commands?: readonly AnyCommand[]
  readonly queries?: readonly QueryDef[]
  readonly hooks?: readonly DocumentHook[]
  readonly applyHooks?: readonly ApplyHook[]
  readonly applyJobs?: readonly ApplyJob[]
  readonly applyWarnings?: ApplyWarnings
  /** Register the built-ins (default true; the app-scope registry has none: no history, no jobs). */
  readonly builtins?: boolean
}): AppResult<Registry> {
  const builtins = defs.builtins !== false
  const commands = [...(builtins ? BUILTIN_COMMANDS : []), ...(defs.commands ?? [])]
  const queries = [...(builtins ? BUILTIN_QUERIES : []), ...(defs.queries ?? [])]
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
    hooks: [...(defs.hooks ?? [])],
    applyHooks: [...(defs.applyHooks ?? [])],
    applyJobs: [...(defs.applyJobs ?? [])],
    ...(defs.applyWarnings === undefined ? {} : { applyWarnings: defs.applyWarnings }),
  })
}

/** Registry of a project dispatcher: built-ins plus `PROJECT_COMMANDS` / `PROJECT_QUERIES`. */
export function createProjectRegistry(): AppResult<Registry> {
  return createRegistry({
    commands: PROJECT_COMMANDS,
    queries: PROJECT_QUERIES,
    ...APPLY_DEFS,
  })
}

/** Registry of the app-scope dispatcher: library, feeds and speeds, project lifecycle; no built-ins. */
export function createAppScopeRegistry(): AppResult<Registry> {
  return createRegistry({
    commands: APP_SCOPE_COMMANDS,
    queries: APP_SCOPE_QUERIES,
    builtins: false,
  })
}

/**
 * Project scope plus the library and feeds-and-speeds entries on one dispatcher, for tests that
 * add library items and use them in a project without an app host. Not used by the app (it runs
 * the two scopes on separate dispatchers); the project lifecycle needs a host and is left out.
 */
export function createAppRegistry(): AppResult<Registry> {
  return createRegistry({
    commands: [...PROJECT_COMMANDS, ...LIBRARY_COMMANDS],
    queries: [...PROJECT_QUERIES, ...LIBRARY_QUERIES, ...FEEDS_SPEEDS_QUERIES],
    ...APPLY_DEFS,
  })
}
