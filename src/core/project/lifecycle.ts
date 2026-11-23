/**
 * Project lifecycle as app-scope commands (`project.create/open/close/list/recovery.*`) and the
 * `HostPort` their handlers call (`ctx.services.host`).
 * Doc: docs/architecture/llm-api.md#app-scope-and-project-scope
 *
 * They run on the app-scope dispatcher (empty document), so a project can be opened by every
 * adapter (IPC, MCP, CLI) through the same pipeline. The host (src/main/host) owns storage and
 * the project runtimes.
 */
import { z } from 'zod'
import { fail, Ok, type AsyncAppResult } from '../../shared/result'
import type { CommandContext, Source } from '../commands/context'
import { defineCommand, defineQuery, type AnyCommand, type QueryDef } from '../commands/define'
import { UnitSystemSchema, type UnitSystem } from './document'
import {
  isProjectFileName,
  PROJECT_KEY,
  RecoverArgsSchema,
  type RecoverableProject,
} from './storage'

/** One open project of the instance (`project.list`). */
export interface OpenProjectInfo {
  readonly key: string
  readonly projectId: string
  /** `null` until an untitled project is saved. */
  readonly file: string | null
  readonly name: string
  readonly dirty: boolean
  readonly revision: number
  /** Sessions bound to it (agents, windows, CLI): `kind:id`, with the client name if known. */
  readonly sources: readonly { readonly source: string; readonly client?: string }[]
}

export interface OpenedResult {
  readonly key: string
  readonly revision: number
}

/** The app host as the lifecycle commands see it. Implemented in src/main/host. */
export interface HostPort {
  create(
    init: { name: string; unitSystem: UnitSystem },
    source: Source,
  ): AsyncAppResult<OpenedResult>
  /**
   * A file already open in this instance returns its key with `alreadyOpen: true`. `reset`: a
   * file with incompatible pre-alpha data (`isIncompatibleProject`) is replaced by an empty
   * project of the same name and opened (callers confirm first); ignored for a file that loads.
   */
  open(
    file: string,
    source: Source,
    reset?: boolean,
  ): AsyncAppResult<OpenedResult & { alreadyOpen: boolean }>
  /** Unsaved changes need `confirm`; `run.busy` while a run job runs. */
  close(key: string, confirm: boolean): AsyncAppResult<void>
  list(): readonly OpenProjectInfo[]
  listRecovery(): AsyncAppResult<readonly RecoverableProject[]>
  /** `restore` opens the project; `discard` opens the project file (nothing for an untitled one). */
  resolveRecovery(
    args: z.output<typeof RecoverArgsSchema>,
    source: Source,
  ): AsyncAppResult<OpenedResult | undefined>
}

/** Runs `fn` with the host; without one (a dispatcher not wired to an app host) → bug. */
async function withHost<T>(
  ctx: Pick<CommandContext, 'services'>,
  where: string,
  fn: (host: HostPort) => AsyncAppResult<T>,
): AsyncAppResult<T> {
  const host = ctx.services.host
  return host === undefined ? noHost(where) : fn(host)
}

const noHost = (where: string) => fail('internal.unexpected', 'no app host service', { where })

const KeySchema = z.string().regex(PROJECT_KEY, 'not a project key').describe('Project key')
const OpenedSchema = z.object({
  key: z.string().describe('Project key: bind sessions with it, pass it to project.close'),
  revision: z.number().int().describe('Current revision of the project'),
})

export const projectCreate = defineCommand({
  kind: 'effect',
  name: 'project.create',
  summary: 'Create a new, untitled project and open it; save it with project.save { target }.',
  title: () => 'New project',
  machine: false,
  args: z.object({
    name: z.string().trim().min(1).max(200).describe('Project name'),
    unitSystem: UnitSystemSchema,
  }),
  result: OpenedSchema,
  async run(_doc, args, ctx) {
    return withHost(ctx, 'project.create', (h) => h.create(args, ctx.source))
  },
})

export const projectOpen = defineCommand({
  kind: 'effect',
  name: 'project.open',
  summary: 'Open a project file; a file already open in this instance returns its key.',
  title: () => 'Open project',
  machine: false,
  args: z.object({
    file: z
      .string()
      .min(1)
      .refine(isProjectFileName, 'must be a .dfyom file')
      .describe('Path of the .dfyom project file'),
    reset: z
      .boolean()
      .default(false)
      .describe(
        'Only after the user confirmed: when the file holds data of an earlier pre-alpha version that no longer loads (error frame project.incompatible), replace it with an empty project of the same name and open that',
      ),
  }),
  result: OpenedSchema.extend({
    alreadyOpen: z.boolean().describe('The file was already open in this instance'),
  }),
  async run(_doc, args, ctx) {
    return withHost(ctx, 'project.open', (h) => h.open(args.file, ctx.source, args.reset))
  },
})

export const projectClose = defineCommand({
  kind: 'effect',
  name: 'project.close',
  summary: 'Close an open project; unsaved changes stay recoverable.',
  title: () => 'Close project',
  machine: false,
  args: z.object({
    key: KeySchema,
    confirm: z
      .boolean()
      .default(false)
      .describe('Must be true to close with unsaved changes (they stay recoverable)'),
  }),
  result: z.object({ key: z.string() }),
  async run(_doc, args, ctx) {
    const closed = await withHost(ctx, 'project.close', (h) => h.close(args.key, args.confirm))
    return closed.map(() => ({ key: args.key }))
  },
})

const RecoverableSchema = z.object({
  key: z.string(),
  projectId: z.string(),
  filePath: z.string().nullable().describe('null for a never-saved project'),
  workingRevision: z.number().int(),
  savedRevision: z.number().int().nullable(),
})

/**
 * An effect, not a query: the scan reads the filesystem asynchronously, and queries are
 * synchronous. `readOnly` marks it for agents (docs/architecture/llm-api.md#app-scope-and-project-scope).
 */
export const projectRecoveryList = defineCommand({
  kind: 'effect',
  name: 'project.recovery.list',
  summary: 'List projects with unsaved changes left by a crash or a close without saving.',
  title: () => 'List recoverable projects',
  machine: false,
  readOnly: true,
  args: z.object({}),
  result: z.object({ projects: z.array(RecoverableSchema) }),
  async run(_doc, _args, ctx) {
    const listed = await withHost(ctx, 'project.recovery.list', (h) => h.listRecovery())
    return listed.map((projects) => ({ projects: [...projects] }))
  },
})

export const projectRecoveryResolve = defineCommand({
  kind: 'effect',
  name: 'project.recovery.resolve',
  summary:
    'Restore the unsaved changes of a recoverable project (opens it), or discard them (confirm).',
  title: (a) => (a.action === 'restore' ? 'Restore project' : 'Discard unsaved changes'),
  machine: false,
  args: RecoverArgsSchema,
  result: z.object({
    key: z.string().nullable().describe('The opened project; null if nothing was opened'),
    revision: z.number().int().nullable(),
  }),
  async run(_doc, args, ctx) {
    const r = await withHost(ctx, 'project.recovery.resolve', (h) =>
      h.resolveRecovery(args, ctx.source),
    )
    return r.map((o) => ({ key: o?.key ?? null, revision: o?.revision ?? null }))
  },
})

export const projectList = defineQuery({
  name: 'project.list',
  summary: 'List the projects open in this instance, with the sessions bound to each.',
  args: z.object({}),
  result: z.object({
    projects: z.array(
      z.object({
        key: z.string(),
        projectId: z.string(),
        file: z.string().nullable(),
        name: z.string(),
        dirty: z.boolean().describe('Unsaved changes'),
        revision: z.number().int(),
        sources: z.array(z.object({ source: z.string(), client: z.string().optional() })),
      }),
    ),
  }),
  readsDocument: false,
  run(_doc, _args, ctx) {
    const host = ctx.services.host
    if (host === undefined) return noHost('project.list')
    return Ok({ projects: host.list().map((p) => ({ ...p, sources: [...p.sources] })) })
  },
})

export const LIFECYCLE_COMMANDS: readonly AnyCommand[] = [
  projectCreate,
  projectOpen,
  projectClose,
  projectRecoveryList,
  projectRecoveryResolve,
]
export const LIFECYCLE_QUERIES: readonly QueryDef[] = [projectList]
