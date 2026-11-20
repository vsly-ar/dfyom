// The window's read replica of its bound project: a snapshot from main, then the action-log
// patch stream; resynchronizes on a gap, a binding change or a patch that does not apply. The UI
// reads it with `useSyncExternalStore` and sends every change as a command.
// Doc: docs/conventions/ui.md#document-replica, docs/architecture/commands.md#project-state
import type { ActionEvent } from '../../../core/commands/action-log'
import { applyDocPatches } from '../../../core/commands/history'
import type { ProjectDoc } from '../../../core/project/document'
import type { PreloadApi, ProjectSnapshot } from '../../../shared/preload-api'

export type ReplicaState =
  /** No project bound to the window. */
  | { readonly status: 'none' }
  /** The first snapshot is on its way. */
  | { readonly status: 'loading' }
  | {
      readonly status: 'open'
      readonly key: string
      readonly doc: ProjectDoc
      readonly revision: number
      /** Last applied action-log seq. */
      readonly seq: number
      readonly file: string | null
      /** Revision of the last save; -1 = unsaved changes since the snapshot. */
      readonly savedRevision: number
    }

export type OpenReplica = Extract<ReplicaState, { status: 'open' }>

export function isDirty(s: OpenReplica): boolean {
  return s.revision !== s.savedRevision
}

export interface Replica {
  getState(): ReplicaState
  subscribe(listener: () => void): () => void
  /** Every action-log event of the bound project, after the replica applied it. */
  onEvent(listener: (event: ActionEvent) => void): () => void
  /** Starts following the bridge; returns the stop function. */
  start(): () => void
}

const NONE: ReplicaState = { status: 'none' }
const LOADING: ReplicaState = { status: 'loading' }

function fromSnapshot(s: ProjectSnapshot): OpenReplica {
  return {
    status: 'open',
    key: s.key,
    doc: s.doc,
    revision: s.revision,
    seq: s.seq,
    file: s.file,
    savedRevision: s.dirty ? -1 : s.revision,
  }
}

/** Applies one event in sequence; `undefined` = it does not fit (resync). */
function apply(s: OpenReplica, e: ActionEvent): OpenReplica | undefined {
  let doc = s.doc
  if ((e.type === 'command' || e.type === 'undo' || e.type === 'redo') && e.patches?.length) {
    const next = applyDocPatches(doc, e.patches)
    if (next.isErr()) return undefined
    doc = next.unwrap()
  }
  const saved = e.type === 'command' && e.name === 'project.save' && e.outcome.ok
  return {
    ...s,
    doc,
    revision: e.revision,
    seq: e.seq,
    savedRevision: saved ? e.revision : s.savedRevision,
  }
}

export function createReplica(bridge: Pick<PreloadApi, 'project'>): Replica {
  let state: ReplicaState = LOADING
  const listeners = new Set<() => void>()
  const eventListeners = new Set<(e: ActionEvent) => void>()
  /** Generation of the latest snapshot request; older answers are dropped. */
  let generation = 0
  /** A snapshot is on its way: events wait in `buffer` until it arrives. */
  let loading = false
  let buffer: ActionEvent[] = []

  const set = (next: ReplicaState) => {
    if (next === state) return
    state = next
    for (const l of [...listeners]) l()
  }

  /** Applies and announces an event in sequence; a gap or a misfit resynchronizes. */
  const deliver = (e: ActionEvent): void => {
    if (state.status !== 'open' || e.seq <= state.seq) return
    const next = e.seq === state.seq + 1 ? apply(state, e) : undefined
    if (next === undefined) {
      resync()
      return
    }
    set(next)
    for (const l of [...eventListeners]) l(e)
  }

  const resync = (): void => {
    const g = ++generation
    loading = true
    buffer = []
    if (state.status === 'none') set(LOADING)
    bridge.project.snapshot().then(
      (snap) => {
        if (g !== generation) return
        loading = false
        const pending = buffer
        buffer = []
        set(snap === null ? NONE : fromSnapshot(snap))
        for (const e of pending) {
          if (loading) break // an event did not fit and started another resync
          deliver(e)
        }
      },
      () => {
        if (g !== generation) return
        loading = false
        buffer = []
        set(NONE)
      },
    )
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    onEvent(listener) {
      eventListeners.add(listener)
      return () => void eventListeners.delete(listener)
    },
    start() {
      const offEvent = bridge.project.onEvent((e) => {
        if (loading) buffer.push(e)
        else deliver(e)
      })
      const offBound = bridge.project.onBound(() => resync())
      resync()
      return () => {
        generation++
        loading = false
        offEvent()
        offBound()
      }
    },
  }
}
