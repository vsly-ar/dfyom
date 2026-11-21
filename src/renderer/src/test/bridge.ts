// A fake `window.dfyom` for renderer tests: records calls and lets a test push main's events. With
// a real core dispatcher bound (`bind`), calls, the snapshot and the patch stream come from it,
// so the replica and the shell run against the real command layer. Doc: docs/conventions/ui.md#testing
import type { ActionEvent } from '../../../core/commands/action-log'
import { FIXTURE_DOCUMENT_COMMANDS } from '../../../core/commands/commands.fixture'
import type { Source } from '../../../core/commands/context'
import { createDispatcher, type Dispatcher } from '../../../core/commands/dispatcher'
import { inProcessWorkers } from '../../../core/commands/jobs'
import { createAppRegistry, createRegistry } from '../../../core/commands/registry'
import { Library } from '../../../core/library/library'
import { createMemoryLibraryStorage } from '../../../core/library/memory-storage'
import { fakeIds } from '../../../core/commands/testing'
import { newProjectDoc, type UnitSystem } from '../../../core/project/document'
import type { RunStatus } from '../../../core/run/service'
import { agentError } from '../../../core/agent/results'
import type { AppErrorData } from '../../../shared/errors/app-error'
import type {
  AgentSessionInfo,
  CallReply,
  LocalHttpState,
  MenuAction,
  PartEvaluationView,
  PreloadApi,
  ProjectSnapshot,
  WindowCloseRequest,
} from '../../../shared/preload-api'
import type { AsyncAppResult } from '../../../shared/result'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../shared/settings'

/**
 * A project runtime on the core fixture commands (`project.name.update`,
 * `project.unitSystem.update`, …) with the built-ins (history, jobs).
 */
export function fixtureDispatcher(name = 'Bracket'): Dispatcher {
  const registry = createRegistry({ commands: [...FIXTURE_DOCUMENT_COMMANDS] })
  if (registry.isErr()) throw registry.unwrapErr()
  return createDispatcher({
    registry: registry.unwrap(),
    doc: newProjectDoc({ name, unitSystem: 'mm' }),
    ids: fakeIds(),
  })
}

/**
 * A project runtime with the real project registry (design, library, plan …) and an in-memory
 * library, without an evaluation service: evaluations are pushed by the test (`emitEvaluation`).
 */
export async function designDispatcher(
  name = 'Bracket',
  unitSystem: UnitSystem = 'mm',
): Promise<Dispatcher> {
  const library = await Library.open(createMemoryLibraryStorage())
  const registry = createAppRegistry()
  if (library.isErr()) throw library.unwrapErr()
  if (registry.isErr()) throw registry.unwrapErr()
  return createDispatcher({
    registry: registry.unwrap(),
    doc: newProjectDoc({ name, unitSystem }),
    ids: fakeIds(),
    services: { workers: inProcessWorkers, library: library.unwrap() },
  })
}

export const WINDOW_SOURCE: Source = { kind: 'ui', id: 'win-1' }

type Handler = (args: unknown) => CallReply | Promise<CallReply>

export interface FakeBridge extends PreloadApi {
  readonly calls: { readonly name: string; readonly args: unknown }[]
  readonly settingsPatches: unknown[]
  readonly closeCalls: boolean[]
  /** Replace the reply of one call name. */
  handle(name: string, handler: Handler): void
  /** Bind the window to a project runtime (or none) and push `project.bound`. */
  bind(dispatcher: Dispatcher | null, key?: string, opts?: { file?: string; dirty?: boolean }): void
  emitSessions(sessions: readonly AgentSessionInfo[]): void
  emitSettings(settings: AppSettings): void
  emitCloseRequest(request: WindowCloseRequest): void
  /** Push a machine status, as main does on every change (run mode). */
  emitRunStatus(status: RunStatus): void
  setLocalHttp(state: LocalHttpState): void
  /** Push a part evaluation (main's mesh push); `get` answers the last one per part. */
  emitEvaluation(view: PartEvaluationView): void
  emitMenu(action: MenuAction): void
  /** Answers of the native file dialogs (null = cancelled, the default). */
  setFileChoice(choice: {
    open?: string | null
    save?: string | null
    export?: string | null
  }): void
  readonly saveDialogNames: string[]
  readonly exportDialogNames: string[]
}

export function errorReply(error: AppErrorData, retryable = false): CallReply {
  return { ok: false, error, retryable }
}

const NO_PROJECT: CallReply = errorReply({
  code: 'input.malformed',
  message: 'no project is bound to this session',
  issues: [{ path: [], rule: 'noProject', message: 'open or create a project first' }],
  frames: [],
})

function channel<T>() {
  const listeners = new Set<(v: T) => void>()
  return {
    on(l: (v: T) => void): () => void {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    emit(v: T): void {
      for (const l of [...listeners]) l(v)
    },
  }
}

async function toReply(
  r: AsyncAppResult<{ value: unknown; revision: number }>,
): Promise<CallReply> {
  const out = await r
  return out.isOk() ? { ok: true, ...out.unwrap() } : { ok: false, ...agentError(out.unwrapErr()) }
}

export function createFakeBridge(initial: AppSettings = DEFAULT_SETTINGS): FakeBridge {
  const events = channel<ActionEvent>()
  const bound = channel<string | null>()
  const sessions = channel<readonly AgentSessionInfo[]>()
  const settings = channel<AppSettings>()
  const closeRequests = channel<WindowCloseRequest>()
  const runStatus = channel<RunStatus>()
  const evaluationPush = channel<PartEvaluationView>()
  const menu = channel<MenuAction>()
  const evaluations = new Map<string, PartEvaluationView>()
  const saveDialogNames: string[] = []
  const exportDialogNames: string[] = []
  let fileChoice: { open: string | null; save: string | null; export: string | null } = {
    open: null,
    save: null,
    export: null,
  }
  const handlers = new Map<string, Handler>()
  const calls: { name: string; args: unknown }[] = []
  const settingsPatches: unknown[] = []
  const closeCalls: boolean[] = []
  let project:
    { d: Dispatcher; key: string; file: string | null; dirty: boolean; off: () => void } | undefined
  let agents: readonly AgentSessionInfo[] = []
  let localHttp: LocalHttpState = { enabled: true, port: 41234 }
  let current = initial

  return {
    calls,
    settingsPatches,
    closeCalls,
    versions: { electron: 'test', chrome: 'test', node: 'test' },
    log: { level: 'info', send: () => {} },
    run: { onStatus: runStatus.on },
    async call(name, args) {
      calls.push({ name, args })
      const h = handlers.get(name)
      if (h) return h(args ?? {})
      if (project === undefined) return NO_PROJECT
      const d = project.d
      // queries first (as the session routes them); an unknown query is a command
      const q = d.query(name, args ?? {}, WINDOW_SOURCE)
      if (q.isOk() || q.unwrapErr().code !== 'command.unknown') return toReply(Promise.resolve(q))
      return toReply(d.dispatch(name, args ?? {}, WINDOW_SOURCE))
    },
    project: {
      onEvent: events.on,
      onBound: bound.on,
      snapshot: () =>
        Promise.resolve<ProjectSnapshot | null>(
          project === undefined
            ? null
            : {
                key: project.key,
                doc: project.d.doc,
                revision: project.d.revision,
                seq: project.d.log.lastSeq,
                file: project.file,
                dirty: project.dirty,
              },
        ),
    },
    agents: {
      list: () => Promise.resolve(agents),
      onSessions: sessions.on,
      localHttp: () => Promise.resolve(localHttp),
    },
    settings: {
      initial,
      update(patch) {
        settingsPatches.push(patch)
        current = {
          ...current,
          ...patch,
          layouts: { ...current.layouts, ...(patch.layouts ?? {}) },
        } as AppSettings
        settings.emit(current)
        return Promise.resolve({ ok: true, value: current, revision: 0 })
      },
      onChange: settings.on,
    },
    evaluation: {
      get: (partId) => Promise.resolve(evaluations.get(partId) ?? null),
      onChange: evaluationPush.on,
    },
    files: {
      chooseOpen: () => Promise.resolve(fileChoice.open),
      chooseSave: (name) => {
        saveDialogNames.push(name)
        return Promise.resolve(fileChoice.save)
      },
      chooseExport: (name) => {
        exportDialogNames.push(name)
        return Promise.resolve(fileChoice.export)
      },
    },
    menu: { onAction: menu.on },
    saveDialogNames,
    exportDialogNames,
    emitEvaluation(view) {
      evaluations.set(view.partId, view)
      evaluationPush.emit(view)
    },
    emitMenu: menu.emit,
    setFileChoice(choice) {
      fileChoice = { ...fileChoice, ...choice }
    },
    window: {
      onCloseRequest: closeRequests.on,
      close(confirm) {
        closeCalls.push(confirm)
        return Promise.resolve({ ok: true, value: {}, revision: 0 })
      },
    },
    handle: (name, handler) => void handlers.set(name, handler),
    bind(d, key = 'p1', opts = {}) {
      project?.off()
      project =
        d === null
          ? undefined
          : {
              d,
              key,
              file: opts.file ?? null,
              dirty: opts.dirty ?? false,
              off: d.log.subscribe({ withPatches: true }, events.emit),
            }
      bound.emit(d === null ? null : key)
    },
    emitSessions(s) {
      agents = s
      sessions.emit(s)
    },
    emitSettings: settings.emit,
    emitCloseRequest: closeRequests.emit,
    emitRunStatus: runStatus.emit,
    setLocalHttp(s) {
      localHttp = s
    },
  }
}
