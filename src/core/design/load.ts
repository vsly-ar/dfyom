/**
 * Loading a part and its stock snapshot from the project document (or a command's draft).
 * Doc: docs/modes/design.md#implementation-task-25
 */
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import type { Region2dPort } from '../geometry/2d/port'
import type { PartGeometryInput } from '../geometry/model'
import { Stock } from '../library/stock'
import type { ProjectDoc, UnitSystem } from '../project/document'
import { enabledPart } from './disabled'
import { checkFeatures, type FrozenRecords, type LoadedFeature } from './feature'
import { baseOf, snapshotFromRecord } from './frozen-memo'
import { toGeometryInput } from './geometry-input'
import { partFromDTO, type Part } from './operation'
import type { PartDTO } from './part.dto'

export interface LoadedPart {
  readonly dto: PartDTO
  readonly part: Part
  readonly stock: Stock
  readonly units: UnitSystem
  /** The document's snapshots (specific tools of the tool field resolve here); absent: none. */
  readonly snapshots?: ProjectDoc['snapshots']
  /** The part's features (v0.4), checked against their owned operations; in record order. */
  readonly features: readonly LoadedFeature[]
}

export function unknownPart(partId: string, where: string): AppResult<never> {
  return fail('input.malformed', `part ${partId} does not exist`, {
    issues: [{ path: ['partId'], rule: 'unknownPart', message: 'no such part' }],
    where,
  })
}

/**
 * The part with its operations and stock as models; a broken record is `input.malformed`.
 * `following`: only for `design.clonesFollow`, which re-expands every Clones right after: a
 * Clones block whose roles no longer match its source (a hole changed type, an inner Clones
 * skipped a position, DF40) is not corruption yet (`checkFeatures`).
 */
export function loadPart(
  doc: ProjectDoc,
  partId: string,
  where: string,
  following = false,
): AppResult<LoadedPart> {
  const dto = Object.hasOwn(doc.parts, partId) ? doc.parts[partId] : undefined
  if (dto === undefined) return unknownPart(partId, where)
  // read the records, not the draft's proxies; unmodified ones are a committed document's frozen
  // objects, whose parsed models and expansions are cached (P5, frozen-memo.ts)
  const records = baseOf(dto)
  const part = partFromDTO(records)
  if (part.isErr()) return Err(part.unwrapErr().prefixIssues('parts', partId).withContext(where))
  const snap = Object.hasOwn(doc.snapshots, dto.stock)
    ? baseOf(doc.snapshots[dto.stock])
    : undefined
  if (snap === undefined || snap.kind !== 'stock')
    return fail('input.malformed', `stock snapshot ${dto.stock} of part ${partId} is missing`, {
      where,
      data: { partId, snapshotId: dto.stock },
    })
  const stock = snapshotFromRecord(snap).andThen((s) =>
    s.values instanceof Stock
      ? Ok(s.values)
      : fail('input.malformed', 'part stock is not a stock snapshot', { where }),
  )
  if (stock.isErr()) return Err(stock.unwrapErr())
  // a specific tool's snapshot must be there, like the stock's
  for (const op of part.unwrap().operations) {
    const t = op.tool.isSome() ? op.tool.unwrap() : undefined
    if (t?.kind !== 'specific') continue
    const s = Object.hasOwn(doc.snapshots, t.snapshotId) ? doc.snapshots[t.snapshotId] : undefined
    if (s?.kind !== 'tool')
      return fail('input.malformed', `tool snapshot ${t.snapshotId} of ${op.id} is missing`, {
        where,
        data: { partId, operationId: op.id, snapshotId: t.snapshotId },
      })
  }
  const features = checkFeatures(
    dto,
    part.unwrap().operations,
    stock.unwrap(),
    doc.unitSystem,
    frozenRecords(records, snap),
    following,
  )
  if (features.isErr())
    return Err(features.unwrapErr().prefixIssues('parts', partId).withContext(where, { partId }))
  return Ok({
    dto,
    part: part.unwrap(),
    stock: stock.unwrap(),
    units: doc.unitSystem,
    snapshots: doc.snapshots,
    features: features.unwrap(),
  })
}

/**
 * The records of a part (`baseOf`: a draft's unmodified records are the committed document's
 * frozen objects), for the consistency check's expansion cache, which uses only frozen ones.
 */
function frozenRecords(records: PartDTO, stock: object): FrozenRecords | undefined {
  if (records.features === undefined) return undefined
  return {
    features: records.features,
    operations: records.operations,
    stock,
    shapes: records.shapes,
  }
}

/**
 * The part as evaluation, DFM and split pieces see it: without its disabled items (hardening
 * DF106, design/disabled.ts). The same as `loadPart` when nothing is disabled.
 */
export function loadEnabledPart(
  doc: ProjectDoc,
  partId: string,
  where: string,
): AppResult<LoadedPart> {
  const dto = Object.hasOwn(doc.parts, partId) ? doc.parts[partId] : undefined
  if (dto?.disabled === undefined) return loadPart(doc, partId, where)
  const enabled = enabledPart(baseOf(dto))
  return loadPart({ ...doc, parts: { ...doc.parts, [partId]: enabled } }, partId, where)
}

/** The geometry input of a part of the document (for evaluation, task 2.8/2.9); DF106: enabled items only. */
export function partGeometryInput(
  doc: ProjectDoc,
  partId: string,
  region2d?: Region2dPort,
): AppResult<PartGeometryInput> {
  return loadEnabledPart(doc, partId, 'partGeometryInput').andThen((l) =>
    toGeometryInput(l.part, l.stock, region2d),
  )
}
