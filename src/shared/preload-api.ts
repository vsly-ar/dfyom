/**
 * Contract of the API the preload script exposes to the renderer as `window.dfyom`.
 * Implemented in src/preload/index.ts. Design: docs/architecture/overview.md#ipc
 *
 * Keep this surface small and typed; every capability added here must also be
 * reachable by LLM agents (docs/architecture/llm-api.md).
 */
import type { ActionEvent } from '../core/commands/action-log'
import type { RunStatus } from '../core/run/service'
import type { AppErrorData } from './errors/app-error'
import type { LogLevel, LogRecord } from './logging'

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
  /** Renderer → main (invoke): local HTTP state / switch it (the setting, task 3.3 persists it). */
  localHttpGet: 'dfyom:agents.localHttp.get',
  localHttpSet: 'dfyom:agents.localHttp.set',
} as const

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
  }
  /** The "agent connected" indicator and the local HTTP setting (UI: task 3.3). */
  readonly agents: {
    list(): Promise<readonly AgentSessionInfo[]>
    onSessions(listener: (sessions: readonly AgentSessionInfo[]) => void): () => void
    localHttp(): Promise<LocalHttpState>
    setLocalHttp(enabled: boolean): Promise<CallReply>
  }
}

declare global {
  interface Window {
    readonly dfyom: PreloadApi
  }
}
