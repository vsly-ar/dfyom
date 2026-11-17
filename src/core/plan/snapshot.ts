/**
 * Design snapshot of a plan and stale detection: the hash of a part, taking the snapshot, and
 * the stale indicators of operations and library copies (derived, never stored).
 * Doc: docs/modes/plan-v0.1.md#plans-are-snapshots
 */
import { fail, Ok, type AppResult } from '../../shared/result'
import type { PartDTO } from '../design/part.dto'
import type { LibraryItemKind } from '../library/item'
import {
  deepEqual,
  Snapshot,
  snapshotStatus,
  type ItemLookup,
  type SnapshotDTO,
  type SnapshotStatus,
} from '../library/snapshot'
import type { ProjectDoc } from '../project/document'
import { stableJson } from '../project/layout'
import type { DesignSnapshotDTO, PlanDTO } from './plan.dto'

/** Hash of a part DTO (the design snapshot's `hash`). */
export const hashPart = (part: PartDTO): string => hashJson(part)

/**
 * cyrb53 of the stable JSON: a cheap content hash (stale detection itself deep-compares; the
 * toolpath cache keys on it).
 */
export function hashJson(value: unknown): string {
  const text = stableJson(value)
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/**
 * The plan's copy of a part of the design and of the part's stock snapshot (same id, so
 * `part.stock` resolves in the plan's own snapshots). JSON copies: nothing is shared.
 */
export function takeDesignSnapshot(
  doc: ProjectDoc,
  partId: string,
  takenAt: string,
  where: string,
): AppResult<{ design: DesignSnapshotDTO; stock: SnapshotDTO }> {
  const part = Object.hasOwn(doc.parts, partId) ? doc.parts[partId] : undefined
  if (part === undefined)
    return fail('input.malformed', `part ${partId} does not exist`, {
      issues: [{ path: ['partId'], rule: 'unknownPart', message: 'no such part' }],
      where,
    })
  const stock = Object.hasOwn(doc.snapshots, part.stock) ? doc.snapshots[part.stock] : undefined
  if (stock === undefined)
    return fail('input.malformed', `stock snapshot ${part.stock} of part ${partId} is missing`, {
      where,
    })
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
  return Ok({
    design: { partId, takenAt, hash: hashPart(part), taken: copy(part), part: copy(part) },
    stock: copy(stock),
  })
}

/** Stale indicators of one operation of the plan's design snapshot. */
export interface OperationStale {
  readonly operationId: string
  /** The design's version differs from the one the plan copied. */
  readonly changedInDesign: boolean
  /** The design no longer has the operation. */
  readonly removedFromDesign: boolean
  /** Edited in the plan (`plan.design.operation.update`). */
  readonly editedInPlan: boolean
}

/** Stale indicator of one library copy (`current` copies are not listed). */
export interface LibraryCopyStale {
  readonly snapshotId: string
  readonly kind: LibraryItemKind
  readonly libraryItemId: string
  readonly status: Exclude<SnapshotStatus, 'current'>
}

export interface PlanStale {
  /** Operations of the snapshot with at least one indicator, in snapshot order. */
  readonly operations: readonly OperationStale[]
  readonly libraryCopies: readonly LibraryCopyStale[]
  /** The part itself is gone from the design. */
  readonly partRemoved: boolean
}

/**
 * Deep compare with the current design and library. New design operations are deliberately not
 * reported: plans never suggest adding operations (only a rebuild takes them).
 */
export function planStale(
  plan: PlanDTO,
  doc: ProjectDoc,
  lookup: ItemLookup | undefined,
): PlanStale {
  const current = Object.hasOwn(doc.parts, plan.design.partId)
    ? doc.parts[plan.design.partId]
    : undefined
  const operations: OperationStale[] = []
  for (const op of plan.design.part.operations) {
    const taken = plan.design.taken.operations.find((o) => o.id === op.id)
    const now = current?.operations.find((o) => o.id === op.id)
    const s: OperationStale = {
      operationId: op.id,
      changedInDesign: now !== undefined && !deepEqual(taken, now),
      removedFromDesign: now === undefined,
      editedInPlan: !deepEqual(taken, op),
    }
    if (s.changedInDesign || s.removedFromDesign || s.editedInPlan) operations.push(s)
  }
  const libraryCopies: LibraryCopyStale[] = []
  if (lookup !== undefined)
    for (const dto of plan.snapshots) {
      const snap = Snapshot.fromDTO(dto)
      if (snap.isErr()) continue
      const status = snapshotStatus(snap.unwrap(), lookup)
      if (status !== 'current')
        libraryCopies.push({
          snapshotId: dto.id,
          kind: dto.kind,
          libraryItemId: dto.libraryItemId,
          status,
        })
    }
  return { operations, libraryCopies, partRemoved: current === undefined }
}

/**
 * Whether the plan's snapshot differs from the current part. The stock copy is a library copy
 * (updated per item), so only a different stock snapshot id counts, through `part.stock`.
 */
export function designChanged(plan: PlanDTO, doc: ProjectDoc): boolean {
  const part = Object.hasOwn(doc.parts, plan.design.partId)
    ? doc.parts[plan.design.partId]
    : undefined
  return part !== undefined && !deepEqual(plan.design.taken, part)
}

/** Whether any operation carries plan-only edits. */
export function hasPlanEdits(plan: PlanDTO): boolean {
  return !deepEqual(plan.design.taken, plan.design.part)
}
