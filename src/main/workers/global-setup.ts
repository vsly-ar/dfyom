// Vitest global setup: bundles the test worker entry and the machine host entry with Vite's build
// API into temp `.mjs` files,
// because a worker thread cannot load the TypeScript sources directly. Tests read its path with
// `inject('workerEntry')`. Doc: docs/architecture/workers.md#testing
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'vite'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    workerEntry: string
    /** The machine host's `worker_threads` entry (src/main/machine/node-worker.ts). */
    machineEntry: string
  }
}

export default async function setup(project: TestProject): Promise<() => void> {
  const outDir = mkdtempSync(join(tmpdir(), 'dfyom-workers-'))
  // manifold-3d stays external (its glue locates nothing: the host passes the bytes), imported
  // by absolute path so the bundle needs no node_modules next to it
  const manifold = createRequire(import.meta.url).resolve('manifold-3d/manifold.js')
  const manifoldDir = dirname(manifold)
  await build({
    configFile: false,
    logLevel: 'warn',
    ssr: { noExternal: true },
    build: {
      ssr: resolve(import.meta.dirname, 'test-entry.ts'),
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'node22',
      rollupOptions: {
        external: (id) => id.startsWith(manifoldDir),
        output: { format: 'es', entryFileNames: 'test-entry.mjs' },
      },
    },
  })
  await build({
    configFile: false,
    logLevel: 'warn',
    ssr: { noExternal: true },
    build: {
      ssr: resolve(import.meta.dirname, '../machine/node-worker.ts'),
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'node22',
      rollupOptions: { output: { format: 'es', entryFileNames: 'machine-entry.mjs' } },
    },
  })
  project.provide('workerEntry', join(outDir, 'test-entry.mjs'))
  project.provide('machineEntry', join(outDir, 'machine-entry.mjs'))
  return () => rmSync(outDir, { recursive: true, force: true })
}
