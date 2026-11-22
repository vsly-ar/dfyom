// The reference ghosts' triangles of one window (task R3): read once per asset through the bridge
// (main runs the worker's STL read and copies the positions once) and kept by the asset's sha256,
// so placement edits, undo and visibility toggles never fetch again; an asset no reference uses
// any more is dropped. Doc: docs/modes/reference-model.md#ghost-mesh-task-r3
import type { AppErrorData } from '../../../shared/errors/app-error'
import type { PreloadApi } from '../../../shared/preload-api'

export type ReferenceMeshEntry =
  | { readonly status: 'loading' }
  | { readonly status: 'done'; readonly positions: Float32Array; readonly edges: Float32Array }
  | { readonly status: 'failed'; readonly error: AppErrorData }

export interface ReferenceMeshes {
  /** The entry of an asset, or undefined if never requested. */
  get(sha256: string): ReferenceMeshEntry | undefined
  /** Starts reading the asset through `referenceId` unless it is cached or in flight. */
  request(sha256: string, referenceId: string): void
  /** Drops every asset not in `keep` (references removed or the project changed). */
  retain(keep: ReadonlySet<string>): void
  subscribe(listener: () => void): () => void
  /** Changes on every entry change (for `useSyncExternalStore`). */
  version(): number
}

export function createReferenceMeshes(bridge: Pick<PreloadApi, 'reference'>): ReferenceMeshes {
  const entries = new Map<string, ReferenceMeshEntry>()
  const listeners = new Set<() => void>()
  let version = 0
  const changed = () => {
    version++
    for (const l of [...listeners]) l()
  }
  return {
    get: (sha) => entries.get(sha),
    request(sha, referenceId) {
      if (entries.has(sha)) return
      entries.set(sha, { status: 'loading' })
      changed()
      void bridge.reference.mesh(referenceId).then(
        (r) => {
          // dropped meanwhile (`retain`): a later request starts over
          if (entries.get(sha)?.status !== 'loading') return
          entries.set(
            sha,
            r.ok
              ? { status: 'done', positions: r.positions, edges: r.edges }
              : { status: 'failed', error: r.error },
          )
          changed()
        },
        (e: unknown) => {
          if (entries.get(sha)?.status !== 'loading') return
          const message = e instanceof Error ? e.message : String(e)
          entries.set(sha, {
            status: 'failed',
            error: { code: 'internal.unexpected', message, issues: [], frames: [] },
          })
          changed()
        },
      )
    },
    retain(keep) {
      let dropped = false
      for (const sha of [...entries.keys()])
        if (!keep.has(sha)) {
          entries.delete(sha)
          dropped = true
        }
      if (dropped) changed()
    },
    subscribe(l) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    version: () => version,
  }
}
