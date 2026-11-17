/**
 * Horizontal planar surfaces of a part, the design reference resolver, operation references,
 * the dependency graph and recalculation after an edit.
 * Doc: docs/modes/design.md#implementation-task-25,
 * docs/architecture/quantities.md#expressions-and-references
 *
 * Surface z values come from the analytic model (exact rationals with worst-case tolerance
 * intervals), never from a mesh.
 */
import type { AppError } from '../../shared/errors/app-error'
import { Err, fail, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import type { ReferenceResolver } from '../expression/evaluate'
import { DependencyGraph } from '../expression/graph'
import { reevaluate, referencesOf } from '../expression/quantity'
import { CHORD_TOLERANCE } from '../geometry/model'
import type { Stock } from '../library/stock'
import { Quantity } from '../quantity/quantity'
import { Rational } from '../quantity/rational'
import { Tolerance } from '../quantity/tolerance'
import { quantityParams, withParam, type Operation, type Shape } from './operation'

/** A z value as an interval: nominal plus exact deviations (0/0 when untoleranced). */
export interface SurfaceZ {
  readonly z: Rational
  readonly upper: Rational
  readonly lower: Rational
  readonly toleranced: boolean
}

export interface SurfaceEntry {
  readonly id: string
  /** Index of the creating operation; −1 for stock surfaces. */
  readonly owner: number
  readonly z: SurfaceZ
  /** May be an operation's `on` (stock top, floors, tab tops). */
  readonly onTarget: boolean
}

export const STOCK_TOP = 'stock.top'

const zero = Rational.ZERO
const exactZ = (z: Rational): SurfaceZ => ({ z, upper: zero, lower: zero, toleranced: false })

function ofQuantity(q: Quantity): SurfaceZ {
  if (q.tolerance.isNone()) return exactZ(q.exact)
  const t = q.tolerance.unwrap()
  return { z: q.exact, upper: t.upper, lower: t.lower, toleranced: true }
}

/** a − b with worst-case deviations. */
function minus(a: SurfaceZ, b: SurfaceZ): SurfaceZ {
  return {
    z: a.z.sub(b.z),
    upper: a.upper.sub(b.lower),
    lower: a.lower.sub(b.upper),
    toleranced: a.toleranced || b.toleranced,
  }
}

const neg = (a: SurfaceZ): SurfaceZ => minus(exactZ(zero), a)

/** Half the narrowest size (float64 mm), as geometry's `inradius`. */
export function inradius(s: Shape): number {
  return s.kind === 'circle'
    ? s.diameter.canonical / 2
    : Math.min(s.length.canonical, s.width.canonical) / 2
}

/**
 * Whether an `inside` profile's slot covers the whole opening, so no tabs are built
 * (the geometry rule, docs/architecture/geometry.md#building-the-solids).
 */
export function slotCoversOpening(op: Extract<Operation, { kind: 'profile' }>): boolean {
  return op.side === 'inside' && inradius(op.shape) - op.slotWidth.canonical <= CHORD_TOLERANCE
}

/** Number of tabs a profile builds (0 when the slot covers an inside opening). */
export function builtTabs(op: Extract<Operation, { kind: 'profile' }>): number {
  if (slotCoversOpening(op)) return 0
  const n = op.tabs.count.canonical
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** Horizontal planar surfaces in design order: the stock's, then each operation's. */
export class SurfaceTable {
  private constructor(private readonly entries: ReadonlyMap<string, SurfaceEntry>) {}

  static build(ops: readonly Operation[], stock: Stock): SurfaceTable {
    const map = new Map<string, SurfaceEntry>()
    const thickness = ofQuantity(stock.thickness)
    const put = (id: string, owner: number, z: SurfaceZ, onTarget: boolean) =>
      map.set(id, { id, owner, z, onTarget })
    put(STOCK_TOP, -1, exactZ(zero), true)
    put('stock.bottom', -1, neg(thickness), false)
    ops.forEach((op, i) => {
      // `on` must be earlier; a dangling `on` leaves the surface out (reported by checkReferences)
      const on = (id: string): Option<SurfaceZ> => {
        const e = map.get(id)
        return e !== undefined && e.owner < i ? Some(e.z) : None
      }
      switch (op.kind) {
        case 'facing':
          put(`${op.id}.floor`, i, neg(ofQuantity(op.depth)), true)
          break
        case 'pocket':
          on(op.on).map((z) => put(`${op.id}.floor`, i, minus(z, ofQuantity(op.depth)), true))
          break
        case 'drilling':
          if (op.bottom === 'flat' && op.depth.isSome()) {
            const depth = ofQuantity(op.depth.unwrap())
            on(op.on).map((z) => put(`${op.id}.bottom`, i, minus(z, depth), false))
          }
          break
        case 'profile': {
          const top = minus(ofQuantity(op.tabs.thickness), thickness)
          for (let t = 0; t < builtTabs(op); t++) put(`${op.id}.tab[${t}].top`, i, top, true)
          break
        }
      }
    })
    return new SurfaceTable(map)
  }

  get(id: string): Option<SurfaceEntry> {
    const e = this.entries.get(id)
    return e === undefined ? None : Some(e)
  }

  /** Surfaces an operation at `index` may reference: the stock's and earlier operations'. */
  before(index: number): readonly SurfaceEntry[] {
    return [...this.entries.values()].filter((e) => e.owner < index)
  }

  /** Expression resolver for an operation at `index` (`<surface>.z`, `.z.min`, `.z.max`). */
  resolver(index: number): ReferenceResolver {
    return {
      resolve: (name) => {
        const m = /^(.+)\.z(?:\.(min|max))?$/.exec(name)
        if (m === null) return None
        const e = this.entries.get(m[1]!)
        if (e === undefined || e.owner >= index) return None
        return surfaceQuantity(name, e.z, m[2] as 'min' | 'max' | undefined)
      },
    }
  }
}

function surfaceQuantity(name: string, s: SurfaceZ, limit: 'min' | 'max' | undefined) {
  const exact = limit === 'max' ? s.z.add(s.upper) : limit === 'min' ? s.z.add(s.lower) : s.z
  const tol =
    limit === undefined && s.toleranced
      ? Tolerance.create({
          notation: s.upper.equals(s.lower.neg()) ? 'symmetric' : 'deviations',
          upper: s.upper,
          lower: s.lower,
        }).ok()
      : None
  return Quantity.create({
    kind: 'length',
    source: name.slice(0, 256),
    defaultUnit: 'mm',
    exact,
    tolerance: tol,
  }).ok()
}

// ── references ────────────────────────────────────────────────────────────────────────────

/** One reference of an operation: the parameter it is in and the surface it names. */
export interface OperationReference {
  readonly param: string
  /** As written (`facing1.floor.z.max`, or the `on` surface id). */
  readonly reference: string
  readonly surface: string
}

/** Surface id of an expression reference (`pocket1.floor.z.max` → `pocket1.floor`). */
export const surfaceOfReference = (ref: string): string => ref.replace(/\.z(\.(min|max))?$/, '')

export function operationReferences(op: Operation): AppResult<OperationReference[]> {
  const out: OperationReference[] = []
  if (op.kind === 'pocket' || op.kind === 'drilling')
    out.push({ param: 'on', reference: op.on, surface: op.on })
  for (const p of quantityParams(op)) {
    const refs = referencesOf(p.value)
    if (refs.isErr()) return Err(refs.unwrapErr().withContext('operationReferences', { op: op.id }))
    for (const r of refs.unwrap())
      out.push({ param: p.path, reference: r, surface: surfaceOfReference(r) })
  }
  return Ok(out)
}

export interface Dependant {
  readonly operationId: string
  readonly param: string
  readonly reference: string
}

/**
 * Every reference must name a surface of the stock or of an earlier operation
 * (docs/modes/design.md#ordering-and-composition); otherwise `design.referenced` listing the
 * dependants.
 */
export function checkReferences(ops: readonly Operation[], stock: Stock): AppResult<void> {
  const table = SurfaceTable.build(ops, stock)
  const dependants: Dependant[] = []
  for (const [i, op] of ops.entries()) {
    const refs = operationReferences(op)
    if (refs.isErr()) return Err(refs.unwrapErr())
    for (const r of refs.unwrap()) {
      const e = table.get(r.surface)
      if (e.isNone() || e.unwrap().owner >= i)
        dependants.push({ operationId: op.id, param: r.param, reference: r.reference })
    }
  }
  if (dependants.length === 0) return Ok(undefined)
  const names = [...new Set(dependants.map((d) => d.operationId))]
  return fail('design.referenced', `referenced by later operations: ${names.join(', ')}`, {
    issues: dependants.map((d) => ({
      path: ['operations', d.operationId, ...d.param.split('.')],
      rule: 'referenced',
      message: `${d.reference} is not a surface of the stock or an earlier operation`,
      params: { operationId: d.operationId, reference: d.reference },
    })),
    where: 'checkReferences',
    data: { dependants: names },
  })
}

// ── dependency graph and recalculation ────────────────────────────────────────────────────

/** Graph node of an operation's own parameters as a whole (an input of its surfaces). */
const paramsNode = (opId: string) => `${opId}#params`
/** Graph node of one expression parameter. */
const paramNode = (opId: string, path: string) => `${opId}#${path}`

/**
 * Nodes: each surface's `.z` (depends on its `on` surface and its operation's parameters) and
 * each expression parameter (depends on what it references).
 */
export function designGraph(ops: readonly Operation[], stock: Stock): AppResult<DependencyGraph> {
  const table = SurfaceTable.build(ops, stock)
  const nodes = new Map<string, readonly string[]>()
  for (const [i, op] of ops.entries()) {
    const on = op.kind === 'pocket' || op.kind === 'drilling' ? [`${op.on}.z`] : []
    for (const e of table.before(i + 1))
      if (e.owner === i) nodes.set(`${e.id}.z`, [...on, paramsNode(op.id)])
    for (const p of quantityParams(op)) {
      const refs = referencesOf(p.value)
      if (refs.isErr()) return Err(refs.unwrapErr())
      if (refs.unwrap().length > 0) nodes.set(paramNode(op.id, p.path), refs.unwrap())
    }
  }
  return DependencyGraph.create(nodes)
}

/**
 * After operation `changedId` was edited: re-evaluate the expression parameters that depend on
 * it (`DependencyGraph.affectedBy`), in evaluation order. Errors name the dependant
 * (issue path `operations.<id>.<param>`).
 */
export function recalculate(
  ops: readonly Operation[],
  stock: Stock,
  changedId: string,
): AppResult<Operation[]> {
  const graph = designGraph(ops, stock)
  if (graph.isErr()) return Err(graph.unwrapErr())
  const next = [...ops]
  for (const node of graph.unwrap().affectedBy([paramsNode(changedId)])) {
    const hash = node.indexOf('#')
    if (hash < 0) continue // a surface: derived on demand from the table
    const opId = node.slice(0, hash)
    const path = node.slice(hash + 1)
    const index = next.findIndex((o) => o.id === opId)
    const op = next[index]!
    const current = quantityParams(op).find((p) => p.path === path)!.value
    const table = SurfaceTable.build(next, stock)
    const r = reevaluate(current, table.resolver(index))
    if (r.isErr()) return Err(dependantError(r.unwrapErr(), opId, path))
    next[index] = withParam(op, path, r.unwrap())
  }
  return Ok(next)
}

function dependantError(e: AppError, opId: string, path: string): AppError {
  return e
    .prefixIssues('operations', opId, ...path.split('.'))
    .withContext('recalculate', { operationId: opId, param: path })
}
