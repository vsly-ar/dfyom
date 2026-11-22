/**
 * Loading a part and its stock snapshot from the project document (or a command's draft).
 * Doc: docs/modes/design.md#implementation-task-25
 */
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import type { Region2dPort } from '../geometry/2d/port'
import type { PartGeometryInput } from '../geometry/model'
import { Snapshot } from '../library/snapshot'
import { Stock } from '../library/stock'
import type { ProjectDoc, UnitSystem } from '../project/document'
import { checkFeatures, type LoadedFeature } from './feature'
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

/** The part with its operations and stock as models; a broken record is `input.malformed`. */
export function loadPart(doc: ProjectDoc, partId: string, where: string): AppResult<LoadedPart> {
  const dto = Object.hasOwn(doc.parts, partId) ? doc.parts[partId] : undefined
  if (dto === undefined) return unknownPart(partId, where)
  const part = partFromDTO(dto)
  if (part.isErr()) return Err(part.unwrapErr().prefixIssues('parts', partId).withContext(where))
  const snap = Object.hasOwn(doc.snapshots, dto.stock) ? doc.snapshots[dto.stock] : undefined
  if (snap === undefined || snap.kind !== 'stock')
    return fail('input.malformed', `stock snapshot ${dto.stock} of part ${partId} is missing`, {
      where,
      data: { partId, snapshotId: dto.stock },
    })
  const stock = Snapshot.fromDTO(snap).andThen((s) =>
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
  const features = checkFeatures(dto, part.unwrap().operations, stock.unwrap(), doc.unitSystem)
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

/** The geometry input of a part of the document (for evaluation, task 2.8/2.9). */
export function partGeometryInput(
  doc: ProjectDoc,
  partId: string,
  region2d?: Region2dPort,
): AppResult<PartGeometryInput> {
  return loadPart(doc, partId, 'partGeometryInput').andThen((l) =>
    toGeometryInput(l.part, l.stock, region2d),
  )
}
