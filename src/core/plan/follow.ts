/**
 * `draft` plans follow library changes: for every changed library copy of a draft plan the app
 * dispatches `plan.libraryItem.update` (source `system`, one undo step each). Other plans only
 * show the change (`plan.stale.list`) until the user re-imports per item. A copy that cannot be
 * applied stays a notice with its reason (`blocked` in `plan.stale.list`).
 * Doc: docs/modes/plan-v0.1.md#plans-are-snapshots
 *
 * Library edits are effect commands outside `ProjectDoc`, so no document hook sees them: the
 * caller (main process, task 3.x) calls `followLibraryChanges` after a `Library` change event.
 */
import { Ok, type AsyncAppResult } from '../../shared/result'
import type { AppError } from '../../shared/errors/app-error'
import type { Source } from '../commands/context'
import type { Dispatcher } from '../commands/dispatcher'
import type { ItemLookup } from '../library/snapshot'
import type { ProjectDoc } from '../project/document'
import { planStale } from './snapshot'

export interface PendingLibraryUpdate {
  readonly planId: string
  readonly snapshotId: string
}

/** Copies of `draft` plans whose library item changed (removed or unreadable ones stay). */
export function draftLibraryUpdates(doc: ProjectDoc, lookup: ItemLookup): PendingLibraryUpdate[] {
  return Object.values(doc.plans)
    .filter((p) => p.status === 'draft')
    .flatMap((p) =>
      planStale(p, doc, lookup)
        .libraryCopies.filter((c) => c.status === 'libraryChanged')
        .map((c) => ({ planId: p.id, snapshotId: c.snapshotId })),
    )
}

export const LIBRARY_FOLLOW_SOURCE: Source = { kind: 'system', id: 'plan.libraryFollow' }

/** Rounds of re-reading after a `command.conflict` (another edit came first). */
export const FOLLOW_RETRIES = 3

export interface FollowFailure extends PendingLibraryUpdate {
  readonly error: AppError
}

export interface FollowResult {
  /** Copies re-imported. */
  readonly updated: number
  /** Copies that could not be applied (e.g. the part does not fit a new stock): they stay notices. */
  readonly failed: readonly FollowFailure[]
}

/**
 * Dispatches `plan.libraryItem.update` with `followOnly: true` (a no-op unless the plan is still
 * a draft when the command runs) for every pending copy, against the current revision. A failing
 * copy does not stop the others. On `command.conflict` the pending list is read again, up to
 * `FOLLOW_RETRIES` times.
 */
export async function followLibraryChanges(
  d: Dispatcher,
  lookup: ItemLookup,
  source: Source = LIBRARY_FOLLOW_SOURCE,
): AsyncAppResult<FollowResult> {
  let updated = 0
  const failed: FollowFailure[] = []
  const tried = new Set<string>()
  const key = (u: PendingLibraryUpdate) => `${u.planId}/${u.snapshotId}`
  for (let round = 0; round <= FOLLOW_RETRIES; round++) {
    const pending = draftLibraryUpdates(d.doc, lookup).filter((u) => !tried.has(key(u)))
    let conflict = false
    for (const u of pending) {
      const r = await d.dispatch('plan.libraryItem.update', { ...u, followOnly: true }, source, {
        expectedRevision: d.revision,
      })
      if (r.isErr() && r.unwrapErr().code === 'command.conflict') {
        conflict = true
        break
      }
      tried.add(key(u))
      if (r.isErr()) failed.push({ ...u, error: r.unwrapErr() })
      else if ((r.unwrap().value as { updated: boolean }).updated) updated += 1
    }
    if (!conflict) break
  }
  return Ok({ updated, failed })
}
