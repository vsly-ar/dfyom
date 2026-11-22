/**
 * The library items a project uses: every snapshot's `libraryItemId`, the design's
 * (`ProjectDoc.snapshots`: stock, specific tools) and each plan's copies (machine, tools, stock).
 * The Library window marks them "Used in this project" (docs/conventions/ui-library-window.md#layout).
 */
import type { ProjectDoc } from '../project/document'

/** Library item ids used by the project, sorted, without duplicates. */
export function usedLibraryItemIds(doc: ProjectDoc): string[] {
  const ids = new Set<string>()
  for (const s of Object.values(doc.snapshots)) ids.add(s.libraryItemId)
  for (const plan of Object.values(doc.plans))
    for (const s of plan.snapshots) ids.add(s.libraryItemId)
  return [...ids].sort()
}
