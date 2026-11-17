/**
 * Contract of the API the preload script exposes to the renderer as `window.dfyom`.
 * Implemented in src/preload/index.ts. Design: docs/architecture/overview.md#ipc
 *
 * Keep this surface small and typed; every capability added here must also be
 * reachable by LLM agents (docs/architecture/llm-api.md).
 */
import type { LogLevel, LogRecord } from './logging'

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
}

declare global {
  interface Window {
    readonly dfyom: PreloadApi
  }
}
