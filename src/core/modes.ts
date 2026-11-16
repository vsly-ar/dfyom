/**
 * The three top-level app modes. Specs: docs/modes/design.md, docs/modes/plan.md, docs/modes/run.md
 *
 * src/core is headless domain logic: no Electron, DOM or Node-only APIs, so it can run in the
 * renderer, the main process, workers, a CLI and tests alike (docs/architecture/overview.md).
 */
export const APP_MODES = ['design', 'plan', 'run'] as const

export type AppMode = (typeof APP_MODES)[number]

export function isAppMode(value: string): value is AppMode {
  return (APP_MODES as readonly string[]).includes(value)
}
