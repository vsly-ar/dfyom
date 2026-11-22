// Library writes seen by this window (`window.dfyom.library.onChanged`: the Library window, another
// window, an agent): a version that grows with each, so whatever shows library data re-reads it
// (tool candidates, the machine and tool pickers, the plan's stale notices), and the pending set
// is refreshed (a library edit is pending in projects whose draft plans copy it).
// Doc: docs/conventions/ui-library-window.md#behaviour-with-projects
import type { LibraryChange } from '../../../core/library/library'
import type { PreloadApi } from '../../../shared/preload-api'

export interface LibraryChanges {
  readonly subscribe: (listener: () => void) => () => void
  /** Grows by one with every library write. */
  readonly getState: () => number
  /** The last write, if any. */
  readonly last: () => LibraryChange | undefined
  /** Follows main's pushes; `onChange` runs after each (the pending refresh). Returns the stop. */
  start(onChange?: () => void): () => void
}

export function createLibraryChanges(bridge: PreloadApi): LibraryChanges {
  let version = 0
  let last: LibraryChange | undefined
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    getState: () => version,
    last: () => last,
    start(onChange) {
      return bridge.library.onChanged((change) => {
        version += 1
        last = change
        for (const l of [...listeners]) l()
        onChange?.()
      })
    },
  }
}
