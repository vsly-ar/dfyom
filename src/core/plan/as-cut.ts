/**
 * The as-cut removals of recut units (hardening DF135 C4): a run-marked unit edited since the run
 * cut it is cut again for the difference only. Its operations as the run cut them (`asCut` of the
 * mark), evaluated in the plan's part in place of the unit's current ones, become hidden earlier
 * removals just before the unit's first plan operation, so the material bands, partial coverage,
 * through depths and openings (plan/through.ts) count what the run already removed.
 * Doc: docs/modes/cut-state.md#cutting-only-the-difference-c4
 */
import { recutUnits } from '../design/already-cut'
import { unitOfOperation } from '../design/disabled'
import { toGeometryInput } from '../design/geometry-input'
import { partFromDTO } from '../design/operation'
import type { OperationDTO, PartDTO } from '../design/part.dto'
import type { Region2dPort } from '../geometry/2d/port'
import type { OperationGeometry } from '../geometry/model'
import type { LoadedPlan } from './plan'

/** The id suffix of a hidden as-cut removal (never a design id: ids are word characters). */
const SUFFIX = '#asCut'

/** One hidden removal: an as-cut operation's geometry (`id` + `#asCut`) and where it sits. */
export interface AsCutRemoval {
  readonly geometry: OperationGeometry
  /** The recut unit it belongs to. */
  readonly unit: string
  /** The machining-order index of the unit's first plan operation (the removal sits before it). */
  readonly index: number
  /** That plan operation's setup index. */
  readonly setup: number
}

/** Whether a geometry id is a hidden as-cut removal's. */
export const isAsCutId = (id: string): boolean => id.endsWith(SUFFIX)

/**
 * The recut units' as-cut operations by unit (C4): what the input hash takes, so a recut
 * operation regenerates when it starts or stops being recut. Empty without recut units.
 */
export function recutAsCut(part: PartDTO): Readonly<Record<string, readonly OperationDTO[]>> {
  const out: Record<string, readonly OperationDTO[]> = {}
  for (const id of recutUnits(part)) out[id] = part.alreadyCutMarks?.[id]?.asCut ?? []
  return out
}

/**
 * The hidden as-cut removals of the plan's recut units. A unit whose as-cut operations no longer
 * evaluate in the part (a surface they stood on is gone) or that no plan operation machines has
 * none: it is then cut in full again (more air, never less material).
 */
export function asCutRemovals(plan: LoadedPlan, port: Region2dPort | undefined): AsCutRemoval[] {
  const dto = plan.dto.design.part
  const units = recutUnits(dto)
  if (units.size === 0) return []
  // the machining order: each design operation's plan operation index and setup index
  const placeOf = new Map<string, { index: number; setup: number }>()
  let index = 0
  plan.setups.forEach((s, si) => {
    for (const op of s.operations) {
      for (const id of op.designOperationIds)
        if (!placeOf.has(id)) placeOf.set(id, { index, setup: si })
      index++
    }
  })
  const out: AsCutRemoval[] = []
  for (const unit of units) {
    const asCut = dto.alreadyCutMarks?.[unit]?.asCut ?? []
    const own = dto.operations.filter((o) => unitOfOperation(dto, o.id) === unit)
    const places = own
      .map((o) => placeOf.get(o.id))
      .filter((p): p is { index: number; setup: number } => p !== undefined)
    if (asCut.length === 0 || places.length === 0) continue
    const first = places.reduce((a, b) => (b.index < a.index ? b : a))
    // the as-cut operations in place of the unit's current ones (where its first one was)
    const at = dto.operations.findIndex((o) => unitOfOperation(dto, o.id) === unit)
    const operations = [
      ...dto.operations.slice(0, at).filter((o) => !own.includes(o)),
      ...asCut,
      ...dto.operations.slice(at).filter((o) => !own.includes(o)),
    ]
    const variant = partFromDTO({ ...dto, operations })
    if (variant.isErr()) continue
    const input = toGeometryInput(variant.unwrap(), plan.stock, port)
    if (input.isErr()) continue
    const ids = new Set(asCut.map((o) => o.id))
    for (const g of input.unwrap().operations)
      if (ids.has(g.id))
        out.push({
          geometry: { ...g, id: g.id + SUFFIX },
          unit,
          index: first.index,
          setup: first.setup,
        })
  }
  return out
}
