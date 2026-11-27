/**
 * Already cut (hardening DF135, docs/modes/cut-state.md): the operations and features of a part
 * whose material is already gone from the stock (`PartDTO.alreadyCut`, top-level ids as the
 * disabled list), whoever cut it. Every plan keeps them in the machining order as removed material
 * but generates no program for them. Works on DTOs only, the same in core and renderer.
 * Doc: docs/modes/cut-state.md#what-is-stored
 */
import { unitOfOperation } from './disabled'
import type { OperationDTO, PartDTO } from './part.dto'

/** The roughing pass's owner id of a DTO (DF122: `roughingOf`, or the `<owner>_roughing` id). */
function roughingOwner(op: OperationDTO): string | undefined {
  const of = (op as { roughingOf?: unknown }).roughingOf
  if (typeof of === 'string') return of
  return op.id.endsWith('_roughing') ? op.id.slice(0, -'_roughing'.length) : undefined
}

/**
 * The design operation ids of `part` that are already cut: those of a listed unit (an operation,
 * or every operation a listed feature owns or nests), and the roughing pass of a cut operation
 * (its material went first). Dependants are not: a pocket on a cut pocket's floor is new work.
 */
export function alreadyCutOperations(part: PartDTO): ReadonlySet<string> {
  const listed = new Set(part.alreadyCut ?? [])
  const out = new Set<string>()
  if (listed.size === 0) return out
  for (const op of part.operations) if (listed.has(unitOfOperation(part, op.id))) out.add(op.id)
  for (const op of part.operations) {
    const owner = roughingOwner(op)
    if (owner !== undefined && out.has(owner)) out.add(op.id)
  }
  return out
}
