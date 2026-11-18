/**
 * Contract of the API the preload script exposes to the renderer as `window.dfyom`.
 * Implemented in src/preload/index.ts. Design: docs/architecture/overview.md#ipc
 *
 * Keep this surface small and typed; every capability added here must also be
 * reachable by LLM agents (docs/architecture/llm-api.md).
 */
import type { RunStatus } from '../core/run/service'
import type { LogLevel, LogRecord } from './logging'

/** Main → renderer push of the machine status (docs/modes/run-v0.1.md#status). */
export const RUN_STATUS_IPC_CHANNEL = 'dfyom:run.status'

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
}

declare global {
  interface Window {
    readonly dfyom: PreloadApi
  }
}
