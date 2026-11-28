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
    /** DF145: a facing's region (`{ shape }` places a shape). */
    readonly region?: unknown
    readonly paths?: readonly unknown[] | undefined
    readonly featureId?: string | undefined
  }[]
  readonly shapes?:
    | readonly {
        readonly id: string
        readonly items?: readonly { readonly kind: string; readonly shapeId?: unknown }[]
        readonly pattern?: { readonly cell: object } | undefined
        readonly engraving?: { readonly motif: object } | undefined
      }[]
    | undefined
}

/**
 * Ids of the operations whose shape places `shapeId` (`shape: { kind: 'named', shapeId }`, v0.3
 * K3; a Line's paths), or an owned pattern shape whose cell it is (patterns P1), or an owned
 * engraving shape whose motif it is (engraved-patterns.md E3); in design order.
 */
export function operationsUsingShape(
  part: PartLike,
  shapeId: string,
  /** Also through shapes offsetting it, by any chain (design-llm-first.md § Offset item). */
  throughOffsets = true,
): string[] {
  const ids = new Set([shapeId, ...(throughOffsets ? shapesOffsetting(part, shapeId) : [])])
  for (const sh of part.shapes ?? []) {
    if ((sh.pattern?.cell as { shapeId?: unknown } | undefined)?.shapeId === shapeId) ids.add(sh.id)
    const motif = sh.engraving?.motif as { shapeIds?: unknown } | undefined
    if (Array.isArray(motif?.shapeIds) && motif.shapeIds.includes(shapeId)) ids.add(sh.id)
  }
  const named = (s: unknown) => {
    const n = s as { kind?: unknown; shapeId?: unknown } | undefined
    return n?.kind === 'named' && ids.has(n.shapeId as string)
  }
  return part.operations
    .filter(
      (op) =>
        named(op.shape) ||
        named((op.region as { shape?: unknown } | undefined)?.shape) ||
        (op.paths ?? []).some((p) => ids.has((p as { shapeId?: string }).shapeId ?? '')),
    )
    .map((op) => op.id)
}

/**
 * Ids of the named shapes with an offset item on `shapeId` (docs/modes/design-llm-first.md#offset-item):
 * the direct ones, or with `transitive` also those offsetting them, in record order. They follow
 * its edits, and it cannot be removed while one exists.
 */
export function shapesOffsetting(
  part: Pick<PartLike, 'shapes'>,
  shapeId: string,
  transitive = true,
): string[] {
  const found = new Set<string>()
  const queue = [shapeId]
  for (let id = queue.shift(); id !== undefined; id = queue.shift())
    for (const sh of part.shapes ?? [])
      if (
        !found.has(sh.id) &&
        sh.id !== shapeId &&
        (sh.items ?? []).some((i) => i.kind === 'offset' && i.shapeId === id)
      ) {
        found.add(sh.id)
        if (transitive) queue.push(sh.id)
      }
  return (part.shapes ?? []).filter((s) => found.has(s.id)).map((s) => s.id)
}

/**
 * Ids of the features with a Clones `along` row on `shapeId` (v0.4 F6; their clones follow the
 * shape), a pattern whose cell it is (patterns P1) or an engraved pattern whose motif it is, in
 * record order.
 */
export function featuresUsingShape(
  part: { readonly features?: readonly { readonly id: string }[] | undefined },
  shapeId: string,
): string[] {
  return (part.features ?? [])
    .filter((f) => {
      const cell = (f as { cell?: { kind?: unknown; shapeId?: unknown } }).cell
      if (cell?.kind === 'shape' && cell.shapeId === shapeId) return true
      // an engraved pattern whose motif it is (engraved-patterns.md E3)
      const motif = (f as { motif?: { shapeIds?: unknown } }).motif
      if (Array.isArray(motif?.shapeIds) && motif.shapeIds.includes(shapeId)) return true
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
