/**
 * Contract of the API the preload script exposes to the renderer as `window.dfyom`.
 * Implemented in src/preload/index.ts. Design: docs/architecture/overview.md#ipc
 *
 * Keep this surface small and typed; every capability added here must also be
 * reachable by LLM agents (docs/architecture/llm-api.md).
 */
export interface PreloadApi {
  readonly versions: {
    readonly electron: string
    readonly chrome: string
    readonly node: string
  }
}

declare global {
  interface Window {
    readonly dfyom: PreloadApi
  }
}
