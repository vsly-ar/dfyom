/**
 * Test-only Node host of the 2D port: reads the vendored `cavalier_contours.wasm` and loads it
 * synchronously, as the dispatcher hosts do. Node modules are reached through
 * `process.getBuiltinModule` so `src/core` keeps no Node imports (as geometry/testing/node-wasm.ts).
 */
import type { Region2dPort } from '../port'
import { loadRegion2dSync } from '../cavalier'

interface NodeProcess {
  getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL): Uint8Array }
}

/** The vendored module's bytes (vendor/cavalier-contours/, docs/architecture/shapes.md#2d-port). */
export function nodeCavalierWasm(): Uint8Array {
  const proc = (globalThis as unknown as { process: NodeProcess }).process
  const url = new URL(
    '../../../../../vendor/cavalier-contours/cavalier_contours.wasm',
    import.meta.url,
  )
  return proc.getBuiltinModule('node:fs').readFileSync(url)
}

/** A port on a fresh instance of the vendored module. */
export function nodeRegion2d(): Region2dPort {
  return loadRegion2dSync(nodeCavalierWasm()).expect('the vendored 2D module loads')
}
