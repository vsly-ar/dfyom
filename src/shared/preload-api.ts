/**
 * Contract of the API the preload script exposes to the renderer as `window.dfyom`.
 * Implemented in src/preload/index.ts. Design: docs/architecture/overview.md#ipc
 *
 * Keep this surface small and typed; every capability added here must also be
 * reachable by LLM agents (docs/architecture/llm-api.md).
 */
import type { ActionEvent } from '../core/commands/action-log'
import type { EvaluationStatus } from '../core/design/evaluation'
import type { PartEvaluation } from '../core/geometry/evaluate'
import type { ProjectDoc } from '../core/project/document'
import type { RunStatus } from '../core/run/service'
import type { LibraryItemKind } from '../core/library/item'
import type { LibraryChange } from '../core/library/library'
import type { UnitSystem } from '../core/project/document'
import type { AppErrorData } from './errors/app-error'
import type { LogLevel, LogRecord } from './logging'
import type { AppSettings, AppSettingsPatch } from './settings'

/** Main → renderer push of the machine status (docs/modes/run-v0.1.md#status). */
export const RUN_STATUS_IPC_CHANNEL = 'dfyom:run.status'

/**
 * Project and agent IPC (docs/architecture/llm-api.md#processes-and-hosting): every window is a
 * session of the app host (source `ui:win-<id>`), like an MCP session.
 */
export const IPC = {
  /** Renderer → main (invoke): one command, query or session tool. */
  call: 'dfyom:call',
  /** Main → renderer: action-log events (with patches) of the window's project. */
  projectEvent: 'dfyom:project.event',
  /** Main → renderer: the attached agent sessions changed (indicator). */
  agentSessions: 'dfyom:agents.sessions',
  /** Renderer → main (invoke): the attached agent sessions. */
  agentsList: 'dfyom:agents.list',
  /** Renderer → main (invoke): local HTTP state (switched by the `allowLocalAgents` setting). */
  localHttpGet: 'dfyom:agents.localHttp.get',
  /** Renderer → main (invoke): the bound project's document for the replica, or null. */
  projectSnapshot: 'dfyom:project.snapshot',
  /** Main → renderer: the window's bound project runtime changed (key, or null): re-snapshot. */
  projectBound: 'dfyom:project.bound',
  /** Renderer → main (invoke): apply a settings patch (docs/conventions/ui.md#settings). */
  settingsUpdate: 'dfyom:settings.update',
  /** Main → renderer: the settings changed (any window, or main). */
  settingsChanged: 'dfyom:settings.changed',
  /** Main → renderer: closing the window would close its project and needs the user. */
  windowCloseRequest: 'dfyom:window.closeRequest',
  /** Renderer → main (invoke): close the window and its project (`confirm` for unsaved changes). */
  windowClose: 'dfyom:window.close',
  /** Renderer → main (invoke): run an opening command in the window that should show it. */
  windowOpenProject: 'dfyom:window.openProject',
  /** Renderer → main (invoke): a part's evaluation (mesh included when done), or null. */
  evaluationGet: 'dfyom:evaluation.get',
  /** Renderer → main (invoke): a plan's part evaluation (snapshot scene, task E3b), or null. */
  evaluationPlanGet: 'dfyom:evaluation.planGet',
  /**
   * Main → renderer: a part evaluation of the window's project changed (`PartEvaluationView`), a
   * design part's or a plan's part's (`planId`).
   */
  evaluationChanged: 'dfyom:evaluation.changed',
  /** Renderer → main (invoke): the native "Open project" dialog; the chosen path or null. */
  fileChooseOpen: 'dfyom:file.chooseOpen',
  /** Renderer → main (invoke): the native "Save project" dialog; the chosen path or null. */
  fileChooseSave: 'dfyom:file.chooseSave',
  /** Renderer → main (invoke): the native "Export gCode" dialog; the chosen path or null (3.7). */
  fileChooseExport: 'dfyom:file.chooseExport',
  /** Renderer → main (invoke): the native "Import reference" dialog (STL); the path or null (R3). */
  fileChooseReference: 'dfyom:file.chooseReference',
  /** Renderer → main (invoke): the native "Import SVG" dialog; the path or null (I1). */
  fileChooseSvg: 'dfyom:file.chooseSvg',
  /** Renderer → main (invoke): a reference's triangles for the ghost (`ReferenceMeshReply`, R3). */
  referenceMesh: 'dfyom:reference.mesh',
  /**
   * Renderer → main (invoke): a reference's section by a face-parallel plane for the Shape Editor
   * (`ReferenceSectionReply`, U3).
   */
  referenceSection: 'dfyom:reference.section',
  /** Main → renderer: a native application menu item was chosen (`MenuAction`). */
  menuAction: 'dfyom:menu.action',
  /**
   * Renderer → main (invoke): open (or focus) the Library window on a tab / item (`LibraryTarget`),
   * with the asking window's project as its context (docs/conventions/ui-library-window.md).
   */
  libraryOpen: 'dfyom:library.open',
  /** Main → renderer (every window): a library item was added, updated or removed (`LibraryChange`). */
  libraryChanged: 'dfyom:library.changed',
  /** Library window → main (invoke): its context (`LibraryContext`). */
  libraryContext: 'dfyom:library.context',
  /** Main → Library window: its context changed (opened again, the project's library use changed). */
  libraryContextChanged: 'dfyom:library.contextChanged',
  /** Library window → main (send): its unsaved draft and tab (`LibraryWindowState`). */
  libraryState: 'dfyom:library.state',
  /** Main → Library window: closing (or quitting) needs the user's choice about the draft. */
  libraryCloseRequest: 'dfyom:library.closeRequest',
  /** Library window → main (invoke): close now, the draft was saved or discarded. */
  libraryClose: 'dfyom:library.close',
} as const

/** Window argument (`webPreferences.additionalArguments`): which window this is. */
export const WINDOW_KIND_ARG = '--dfyom-window'
/** A project window (the app shell) or the one Library window. */
export type WindowKind = 'project' | 'library'

/** Which tab and item the Library window shows when it is opened. */
export interface LibraryTarget {
  readonly kind?: LibraryItemKind
  readonly itemId?: string
}

/** The project of the window that opened the Library window (L5 units, "Used in this project"). */
export interface LibraryProjectContext {
  readonly key: string
  readonly name: string
  readonly unitSystem: UnitSystem
  /** Library item ids the project uses (its snapshots and plan copies). */
  readonly used: readonly string[]
}

/** What the Library window shows beyond the library itself. Window plumbing, not for agents. */
export interface LibraryContext {
  /** Null when opened from a window without a project, or once that project closed. */
  readonly project: LibraryProjectContext | null
  /** The last open request's tab and item; `seq` grows with every request. */
  readonly target: (LibraryTarget & { readonly seq: number }) | null
  /** The tab to start on (the last one of this app instance). */
  readonly tab: LibraryItemKind
}

/** What the Library window reports to main: its unsaved draft (item name) and tab. */
export interface LibraryWindowState {
  readonly draft: string | null
  readonly tab: LibraryItemKind
}

/** Closing the Library window (or quitting) with a draft: the window asks Save / Discard / Cancel. */
export interface LibraryCloseRequest {
  readonly name: string
  /** The app quits once the window closed. */
  readonly quit: boolean
}

/** The mesh of a done evaluation as the viewport draws it (copied by IPC, ≤ about 1 MB). */
export type EvaluationMesh = Pick<
  PartEvaluation,
  'positions' | 'indices' | 'triangleSurface' | 'surfaces'
>

/**
 * A part's evaluation as a window shows it (docs/architecture/workers.md#evaluation-status):
 * window plumbing like the replica, not an agent capability (agents read `design.warning.list`).
 */
export interface PartEvaluationView {
  /** The project key, so a window drops pushes of a project it no longer shows. */
  readonly key: string
  readonly partId: string
  /**
   * Set for the evaluation of a plan's part (its design snapshot with plan-only edits, drawn by
   * the plan scene: docs/modes/plan-v0.2.md#plan-only-edits-and-the-snapshot-scene); absent for
   * the design's part.
   */
  readonly planId?: string
  readonly status: EvaluationStatus
  /** Hash of the part's geometry input the status is for. */
  readonly inputHash?: string
  /** `done` only. */
  readonly mesh?: EvaluationMesh
  /** `failed` only. */
  readonly error?: AppErrorData
}

/**
 * The triangles of a reference's stored STL for the viewport ghost (task R3,
 * docs/modes/reference-model.md#ghost-mesh-task-r3): 9 float32 per triangle in source units, read
 * once per asset by the worker; the renderer applies the placement itself. `edges` are its feature
 * edges (6 float32 per segment, source units), found by the worker too (U3). Window plumbing like
 * the evaluation push, not an agent capability.
 */
export type ReferenceMeshReply =
  | { readonly ok: true; readonly positions: Float32Array; readonly edges: Float32Array }
  | { readonly ok: false; readonly error: AppErrorData }

/**
 * A reference's section for the Shape Editor (task U3, docs/modes/design-v0.3.md#measure-and-snap):
 * `matrix` (column-major 4 × 4) takes the STL's source units into the face frame (mm), whose third
 * axis is the face normal; the mesh is cut at `w = level` there. The reply's `segments` are
 * `[u0, v0, u1, v1, …]` in the face frame (mm).
 */
export interface ReferenceSectionRequest {
  readonly referenceId: string
  readonly matrix: readonly number[]
  readonly level: number
}

export type ReferenceSectionReply =
  | { readonly ok: true; readonly segments: Float32Array }
  | { readonly ok: false; readonly error: AppErrorData }

/**
 * Native application menu items (docs/conventions/ui.md#app-shell, decision 12); main sends the
 * chosen one to the focused window, which runs it like the matching button or shortcut.
 */
export const MENU_ACTIONS = [
  'project.new',
  'project.open',
  'project.save',
  'project.saveAs',
  'project.apply',
  'edit.undo',
  'edit.redo',
  'mode.design',
  'mode.plan',
  'mode.run',
  'view.navigator',
  'view.inspector',
  'help.shortcuts',
  'app.settings',
] as const
export type MenuAction = (typeof MENU_ACTIONS)[number]

/** Window argument (`webPreferences.additionalArguments`): the settings at window creation. */
export const SETTINGS_ARG = '--dfyom-settings'

/** The result of `call`: the `CommandOutcome`/`QueryOutcome`, or the error as agents see it. */
export type CallReply =
  | { readonly ok: true; readonly value: unknown; readonly revision: number }
  | { readonly ok: false; readonly error: AppErrorData; readonly retryable: boolean }

/** Options of `call`. */
export interface CallOpts {
  /**
   * A step of a live-edit gesture (the field's adjust popover): merged into one undo step with the
   * earlier steps of the same id (docs/architecture/commands.md#gestures-live-edits).
   */
  readonly gesture?: string
}

/** An attached agent session, for the "agent connected" indicator. */
export interface AgentSessionInfo {
  /** `agent:http-2` */
  readonly source: string
  /** MCP client name ("Claude Code"), if known. */
  readonly client?: string
  /** The project it is bound to. */
  readonly key?: string
}

export interface LocalHttpState {
  readonly enabled: boolean
  readonly port?: number
}

/**
 * The bound project as the replica starts from it (docs/conventions/ui.md#document-replica):
 * the document at `revision`, and the action-log `seq` it includes; later events follow.
 */
export interface ProjectSnapshot {
  readonly key: string
  readonly doc: ProjectDoc
  readonly revision: number
  readonly seq: number
  /** `null` until an untitled project is saved. */
  readonly file: string | null
  /** Unsaved changes at `revision`. */
  readonly dirty: boolean
}

/**
 * Closing the last window of a project closes the project; main asks the window when that is
 * refused: unsaved changes (`unsavedChanges`, confirm to close) or another error (e.g. a run).
 */
export type WindowCloseRequest =
  | { readonly kind: 'unsavedChanges'; readonly name: string }
  | { readonly kind: 'refused'; readonly error: AppErrorData }

/**
 * Which window shows the project after `window.openProject` (docs/conventions/ui.md#project-files):
 * the asking window, another window already showing it (brought to the front), or a new window.
 */
export type OpenedWindow = 'this' | 'other' | 'new'

export interface PreloadApi {
  /** Which window this is (window argument `--dfyom-window`; `project` when absent). */
  readonly windowKind: WindowKind
  readonly versions: {
    readonly electron: string
    readonly chrome: string
    readonly node: string
  }
  /**
   * Renderer log forwarding to main (diagnostics plumbing, not a user capability).
   * Doc: docs/conventions/logging.md#port-and-helpers
   */
  readonly log: {
    /** Instance level; the renderer forwards every entry at or above it. */
    readonly level: LogLevel
    /** Fire-and-forget; main validates the batch and writes it to the log file. */
    send(batch: readonly LogRecord[]): void
  }
  /**
   * Run mode (docs/modes/run-v0.1.md#status): the machine status main mirrors, pushed on every
   * change. Agents read the same with the `run.status.get` query.
   */
  readonly run: {
    /** Returns the unsubscribe function. */
    onStatus(listener: (status: RunStatus) => void): () => void
  }
  /**
   * One command, query or session tool by registry name, through this window's session (the same
   * routing and results as MCP: `project.open` binds the window, project tools act on it).
   */
  call(name: string, args?: unknown, opts?: CallOpts): Promise<CallReply>
  readonly project: {
    /** Action-log events of the window's bound project, patches included (replica). */
    onEvent(listener: (event: ActionEvent) => void): () => void
    /** The bound project's document (replica start), or null when the window has none. */
    snapshot(): Promise<ProjectSnapshot | null>
    /** The window's bound project changed (bound, closed, reopened): take a new snapshot. */
    onBound(listener: (key: string | null) => void): () => void
  }
  /** The "agent connected" indicator and the local HTTP state (setting: `settings`). */
  readonly agents: {
    list(): Promise<readonly AgentSessionInfo[]>
    onSessions(listener: (sessions: readonly AgentSessionInfo[]) => void): () => void
    localHttp(): Promise<LocalHttpState>
  }
  /**
   * App settings (docs/conventions/ui.md#settings): GUI preferences owned by main, mirrored by
   * every window. Not an agent capability: agents must not change their own access.
   */
  readonly settings: {
    /** The settings when the window was created (applied before the first render). */
    readonly initial: AppSettings | undefined
    /** Applies a patch; the reply's value is the new settings. */
    update(patch: AppSettingsPatch): Promise<CallReply>
    onChange(listener: (settings: AppSettings) => void): () => void
  }
  /**
   * Part evaluations of the window's project for the viewport (renderer mesh push and query;
   * docs/architecture/workers.md#transferred-vs-cloned). Window plumbing, not for agents.
   */
  readonly evaluation: {
    get(partId: string): Promise<PartEvaluationView | null>
    /** The evaluation of the plan's part (snapshot scene), or null. */
    getPlan(planId: string): Promise<PartEvaluationView | null>
    onChange(listener: (view: PartEvaluationView) => void): () => void
  }
  /**
   * Native file dialogs for New / Open / Save (docs/conventions/ui.md#project-files) and the gCode
   * export (task 3.7). The renderer then calls `project.open` / `project.save` / `plan.export`
   * with the path, as an agent passes one.
   */
  readonly files: {
    chooseOpen(): Promise<string | null>
    /** `defaultName` without extension; the path ends in `.dfyom`. */
    chooseSave(defaultName: string): Promise<string | null>
    /** `defaultName` without extension; the path ends in `.nc`, `.gcode` or `.ngc`. */
    chooseExport(defaultName: string): Promise<string | null>
    /** An STL to import as a reference (R3); the window then calls `design.reference.import`. */
    chooseReference(): Promise<string | null>
    /** An SVG to import as shapes (I1); the window then calls `design.shape.import`. */
    chooseSvg(): Promise<string | null>
  }
  /** Reference models of the window's project: the ghost's triangles (R3), a section (U3). */
  readonly reference: {
    mesh(referenceId: string): Promise<ReferenceMeshReply>
    section(request: ReferenceSectionRequest): Promise<ReferenceSectionReply>
  }
  /**
   * The Library window (docs/conventions/ui-library-window.md): window plumbing around the
   * `library.*` commands, which every window calls with `call` like agents do.
   */
  readonly library: {
    /** Opens or focuses the Library window on a tab / item, with this window's project. */
    open(target?: LibraryTarget): Promise<void>
    /** Library writes by anyone (this instance's windows, agents). */
    onChanged(listener: (change: LibraryChange) => void): () => void
    /** Library window: its context. */
    context(): Promise<LibraryContext>
    onContext(listener: (context: LibraryContext) => void): () => void
    /** Library window: reports its draft (guards closing and quitting) and tab. */
    report(state: LibraryWindowState): void
    onCloseRequest(listener: (request: LibraryCloseRequest) => void): () => void
    /**
     * Library window: closes it (the draft was saved or discarded); `quit` passes on a close
     * request's `quit`, so the app quits once it closed.
     */
    close(quit?: boolean): Promise<void>
  }
  /** The native application menu's items for this window. */
  readonly menu: {
    onAction(listener: (action: MenuAction) => void): () => void
  }
  /** This window's lifecycle (closing a project with its last window). */
  readonly window: {
    onCloseRequest(listener: (request: WindowCloseRequest) => void): () => void
    /** Closes the window and its project; `confirm` closes with unsaved changes (recoverable). */
    close(confirm: boolean): Promise<CallReply>
    /**
     * New / Open / Restore (docs/conventions/ui.md#project-files): runs `project.open`,
     * `project.create` or `project.recovery.resolve` in the window that should show the project
     * (this one when it has none, the one already showing the file, else a new window). The
     * reply is the command's; on success its value also has `window: OpenedWindow`.
     */
    openProject(
      name: 'project.open' | 'project.create' | 'project.recovery.resolve',
      args: unknown,
    ): Promise<CallReply>
  }
}

declare global {
  interface Window {
    readonly dfyom: PreloadApi
  }
}
