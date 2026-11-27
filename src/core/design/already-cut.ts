/**
 * Already cut (hardening DF135, docs/modes/cut-state.md): the operations and features of a part
 * whose material is already gone from the stock (`PartDTO.alreadyCut`, top-level ids as the
 * disabled list), whoever cut it. Every plan keeps them in the machining order as removed material
 * but generates no program for them. Works on DTOs only, the same in core and renderer.
 * Doc: docs/modes/cut-state.md#what-is-stored
 */
import { hashJson } from '../plan/snapshot'
import { unitOfOperation } from './disabled'
import type { CutMarkDTO, OperationDTO, PartDTO } from './part.dto'

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

/** The roughing pass's owner of design operation `op` (DF122), if it is one. */
export function roughingOwnerOf(op: OperationDTO): string | undefined {
  return roughingOwner(op)
}

/** Without the display name: renaming re-describes nothing that was cut. */
function geometryOf<T extends object>(item: T): Omit<T, 'name'> {
  const { name: _name, ...rest } = item as T & { name?: unknown }
  return rest
}

/**
 * The geometry of the top-level unit `id` of `part` as a hash (DF135 C2): the unit's features and
 * operations without their names. A run mark keeps it, so an edit of what the run cut shows
 * (`cutChangedUnits`). Named shapes an operation places are not in it (a shape edit does not warn).
 * Doc: docs/modes/cut-state.md#editing-an-already-cut-operation
 */
export function unitFingerprint(part: PartDTO, id: string): string {
  const features = (part.features ?? []).filter((f) => unitOfOperation(part, f.id) === id)
  const operations = part.operations.filter((o) => unitOfOperation(part, o.id) === id)
  return hashJson({ features: features.map(geometryOf), operations: operations.map(geometryOf) })
}

/** The mark of listed id `id` (`hand` without a date for a list written without marks). */
export function cutMarkOf(part: PartDTO, id: string): CutMarkDTO | undefined {
  if (part.alreadyCut?.includes(id) !== true) return undefined
  return part.alreadyCutMarks?.[id] ?? { by: 'hand', at: '' }
}

/**
 * The marks of a new already-cut `list` of `part` (DF135 C2): kept for ids still listed, new for
 * ids the list adds – by `run` with the unit's fingerprint in `runPart` (the run's plan's design
 * copy) when given, else by `hand` – at ISO time `at`. `undefined` for an empty list.
 */
export function cutMarksFor(
  part: PartDTO,
  list: readonly string[],
  runPart: PartDTO | undefined,
  at: string,
): Record<string, CutMarkDTO> | undefined {
  if (list.length === 0) return undefined
  const before = new Set(part.alreadyCut ?? [])
  const out: Record<string, CutMarkDTO> = {}
  for (const id of list) {
    const kept = before.has(id) ? part.alreadyCutMarks?.[id] : undefined
    if (kept !== undefined) out[id] = kept
    else if (before.has(id))
      continue // listed before marks were kept: when is unknown
    else if (runPart === undefined) out[id] = { by: 'hand', at }
    else {
      const source = runPart.operations.some((o) => unitOfOperation(runPart, o.id) === id)
        ? runPart
        : part
      out[id] = { by: 'run', at, fingerprint: unitFingerprint(source, id) }
    }
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * The listed ids marked by a run whose geometry changed since (DF135 C2, Q198 as revised): they
 * warn `plan.cutChanged`. Marks set by hand never do.
 */
export function cutChangedUnits(part: PartDTO): ReadonlySet<string> {
  const out = new Set<string>()
  for (const id of part.alreadyCut ?? []) {
    const mark = part.alreadyCutMarks?.[id]
    if (mark?.by !== 'run' || mark.fingerprint === undefined) continue
    if (unitFingerprint(part, id) !== mark.fingerprint) out.add(id)
  }
  return out
}
