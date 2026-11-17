/**
 * `draft` plans follow library changes: for every changed library copy of a draft plan the app
 * dispatches `plan.libraryItem.update` (source `system`, one undo step each). Other plans only
 * show the change (`plan.stale.list`) until the user re-imports per item.
 * Doc: docs/modes/plan-v0.1.md#plans-are-snapshots
 *
 * Library edits are effect commands outside `ProjectDoc`, so no document hook sees them: the
 * caller (main process, task 3.x) calls `followLibraryChanges` after a `Library` change event.
 */
import { Ok, type AsyncAppResult } from '../../shared/result'
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

/**
 * Dispatches `plan.libraryItem.update` for every pending copy, one at a time against the
 * current revision. Returns how many copies were updated; stops at the first failure.
 */
export async function followLibraryChanges(
  d: Dispatcher,
  lookup: ItemLookup,
  source: Source = LIBRARY_FOLLOW_SOURCE,
): AsyncAppResult<number> {
  let updated = 0
  for (const u of draftLibraryUpdates(d.doc, lookup)) {
    const r = await d.dispatch('plan.libraryItem.update', u, source, {
      expectedRevision: d.revision,
    })
    if (r.isErr()) return r.map(() => updated)
    updated += 1
  }
  return Ok(updated)
}
