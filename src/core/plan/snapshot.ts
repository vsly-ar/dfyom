/**
 * Design snapshot of a plan and stale detection: the hash of a part, taking the snapshot, and
 * the stale indicators of operations and library copies (derived, never stored).
 * Doc: docs/modes/plan-v0.1.md#plans-are-snapshots
 */
import { fail, Ok, type AppResult } from '../../shared/result'
import type { PartDTO } from '../design/part.dto'
import type { LibraryItemKind } from '../library/item'
import {
  Snapshot,
  snapshotStatus,
  type ItemLookup,
  type SnapshotDTO,
  type SnapshotStatus,
} from '../library/snapshot'
import type { Region2dPort } from '../geometry/2d/port'
import type { ProjectDoc } from '../project/document'
import { stableJson } from '../project/layout'
import type { DesignSnapshotDTO, PlanDTO } from './plan.dto'
import { sameDesignToolField } from './design-tool'
import { libraryUpdateBlocker, rebuildBlocker, sameValue } from './validity'

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
 * The plan's copy of a part of the design, of the part's stock snapshot and of the tool snapshots
 * of its specific design tools (same ids, so `part.stock` and the tool fields resolve in the plan's
 * own snapshots; a missing tool snapshot is left out). JSON copies: nothing is shared.
 */
export function takeDesignSnapshot(
  doc: ProjectDoc,
  partId: string,
  takenAt: string,
  where: string,
): AppResult<{ design: DesignSnapshotDTO; stock: SnapshotDTO; tools: SnapshotDTO[] }> {
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
  const toolIds = new Set(
    part.operations.flatMap((o) => (o.tool?.kind === 'specific' ? [o.tool.snapshotId] : [])),
  )
  const tools = [...toolIds].flatMap((id) => {
    const s = Object.hasOwn(doc.snapshots, id) ? doc.snapshots[id] : undefined
    return s?.kind === 'tool' ? [copy(s)] : []
  })
  return Ok({
    design: { partId, takenAt, hash: hashPart(part), taken: copy(part), part: copy(part) },
    stock: copy(stock),
    tools,
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
  /**
   * The design's tool field differs from the snapshot's, or a rebuild kept a plan-assigned tool
   * although it changed (docs/modes/plan-v0.2.md#tool-resolution-from-the-design-tool-field).
   */
  readonly designToolChanged: boolean
}

/** Stale indicator of one library copy (`current` copies are not listed). */
export interface LibraryCopyStale {
  readonly snapshotId: string
  readonly kind: LibraryItemKind
  readonly libraryItemId: string
  readonly status: Exclude<SnapshotStatus, 'current'>
  /** Why re-importing this changed copy cannot be applied (the part must fit a new stock). */
  readonly blocked: string | null
}

export interface PlanStale {
  /** Operations of the snapshot with at least one indicator, in snapshot order. */
  readonly operations: readonly OperationStale[]
  readonly libraryCopies: readonly LibraryCopyStale[]
  /** The part itself is gone from the design. */
  readonly partRemoved: boolean
  /** Part-level fields (not operations) that differ from the design, e.g. `generalTolerance`. */
  readonly partChanged: readonly string[]
  /** A `draft` plan that could not follow the design: why (rebuild blocked by its stock copy). */
  readonly rebuildBlocked: string | null
}

/**
 * Deep compare with the current design and library. New design operations are deliberately not
 * reported: plans never suggest adding operations (only a rebuild takes them).
 */
export function planStale(
  plan: PlanDTO,
  doc: ProjectDoc,
  lookup: ItemLookup | undefined,
  port?: Region2dPort,
): PlanStale {
  const current = Object.hasOwn(doc.parts, plan.design.partId)
    ? doc.parts[plan.design.partId]
    : undefined
  const operations: OperationStale[] = []
  const kept = new Set(
    plan.setups.flatMap((s) =>
      s.operations.flatMap((p) => (p.designToolChanged === true ? p.designOperationIds : [])),
    ),
  )
  const field = (o: PartDTO['operations'][number] | undefined) => ({
    tool: o?.tool,
    locked: o?.toolLocked === true,
  })
  for (const op of plan.design.part.operations) {
    const taken = plan.design.taken.operations.find((o) => o.id === op.id)
    const now = current?.operations.find((o) => o.id === op.id)
    const s: OperationStale = {
      operationId: op.id,
      changedInDesign:
        now !== undefined &&
        (!sameValue(taken, now) || shapeChanged(now, plan.design.taken, current)),
      removedFromDesign: now === undefined,
      editedInPlan: !sameValue(taken, op),
      designToolChanged:
        kept.has(op.id) || (now !== undefined && !sameDesignToolField(field(taken), field(now))),
    }
    if (s.changedInDesign || s.removedFromDesign || s.editedInPlan || s.designToolChanged)
      operations.push(s)
  }
  const libraryCopies: LibraryCopyStale[] = []
  if (lookup !== undefined)
    for (const dto of plan.snapshots) {
      const snap = Snapshot.fromDTO(dto)
      if (snap.isErr()) continue
      const status = snapshotStatus(snap.unwrap(), lookup)
      if (status === 'current') continue
      const found = lookup(dto.kind, dto.libraryItemId)
      const blocked =
        status === 'libraryChanged' && found.state === 'found'
          ? libraryUpdateBlocker(plan, dto, found.item, port)
          : undefined
      libraryCopies.push({
        snapshotId: dto.id,
        kind: dto.kind,
        libraryItemId: dto.libraryItemId,
        status,
        blocked: blocked ?? null,
      })
    }
  const partChanged =
    current === undefined
      ? []
      : [...new Set([...Object.keys(plan.design.taken), ...Object.keys(current)])]
          .filter((k) => k !== 'operations' && k !== 'id')
          .filter(
            (k) =>
              !sameValue(
                (plan.design.taken as Record<string, unknown>)[k],
                (current as Record<string, unknown>)[k],
              ),
          )
          .sort()
  const rebuildBlocked =
    plan.status === 'draft' && designChanged(plan, doc)
      ? (rebuildBlocker(plan, doc, port) ?? null)
      : null
  return {
    operations,
    libraryCopies,
    partRemoved: current === undefined,
    partChanged,
    rebuildBlocked,
  }
}

/** The named shape `op` places (design.shape.* keeps every referenced id existing). */
const namedShapeId = (op: PartDTO['operations'][number]): string | undefined =>
  'shape' in op && op.shape.kind === 'named' ? op.shape.shapeId : undefined

/**
 * Whether the definition of the named shape the design's `op` places differs between the plan's
 * taken part and the current one: a shape-only edit changes the operation's cut (v0.3, K3 known
 * issue "stale indicators miss shape-only edits"). Doc: docs/modes/plan-v0.3.md#wiring-t1-t2
 */
function shapeChanged(
  op: PartDTO['operations'][number],
  taken: PartDTO,
  current: PartDTO | undefined,
): boolean {
  const id = namedShapeId(op)
  if (id === undefined) return false
  const find = (p: PartDTO | undefined) => p?.shapes?.find((x) => x.id === id)
  return !sameValue(find(taken), find(current))
}

/**
 * Whether the plan's snapshot differs from the current part. The stock copy is a library copy
 * (updated per item), so only a different stock snapshot id counts, through `part.stock`.
 */
export function designChanged(plan: PlanDTO, doc: ProjectDoc): boolean {
  const part = Object.hasOwn(doc.parts, plan.design.partId)
    ? doc.parts[plan.design.partId]
    : undefined
  return part !== undefined && !sameValue(plan.design.taken, part)
}

/** Whether any operation carries plan-only edits (compared by value). */
export function hasPlanEdits(plan: PlanDTO): boolean {
  return !sameValue(plan.design.taken, plan.design.part)
}
