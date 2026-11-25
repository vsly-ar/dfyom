/**
 * The read-only rule of split pieces (`model.invariant`, rule `derivedPart`), apart from the split
 * commands so `design.part.remove` can use it without an import cycle.
 * Doc: docs/modes/split-parts.md#source-and-pieces
 */
import type { Draft } from 'immer'
import { fail, type AppResult } from '../../../shared/result'
import type { ProjectDoc } from '../../project/document'
import type { PartDTO } from '../part.dto'

/** `model.invariant` rule `derivedPart`: a piece is edited through its source. */
export function derivedPartError(
  doc: Draft<ProjectDoc> | ProjectDoc,
  piece: PartDTO,
  where: string,
  operationId?: string,
): AppResult<never> {
  const source = doc.parts[piece.derivedFrom!.partId]
  const sourceName = source?.name ?? piece.derivedFrom!.partId
  const what =
    operationId === undefined
      ? piece.name
      : `${piece.operations.find((o) => o.id === operationId)?.name ?? operationId} belongs to ${piece.name}; it`
  return fail('model.invariant', `${what} is derived from ${sourceName}; edit ${sourceName}`, {
    issues: [
      {
        path: operationId === undefined ? ['partId'] : ['operationId'],
        rule: 'derivedPart',
        message: `derived from ${sourceName}; edit ${sourceName}`,
        params: { sourcePartId: piece.derivedFrom!.partId },
      },
    ],
    where,
    data: { partId: piece.id, sourcePartId: piece.derivedFrom!.partId },
  })
}
