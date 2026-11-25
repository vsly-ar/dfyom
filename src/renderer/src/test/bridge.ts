// A fake `window.dfyom` for renderer tests: records calls and lets a test push main's events. With
// a real core dispatcher bound (`bind`), calls, the snapshot and the patch stream come from it,
// so the replica and the shell run against the real command layer. Doc: docs/conventions/ui.md#testing
import type { ActionEvent } from '../../../core/commands/action-log'
import { FIXTURE_DOCUMENT_COMMANDS } from '../../../core/commands/commands.fixture'
import type { Services, Source } from '../../../core/commands/context'
import { createDispatcher, type Dispatcher } from '../../../core/commands/dispatcher'
import { inProcessWorkers } from '../../../core/commands/jobs'
import { createAppRegistry, createRegistry } from '../../../core/commands/registry'
import { Library } from '../../../core/library/library'
import { createMemoryLibraryStorage } from '../../../core/library/memory-storage'
import { fakeIds } from '../../../core/commands/testing'
import { newProjectDoc, type UnitSystem } from '../../../core/project/document'
import type { RunProgram, RunStatus } from '../../../core/run/service'
import { agentError } from '../../../core/agent/results'
import type { AppErrorData } from '../../../shared/errors/app-error'
import type {
  AgentSessionInfo,
  CallReply,
  ConnectInfo,
  LocalHttpState,
  MenuAction,
  PartEvaluationView,
  PreloadApi,
  ProjectSnapshot,
  ReferenceCompareViewReply,
  ReferenceCompareViewRequest,
  ReferenceMeshReply,
  ReferenceSectionReply,
  ReferenceSectionRequest,
  WindowCloseRequest,
  LibraryCloseRequest,
  LibraryContext,
  LibraryTarget,
  LibraryWindowState,
  ShapeEditorTarget,
  WindowKind,
} from '../../../shared/preload-api'
import type { LibraryChange } from '../../../core/library/library'
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
 * `services` adds or replaces some (e.g. a project session and file-reading workers for
 * `design.reference.import`).
 */
export async function designDispatcher(
  name = 'Bracket',
  unitSystem: UnitSystem = 'mm',
  services: Partial<Services> = {},
): Promise<Dispatcher> {
  const library = await Library.open(createMemoryLibraryStorage())
  const registry = createAppRegistry()
  if (library.isErr()) throw library.unwrapErr()
  if (registry.isErr()) throw registry.unwrapErr()
  return createDispatcher({
    registry: registry.unwrap(),
    doc: newProjectDoc({ name, unitSystem }),
    ids: fakeIds(),
    services: { workers: inProcessWorkers, library: library.unwrap(), ...services },
  })
}

export const WINDOW_SOURCE: Source = { kind: 'ui', id: 'win-1' }

type Handler = (args: unknown) => CallReply | Promise<CallReply>

export interface FakeBridge extends PreloadApi {
  readonly calls: { readonly name: string; readonly args: unknown; readonly gesture?: string }[]
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
  /** The program main keeps for a run job (`run.program`, DF84); `undefined` forgets it. */
  setRunProgram(program: RunProgram | undefined): void
  setLocalHttp(state: LocalHttpState): void
  /** Push a part evaluation (main's mesh push); `get` / `getPlan` answer the last one per subject. */
  emitEvaluation(view: PartEvaluationView): void
  emitMenu(action: MenuAction): void
  /** Main hands the window a file to open (Finder, a launch argument; hardening U5). */
  emitOpenFile(file: string): void
  /** Answers `agents.connectInfo` (Help → Connect an agent…). */
  setConnectInfo(info: ConnectInfo): void
  /** Answers of the native file dialogs (null = cancelled, the default). */
  setFileChoice(choice: {
    open?: string | null
    save?: string | null
    export?: string | null
    reference?: string | null
    svg?: string | null
  }): void
  readonly saveDialogNames: string[]
  readonly exportDialogNames: string[]
  /** Paths passed to `files.showInFolder` (DF48). */
  readonly shownInFolder: string[]
  /** The reference ids whose ghost mesh was asked for (`reference.mesh`), in order. */
  readonly referenceMeshCalls: string[]
  /** Answers `reference.mesh` (default: one triangle). */
  setReferenceMesh(
    handler: (referenceId: string) => ReferenceMeshReply | Promise<ReferenceMeshReply>,
  ): void
  /** The section requests (`reference.section`, U3), in order. */
  readonly referenceSectionCalls: ReferenceSectionRequest[]
  /** Answers `reference.section` (default: no segments). */
  setReferenceSection(
    handler: (
      request: ReferenceSectionRequest,
    ) => ReferenceSectionReply | Promise<ReferenceSectionReply>,
  ): void
  /** The compare overlay's requests (`reference.compareView`, DF60 P5), in order. */
  readonly referenceCompareViewCalls: ReferenceCompareViewRequest[]
  /** Answers `reference.compareView` (default: every distance 0, no missing pieces). */
  setReferenceCompareView(
    handler: (
      request: ReferenceCompareViewRequest,
    ) => ReferenceCompareViewReply | Promise<ReferenceCompareViewReply>,
  ): void
  /**
   * The app-scope dispatcher calls go to while no project is bound (the Library window's
   * `library.*` commands); its library's writes are pushed as `library.onChanged`.
   */
  appScope(dispatcher: Dispatcher, library?: Library): void
  /** `library.open` requests, in order. */
  readonly libraryOpens: LibraryTarget[]
  /** `library.report` states, in order. */
  readonly libraryReports: LibraryWindowState[]
  /** `library.close` calls (their `quit`), in order. */
  readonly libraryCloses: boolean[]
  /** Sets (and pushes) the Library window's context. */
  emitLibraryContext(context: LibraryContext): void
  emitLibraryChange(change: LibraryChange): void
  emitLibraryCloseRequest(request: LibraryCloseRequest): void
  /** `shapeEditor.open` requests of a project window, in order (DF94). */
  readonly shapeEditorOpens: { partId: string; shapeId: string | null }[]
  /** Sets (and pushes) the Shape Editor window's target; `seq` grows by itself. */
  emitShapeEditorTarget(target: { partId: string; shapeId: string | null }): void
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

export function createFakeBridge(
  initial: AppSettings = DEFAULT_SETTINGS,
  windowKind: WindowKind = 'project',
): FakeBridge {
  const libraryChanges = channel<LibraryChange>()
  const libraryContexts = channel<LibraryContext>()
  const libraryCloseRequests = channel<LibraryCloseRequest>()
  let libraryContext: LibraryContext = { project: null, target: null, tab: 'tool' }
  let app: { d: Dispatcher; off: () => void } | undefined
  const libraryOpens: LibraryTarget[] = []
  const libraryReports: LibraryWindowState[] = []
  const libraryCloses: boolean[] = []
  const shapeEditorOpens: { partId: string; shapeId: string | null }[] = []
  const shapeEditorTargets = channel<ShapeEditorTarget>()
  let shapeEditorTarget: ShapeEditorTarget | null = null
  const events = channel<ActionEvent>()
  const bound = channel<string | null>()
  const sessions = channel<readonly AgentSessionInfo[]>()
  const settings = channel<AppSettings>()
  const closeRequests = channel<WindowCloseRequest>()
  const runStatus = channel<RunStatus>()
  let runProgram: RunProgram | undefined
  const evaluationPush = channel<PartEvaluationView>()
  const menu = channel<MenuAction>()
  const openFiles = channel<string>()
  let connectInfo: ConnectInfo = {
    connect:
      'claude mcp add --scope user dfyom -- /Applications/DFYOM.app/Contents/Resources/bin/dfyom mcp --connect',
    headless:
      'claude mcp add --scope user dfyom -- /Applications/DFYOM.app/Contents/Resources/bin/dfyom mcp',
    cli: '/Applications/DFYOM.app/Contents/Resources/bin/dfyom',
    development: false,
    localAgents: true,
  }
  const evaluations = new Map<string, PartEvaluationView>()
  const saveDialogNames: string[] = []
  const exportDialogNames: string[] = []
  const shownInFolder: string[] = []
  let fileChoice: {
    open: string | null
    save: string | null
    export: string | null
    reference: string | null
    svg: string | null
  } = { open: null, save: null, export: null, reference: null, svg: null }
  const referenceMeshCalls: string[] = []
  let referenceMesh = (_id: string): ReferenceMeshReply | Promise<ReferenceMeshReply> => ({
    ok: true,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    edges: new Float32Array([0, 0, 0, 1, 0, 0]),
  })
  const referenceSectionCalls: ReferenceSectionRequest[] = []
  let referenceSection = (
    _r: ReferenceSectionRequest,
  ): ReferenceSectionReply | Promise<ReferenceSectionReply> => ({
    ok: true,
    segments: new Float32Array(0),
  })
  const referenceCompareViewCalls: ReferenceCompareViewRequest[] = []
  let referenceCompareView = (
    r: ReferenceCompareViewRequest,
  ): ReferenceCompareViewReply | Promise<ReferenceCompareViewReply> => ({
    ok: true,
    distances: new Float32Array(r.positions.length / 3),
  })
  const handlers = new Map<string, Handler>()
  const calls: { name: string; args: unknown; gesture?: string }[] = []
  const settingsPatches: unknown[] = []
  const closeCalls: boolean[] = []
  let project:
    { d: Dispatcher; key: string; file: string | null; dirty: boolean; off: () => void } | undefined
  let agents: readonly AgentSessionInfo[] = []
  let localHttp: LocalHttpState = { enabled: true, port: 41234 }
  let current = initial

  const bridge: FakeBridge = {
    calls,
    settingsPatches,
    closeCalls,
    windowKind,
    versions: { electron: 'test', chrome: 'test', node: 'test' },
    log: { level: 'info', send: () => {} },
    run: {
      onStatus: runStatus.on,
      program: (jobId) => Promise.resolve(runProgram?.jobId === jobId ? runProgram : null),
    },
    async call(name, args, opts) {
      const gesture = opts?.gesture
      calls.push({ name, args, ...(gesture === undefined ? {} : { gesture }) })
      const h = handlers.get(name)
      if (h) return h(args ?? {})
      const d = project?.d ?? app?.d
      if (d === undefined) return NO_PROJECT
      // queries first (as the session routes them); an unknown query is a command
      const q = await d.queryAsync(name, args ?? {}, WINDOW_SOURCE)
      if (q.isOk() || q.unwrapErr().code !== 'command.unknown') return toReply(Promise.resolve(q))
      return toReply(
        d.dispatch(name, args ?? {}, WINDOW_SOURCE, gesture === undefined ? {} : { gesture }),
      )
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
      connectInfo: () => Promise.resolve(connectInfo),
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
      getPlan: (planId) => Promise.resolve(evaluations.get(`plan:${planId}`) ?? null),
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
      chooseReference: () => Promise.resolve(fileChoice.reference),
      chooseSvg: () => Promise.resolve(fileChoice.svg),
      showInFolder: (path) => {
        shownInFolder.push(path)
        return Promise.resolve(true)
      },
    },
    reference: {
      mesh: (referenceId) => {
        referenceMeshCalls.push(referenceId)
        return Promise.resolve(referenceMesh(referenceId))
      },
      section: (request) => {
        referenceSectionCalls.push(request)
        return Promise.resolve(referenceSection(request))
      },
      compareView: (request) => {
        referenceCompareViewCalls.push(request)
        return Promise.resolve(referenceCompareView(request))
      },
    },
    referenceMeshCalls,
    setReferenceMesh(handler) {
      referenceMesh = handler
    },
    referenceSectionCalls,
    setReferenceSection(handler) {
      referenceSection = handler
    },
    referenceCompareViewCalls,
    setReferenceCompareView(handler) {
      referenceCompareView = handler
    },
    menu: { onAction: menu.on },
    library: {
      open(target) {
        libraryOpens.push(target ?? {})
        return Promise.resolve()
      },
      onChanged: libraryChanges.on,
      context: () => Promise.resolve(libraryContext),
      onContext: libraryContexts.on,
      report: (state) => void libraryReports.push(state),
      onCloseRequest: libraryCloseRequests.on,
      close(quit) {
        libraryCloses.push(quit === true)
        return Promise.resolve()
      },
    },
    shapeEditor: {
      open(target) {
        shapeEditorOpens.push({ partId: target.partId, shapeId: target.shapeId })
        return Promise.resolve()
      },
      target: () => Promise.resolve(shapeEditorTarget),
      onTarget: shapeEditorTargets.on,
    },
    shapeEditorOpens,
    emitShapeEditorTarget(t) {
      shapeEditorTarget = { ...t, seq: (shapeEditorTarget?.seq ?? 0) + 1 }
      shapeEditorTargets.emit(shapeEditorTarget)
    },
    libraryOpens,
    libraryReports,
    libraryCloses,
    appScope(d, lib) {
      app?.off()
      app = { d, off: lib === undefined ? () => {} : lib.subscribe(libraryChanges.emit) }
    },
    emitLibraryContext(c) {
      libraryContext = c
      libraryContexts.emit(c)
    },
    emitLibraryChange: libraryChanges.emit,
    emitLibraryCloseRequest: libraryCloseRequests.emit,
    saveDialogNames,
    exportDialogNames,
    shownInFolder,
    emitEvaluation(view) {
      evaluations.set(view.planId === undefined ? view.partId : `plan:${view.planId}`, view)
      evaluationPush.emit(view)
    },
    emitMenu: menu.emit,
    emitOpenFile: openFiles.emit,
    setConnectInfo(info) {
      connectInfo = info
    },
    setFileChoice(choice) {
      fileChoice = { ...fileChoice, ...choice }
    },
    window: {
      // as if main picked this window (it has no project); tests check the calls
      openProject(name, args) {
        return bridge.call(name, args)
      },
      onCloseRequest: closeRequests.on,
      onOpenFile: openFiles.on,
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
    setRunProgram(p) {
      runProgram = p
    },
    setLocalHttp(s) {
      localHttp = s
    },
  }
  return bridge
}
