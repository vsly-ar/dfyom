/**
 * Test-only Node host for `loadManifold`: reads `manifold.wasm` from node_modules and passes
 * the binary in, as the worker hosts will (task 2.9). Node modules are reached through
 * `process.getBuiltinModule` so `src/core` keeps no Node imports
 * (docs/architecture/geometry.md#wasm-lifetime-and-ownership).
 */
import type { ManifoldWasmSource } from '../manifold'

interface NodeProcess {
  getBuiltinModule(id: 'node:fs'): { readFileSync(path: string): Uint8Array }
  getBuiltinModule(id: 'node:module'): {
    createRequire(from: string): { resolve(id: string): string }
  }
}

export function nodeManifoldSource(): ManifoldWasmSource {
  const proc = (globalThis as unknown as { process: NodeProcess }).process
  const require = proc.getBuiltinModule('node:module').createRequire(import.meta.url)
  const path = require.resolve('manifold-3d/manifold.wasm')
  return { wasmBinary: proc.getBuiltinModule('node:fs').readFileSync(path) }
}
