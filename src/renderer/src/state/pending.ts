// The window's view of Apply (task P3): the bound project's pending changes (`project.pending.get`,
// re-read after every action-log event, binding change and window focus), the running apply jobs, this window's
// Apply call and its failure, and "Applied by …" after another source applied. `apply()` sends
// `project.apply`; it is sent after the commit it follows (one IPC channel, one project queue,
// both FIFO), so Enter in a field applies the value it just committed.
// Doc: docs/architecture/apply.md#ui, docs/conventions/ui.md#app-shell
import type { ActionEvent } from '../../../core/commands/action-log'
import type { AppErrorData } from '../../../shared/errors/app-error'
import type { PreloadApi } from '../../../shared/preload-api'
import type { Replica } from './replica'

/** One pending change as `project.pending.get` lists it. */
export interface PendingChangeView {
  readonly kind: 'design' | 'plan' | 'library'
  readonly partId?: string
  readonly operationId?: string
  readonly planId?: string
  readonly field?: string
  /** "Pocket 1: depth", "Drilling 2 added" (core label). */
  readonly label: string
  readonly source: { readonly kind: string; readonly id: string }
  readonly revision: number
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
}

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
}

/** Another source's `project.apply` that applied something (not a window's own). */
function appliedByOther(e: ActionEvent): string | null {
  if (e.type !== 'command' || e.name !== 'project.apply' || !e.outcome.ok) return null
  if (e.source.kind === 'ui') return null
  const changes = (e.outcome.value as { changes?: unknown } | undefined)?.changes
  return typeof changes === 'number' && changes > 0 ? e.source.kind : null
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
        set({ ...EMPTY, version: state.version + 1 })
        read()
      }
      const offState = replica.subscribe(follow)
      const offEvent = replica.onEvent((e) => {
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
