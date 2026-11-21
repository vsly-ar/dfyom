/**
 * The shared session core of MCP, the CLI and the GUI's IPC: one source, at most one bound
 * project, routing of a tool call to the app-scope or the bound project's dispatcher, the
 * session tools and the action digest.
 * Doc: docs/architecture/llm-api.md#sessions-and-sources
 *
 * Adapters never serialize calls: each call goes straight to `dispatch`/`query`, so ordering is
 * the project queue's (urgent commands skip it).
 */
import { z } from 'zod'
import { atBoundary, type ErrorReporter } from '../../shared/boundary'
import { Err, fail, None, Ok, type AppResult, type Option } from '../../shared/result'
import { parseArgs } from '../commands/args'
import type { ActionEvent } from '../commands/action-log'
import {
  sameSource,
  sourceKey,
  systemTimers,
  type JobProgress,
  type Source,
  type Timers,
} from '../commands/context'
import type { CommandOutcome, Dispatcher } from '../commands/dispatcher'
import { JobInfoSchema } from '../commands/jobs'
import type { Registry } from '../commands/registry'
import { EXPECTED_REVISION, type SessionToolDef } from './tools'

/** What a session needs from the app host. Implemented by src/main/host. */
export interface SessionHost {
  /** The instance's app-scope dispatcher (library, feeds and speeds, project lifecycle). */
  readonly app: Dispatcher
  readonly registries: { readonly app: Registry; readonly project: Registry }
  /** The dispatcher of an open project. */
  project(key: string): Option<Dispatcher>
  /** A session started, changed its binding (`key`) or ended (`ended`): project.list, indicator. */
  sessionChanged(info: SessionInfo, ended?: boolean): void
}

export interface SessionInfo {
  readonly source: Source
  /** MCP `clientInfo.name`, if known. */
  readonly client?: string
  /** The bound project. */
  readonly key?: string
}

export type CallKind = 'command' | 'job' | 'query' | 'session'

/** The action digest of one tool result (docs: #action-log-and-user-actions). */
export interface Digest {
  readonly line: string
  readonly meta: {
    readonly fromSeq: number
    readonly toSeq: number
    readonly count: number
    readonly bySource: Readonly<Record<string, readonly string[]>>
    readonly revision: { readonly from: number; readonly to: number }
    readonly gap: boolean
  }
}

export interface SessionCallResult {
  /** Registry or session tool name (dotted). */
  readonly name: string
  readonly kind: CallKind
  readonly result: AppResult<CommandOutcome>
  readonly digest?: Digest
}

export interface CallOptions {
  /** Cancels a `job.wait` (never the job). */
  readonly signal?: AbortSignal
  /** Progress of the job a `job.wait` waits for (dispatcher-throttled ticks). */
  readonly onProgress?: (p: JobProgress) => void
  /**
   * A step of a live-edit gesture (UI adapter only; docs/architecture/commands.md#gestures-live-edits):
   * passed to a project-scope command's dispatch.
   */
  readonly gesture?: string
}

export interface SessionOptions {
  readonly source: Source
  readonly client?: string
  /** Boundary reporter (logs each error once); default: none. */
  readonly report?: ErrorReporter
  readonly timers?: Timers
}

// ---------------------------------------------------------------------------
// Session tools (docs: #session-tools)

const KeyArg = z
  .string()
  .min(1)
  .describe('Project key from project.list, project.open or project.create')

const LogArgs = z.object({
  afterSeq: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Only events after this seq (0 = all retained)'),
  sources: z
    .array(z.string())
    .optional()
    .describe('Only these sources, as kind:id (e.g. ui:win-1, agent:http-2)'),
  names: z
    .array(z.string())
    .optional()
    .describe('Only these command names (history.undo/history.redo for undo/redo)'),
  limit: z.number().int().min(1).max(1000).default(100).describe('Max events (default 100)'),
})

export const MAX_WAIT_SECONDS = 300

export const SESSION_TOOLS: readonly SessionToolDef[] = [
  {
    name: 'project.bind',
    summary:
      'Bind this session to an open project; project tools then act on it. project.open, project.create and project.recovery.resolve bind automatically.',
    args: z.object({ key: KeyArg }),
    result: z.object({ key: z.string(), revision: z.number().int() }),
    // changes which project the session's tools act on: not read-only
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'project.log.list',
    summary:
      'List action-log events of the bound project (what the user and other agents did); gap = events were dropped, re-query what you need.',
    args: LogArgs,
    result: z.object({
      events: z.array(z.record(z.string(), z.unknown())),
      lastSeq: z.number().int(),
      gap: z.boolean(),
      more: z.boolean().describe('More events after the last one returned'),
    }),
  },
  {
    name: 'job.wait',
    summary:
      'Wait until a job finishes or the timeout passes; returns job.get (timedOut: true if still running). Cancelling the wait never stops the job (job_abort does).',
    args: z.object({
      jobId: z.string().describe('Id returned when the job started'),
      timeoutSeconds: z
        .number()
        .min(0)
        .max(MAX_WAIT_SECONDS)
        .default(30)
        .describe(`Max wait (default 30, max ${MAX_WAIT_SECONDS})`),
    }),
    result: JobInfoSchema.extend({ timedOut: z.boolean() }),
  },
]

const SESSION_TOOL_NAMES = new Set(SESSION_TOOLS.map((t) => t.name))

function noProject(
  name: string,
  message = 'no project is bound to this session',
): AppResult<never> {
  return fail('input.malformed', `${name}: ${message}`, {
    where: 'AgentSession',
    issues: [
      {
        path: [],
        rule: 'noProject',
        message:
          'open or create a project first (project_open, project_create), or bind one (project_bind)',
      },
    ],
  })
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseSourceKey(s: string): Source | undefined {
  const i = s.indexOf(':')
  if (i <= 0) return undefined
  const kind = s.slice(0, i)
  if (!['ui', 'agent', 'cli', 'automation', 'system'].includes(kind)) return undefined
  return { kind: kind as Source['kind'], id: s.slice(i + 1) }
}

function eventName(e: ActionEvent): string {
  return 'name' in e ? e.name : `history.${e.type}`
}

/** One agent, CLI run or window. */
export class AgentSession {
  readonly source: Source
  private clientName: string | undefined
  private key: string | undefined
  /** The runtime the session is bound to (identity: a reopened project is another one). */
  private dispatcher: Dispatcher | undefined
  /** Key of a bound project whose runtime ended, for the `noProject` message. */
  private lostKey: string | undefined
  private readonly waits = new Set<AbortController>()
  private cursor = 0
  private cursorRevision = 0
  private readonly report: ErrorReporter
  private readonly timers: Timers
  private ended = false

  constructor(
    private readonly host: SessionHost,
    opts: SessionOptions,
  ) {
    this.source = opts.source
    this.clientName = opts.client
    this.report = opts.report ?? (() => {})
    this.timers = opts.timers ?? systemTimers
    this.host.sessionChanged(this.info())
  }

  /** MCP `clientInfo.name` (logged with the source, shown by the GUI indicator). */
  get client(): string | undefined {
    return this.clientName
  }

  setClient(name: string): void {
    this.clientName = name
    if (!this.ended) this.host.sessionChanged(this.info())
  }

  /** The bound project's key (undefined when none, or when its runtime ended meanwhile). */
  get boundKey(): string | undefined {
    return this.bound().isSome() ? this.key : undefined
  }

  /**
   * The bound project's dispatcher. The binding is to one runtime, not to a key: a project that
   * was closed (and maybe reopened under the same key) unbinds the session, whose digest cursor
   * and stale-write baseline belonged to the old runtime.
   */
  bound(): Option<Dispatcher> {
    if (this.key === undefined) return None
    const d = this.host.project(this.key)
    if (d.isSome() && d.unwrap() === this.dispatcher) return d
    this.lostKey = this.key
    this.unbind()
    return None
  }

  info(): SessionInfo {
    return {
      source: this.source,
      ...(this.client === undefined ? {} : { client: this.client }),
      ...(this.key === undefined ? {} : { key: this.key }),
    }
  }

  /** Session end (MCP session closed, CLI exit, window closed): unbinds; projects stay open. */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.host.sessionChanged(this.info(), true)
  }

  /**
   * Binds to an open project; the digest starts at its current log position. Not a read: an
   * edit needs a query or `expectedRevision` first (docs/architecture/llm-api.md#undo-and-history).
   */
  bind(key: string): AppResult<CommandOutcome> {
    const d = this.host.project(key)
    if (d.isNone())
      return fail('input.malformed', `no open project ${key}`, {
        where: 'project.bind',
        issues: [{ path: ['key'], rule: 'unknownProject', message: 'see project.list' }],
      })
    const dispatcher = d.unwrap()
    this.key = key
    this.dispatcher = dispatcher
    this.lostKey = undefined
    this.cursor = dispatcher.log.lastSeq
    this.cursorRevision = dispatcher.revision
    this.host.sessionChanged(this.info())
    return Ok({ value: { key, revision: dispatcher.revision }, revision: dispatcher.revision })
  }

  private unbind(): void {
    this.key = undefined
    this.dispatcher = undefined
    this.host.sessionChanged(this.info())
  }

  /**
   * Ends every pending `job.wait` of this session now (`op.aborted`; the jobs keep running):
   * shutting down must not wait for their timeouts.
   */
  abortWaits(): void {
    for (const c of this.waits) c.abort()
  }

  private lostMessage(): string | undefined {
    return this.lostKey === undefined
      ? undefined
      : `the project bound to this session (${this.lostKey}) was closed; open or bind it again`
  }

  /** Kind of a tool by name, for result framing (`job` → "wait with job_wait"). */
  kindOf(name: string): CallKind | undefined {
    if (SESSION_TOOL_NAMES.has(name)) return 'session'
    for (const reg of [this.host.registries.app, this.host.registries.project]) {
      const c = reg.command(name)
      if (c.isSome()) return c.unwrap().kind === 'job' ? 'job' : 'command'
      if (reg.query(name).isSome()) return 'query'
    }
    return undefined
  }

  /** One tool call, inside `atBoundary` (entry kind = the source's kind). Never rejects. */
  async call(name: string, rawArgs: unknown, opts: CallOptions = {}): Promise<SessionCallResult> {
    const kind = this.kindOf(name) ?? 'command'
    const result = await atBoundary(
      { kind: this.source.kind, name, args: rawArgs },
      () => this.route(name, rawArgs ?? {}, opts),
      this.report,
    )
    const digest = this.digest()
    return { name, kind, result, ...(digest === undefined ? {} : { digest }) }
  }

  private async route(
    name: string,
    rawArgs: unknown,
    opts: CallOptions,
  ): Promise<AppResult<CommandOutcome>> {
    const { app, project } = this.host.registries
    if (SESSION_TOOL_NAMES.has(name)) return this.sessionTool(name, rawArgs, opts)
    if (app.command(name).isSome()) {
      const r = await this.host.app.dispatch(name, rawArgs, this.source)
      return this.afterLifecycle(name, rawArgs, r)
    }
    if (app.query(name).isSome()) return this.host.app.query(name, rawArgs, this.source)
    const isCommand = project.command(name).isSome()
    if (!isCommand && project.query(name).isNone())
      return fail('command.unknown', `unknown tool ${name}`, { where: 'AgentSession' })
    const bound = this.bound()
    if (bound.isNone()) return noProject(name, this.lostMessage())
    const d = bound.unwrap()
    if (!isCommand) return d.query(name, rawArgs, this.source)
    const split = splitExpectedRevision(rawArgs)
    if (split.isErr()) return split
    const { args, expectedRevision } = split.unwrap()
    return d.dispatch(name, args, this.source, {
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      ...(opts.gesture === undefined ? {} : { gesture: opts.gesture }),
    })
  }

  /** open/create/restore bind the session; closing the bound project unbinds it. */
  private afterLifecycle(
    name: string,
    rawArgs: unknown,
    r: AppResult<CommandOutcome>,
  ): AppResult<CommandOutcome> {
    if (r.isErr()) return r
    const value = r.unwrap().value as {
      key?: unknown
      revision?: unknown
      alreadyOpen?: unknown
    } | null
    const key = value?.key
    if (
      (name === 'project.open' ||
        name === 'project.create' ||
        name === 'project.recovery.resolve') &&
      typeof key === 'string'
    ) {
      const bound = this.bind(key)
      if (bound.isErr()) return Err(bound.unwrapErr())
      // This call started the runtime and its result showed the document at `revision`: a read.
      // A project that was already open (someone else's) is not: query before editing.
      if (value?.alreadyOpen !== true && typeof value?.revision === 'number')
        this.dispatcher?.markRead(this.source, value.revision)
    }
    if (
      name === 'project.close' &&
      isPlainObject(rawArgs) &&
      rawArgs['key'] === this.key &&
      this.key !== undefined
    )
      this.unbind()
    return r
  }

  private async sessionTool(
    name: string,
    rawArgs: unknown,
    opts: CallOptions,
  ): Promise<AppResult<CommandOutcome>> {
    const def = SESSION_TOOLS.find((t) => t.name === name)
    if (def === undefined) return fail('command.unknown', `unknown tool ${name}`)
    const parsed = parseArgs(def.args, rawArgs, name)
    if (parsed.isErr()) return Err(parsed.unwrapErr())
    const args = parsed.unwrap() as Record<string, unknown>
    if (name === 'project.bind') return this.bind(args['key'] as string)
    const bound = this.bound()
    if (bound.isNone()) return noProject(name, this.lostMessage())
    const d = bound.unwrap()
    if (name === 'project.log.list')
      return Ok({ value: logList(d, args as unknown as LogQuery), revision: d.revision })
    return this.waitJob(d, args as unknown as { jobId: string; timeoutSeconds: number }, opts)
  }

  private async waitJob(
    d: Dispatcher,
    args: { jobId: string; timeoutSeconds: number },
    opts: CallOptions,
  ): Promise<AppResult<CommandOutcome>> {
    const job = d.job(args.jobId)
    if (job.isNone())
      return fail('input.malformed', `no job ${args.jobId}`, {
        issues: [{ path: ['jobId'], rule: 'unknownJob', message: 'no such job' }],
        where: 'job.wait',
      })
    const handle = job.unwrap()
    // The latest progress first (the job may be past its last tick, or finished), then the ticks.
    if (handle.progress !== undefined) opts.onProgress?.(handle.progress)
    const offProgress =
      opts.onProgress === undefined ? undefined : handle.onProgress(opts.onProgress)
    let timer: unknown
    const own = new AbortController()
    this.waits.add(own)
    const onAbort = () => own.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const waited = await new Promise<'done' | 'timeout' | 'cancelled'>((resolve) => {
      if (opts.signal?.aborted === true) return resolve('cancelled')
      timer = this.timers.set(() => resolve('timeout'), args.timeoutSeconds * 1000)
      own.signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
      void handle.result.then(() => resolve('done'))
    })
    this.timers.clear(timer)
    this.waits.delete(own)
    opts.signal?.removeEventListener('abort', onAbort)
    offProgress?.()
    if (waited === 'cancelled')
      return fail('op.aborted', 'the wait was cancelled; the job keeps running', {
        where: 'job.wait',
        data: { jobId: args.jobId },
      })
    const info = d.query('job.get', { jobId: args.jobId }, this.source)
    return info.map((o) => ({
      value: { ...(o.value as object), timedOut: waited === 'timeout' },
      revision: o.revision,
    }))
  }

  /**
   * Events by other sources (and this session's finished jobs) since the last call, as one
   * line; advances the cursor. None when nothing happened.
   */
  private digest(): Digest | undefined {
    const bound = this.bound()
    if (bound.isNone()) return undefined
    const d = bound.unwrap()
    const all = d.log.since(this.cursor)
    const fromSeq = this.cursor
    const gap = all.length > 0 ? (all[0]?.seq ?? 0) > fromSeq + 1 : d.log.lastSeq > fromSeq
    const from = this.cursorRevision
    this.cursor = d.log.lastSeq
    this.cursorRevision = d.revision
    const relevant = all.filter((e) => {
      const own = sameSource(e.source, this.source)
      if (e.type === 'job') return e.state === 'finished'
      if (own) return false
      return e.type !== 'command' || e.outcome.ok
    })
    if (relevant.length === 0 && !gap) return undefined
    const bySource = new Map<string, string[]>()
    for (const e of relevant) {
      const who = sameSource(e.source, this.source) ? 'you' : sourceKey(e.source)
      const label =
        e.type === 'job'
          ? `${e.name} ${e.outcome?.ok === false ? 'failed' : 'finished'}`
          : eventName(e)
      bySource.set(who, [...(bySource.get(who) ?? []), label])
    }
    const parts = [...bySource.entries()].map(([who, names]) => {
      const counts = new Map<string, number>()
      for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
      const list = [...counts.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ')
      return `${names.length} action${names.length === 1 ? '' : 's'} by ${who} (${list})`
    })
    const line =
      `Since your last call: ${parts.length > 0 ? parts.join('; ') : 'events'}, revision ${from} → ${d.revision}.` +
      (gap ? ' Some events were dropped; re-query what you need.' : '')
    return {
      line,
      meta: {
        fromSeq,
        toSeq: this.cursor,
        count: relevant.length,
        bySource: Object.fromEntries(bySource),
        revision: { from, to: d.revision },
        gap,
      },
    }
  }
}

interface LogQuery {
  afterSeq: number
  sources?: string[]
  names?: string[]
  limit: number
}

/** `project.log.list`: retained events after `afterSeq`, patches never included. */
function logList(d: Dispatcher, q: LogQuery) {
  const all = d.log.since(q.afterSeq)
  const gap = all.length > 0 ? (all[0]?.seq ?? 0) > q.afterSeq + 1 : d.log.lastSeq > q.afterSeq
  const sources = q.sources?.map(parseSourceKey).filter((s): s is Source => s !== undefined)
  const matching = d.log.since(q.afterSeq, {
    withPatches: false,
    ...(sources === undefined ? {} : { sources }),
    ...(q.names === undefined ? {} : { names: q.names }),
  })
  return {
    events: matching.slice(0, q.limit) as unknown as Record<string, unknown>[],
    lastSeq: d.log.lastSeq,
    gap,
    more: matching.length > q.limit,
  }
}

/** Removes the reserved `expectedRevision` (decision 12) before dispatch. */
export function splitExpectedRevision(
  rawArgs: unknown,
): AppResult<{ args: unknown; expectedRevision?: number }> {
  if (!isPlainObject(rawArgs) || !(EXPECTED_REVISION in rawArgs)) return Ok({ args: rawArgs })
  const { [EXPECTED_REVISION]: rev, ...args } = rawArgs
  if (rev === undefined) return Ok({ args })
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0)
    return fail('input.malformed', 'expectedRevision must be a non-negative integer', {
      where: 'AgentSession',
      issues: [
        { path: [EXPECTED_REVISION], rule: 'integer', message: 'expected a revision number' },
      ],
    })
  return Ok({ args, expectedRevision: rev })
}
