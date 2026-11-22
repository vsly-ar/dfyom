// The renderer's 2D port (sketch preview, snapping, live offsets: K3). The module is inlined into
// the bundle as a base64 data URL (`?url&inline`: Vite 8 has no .wasm asset type, so a plain
// `?inline` fails), so loading needs no fetch of a file:// URL, and it is compiled asynchronously: Chromium refuses synchronous compiles over 4 KiB on the main thread.
// The CSP allows it with 'wasm-unsafe-eval' (index.html).
// Doc: docs/architecture/shapes.md#where-the-2d-layer-runs
import wasmUrl from '../../../vendor/cavalier-contours/cavalier_contours.wasm?url&inline'
import { loadRegion2d } from '../../core/geometry/2d/cavalier'
import type { Region2dPort } from '../../core/geometry/2d/port'
import { logAppError, type Logger } from '../../shared/logging'
import { Err, tryCatch, type AppResult } from '../../shared/result'

/** Decodes a `data:…;base64,` URL into its bytes. */
export function dataUrlBytes(url: string): AppResult<Uint8Array> {
  return tryCatch(
    () => {
      const comma = url.indexOf(',')
      if (comma < 0 || !url.slice(0, comma).endsWith(';base64')) throw new Error('not base64')
      const text = atob(url.slice(comma + 1))
      const bytes = new Uint8Array(text.length)
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
      return bytes
    },
    'internal.unexpected',
    'the inlined 2D library module is not a base64 data URL',
  )
}

let loading: Promise<AppResult<Region2dPort>> | undefined

/** Loads the port once per window; logs the outcome (renderer logs reach the main log file). */
export function rendererRegion2d(log: Logger): Promise<AppResult<Region2dPort>> {
  loading ??= (async () => {
    const t0 = performance.now()
    const bytes = dataUrlBytes(wasmUrl)
    const port = bytes.isOk() ? await loadRegion2d(bytes.unwrap()) : Err(bytes.unwrapErr())
    if (port.isOk()) log.info({ ms: performance.now() - t0 }, '2D geometry loaded')
    else logAppError(log, port.unwrapErr(), { kind: 'system', name: 'renderer.region2d' })
    return port
  })()
  return loading
}
