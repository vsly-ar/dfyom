/**
 * Validity of a plan's part against its own stock copy, and comparison by value.
 * Doc: docs/modes/plan-v0.1.md#implementation-task-213
 *
 * A plan's part was valid for the design's stock snapshot; the plan's stock copy may differ
 * (re-imported from the library), so re-imports and rebuilds re-check the part against it.
 */
import { Err, fail, type AppResult } from '../../shared/result'
import { partFromDTO } from '../design/operation'
import type { PartDTO } from '../design/part.dto'
import { checkReferences } from '../design/surfaces'
import { checkOperations } from '../design/validate'
import type { LibraryItem } from '../library/library-item'
import { Snapshot, type SnapshotDTO } from '../library/snapshot'
import { Stock } from '../library/stock'
import type { ProjectDoc } from '../project/document'
import type { PlanDTO } from './plan.dto'

/** The part's references and constraints against a stock copy (`model.invariant`, `design.referenced`). */
export function checkPartFits(part: PartDTO, stock: SnapshotDTO, where: string): AppResult<void> {
  const model = partFromDTO(part)
  if (model.isErr()) return Err(model.unwrapErr().withContext(where))
  const values = Snapshot.fromDTO(stock).map((s) => s.values)
  if (values.isErr()) return Err(values.unwrapErr().withContext(where))
  const s = values.unwrap()
  if (!(s instanceof Stock))
    return fail('input.malformed', `copy ${stock.id} is not a stock`, { where })
  const ops = model.unwrap().operations
  return checkReferences(ops, s)
    .andThen(() => checkOperations(ops, s))
    .mapErr((e) => e.withContext(where))
}

/** The stock copy a part resolves to in a plan (after a rebuild: the design's, if new). */
export function stockCopyFor(
  plan: PlanDTO,
  part: PartDTO,
  doc: ProjectDoc,
): SnapshotDTO | undefined {
  return (
    plan.snapshots.find((s) => s.id === part.stock) ??
    (Object.hasOwn(doc.snapshots, part.stock) ? doc.snapshots[part.stock] : undefined)
  )
}

const reason = (r: AppResult<void>): string | undefined =>
  r.isOk()
    ? undefined
    : [
        r.unwrapErr().message,
        ...r.unwrapErr().issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      ]
        .slice(0, 3)
        .join('; ')

/**
 * Why re-importing a copy from `item` cannot be applied (only stock copies can fail: the part
 * must fit the new stock), else undefined.
 */
export function libraryUpdateBlocker(
  plan: PlanDTO,
  copy: SnapshotDTO,
  item: LibraryItem,
): string | undefined {
  if (copy.kind !== 'stock' || item.values.kind !== 'stock') return undefined
  const next = { ...copy, values: item.values.toDTO() } as SnapshotDTO
  const why = reason(checkPartFits(plan.design.part, next, 'plan.libraryItem.update'))
  return why === undefined
    ? undefined
    : `library update of stock "${item.values.name}" can't be applied: the part doesn't fit (${why})`
}

/** Why rebuilding from the current design is blocked by the plan's stock copy, else undefined. */
export function rebuildBlocker(plan: PlanDTO, doc: ProjectDoc): string | undefined {
  const part = Object.hasOwn(doc.parts, plan.design.partId)
    ? doc.parts[plan.design.partId]
    : undefined
  if (part === undefined) return undefined
  const stock = stockCopyFor(plan, part, doc)
  if (stock === undefined) return 'rebuild blocked: the stock copy is missing'
  const why = reason(checkPartFits(part, stock, 'plan.rebuild'))
  return why === undefined
    ? undefined
    : `rebuild blocked: the current design doesn't fit the plan's stock copy (${why})`
}

// ── comparison by value ────────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const isQuantity = (v: unknown): v is Rec =>
  isRec(v) && typeof v['kind'] === 'string' && typeof v['source'] === 'string' && isRec(v['exact'])

const sameRational = (a: unknown, b: unknown) =>
  isRec(a) && isRec(b) && a['num'] === b['num'] && a['den'] === b['den']

function sameQuantity(a: Rec, b: Rec): boolean {
  if (a['kind'] !== b['kind'] || !sameRational(a['exact'], b['exact'])) return false
  const ta = a['tolerance']
  const tb = b['tolerance']
  if (ta === undefined || tb === undefined) return ta === tb
  return (
    isRec(ta) &&
    isRec(tb) &&
    sameRational(ta['upper'], tb['upper']) &&
    sameRational(ta['lower'], tb['lower'])
  )
}

/**
 * Structural equality where quantities compare by exact value and tolerance deviations, not by
 * `source`, unit or notation (the design keeps the user's notation for display only).
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (isQuantity(a) && isQuantity(b)) return sameQuantity(a, b)
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
  if (!isRec(a) || !isRec(b)) return false
  const ka = Object.keys(a).filter((k) => a[k] !== undefined)
  const kb = Object.keys(b).filter((k) => b[k] !== undefined)
  return ka.length === kb.length && ka.every((k) => sameValue(a[k], b[k]))
}
