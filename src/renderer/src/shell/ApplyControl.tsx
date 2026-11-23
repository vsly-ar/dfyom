// The main toolbar's Apply button wired to the window's pending store (task P3): the state from
// the pending changes, this window's Apply call, the running apply jobs' progress and another
// source's Apply, and the auto-apply countdown (DF28). Doc: docs/architecture/apply.md#apply-button,
// #auto-apply-df28, docs/conventions/ui.md#app-shell
import { useCallback } from 'react'
import { pendingList } from '../messages/apply'
import type { PendingState } from '../state/pending'
import { ApplyButton, type ApplyButtonState, type JobView } from '../ui'
import { useJobs } from './hooks'
import { usePending, useSettings, useShell } from './ShellContext'
import { APPLY_KEY_SHORTCUTS, APPLY_SHORTCUT } from './shortcuts'
import { useAutoApply } from './useAutoApply'

/** Overall progress (0..1) of the apply jobs, or null when no total is known. */
function applyProgress(jobs: readonly JobView[], ids: readonly string[]): number | null {
  let done = 0
  let total = 0
  for (const j of jobs) {
    if (!ids.includes(j.id)) continue
    const t = j.progress?.total
    if (t === undefined || t <= 0) return null
    done += j.progress?.done ?? 0
    total += t
  }
  return total === 0 ? null : Math.min(1, done / total)
}

/** The button's state (apply.md § Apply button: failed, applying, pending, applied by, clean). */
export function applyButtonState(p: PendingState, progress: number | null): ApplyButtonState {
  if (!p.known) return { kind: 'clean' }
  if (p.error !== null) return { kind: 'failed', count: p.count, error: p.error }
  if (p.applying.length > 0) return { kind: 'applying', count: p.count, progress }
  if (p.count > 0) return { kind: 'pending', count: p.count }
  if (p.appliedBy !== null) return { kind: 'appliedBy', by: p.appliedBy }
  return p.applied ? { kind: 'clean', applied: true } : { kind: 'clean' }
}

export function ApplyControl(): React.JSX.Element {
  const { pending } = useShell()
  const state = usePending()
  const { jobs } = useJobs()
  const progress = applyProgress(jobs, state.applying)
  const delay = useSettings((s) => s.settings.autoApplyDelay)
  const apply = useCallback(() => void pending.apply(), [pending])
  const due = useAutoApply(state, delay, apply)
  return (
    <ApplyButton
      state={applyButtonState(state, progress)}
      list={pendingList(state.changes.map((c) => c.label))}
      shortcut={APPLY_SHORTCUT}
      keyShortcuts={APPLY_KEY_SHORTCUTS}
      onApply={apply}
      autoApply={due}
    />
  )
}
