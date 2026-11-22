/**
 * The app host: what every mode (GUI, headless MCP, CLI) runs – project storage, the library,
 * the app-scope dispatcher, one runtime per open project (dispatcher, `EvaluationScheduler`,
 * `ToolpathCache`, `ExportFiles`, geometry prewarm) and the agent/window sessions.
 * Doc: docs/architecture/llm-api.md#processes-and-hosting
 *
 * No Electron import: the GUI adds windows and IPC, MCP and the CLI their framing.
 */
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import {
  AgentSession,
  SESSION_TOOLS,
  type SessionHost,
  type SessionInfo,
} from '../../core/agent/session'
import { buildAgentTools, type AgentTool } from '../../core/agent/tools'
import {
  sourceKey,
  type Clock,
  type IdGenerator,
  type Services,
  type Source,
  type Timers,
} from '../../core/commands/context'
import { createDispatcher, type Dispatcher } from '../../core/commands/dispatcher'
import type { WorkerPort } from '../../core/commands/jobs'
import type { Region2dPort } from '../../core/geometry/2d/port'
import type { PermissionPolicy } from '../../core/commands/permission'
import {
  createAppScopeRegistry,
  createProjectRegistry,
  type Registry,
} from '../../core/commands/registry'
import {
  createEvaluationScheduler,
  type EvaluationScheduler,
  type PartEvaluationState,
} from '../../core/design/evaluation'
import { Library } from '../../core/library/library'
import type { ExportFiles } from '../../core/post/plan-export'
import { newProjectDoc } from '../../core/project/document'
import type { HostPort, OpenedResult, OpenProjectInfo } from '../../core/project/lifecycle'
import {
  attachSession,
  resolveRecovery,
  type OpenedProject,
  type ProjectSession,
  type ProjectStorage,
} from '../../core/project/storage'
import { checkNoRunJob } from '../../core/run/commands'
import type { MachineService } from '../../core/run/service'
import { createToolpathCache } from '../../core/toolpath/cache'
import { stlMesh, type StlMesh } from '../../core/workers/tasks'
import type { ErrorReporter } from '../../shared/boundary'
import type { AppError } from '../../shared/errors/app-error'
import type { Logger } from '../../shared/logging'
import { Err, fail, None, Ok, Some, type AsyncAppResult, type Option } from '../../shared/result'
import { createFsLibraryStorage } from '../library/fs-storage'
import { canonicalPath, nodeFs, samePath } from '../persistence/fs'
import { createProjectStorage } from '../persistence/storage'
import { listInstances } from './discovery'

export interface AppHostOptions {
  /** `<appData>`: Electron's `userData`, or `--data-dir` headless. */
  readonly appData: string
  readonly appVersion: string
  /** This instance (log `instance`, lock owner, discovery file name). */
  readonly instanceId: string
  readonly log: Logger
  /** Boundary reporter of every session call (logs each error once). */
  readonly report: ErrorReporter
  /** The app-wide compute pool (`prewarm` hides the geometry worker's cold start). */
  readonly workers: WorkerPort & { prewarm?(lane: 'geometry' | 'toolpath'): void }
  /** The instance's machine connection (`services.machine` of every project). */
  readonly machine?: MachineService
  readonly exportFiles?: ExportFiles
  /** The 2D port of the instance (`services.region2d` of every project). */
  readonly region2d?: Region2dPort
  /** Defaults: storage under `appData`, library under `<appData>/library`. */
  readonly storage?: ProjectStorage
  readonly library?: Library
  readonly policy?: PermissionPolicy
  readonly ids?: IdGenerator
  readonly clock?: Clock
  readonly timers?: Timers
  /** Evaluation debounce (tests). */
  readonly evaluationDebounceMs?: number
}

/** The source of the host's own dispatches (aborting jobs on close, following the library). */
export const HOST_SOURCE: Source = { kind: 'system', id: 'host' }

interface ProjectRuntime {
  readonly key: string
  readonly session: ProjectSession
  readonly dispatcher: Dispatcher
  readonly scheduler: EvaluationScheduler
  readonly detach: () => void
  /** Revision of the last save (or of the open, if it had no unsaved changes); -1 = none. */
  clean: number
}

/**
 * Unsaved changes: the storage's flag lags behind by the working-folder debounce, so a revision
 * after the last save counts too.
 */
function isDirty(rt: ProjectRuntime): boolean {
  return rt.session.dirty || rt.dispatcher.revision !== rt.clean
}

export interface AppHost extends SessionHost, HostPort {
  readonly instanceId: string
  readonly appData: string
  readonly library: Library
  /** Every agent tool (both registries and the session tools). */
  readonly tools: readonly AgentTool[]
  /** A new session for an MCP connection, CLI run or window. */
  openSession(source: Source, client?: string): AgentSession
  /** A unique source id for a transport: `stdio-1`, `http-2`, … */
  nextSourceId(prefix: string): string
  /** Sessions currently attached (all kinds). */
  sessions(): readonly SessionInfo[]
  /** Called whenever a session starts, ends or changes its binding. Returns the unsubscribe. */
  onSessions(listener: (sessions: readonly SessionInfo[]) => void): () => void
  /** Called after a project was opened, created or restored, with the source that did it. */
  onProjectOpened(listener: (key: string, source: Source) => void): () => void
  /**
   * The key of `file` if it is already open in this instance, else undefined (the GUI's window
   * choice for Open: docs/conventions/ui.md#project-files).
   */
  openKey(file: string): Promise<string | undefined>
  /** Called after a project runtime started or stopped (windows re-follow their project). */
  onProjectsChanged(listener: () => void): () => void
  /**
   * A part's evaluation in the project's current document, for the window mesh push (renderer
   * only, not an agent capability: docs/architecture/overview.md#ipc). Undefined without the project.
   */
  evaluation(key: string, partId: string): PartEvaluationState | undefined
  /** The project's part evaluations may have changed (`evaluation` reads them). Returns the unsubscribe. */
  onEvaluation(key: string, listener: (partId: string) => void): () => void
  /**
   * The evaluation of a plan's part (its design snapshot with plan-only edits: the snapshot scene,
   * docs/modes/plan-v0.2.md#plan-only-edits-and-the-snapshot-scene), with the part's id, for the
   * window push. Undefined without the project or the plan.
   */
  planEvaluation(
    key: string,
    planId: string,
  ): { readonly partId: string; readonly state: PartEvaluationState } | undefined
  /** A plan's part evaluation may have changed (`planEvaluation` reads it). Returns the unsubscribe. */
  onPlanEvaluation(key: string, listener: (planId: string) => void): () => void
  /**
   * The triangles of a reference's stored asset for the window's ghost (task R3: window plumbing
   * like the mesh push, not an agent capability), read by the worker
   * (docs/modes/reference-model.md#ghost-mesh-task-r3). `input.malformed` (rule
   * `unknownReference`) without the project or the reference.
   */
  referenceMesh(key: string, referenceId: string): AsyncAppResult<StlMesh>
  /**
   * Stdin end, app quit: abort jobs and close every project (unsaved changes stay recoverable).
   * Returns the projects that had unsaved changes.
   */
  shutdown(): Promise<readonly OpenProjectInfo[]>
}

/** Opens the library (`<appData>/library`) unless given, and builds the host. */
export async function createAppHost(o: AppHostOptions): AsyncAppResult<AppHost> {
  let library = o.library
  if (library === undefined) {
    const storage = await createFsLibraryStorage(join(o.appData, 'library'))
    if (storage.isErr()) return Err(storage.unwrapErr().withContext('createAppHost'))
    const opened = await Library.open(storage.unwrap())
    if (opened.isErr()) return Err(opened.unwrapErr().withContext('createAppHost'))
    library = opened.unwrap()
  }
  const app = createAppScopeRegistry()
  const project = createProjectRegistry()
  if (app.isErr()) return app
  if (project.isErr()) return project
  const registries = { app: app.unwrap(), project: project.unwrap() }
  const tools = buildAgentTools(registries, SESSION_TOOLS)
  if (tools.isErr()) return tools
  return Ok(new Host(o, library, registries, tools.unwrap()))
}

class Host implements AppHost {
  readonly instanceId: string
  readonly appData: string
  readonly app: Dispatcher
  private readonly storage: ProjectStorage
  private readonly runtimes = new Map<string, ProjectRuntime>()
  private readonly attached = new Map<string, SessionInfo>()
  private readonly sessionListeners = new Set<(s: readonly SessionInfo[]) => void>()
  private readonly openListeners = new Set<(key: string, source: Source) => void>()
  private readonly counters = new Map<string, number>()
  private readonly log: Logger
  private prewarmed = false
  private closing: Promise<readonly OpenProjectInfo[]> | undefined
  private readonly changeListeners = new Set<() => void>()

  constructor(
    private readonly o: AppHostOptions,
    readonly library: Library,
    readonly registries: { readonly app: Registry; readonly project: Registry },
    readonly tools: readonly AgentTool[],
  ) {
    this.instanceId = o.instanceId
    this.appData = o.appData
    this.log = o.log.child({ scope: 'host' })
    this.storage =
      o.storage ??
      createProjectStorage({
        appData: o.appData,
        appVersion: o.appVersion,
        owner: { instanceId: o.instanceId, pid: process.pid, host: hostname() },
        log: o.log,
      })
    this.app = createDispatcher({
      registry: registries.app,
      doc: newProjectDoc({ name: 'app', unitSystem: 'mm' }),
      services: { workers: o.workers, library, host: this },
      ...this.common(),
    })
    // Draft plans follow library changes on the next Apply of each project: a changed library
    // item a draft plan copies is pending there (docs/architecture/apply.md#apply-hooks).
  }

  private common() {
    return {
      ...(this.o.ids === undefined ? {} : { ids: this.o.ids }),
      ...(this.o.clock === undefined ? {} : { clock: this.o.clock }),
      ...(this.o.policy === undefined ? {} : { policy: this.o.policy }),
      onListenerError: (e: AppError) =>
        this.o.report(e, { kind: 'system', name: 'actionLog.listener' }),
    }
  }

  // --- SessionHost -------------------------------------------------------------------------

  project(key: string): Option<Dispatcher> {
    const rt = this.runtimes.get(key)
    return rt === undefined ? None : Some(rt.dispatcher)
  }

  sessionChanged(info: SessionInfo, ended = false): void {
    const k = sourceKey(info.source)
    if (ended) this.attached.delete(k)
    else this.attached.set(k, info)
    this.notifySessions()
  }

  private notifySessions(): void {
    const all = this.sessions()
    for (const l of [...this.sessionListeners]) l(all)
  }

  openSession(source: Source, client?: string): AgentSession {
    return new AgentSession(this, {
      source,
      ...(client === undefined ? {} : { client }),
      report: this.o.report,
      ...(this.o.timers === undefined ? {} : { timers: this.o.timers }),
    })
  }

  nextSourceId(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1
    this.counters.set(prefix, n)
    return `${prefix}-${n}`
  }

  sessions(): readonly SessionInfo[] {
    return [...this.attached.values()]
  }

  onSessions(listener: (s: readonly SessionInfo[]) => void): () => void {
    this.sessionListeners.add(listener)
    return () => void this.sessionListeners.delete(listener)
  }

  onProjectOpened(listener: (key: string, source: Source) => void): () => void {
    this.openListeners.add(listener)
    return () => void this.openListeners.delete(listener)
  }

  // --- HostPort ----------------------------------------------------------------------------

  async create(
    init: Parameters<HostPort['create']>[0],
    source: Source,
  ): AsyncAppResult<OpenedResult> {
    const created = await this.storage.create(newProjectDoc(init))
    if (created.isErr()) return Err(created.unwrapErr())
    return Ok(this.start(created.unwrap(), source))
  }

  async open(
    file: string,
    source: Source,
  ): AsyncAppResult<OpenedResult & { alreadyOpen: boolean }> {
    const where = 'host.open'
    const already = await this.findOpen(file)
    if (already !== undefined)
      return Ok({ key: already.key, revision: already.dispatcher.revision, alreadyOpen: true })
    const opened = await this.storage.open(file)
    if (opened.isErr()) return Err(await this.withConnectHint(opened.unwrapErr()))
    const outcome = opened.unwrap()
    if (outcome.kind === 'recoverable') {
      const r = outcome.recoverable
      return fail(
        'persist.recovery',
        'the project has unsaved changes from an earlier session; restore or discard them with project.recovery.resolve',
        {
          where,
          data: { key: r.key, file: r.filePath, workingRevision: r.workingRevision },
        },
      )
    }
    return Ok({ ...this.start(outcome.project, source), alreadyOpen: false })
  }

  async openKey(file: string): Promise<string | undefined> {
    return (await this.findOpen(file))?.key
  }

  /** A file already open in this instance (the storage would answer `persist.locked`). */
  private async findOpen(file: string): Promise<ProjectRuntime | undefined> {
    let canonical: string
    try {
      canonical = await canonicalPath(nodeFs, resolve(file))
    } catch {
      return undefined // the storage reports the real error
    }
    for (const rt of this.runtimes.values())
      if (rt.session.filePath !== null && samePath(rt.session.filePath, canonical)) return rt
    return undefined
  }

  /** `persist.locked`: the holder's id and, if it serves HTTP, how to attach to it (decision 5). */
  private async withConnectHint(e: AppError) {
    if (e.code !== 'persist.locked') return e
    const holder = e.frames.map((f) => f.data?.['holder']).find((h) => typeof h === 'string') as
      string | undefined
    if (holder === undefined) return e
    const live = await listInstances(this.appData).catch(() => [])
    const serves = live.some((r) => r.instanceId === holder)
    return e.withContext('project.open', {
      holder,
      ...(serves ? { connect: `dfyom mcp --connect ${holder}` } : {}),
    })
  }

  async close(key: string, confirm: boolean): AsyncAppResult<void> {
    const where = 'project.close'
    const rt = this.runtimes.get(key)
    if (rt === undefined)
      return fail('input.malformed', `no open project ${key}`, {
        where,
        issues: [{ path: ['key'], rule: 'unknownProject', message: 'see project.list' }],
      })
    const refused = this.refuseClose(rt, confirm)
    if (refused !== undefined) return refused
    // Refuse new dispatches and drain the queue, then check again: an edit queued meanwhile
    // must not slip past the unsaved-changes confirmation.
    await rt.dispatcher.suspend()
    const late = this.refuseClose(rt, confirm)
    if (late !== undefined) {
      rt.dispatcher.resume()
      return late
    }
    return this.stop(rt)
  }

  private refuseClose(rt: ProjectRuntime, confirm: boolean) {
    const busy = checkNoRunJob(rt.dispatcher.jobs)
    if (busy.isErr()) return busy
    if (isDirty(rt) && !confirm)
      return fail('input.malformed', 'the project has unsaved changes', {
        where: 'project.close',
        issues: [
          {
            path: ['confirm'],
            rule: 'unsavedChanges',
            message: 'save first, or set confirm: true to close (the changes stay recoverable)',
          },
        ],
      })
    return undefined
  }

  list(): readonly OpenProjectInfo[] {
    return [...this.runtimes.values()].map((rt) => ({
      key: rt.key,
      projectId: rt.session.projectId,
      file: rt.session.filePath,
      name: rt.dispatcher.doc.name,
      dirty: isDirty(rt),
      revision: rt.dispatcher.revision,
      sources: [...this.attached.values()]
        .filter((s) => s.key === rt.key)
        .map((s) => ({
          source: sourceKey(s.source),
          ...(s.client === undefined ? {} : { client: s.client }),
        })),
    }))
  }

  listRecovery() {
    return this.storage.listRecoverable()
  }

  async resolveRecovery(
    args: Parameters<HostPort['resolveRecovery']>[0],
    source: Source,
  ): AsyncAppResult<OpenedResult | undefined> {
    const r = await resolveRecovery(this.storage, args)
    if (r.isErr()) return Err(r.unwrapErr())
    const opened = r.unwrap()
    return Ok(opened === undefined ? undefined : this.start(opened, source))
  }

  // --- runtimes ----------------------------------------------------------------------------

  /** Wires an opened project: dispatcher with every service, working folder, evaluations. */
  private start(opened: OpenedProject, source: Source): OpenedResult {
    const { session } = opened
    const scheduler = createEvaluationScheduler({
      workers: this.o.workers,
      log: this.o.log,
      ...(this.o.timers === undefined ? {} : { timers: this.o.timers }),
      ...(this.o.clock === undefined ? {} : { clock: this.o.clock }),
      ...(this.o.evaluationDebounceMs === undefined
        ? {}
        : { debounceMs: this.o.evaluationDebounceMs }),
    })
    const services: Services = {
      workers: this.o.workers,
      evaluations: scheduler,
      toolpaths: createToolpathCache(),
      library: this.library,
      project: session,
      ...(this.o.machine === undefined ? {} : { machine: this.o.machine }),
      ...(this.o.exportFiles === undefined ? {} : { exportFiles: this.o.exportFiles }),
      ...(this.o.region2d === undefined ? {} : { region2d: this.o.region2d }),
    }
    const dispatcher = createDispatcher({
      registry: this.registries.project,
      doc: opened.doc,
      revision: opened.revision,
      services,
      ...this.common(),
    })
    const detachSession = attachSession(dispatcher, session)
    const rt: ProjectRuntime = {
      key: session.key,
      session,
      dispatcher,
      scheduler,
      detach: () => {
        detachSession()
        stopSaves()
      },
      clean: session.dirty ? -1 : dispatcher.revision,
    }
    const stopSaves = dispatcher.log.subscribe({ names: ['project.save'] }, (e) => {
      if (e.type === 'command' && e.outcome.ok) rt.clean = e.revision
    })
    scheduler.attach(dispatcher)
    if (!this.prewarmed) {
      this.prewarmed = true
      this.o.workers.prewarm?.('geometry')
    }
    this.runtimes.set(session.key, rt)
    this.log.info(
      { key: session.key, project: session.projectId, source },
      'project runtime started',
    )
    for (const l of [...this.openListeners]) l(session.key, source)
    for (const l of [...this.changeListeners]) l()
    return { key: session.key, revision: dispatcher.revision }
  }

  /** Aborts the project's jobs, stops evaluations, releases storage (unsaved stays recoverable). */
  private async stop(rt: ProjectRuntime): AsyncAppResult<void> {
    await rt.dispatcher.suspend() // queued commands finish (and are flushed) first
    this.runtimes.delete(rt.key)
    const running = rt.dispatcher.jobs.list().filter((j) => j.state !== 'finished')
    for (const j of running) await rt.dispatcher.dispatch('job.abort', { jobId: j.id }, HOST_SOURCE)
    await Promise.all(running.map((j) => j.result))
    rt.scheduler.close()
    const closed = await this.storage.close(rt.key)
    rt.detach()
    // Bound sessions notice on their next call (`AgentSession.boundKey`); the list is current now.
    for (const [k, s] of this.attached)
      if (s.key === rt.key)
        this.attached.set(k, {
          source: s.source,
          ...(s.client === undefined ? {} : { client: s.client }),
        })
    this.notifySessions()
    for (const l of [...this.changeListeners]) l()
    this.log.info({ key: rt.key }, 'project runtime stopped')
    return closed
  }

  async shutdown(): Promise<readonly OpenProjectInfo[]> {
    if (this.closing !== undefined) return this.closing
    this.closing = (async () => {
      const unsaved = this.list().filter((p) => p.dirty)
      for (const rt of [...this.runtimes.values()]) {
        const r = await this.stop(rt)
        if (r.isErr()) this.o.report(r.unwrapErr(), { kind: 'system', name: 'host.shutdown' })
      }
      return unsaved
    })()
    return this.closing
  }

  evaluation(key: string, partId: string): PartEvaluationState | undefined {
    const rt = this.runtimes.get(key)
    if (rt === undefined || !Object.hasOwn(rt.dispatcher.doc.parts, partId)) return undefined
    return rt.scheduler.state(rt.dispatcher.doc, partId)
  }

  onEvaluation(key: string, listener: (partId: string) => void): () => void {
    const rt = this.runtimes.get(key)
    return rt === undefined ? () => {} : rt.scheduler.onChange(listener)
  }

  planEvaluation(
    key: string,
    planId: string,
  ): { readonly partId: string; readonly state: PartEvaluationState } | undefined {
    const rt = this.runtimes.get(key)
    const doc = rt?.dispatcher.doc
    if (rt === undefined || doc === undefined || !Object.hasOwn(doc.plans, planId)) return undefined
    return { partId: doc.plans[planId]!.design.partId, state: rt.scheduler.planState(doc, planId) }
  }

  onPlanEvaluation(key: string, listener: (planId: string) => void): () => void {
    const rt = this.runtimes.get(key)
    return rt === undefined ? () => {} : rt.scheduler.onPlanChange(listener)
  }

  async referenceMesh(key: string, referenceId: string): AsyncAppResult<StlMesh> {
    const where = 'reference.mesh'
    const rt = this.runtimes.get(key)
    const refs = rt?.dispatcher.doc.references
    const ref =
      refs !== undefined && Object.hasOwn(refs, referenceId) ? refs[referenceId] : undefined
    if (rt === undefined || ref === undefined)
      return fail('input.malformed', `reference ${referenceId} is not in this project`, {
        issues: [{ path: ['referenceId'], rule: 'unknownReference', message: 'no such reference' }],
        where,
      })
    const file = rt.session.assetFile(ref.asset.path)
    if (file.isErr()) return Err(file.unwrapErr().withContext(where))
    const r = await this.o.workers.run(
      stlMesh,
      { path: file.unwrap(), triangles: ref.asset.triangles },
      { signal: new AbortController().signal, progress: () => undefined },
    )
    return r.isErr() ? Err(r.unwrapErr().withContext(where, { referenceId })) : r
  }

  onProjectsChanged(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => void this.changeListeners.delete(listener)
  }
}
