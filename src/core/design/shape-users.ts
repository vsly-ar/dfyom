/**
 * Which operations use a named shape, and which operations a design pending change is an input
 * of (shared by the auto tool choice, `design.warning.list` and the renderer's pending marks).
 * Doc: docs/modes/design-v0.3.md#apply-and-pending-changes, docs/architecture/apply.md#what-is-pending
 */
import type { PendingChange } from '../commands/apply'

interface PartLike {
  readonly operations: readonly {
    readonly id: string
    readonly shape?: unknown
    readonly featureId?: string | undefined
  }[]
  readonly shapes?:
    | readonly { readonly id: string; readonly pattern?: { readonly cell: object } | undefined }[]
    | undefined
}

/**
 * Ids of the operations whose shape places `shapeId` (`shape: { kind: 'named', shapeId }`, v0.3
 * K3), or an owned pattern shape whose cell it is (patterns P1); in design order.
 */
export function operationsUsingShape(part: PartLike, shapeId: string): string[] {
  const ids = new Set([shapeId])
  for (const sh of part.shapes ?? [])
    if ((sh.pattern?.cell as { shapeId?: unknown } | undefined)?.shapeId === shapeId) ids.add(sh.id)
  return part.operations
    .filter((op) => {
      const s = op.shape as { kind?: unknown; shapeId?: unknown } | undefined
      return s?.kind === 'named' && ids.has(s.shapeId as string)
    })
    .map((op) => op.id)
}

/**
 * Ids of the features with a Clones `along` row on `shapeId` (v0.4 F6; their clones follow the
 * shape) or a pattern whose cell it is (patterns P1), in record order.
 */
export function featuresUsingShape(
  part: { readonly features?: readonly { readonly id: string }[] | undefined },
  shapeId: string,
): string[] {
  return (part.features ?? [])
    .filter((f) => {
      const cell = (f as { cell?: { kind?: unknown; shapeId?: unknown } }).cell
      if (cell?.kind === 'shape' && cell.shapeId === shapeId) return true
      const rows = (f as { rows?: unknown }).rows
      return (
        Array.isArray(rows) &&
        rows.some(
          (r: { kind?: unknown; shapeId?: unknown }) => r.kind === 'along' && r.shapeId === shapeId,
        )
      )
    })
    .map((f) => f.id)
}

/**
 * The operations of `part` a design change is an input of: its own operation; for a feature key
 * the operations the feature owns; for a shape key
 * every operation using the shape (counted once however many use it); a new part or a changed
 * stock: all of them; other part fields (general tolerance): none.
 */
export function designChangeTargets(
  part: PartLike,
  c: Pick<PendingChange, 'operationId' | 'shapeId' | 'featureId' | 'field'>,
): readonly string[] {
  if (c.operationId !== undefined) return [c.operationId]
  // a feature key: every operation it owns (features.md § Apply and pending changes)
  if (c.featureId !== undefined)
    return part.operations.filter((op) => op.featureId === c.featureId).map((op) => op.id)
  if (c.shapeId !== undefined) return operationsUsingShape(part, c.shapeId)
  if (c.field === 'stock' || c.field === 'added') return part.operations.map((op) => op.id)
  return []
}
