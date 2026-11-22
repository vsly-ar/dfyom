// Node host of the 2D port: reads the vendored `cavalier_contours.wasm` once and loads it
// synchronously for the dispatcher (app and CLI); the same bytes go to the worker lanes.
// Doc: docs/architecture/shapes.md#where-the-2d-layer-runs
import { readFileSync } from 'node:fs'
import { loadRegion2dSync } from '../../core/geometry/2d/cavalier'
import type { Region2dPort } from '../../core/geometry/2d/port'
import type { Logger } from '../../shared/logging'
import { tryCatch, type AppResult } from '../../shared/result'

export interface HostRegion2d {
  /** The dispatcher's port (`services.region2d`). */
  readonly port: Region2dPort
  /** The module's bytes, for the worker lanes (cloned into each worker's `init`). */
  readonly wasm: ArrayBuffer
}

/** Reads and loads the module at `path`; a failure is a build bug (the file ships with the app). */
export function loadHostRegion2d(path: string, log: Logger): AppResult<HostRegion2d> {
  const t0 = performance.now()
  return tryCatch(
    () => {
      const bytes = readFileSync(path)
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer
    },
    'persist.io',
    'the 2D library module could not be read',
  )
    .mapErr((e) => e.withContext('loadHostRegion2d', { path }))
    .andThen((wasm) =>
      loadRegion2dSync(wasm).map((port) => {
        log.info({ ms: performance.now() - t0, bytes: wasm.byteLength }, '2D geometry loaded')
        return { port, wasm }
      }),
    )
}
