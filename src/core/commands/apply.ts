/**
 * Apply: pending changes since the last Apply, `project.apply` and `project.pending.get`.
 * Doc: docs/architecture/apply.md (pending changes, `project.apply`, queries for pending state)
 *
 * The dispatcher executes both built-ins (they need its history markers and jobs); this module
 * holds their definitions, the result schema and the pure pending computation.
 */
import { z } from 'zod'
import { fail, Ok } from '../../shared/result'
import { DesignToolDtoSchema, type PartDTO } from '../design/part.dto'
import { sameValue } from '../plan/validity'
import type { ProjectDoc } from '../project/document'
import type { Source } from './context'
import { defineQuery, type BuiltinCommand } from './define'

// ── pending changes ─────────────────────────────────────────────────────────────────────────

/** Kind of a pending change (apply.md § What is pending). */
export type PendingKind = 'design' | 'plan' | 'library'

/** One pending key; the count `N` is the number of these. */
export interface PendingChange {
  readonly kind: PendingKind
  readonly partId?: string
  /** A design operation (`design`), or a plan operation (`plan`). */
  readonly operationId?: string
  readonly planId?: string
  /** A named shape of the part (`design` keys of shapes, design-v0.3.md § Apply). */
  readonly shapeId?: string
  /** A setup of a plan (`plan` keys of setup fields). */
  readonly setupId?: string
  /** The changed library item (`library` keys). */
  readonly libraryItemId?: string
  /**
   * The changed field as a dotted path (`depth`, `shape.cornerRadius`, `stock`, a shape's
   * `items.2.radius`), or the structural change of an operation: `added`, `removed`, `moved`, of a
   * shape: `added`, `removed`, `items` (its item list) – one key each.
   */
  readonly field?: string
  /** For the tooltip: "Pocket 1: depth", "Drilling 2 added". */
  readonly label: string
}

/** A pending change with who made it: the last commit that touched its part (or plan). */
export interface PendingChangeInfo extends PendingChange {
  readonly source: Source
  readonly revision: number
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A quantity DTO is compared as one value (by `sameValue`), never field by field. */
const isQuantity = (v: unknown): boolean => isRec(v) && isRec(v['exact'])

/** Operation fields no deferred work reads (apply.md: "names and other fields"). */
const OPERATION_IGNORED = new Set(['id', 'kind', 'name'])
/** Part fields handled separately (`operations`) or read by no deferred work. */
const PART_IGNORED = new Set(['id', 'name', 'operations', 'shapes', 'stock'])
/** Shape item fields are all read (the definition); the shape's `name` and `source` are not. */
const ITEM_IGNORED: ReadonlySet<string> = new Set()

/**
 * Changed fields by value as dotted paths. Plain objects of the same `kind` (shape, tabs,
 * tolerances) recurse one level per nesting, so "corner radius" and "depth" count apart;
 * quantities, arrays (points) and objects of another kind are one field.
 */
export function changedFields(a: Rec, b: Rec, ignored: ReadonlySet<string>, prefix = ''): string[] {
  const out: string[] = []
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (prefix === '' && ignored.has(k)) continue
    const va = a[k]
    const vb = b[k]
    if (va === vb || sameValue(va, vb)) continue
    const nested =
      isRec(va) && isRec(vb) && !isQuantity(va) && !isQuantity(vb) && va['kind'] === vb['kind']
    if (nested) out.push(...changedFields(va, vb, ignored, `${prefix}${k}.`))
    else out.push(`${prefix}${k}`)
  }
  return out
}

/** Indices (into `seq`) of one longest strictly increasing subsequence. */
function longestIncreasing(seq: readonly number[]): Set<number> {
  const len = seq.map(() => 1)
  const prev = seq.map(() => -1)
  let best = -1
  for (let i = 0; i < seq.length; i++) {
    for (let j = 0; j < i; j++)
      if ((seq[j] ?? 0) < (seq[i] ?? 0) && (len[j] ?? 0) + 1 > (len[i] ?? 0)) {
        len[i] = (len[j] ?? 0) + 1
        prev[i] = j
      }
    if (best === -1 || (len[i] ?? 0) > (len[best] ?? 0)) best = i
  }
  const keep = new Set<number>()
  for (let i = best; i !== -1; i = prev[i] ?? -1) keep.add(i)
  return keep
}

/** Records whose order relative to the others changed: those outside a longest kept order. */
export function movedIds(
  before: readonly { readonly id: string }[],
  after: readonly { readonly id: string }[],
): string[] {
  const index = new Map(before.map((o, i) => [o.id, i]))
  const common = after.filter((o) => index.has(o.id))
  const keep = longestIncreasing(common.map((o) => index.get(o.id) ?? 0))
  return common.filter((_, i) => !keep.has(i)).map((o) => o.id)
}

function partChanges(doc: ProjectDoc, base: ProjectDoc, id: string): PendingChange[] {
  const before = Object.hasOwn(base.parts, id) ? base.parts[id] : undefined
  const after = Object.hasOwn(doc.parts, id) ? doc.parts[id] : undefined
  if (before === after && (after === undefined || stockSame(doc, base, after, after))) return []
  const design = (field: string, label: string, operationId?: string): PendingChange => ({
    kind: 'design',
    partId: id,
    ...(operationId === undefined ? {} : { operationId }),
    field,
    label,
  })
  // a new part is pending through its operations only (each an input of the tool choice): an
  // empty part, alone or with a reference model, has no derived work (apply.md § What is pending)
  if (before === undefined)
    return (after as PartDTO).operations.map((op) => design('added', `${op.name} added`, op.id))
  if (after === undefined) return [design('removed', `${before.name} removed`)]
  const out: PendingChange[] = []
  const fields = changedFields(after as unknown as Rec, before as unknown as Rec, PART_IGNORED)
  if (!stockSame(doc, base, after, before)) fields.unshift('stock')
  for (const f of fields) out.push(design(f, `${after.name}: ${f}`))
  out.push(...shapeChanges(id, after, before))
  if (before.operations === after.operations) return out
  const beforeOps = new Map(before.operations.map((o) => [o.id, o]))
  const afterIds = new Set(after.operations.map((o) => o.id))
  const moved = new Set(movedIds(before.operations, after.operations))
  for (const op of after.operations) {
    const old = beforeOps.get(op.id)
    if (old === undefined) {
      out.push(design('added', `${op.name} added`, op.id))
      continue
    }
    if (moved.has(op.id)) out.push(design('moved', `${op.name} moved`, op.id))
    if (old === op) continue
    for (const f of changedFields(op as unknown as Rec, old as unknown as Rec, OPERATION_IGNORED))
      out.push(design(f, `${op.name}: ${f}`, op.id))
  }
  for (const op of before.operations)
    if (!afterIds.has(op.id)) out.push(design('removed', `${op.name} removed`, op.id))
  return out
}

/**
 * Keys of the part's named shapes (design-v0.3.md § Apply and pending changes): (part, shape) for
 * an added or removed shape and a changed item list (count or an item's kind / `op`), else
 * (part, shape, item, field) per changed item field (`items.<n>.<field>`). Names and `source`
 * are not pending.
 */
function shapeChanges(id: string, after: PartDTO, before: PartDTO): PendingChange[] {
  if (after.shapes === before.shapes) return []
  const key = (shapeId: string, field: string, label: string): PendingChange => ({
    kind: 'design',
    partId: id,
    shapeId,
    field,
    label,
  })
  const out: PendingChange[] = []
  const old = new Map((before.shapes ?? []).map((s) => [s.id, s]))
  const afterIds = new Set<string>()
  for (const s of after.shapes ?? []) {
    afterIds.add(s.id)
    const b = old.get(s.id)
    if (b === undefined) {
      out.push(key(s.id, 'added', `${s.name} added`))
      continue
    }
    if (b === s || b.items === s.items) continue
    const listChanged =
      b.items.length !== s.items.length ||
      s.items.some((it, n) => it.kind !== b.items[n]!.kind || it.op !== b.items[n]!.op)
    if (listChanged) {
      if (!sameValue(b.items, s.items)) out.push(key(s.id, 'items', `${s.name}: items`))
      continue
    }
    s.items.forEach((it, n) => {
      const was = b.items[n]!
      if (it === was) return
      for (const f of changedFields(it as unknown as Rec, was as unknown as Rec, ITEM_IGNORED))
        out.push(key(s.id, `items.${n}.${f}`, `${s.name}: item ${n + 1} ${f}`))
    })
  }
  for (const b of before.shapes ?? [])
    if (!afterIds.has(b.id)) out.push(key(b.id, 'removed', `${b.name} removed`))
  return out
}

/** The part's stock: the same snapshot id with an equal snapshot value. */
function stockSame(doc: ProjectDoc, base: ProjectDoc, after: PartDTO, before: PartDTO): boolean {
  if (after.stock !== before.stock) return false
  const a = Object.hasOwn(doc.snapshots, after.stock) ? doc.snapshots[after.stock] : undefined
  const b = Object.hasOwn(base.snapshots, before.stock) ? base.snapshots[before.stock] : undefined
  return a === b || sameValue(a, b)
}

/** A pending change's identity (one count per key), to merge the keys of several sources. */
export function pendingKey(c: PendingChange): string {
  return [
    c.kind,
    c.partId,
    c.planId,
    c.setupId,
    c.operationId,
    c.shapeId,
    c.libraryItemId,
    c.field,
  ].join('\0')
}

/**
 * The design changes of `doc` against the `baseline` (the document at the last Apply), by
 * value (apply.md § What is pending): operations and part fields. The plan-input, draft-plan
 * and library keys come from the registry's `PendingSource`s (plan/pending.ts). Cost: both documents are immutable and share structure, so unchanged parts
 * and operations are skipped by reference; only touched ones are compared.
 */
export function pendingChanges(doc: ProjectDoc, baseline: ProjectDoc): PendingChange[] {
  if (doc === baseline) return []
  const ids = new Set([...Object.keys(baseline.parts), ...Object.keys(doc.parts)])
  return [...ids].flatMap((id) => partChanges(doc, baseline, id))
}

/** "Apply 3 changes" (history entry title, apply.md § Steps). */
export function applyTitle(changes: number): string {
  return `Apply ${changes} change${changes === 1 ? '' : 's'}`
}

// ── apply hooks and jobs: contributions to the outcome ──────────────────────────────────────

/** design-v0.2's `toolChange`: the auto choice replaced an operation's tool. */
export const ToolChangeSchema = z.object({
  partId: z.string(),
  operationId: z.string(),
  from: DesignToolDtoSchema.nullable().describe('The tool before Apply; null: none chosen yet'),
  to: DesignToolDtoSchema.describe('The tool after Apply'),
  reason: z.string().describe('Why the old tool was replaced (its failed fit rule)'),
})
export type ToolChange = z.output<typeof ToolChangeSchema>

/** What Apply did to one plan. */
export const PlanApplySchema = z.object({
  planId: z.string(),
  status: z.enum(['rebuilt', 'followed', 'blocked']),
  reason: z.string().optional().describe('Why the plan is blocked'),
})
export type PlanApply = z.output<typeof PlanApplySchema>

/** Part warnings after Apply (`design.warning.list` of each affected part). */
export const ApplyWarningsSchema = z.object({
  partId: z.string(),
  warnings: z.array(z.unknown()),
})

export const ApplyOutcomeSchema = z
  .object({
    changes: z.number().int().describe('Pending changes applied (0: nothing was pending)'),
    entrySeq: z
      .number()
      .int()
      .nullable()
      .describe(
        'Seq of the "Apply N changes" history entry; null when the document did not change',
      ),
    toolChanges: z.array(ToolChangeSchema),
    plans: z.array(PlanApplySchema),
    jobIds: z.array(z.string()).describe('Apply jobs started (toolpaths); wait with job_wait'),
    warnings: z.array(ApplyWarningsSchema).describe('DFM warnings of the affected parts'),
  })
  .describe('Result of an Apply')
export type ApplyOutcome = z.output<typeof ApplyOutcomeSchema>

export const EMPTY_APPLY: ApplyOutcome = {
  changes: 0,
  entrySeq: null,
  toolChanges: [],
  plans: [],
  jobIds: [],
  warnings: [],
}

// ── built-in command and query ──────────────────────────────────────────────────────────────

/**
 * `project.apply` (built-in): runs the apply hooks over all pending changes as one undo entry,
 * then starts the apply jobs. Executed by the dispatcher (dispatcher.ts `runApply`).
 */
export const projectApply: BuiltinCommand<z.ZodObject, ApplyOutcome> = {
  kind: 'builtin',
  name: 'project.apply',
  summary:
    'Apply all pending changes of the project (everyone’s): choose tools, update draft plans, regenerate toolpaths. One undo step.',
  title: () => 'Apply',
  machine: false,
  args: z.object({}),
  result: ApplyOutcomeSchema,
}

const PendingChangeSchema = z.object({
  kind: z.enum(['design', 'plan', 'library']),
  partId: z.string().optional(),
  operationId: z.string().optional().describe('Design or plan operation'),
  planId: z.string().optional(),
  shapeId: z.string().optional().describe('Named shape of the part'),
  setupId: z.string().optional(),
  libraryItemId: z.string().optional(),
  field: z.string().optional().describe('Changed field, or added / removed / moved'),
  label: z.string(),
  source: z.object({ kind: z.string(), id: z.string() }).describe('Who changed it last'),
  revision: z.number().int().describe('Revision of that change'),
})

export const LastApplySchema = z.object({
  entrySeq: z.number().int().nullable(),
  revision: z.number().int(),
  at: z.string(),
  source: z.object({ kind: z.string(), id: z.string() }),
})
export type LastApply = z.output<typeof LastApplySchema>

/** The dispatcher's Apply state, for `project.pending.get` and the `pendingApply` flags. */
export interface ApplyView {
  pending(): readonly PendingChangeInfo[]
  /** Ids of the running apply jobs. */
  readonly applying: readonly string[]
  readonly lastApply: LastApply | null
}

export const projectPendingGet = defineQuery({
  name: 'project.pending.get',
  summary: 'List the changes not applied yet (by everyone) and the running apply jobs.',
  args: z.object({}),
  result: z.object({
    count: z.number().int(),
    changes: z.array(PendingChangeSchema),
    applying: z.array(z.string()).describe('Running apply job ids'),
    lastApply: LastApplySchema.nullable(),
  }),
  // dispatcher state, not document values: no stale-write read
  readsDocument: false,
  run(_doc, _args, ctx) {
    const view = ctx.apply
    if (view === undefined)
      return fail('internal.unexpected', 'no apply state (query run outside a dispatcher)', {
        where: 'project.pending.get',
      })
    const changes = view
      .pending()
      .map((c) => ({ ...c, source: { kind: c.source.kind, id: c.source.id } }))
    return Ok({
      count: changes.length,
      changes,
      applying: [...view.applying],
      lastApply: view.lastApply,
    })
  },
})
