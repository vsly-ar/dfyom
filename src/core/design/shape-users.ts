/**
 * Which operations use a named shape, and which operations a design pending change is an input
 * of (shared by the auto tool choice, `design.warning.list` and the renderer's pending marks).
 * Doc: docs/modes/design-v0.3.md#apply-and-pending-changes, docs/architecture/apply.md#what-is-pending
 */
import type { PendingChange } from '../commands/apply'

interface PartLike {
  readonly operations: readonly { readonly id: string; readonly shape?: unknown }[]
}

/**
 * Ids of the operations whose shape places `shapeId` (`shape: { kind: 'named', shapeId }`, v0.3
 * K3); in design order.
 */
export function operationsUsingShape(part: PartLike, shapeId: string): string[] {
  return part.operations
    .filter((op) => {
      const s = op.shape as { kind?: unknown; shapeId?: unknown } | undefined
      return s?.kind === 'named' && s.shapeId === shapeId
    })
    .map((op) => op.id)
}

/**
 * The operations of `part` a design change is an input of: its own operation; for a shape key
 * every operation using the shape (counted once however many use it); a new part or a changed
 * stock: all of them; other part fields (general tolerance): none.
 */
export function designChangeTargets(
  part: PartLike,
  c: Pick<PendingChange, 'operationId' | 'shapeId' | 'field'>,
): readonly string[] {
  if (c.operationId !== undefined) return [c.operationId]
  if (c.shapeId !== undefined) return operationsUsingShape(part, c.shapeId)
  if (c.field === 'stock' || c.field === 'added') return part.operations.map((op) => op.id)
  return []
}
