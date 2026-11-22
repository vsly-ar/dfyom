// The window's view of Apply (task P3): the bound project's pending changes (`project.pending.get`,
// re-read after every action-log event, binding change and window focus), the running apply jobs, this window's
// Apply call and its failure, and "Applied by …" after another source applied. `apply()` sends
// `project.apply`; it is sent after the commit it follows (one IPC channel, one project queue,
// both FIFO), so Enter in a field applies the value it just committed. It also keeps the last
// automatic tool change per operation from every source's Apply (`toolChanges` of the
// `project.apply` events), for the tool field's "Chosen automatically: …" (task F5).
// Doc: docs/architecture/apply.md#ui, docs/conventions/ui.md#app-shell,
// docs/modes/design-v0.2.md#implementation-task-f5
import type { ActionEvent } from '../../../core/commands/action-log'
import type { ToolChange } from '../../../core/commands/apply'
import type { AppErrorData } from '../../../shared/errors/app-error'
import type { PreloadApi } from '../../../shared/preload-api'
import type { Replica } from './replica'

/** One pending change as `project.pending.get` lists it. */
export interface PendingChangeView {
  readonly kind: 'design' | 'plan' | 'library'
  readonly partId?: string
  readonly operationId?: string
  /** A named shape of the part (design keys of shapes). */
  readonly shapeId?: string
  readonly planId?: string
  readonly field?: string
  /** "Pocket 1: depth", "Drilling 2 added" (core label). */
  readonly label: string
  readonly source: { readonly kind: string; readonly id: string }
  readonly revision: number
}

/** An automatic tool change of an Apply, with the old tool's name when it was a library tool. */
export interface ToolChangeView extends ToolChange {
  /** Name of the replaced specific tool (its snapshot may be gone after the Apply). */
  readonly fromName?: string
}

interface PendingAnswer {
  readonly count: number
  readonly changes: readonly PendingChangeView[]
  readonly applying: readonly string[]
  readonly lastApply: { readonly at: string; readonly revision: number } | null
}

export interface PendingState {
  /** False without a bound project (or before the first answer). */
  readonly known: boolean
  readonly count: number
  readonly changes: readonly PendingChangeView[]
  /** Running apply jobs (toolpaths). */
  readonly applying: readonly string[]
  /** This window's `project.apply` is on its way. */
  readonly sending: boolean
  /** Why this window's last Apply failed; cleared by a later Apply or when nothing is pending. */
  readonly error: AppErrorData | null
  /** This window's last Apply succeeded and nothing is pending since (announced). */
  readonly applied: boolean
  /** Source kind of another source's Apply that just applied changes ("agent"), for 2 s. */
  readonly appliedBy: string | null
  /** Bumped whenever the pending answer changes: tag for re-reading `pendingApply` flags. */
  readonly version: number
  /**
   * The last automatic tool change of each operation (any source's Apply since the project was
   * bound in this window), keyed `partId:operationId`.
   */
  readonly toolChanges: ReadonlyMap<string, ToolChangeView>
}

/** Key of `PendingState.toolChanges`. */
export const toolChangeKey = (partId: string, operationId: string): string =>
  `${partId}:${operationId}`

export interface PendingStore {
  getState(): PendingState
  subscribe(listener: () => void): () => void
  /** Applies every pending change of the project (`project.apply`). */
  apply(): Promise<void>
  /** Re-reads the pending changes (a library edit changes them without a project event). */
  refresh(): void
  /** Starts following the replica; returns the stop function. */
  start(): () => void
}

/** How long "Applied by agent" shows (apply.md § Apply button). */
export const APPLIED_BY_MS = 2000

const EMPTY: PendingState = {
  known: false,
  count: 0,
  changes: [],
  applying: [],
  sending: false,
  error: null,
  applied: false,
  appliedBy: null,
  version: 0,
  toolChanges: new Map(),
}

/** Another source's `project.apply` that applied something (not a window's own). */
function appliedByOther(e: ActionEvent): string | null {
  if (e.type !== 'command' || e.name !== 'project.apply' || !e.outcome.ok) return null
  if (e.source.kind === 'ui') return null
  const changes = (e.outcome.value as { changes?: unknown } | undefined)?.changes
  return typeof changes === 'number' && changes > 0 ? e.source.kind : null
}

/** The tool changes of a successful `project.apply` event (none for other events). */
function toolChangesOf(e: ActionEvent): readonly ToolChange[] {
  if (e.type !== 'command' || e.name !== 'project.apply' || !e.outcome.ok) return []
  const changes = (e.outcome.value as { toolChanges?: unknown } | undefined)?.toolChanges
  return Array.isArray(changes) ? (changes as ToolChange[]) : []
}

export function createPending(
  bridge: Pick<PreloadApi, 'call'>,
  replica: Pick<Replica, 'getState' | 'subscribe' | 'onEvent'>,
): PendingStore {
  let state = EMPTY
  const listeners = new Set<() => void>()
  let key: string | undefined
  /** A read is on its way; `again`: something changed meanwhile, read once more after it. */
  let reading = false
  let again = false
  let appliedTimer: ReturnType<typeof setTimeout> | undefined
  /** Names of the tool snapshots seen in this window (a replaced one is gone after the Apply). */
  const toolNames = new Map<string, string>()
  let seenSnapshots: object | undefined
  const learnToolNames = () => {
    const s = replica.getState()
    if (s.status !== 'open' || s.doc.snapshots === seenSnapshots) return
    seenSnapshots = s.doc.snapshots
    for (const snap of Object.values(s.doc.snapshots)) {
      const name = (snap.values as { name?: unknown }).name
      if (snap.kind === 'tool' && typeof name === 'string') toolNames.set(snap.id, name)
    }
  }

  const set = (patch: Partial<PendingState>) => {
    state = { ...state, ...patch }
    for (const l of [...listeners]) l()
  }

  const same = (a: PendingAnswer) =>
    a.count === state.count &&
    a.applying.length === state.applying.length &&
    a.applying.every((id, i) => state.applying[i] === id) &&
    a.changes.every((c, i) => state.changes[i]?.label === c.label)

  const read = (): void => {
    if (key === undefined) return
    if (reading) {
      again = true
      return
    }
    reading = true
    const asked = key
    void bridge.call('project.pending.get', {}).then((r) => {
      reading = false
      if (asked === key && r.ok) {
        const a = r.value as PendingAnswer
        const changed = !state.known || !same(a)
        set({
          known: true,
          count: a.count,
          changes: a.changes,
          applying: a.applying,
          ...(a.count === 0 ? { error: null } : { applied: false }),
          ...(changed ? { version: state.version + 1 } : {}),
        })
      }
      if (again) {
        again = false
        read()
      }
    })
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    async apply() {
      if (key === undefined) return
      set({ sending: true })
      const r = await bridge.call('project.apply', {})
      set({ sending: false, error: r.ok ? null : r.error, applied: r.ok })
      read()
    },
    refresh: read,
    start() {
      const follow = () => {
        const s = replica.getState()
        const next = s.status === 'open' ? s.key : undefined
        if (next === key) return
        key = next
        clearTimeout(appliedTimer)
        toolNames.clear()
        seenSnapshots = undefined
        learnToolNames()
        set({ ...EMPTY, version: state.version + 1, toolChanges: new Map() })
        read()
      }
      const offState = replica.subscribe(() => {
        learnToolNames()
        follow()
      })
      const offEvent = replica.onEvent((e) => {
        const changes = toolChangesOf(e)
        if (changes.length > 0) {
          const next = new Map(state.toolChanges)
          for (const c of changes) {
            const fromName =
              c.from?.kind === 'specific' ? toolNames.get(c.from.snapshotId) : undefined
            next.set(toolChangeKey(c.partId, c.operationId), {
              ...c,
              ...(fromName === undefined ? {} : { fromName }),
            })
          }
          set({ toolChanges: next })
        }
        const by = appliedByOther(e)
        if (by !== null) {
          clearTimeout(appliedTimer)
          set({ appliedBy: by, error: null, applied: false })
          appliedTimer = setTimeout(() => set({ appliedBy: null }), APPLIED_BY_MS)
        }
        read()
      })
      // a library edit in another window changes pending here without a project event
      const onFocus = () => read()
      window.addEventListener('focus', onFocus)
      follow()
      return () => {
        window.removeEventListener('focus', onFocus)
        offState()
        offEvent()
        clearTimeout(appliedTimer)
      }
    },
  }
}
