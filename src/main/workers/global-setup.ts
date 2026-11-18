// Vitest global setup: bundles the test worker entry, the production worker entry, the machine
// host entry and the CLI test entry with Vite's build API into temp `.mjs` files,
// because a worker thread cannot load the TypeScript sources directly. Tests read its path with
// `inject('workerEntry')`. Doc: docs/architecture/workers.md#testing
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
    /** The production compute worker entry (src/main/workers/entry.ts). */
    productionWorkerEntry: string
    /**
     * The CLI (src/main/cli/test-entry.ts; worker entries from `DFYOM_TEST_*` env vars), built
     * into `node_modules/.cache` so its external dependencies resolve. Docs: llm-api.md#testing
     */
    cliEntry: string
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
  await build({
    configFile: false,
    logLevel: 'warn',
    ssr: { noExternal: true },
    build: {
      ssr: resolve(import.meta.dirname, 'entry.ts'),
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'node22',
      rollupOptions: {
        external: (id) => id.startsWith(manifoldDir),
        output: { format: 'es', entryFileNames: 'worker-entry.mjs' },
      },
    },
  })
  // Dependencies stay external (pino, the MCP SDK, manifold's wasm lookup): the bundle lives
  // under node_modules/.cache so Node resolves them from the repo's node_modules.
  const cacheDir = resolve(import.meta.dirname, '../../../node_modules/.cache')
  mkdirSync(cacheDir, { recursive: true })
  const cliDir = mkdtempSync(join(cacheDir, 'dfyom-cli-test-'))
  await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      ssr: resolve(import.meta.dirname, '../cli/test-entry.ts'),
      outDir: cliDir,
      emptyOutDir: false,
      minify: false,
      target: 'node22',
      rollupOptions: { output: { format: 'es', entryFileNames: 'cli.mjs' } },
    },
  })
  project.provide('workerEntry', join(outDir, 'test-entry.mjs'))
  project.provide('machineEntry', join(outDir, 'machine-entry.mjs'))
  project.provide('productionWorkerEntry', join(outDir, 'worker-entry.mjs'))
  project.provide('cliEntry', join(cliDir, 'cli.mjs'))
  return () => {
    rmSync(outDir, { recursive: true, force: true })
    rmSync(cliDir, { recursive: true, force: true })
  }
}
