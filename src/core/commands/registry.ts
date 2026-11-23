/**
 * Registry of all commands and queries, with name checks.
 * Doc: docs/architecture/commands.md#naming
 */
import type { Issue } from '../../shared/errors/app-error'
import { fail, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import { DESIGN_COMMANDS, DESIGN_QUERIES } from '../design/commands'
import {
  DESIGN_TOOL_COMMANDS,
  DESIGN_TOOL_QUERIES,
  designToolAutoChoice,
  toolScan,
} from '../design/tool-commands'
import { REFERENCE_COMMANDS, REFERENCE_QUERIES } from '../design/reference-commands'
import { SHAPE_COMMANDS, SHAPE_QUERIES } from '../design/shape-commands'
import { designMeasure } from '../design/measure'
import { FASTENER_QUERIES } from '../design/fastener/commands'
import { FEATURE_COMMANDS, FEATURE_QUERIES } from '../design/feature-commands'
import {
  CLONES_COMMANDS,
  CLONES_QUERIES,
  clonesFollowApply,
  clonesFollowHook,
} from '../design/clones/commands'
import { HOLE_COMMANDS } from '../design/hole-commands'
import { FEEDS_SPEEDS_QUERIES } from '../feeds-speeds/commands'
import { LIBRARY_COMMANDS, LIBRARY_QUERIES } from '../library/commands'
import { PLAN_COMMANDS, PLAN_QUERIES, planDraftFollow } from '../plan/commands'
import { PLAN_PENDING_SOURCES } from '../plan/pending'
import type {
  AnyCommand,
  ApplyHook,
  ApplyJob,
  ApplyWarnings,
  DocumentHook,
  OpenScan,
  PendingSource,
  QueryDef,
} from './define'
import { projectApply, projectPendingGet } from './apply'
import { projectSave } from '../project/commands'
import { toolpathApplyJob } from '../toolpath/apply-job'
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
  ...SHAPE_COMMANDS,
  ...FEATURE_COMMANDS,
  ...HOLE_COMMANDS,
  ...CLONES_COMMANDS,
  ...REFERENCE_COMMANDS,
  ...PLAN_COMMANDS,
  toolpathGenerateJob,
  planExport,
  ...RUN_COMMANDS,
]
export const PROJECT_QUERIES: readonly QueryDef[] = [
  ...DESIGN_QUERIES,
  designMeasure,
  ...DESIGN_TOOL_QUERIES,
  ...SHAPE_QUERIES,
  ...FEATURE_QUERIES,
  ...CLONES_QUERIES,
  ...REFERENCE_QUERIES,
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
  ...FASTENER_QUERIES,
  ...LIFECYCLE_QUERIES,
]
/**
 * Document hooks of the app (docs/architecture/commands.md#document-hooks): Clones instances
 * follow an edited source in the same command (`design.clonesFollow`, v0.4 F5). The draft
 * auto-rebuild moved behind Apply in v0.2 P2 (`plan.draftFollow`).
 */
export const APP_HOOKS: readonly DocumentHook[] = [clonesFollowHook]

/**
 * Apply hooks of the app, in this order (docs/architecture/apply.md#apply-hooks): the tool
 * choice first, because the rebuild resolves plan tools from the design tool field; then Clones
 * instances take their source's chosen tool (C3) before the rebuild reads them.
 */
export const APPLY_HOOKS: readonly ApplyHook[] = [
  designToolAutoChoice,
  clonesFollowApply,
  planDraftFollow,
]

/** Apply jobs of the app (docs/architecture/apply.md#apply-jobs): toolpaths of kept-current plans. */
export const APPLY_JOBS: readonly ApplyJob[] = [toolpathApplyJob]

/** Pending keys beyond the design diff (docs/architecture/apply.md#what-is-pending). */
export const PENDING_SOURCES: readonly PendingSource[] = PLAN_PENDING_SOURCES

/**
 * The consistency scan on open (docs/architecture/apply.md#opening-and-recovery): unfit or absent
 * auto tools. `draft` plans that do not follow their part and changed library copies of `draft`
 * plans are pending through `PENDING_SOURCES` (derived on every read), so they need no scan.
 */
export const OPEN_SCAN: OpenScan = toolScan

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
  pendingSources: PENDING_SOURCES,
  openScan: OPEN_SCAN,
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
  /** Pending keys beyond the design diff, in this order (apply.md § What is pending). */
  readonly pendingSources: readonly PendingSource[]
  /** The consistency scan when a dispatcher opens a document; absent = none. */
  readonly openScan?: OpenScan
}

/** Builds a registry (built-ins included). Invalid definitions are bugs → `internal.unexpected`. */
export function createRegistry(defs: {
  readonly commands?: readonly AnyCommand[]
  readonly queries?: readonly QueryDef[]
  readonly hooks?: readonly DocumentHook[]
  readonly applyHooks?: readonly ApplyHook[]
  readonly applyJobs?: readonly ApplyJob[]
  readonly applyWarnings?: ApplyWarnings
  readonly pendingSources?: readonly PendingSource[]
  readonly openScan?: OpenScan
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
    pendingSources: [...(defs.pendingSources ?? [])],
    ...(defs.openScan === undefined ? {} : { openScan: defs.openScan }),
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
 * Project scope plus the library, feeds-and-speeds and fastener entries on one dispatcher, for tests that
 * add library items and use them in a project without an app host. Not used by the app (it runs
 * the two scopes on separate dispatchers); the project lifecycle needs a host and is left out.
 */
export function createAppRegistry(
  /** Test-only extra commands (a test feature kind, design-v0.4.md#implementation-f1). */
  extra: readonly AnyCommand[] = [],
): AppResult<Registry> {
  return createRegistry({
    commands: [...PROJECT_COMMANDS, ...LIBRARY_COMMANDS, ...extra],
    queries: [...PROJECT_QUERIES, ...LIBRARY_QUERIES, ...FEEDS_SPEEDS_QUERIES, ...FASTENER_QUERIES],
    ...APPLY_DEFS,
  })
}
