/**
 * Contract of the API the preload script exposes to the renderer as `window.dfyom`.
 * Implemented in src/preload/index.ts. Design: docs/architecture/overview.md#ipc
 *
 * Keep this surface small and typed; every capability added here must also be
 * reachable by LLM agents (docs/architecture/llm-api.md).
 */
import type { ActionEvent } from '../core/commands/action-log'
import type { ProjectDoc } from '../core/project/document'
import type { RunStatus } from '../core/run/service'
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
} as const

/** Window argument (`webPreferences.additionalArguments`): the settings at window creation. */
export const SETTINGS_ARG = '--dfyom-settings'

/** The result of `call`: the `CommandOutcome`/`QueryOutcome`, or the error as agents see it. */
export type CallReply =
  | { readonly ok: true; readonly value: unknown; readonly revision: number }
  | { readonly ok: false; readonly error: AppErrorData; readonly retryable: boolean }

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

export interface PreloadApi {
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
  call(name: string, args?: unknown): Promise<CallReply>
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
  /** This window's lifecycle (closing a project with its last window). */
  readonly window: {
    onCloseRequest(listener: (request: WindowCloseRequest) => void): () => void
    /** Closes the window and its project; `confirm` closes with unsaved changes (recoverable). */
    close(confirm: boolean): Promise<CallReply>
  }
}

declare global {
  interface Window {
    readonly dfyom: PreloadApi
  }
}
