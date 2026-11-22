// Node host of the compute workers: `worker_threads` as a `WorkerFactory`, the WASM bytes, and
// the pool with log forwarding. Same code in the app (Electron main) and headless/CLI.
// Doc: docs/architecture/workers.md#hosting, #wasm-lifetime
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { createWorkerPool, type WorkerFactory, type WorkerPool } from '../../core/workers/pool'
import type { LogLevel, Logger } from '../../shared/logging'
import type { ForwardReceiver } from '../logging/forward'

/** Caps a runaway JS heap in a worker; WASM memory is not covered (watched by heap stats). */
export const WORKER_MAX_OLD_GENERATION_MB = 1_024

/** `worker_threads` workers running `entryPath` (a bundled `.js`/`.mjs` worker entry). */
export function nodeWorkerFactory(entryPath: string): WorkerFactory {
  return ({ workerId }, events) => {
    const worker = new Worker(entryPath, {
      name: workerId,
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_GENERATION_MB },
    })
    worker.on('message', (m: unknown) => events.message(m))
    worker.on('error', (e) => events.error(e))
    worker.on('messageerror', (e) => events.error(e))
    worker.on('exit', (code) => events.exit(code))
    return {
      post: (message, transfer) =>
        worker.postMessage(message, transfer === undefined ? [] : [...transfer]),
      terminate: () => void worker.terminate(),
      setIdle: (idle) => (idle ? worker.unref() : worker.ref()),
    }
  }
}

/** `manifold.wasm` from the installed package; read once, kept for restarts. */
export function readManifoldWasm(): ArrayBuffer {
  const path = createRequire(import.meta.url).resolve('manifold-3d/manifold.wasm')
  const bytes = readFileSync(path)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export interface NodePoolOptions {
  readonly entryPath: string
  readonly log: Logger
  readonly logLevel: LogLevel
  /** Writes forwarded worker log batches (`createForwardReceiver`); absent = dropped. */
  readonly forward?: ForwardReceiver
  /** `cavalier_contours.wasm` for both lanes (the 2D port; src/main/region2d/node.ts). */
  readonly region2dWasm?: ArrayBuffer
}

/** The app-wide pool of one process; `terminate()` it on app quit or CLI exit. */
export function createNodeWorkerPool(o: NodePoolOptions): WorkerPool {
  let wasm: ArrayBuffer | undefined
  return createWorkerPool({
    factory: nodeWorkerFactory(o.entryPath),
    log: o.log,
    logLevel: o.logLevel,
    wasm: () => (wasm ??= readManifoldWasm()),
    region2dWasm: () => o.region2dWasm,
    onLog: (batch, { worker }) => void o.forward?.(batch, { proc: 'worker', worker }),
  })
}
