/**
 * Planar face surfaces of a part (the surface table, per direction), the design reference
 * resolver, operation references, the dependency graph and recalculation after an edit.
 * Doc: docs/modes/design.md#implementation-task-25,
 * docs/modes/design-v0.2.md#surface-table-per-direction,
 * docs/architecture/quantities.md#expressions-and-references
 *
 * Surface levels come from the analytic model (exact rationals with worst-case tolerance
 * intervals), never from a mesh.
 */
import type { AppError } from '../../shared/errors/app-error'
import { Err, fail, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import type { ReferenceResolver } from '../expression/evaluate'
import { DependencyGraph } from '../expression/graph'
import { reevaluate, referencesOf } from '../expression/quantity'
import {
  DIRECTION,
  DIRECTIONS,
  STOCK_FACE,
  type Axis,
  type Direction,
  type StockDimension,
} from '../geometry/face'
import { CHORD_TOLERANCE } from '../geometry/model'
import type { Stock } from '../library/stock'
import { Quantity } from '../quantity/quantity'
import { Rational } from '../quantity/rational'
import { Tolerance } from '../quantity/tolerance'
import { roundRadius, roundRadiusHolds } from './round'
import {
  bottomEdgeFace,
  isGeneralShape,
  quantityParams,
  withParam,
  type Operation,
  type Part,
  type Shape,
} from './operation'

/** A level (or coordinate) as an interval: nominal plus exact deviations (0/0 when untoleranced). */
export interface SurfaceLevel {
  readonly value: Rational
  readonly upper: Rational
  readonly lower: Rational
  readonly toleranced: boolean
}

export interface SurfaceEntry {
  readonly id: string
  /** Index of the creating operation; −1 for stock surfaces. */
  readonly owner: number
  /** Outward normal: the approach direction of operations on this face. */
  readonly direction: Direction
  /** Signed coordinate along the normal (`n · p`): deeper is lower. */
  readonly level: SurfaceLevel
  /**
   * Nominal level relative to the stock face of its direction: 0 on the stock face, −depth below
   * it. The z of the face frame (on `+z` the part-frame z, as in v0.1).
   */
  readonly faceZ: Rational
  /** May be an operation's `on` (stock faces, floors, tab tops). */
  readonly onTarget: boolean
}

export const STOCK_TOP = STOCK_FACE['+z']

/** The six stock face ids (the valid `on` of a facing or profile). */
export const STOCK_FACES: readonly string[] = DIRECTIONS.map((d) => STOCK_FACE[d])

const zero = Rational.ZERO
const exactLevel = (value: Rational): SurfaceLevel => ({
  value,
  upper: zero,
  lower: zero,
  toleranced: false,
})

function ofQuantity(q: Quantity): SurfaceLevel {
  if (q.tolerance.isNone()) return exactLevel(q.exact)
  const t = q.tolerance.unwrap()
  return { value: q.exact, upper: t.upper, lower: t.lower, toleranced: true }
}

/** a − b with worst-case deviations. */
function minus(a: SurfaceLevel, b: SurfaceLevel): SurfaceLevel {
  return {
    value: a.value.sub(b.value),
    upper: a.upper.sub(b.lower),
    lower: a.lower.sub(b.upper),
    toleranced: a.toleranced || b.toleranced,
  }
}

const neg = (a: SurfaceLevel): SurfaceLevel => minus(exactLevel(zero), a)
const plus = (a: SurfaceLevel, b: SurfaceLevel): SurfaceLevel => minus(a, neg(b))

/**
 * Half the narrowest size (float64 mm), as geometry's `inradius`; undefined for a general shape
 * (named or rotated), whose width needs the 2D layer (K4).
 */
export function inradius(s: Shape): number | undefined {
  if (isGeneralShape(s)) return undefined
  if (s.kind === 'circle') return s.diameter.canonical / 2
  if (s.kind === 'rectangle') return Math.min(s.length.canonical, s.width.canonical) / 2
  return undefined
}

/**
 * Whether an `inside` profile's slot covers the whole opening, so no tabs are built
 * (the geometry rule, docs/architecture/geometry.md#building-the-solids). General shapes: never
 * (their width is a 2D-layer check, K4; G1 builds their tabs).
 */
export function slotCoversOpening(op: Extract<Operation, { kind: 'profile' }>): boolean {
  const r = inradius(op.shape)
  return op.side === 'inside' && r !== undefined && r - op.slotWidth.canonical <= CHORD_TOLERANCE
}

/**
 * Whether a named shape is an open path (a single open `path` item): read from the definition,
 * so it needs no 2D port.
 */
export function isOpenShape(s: Shape, shapes: Part['shapes']): boolean {
  if (s.kind !== 'named') return false
  const items = shapes?.get(s.shapeId)?.items
  return items?.length === 1 && items[0]!.kind === 'path' && !items[0]!.closed
}

/**
 * Number of tabs a profile builds: the given positions, else `count`; none when the slot covers
 * an inside opening, and none on a blind `on` groove or an open path (tabs hold a through cut of
 * a closed loop only, design-v0.3.md#cut-side-and-open-shapes).
 */
export function builtTabs(
  op: Extract<Operation, { kind: 'profile' }>,
  shapes?: Part['shapes'],
): number {
  if (slotCoversOpening(op)) return 0
  if (op.depth.isSome() || isOpenShape(op.shape, shapes)) return 0
  if (op.tabs.positions.isSome()) return op.tabs.positions.unwrap().length
  const n = op.tabs.count.canonical
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** Stock levels per direction, with the stock's tolerances. */
class StockLevels {
  constructor(private readonly stock: Stock) {}
  private size(d: StockDimension): SurfaceLevel {
    return ofQuantity(this.stock[d])
  }
  /** Level of the stock face of `direction`. */
  face(direction: Direction): SurfaceLevel {
    const f = DIRECTION[direction].faceLevel
    return f === undefined ? exactLevel(zero) : this.size(f)
  }
  /** Stock extent along the normal of `direction` (T, L or W). */
  extent(direction: Direction): SurfaceLevel {
    return this.size(DIRECTION[direction].extent)
  }
}

/** `SurfaceTable.of`: tables by operations array, then stock (weakly held). */
const memo = new WeakMap<readonly Operation[], WeakMap<Stock, SurfaceTable>>()

/** Planar face surfaces in design order: the six stock faces, then each operation's. */
export class SurfaceTable {
  private constructor(
    private readonly entries: ReadonlyMap<string, SurfaceEntry>,
    private readonly levels: StockLevels,
  ) {}

  /** `shapes`: the part's loaded named shapes (an open path builds no tabs, `builtTabs`). */
  static build(ops: readonly Operation[], stock: Stock, shapes?: Part['shapes']): SurfaceTable {
    const map = new Map<string, SurfaceEntry>()
    const levels = new StockLevels(stock)
    const put = (
      id: string,
      owner: number,
      direction: Direction,
      level: SurfaceLevel,
      onTarget: boolean,
    ) =>
      map.set(id, {
        id,
        owner,
        direction,
        level,
        faceZ: level.value.sub(levels.face(direction).value),
        onTarget,
      })
    for (const d of DIRECTIONS) put(STOCK_FACE[d], -1, d, levels.face(d), true)
    ops.forEach((op, i) => {
      // `on` must be earlier; a dangling `on` leaves the surface out (reported by checkReferences
      // and the `onSurface` rule)
      const on = (id: string): Option<SurfaceEntry> => {
        const e = map.get(id)
        return e !== undefined && e.owner < i ? Some(e) : None
      }
      const below = (id: string, depth: Quantity, role: string, onTarget: boolean) =>
        on(id).map((e) =>
          put(`${op.id}.${role}`, i, e.direction, minus(e.level, ofQuantity(depth)), onTarget),
        )
      switch (op.kind) {
        case 'facing':
          below(op.on, op.depth, 'floor', true)
          break
        case 'pocket':
          // a through pocket (patterns P4): its "floor" is the opposite stock face, nothing
          // stands on it (docs/modes/patterns.md#implementation-p4)
          // DF108: a roughing pocket's floor is the pattern pocket's; nothing stands on it
          if (op.roughing === true && op.through !== true) below(op.on, op.depth, 'floor', false)
          else if (op.through === true)
            on(op.on).map((e) =>
              put(
                `${op.id}.floor`,
                i,
                e.direction,
                minus(levels.face(e.direction), levels.extent(e.direction)),
                false,
              ),
            )
          else below(op.on, op.depth, 'floor', true)
          break
        case 'drilling':
          if (op.bottom === 'flat' && op.depth.isSome())
            below(op.on, op.depth.unwrap(), 'bottom', false)
          break
        case 'profile':
          // a blind `on` groove has a floor (G1, docs/architecture/shapes.md#implementation-g1);
          // DF122 R4: a roughing profile's floor and tabs are its owner's (no targets of its own)
          if (op.depth.isSome()) below(op.on, op.depth.unwrap(), 'floor', op.roughing !== true)
          if (op.roughing === true) break
          on(op.on).map((e) => {
            // measured up from the opposite stock face along the profile's normal
            const d = e.direction
            const opposite = minus(levels.face(d), levels.extent(d))
            const top = plus(opposite, ofQuantity(op.tabs.thickness))
            for (let t = 0; t < builtTabs(op, shapes); t++)
              put(`${op.id}.tab[${t}].top`, i, d, top, true)
          })
          break
      }
    })
    return new SurfaceTable(map, levels)
  }

  /**
   * `build(ops, stock)` once per (operations array, stock) – both immutable models – for code
   * that asks per operation of one part (the plan's tool checks and hole depths, hardening P4:
   * a table per plan operation made plan creation and export quadratic in operations).
   * Doc: docs/research/s6-clone-budgets.md#follow-up-p4
   */
  static of(ops: readonly Operation[], stock: Stock): SurfaceTable {
    let byStock = memo.get(ops)
    if (byStock === undefined) memo.set(ops, (byStock = new WeakMap()))
    let table = byStock.get(stock)
    if (table === undefined) byStock.set(stock, (table = SurfaceTable.build(ops, stock)))
    return table
  }

  get(id: string): Option<SurfaceEntry> {
    const e = this.entries.get(id)
    return e === undefined ? None : Some(e)
  }

  /** Surfaces an operation at `index` may reference: the stock's and earlier operations'. */
  before(index: number): readonly SurfaceEntry[] {
    return [...this.entries.values()].filter((e) => e.owner < index)
  }

  /** Nominal stock extent along the normal of `direction` (T, L or W). */
  extent(direction: Direction): Rational {
    return this.levels.extent(direction).value
  }

  /**
   * Expression resolver for an operation at `index`: `<surface>.<axis>`, `.<axis>.min`,
   * `.<axis>.max`, the part-frame coordinate on the axis of the surface's normal
   * (design-v0.2.md#formula-names). A name on another axis is unknown.
   */
  resolver(index: number): ReferenceResolver {
    return {
      resolve: (name) => {
        const m = /^(.+)\.([xyz])(?:\.(min|max))?$/.exec(name)
        if (m === null) return None
        const e = this.entries.get(m[1]!)
        if (e === undefined || e.owner >= index) return None
        if (DIRECTION[e.direction].axis !== (m[2] as Axis)) return None
        return surfaceQuantity(name, coordinate(e), m[3] as 'min' | 'max' | undefined)
      },
    }
  }
}

/** Part-frame coordinate of a surface on its normal's axis (`sign · level`). */
export function coordinate(e: SurfaceEntry): SurfaceLevel {
  return DIRECTION[e.direction].sign > 0 ? e.level : neg(e.level)
}

/** Formula name of a surface's coordinate, e.g. `pocket1.floor.z`, `stock.side[1].x`. */
export const coordinateName = (e: SurfaceEntry): string => `${e.id}.${DIRECTION[e.direction].axis}`

function surfaceQuantity(name: string, s: SurfaceLevel, limit: 'min' | 'max' | undefined) {
  const exact =
    limit === 'max' ? s.value.add(s.upper) : limit === 'min' ? s.value.add(s.lower) : s.value
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

/**
 * Surface id of an expression reference (`pocket1.floor.z.max` → `pocket1.floor`,
 * `stock.side[1].x` → `stock.side[1]`).
 */
export const surfaceOfReference = (ref: string): string => ref.replace(/\.[xyz](\.(min|max))?$/, '')

export function operationReferences(op: Operation): AppResult<OperationReference[]> {
  const out: OperationReference[] = []
  // a facing's or profile's `on` is a stock face: always there, and removed by a facing itself
  if (op.kind === 'pocket' || op.kind === 'drilling' || op.kind === 'chamfer' || op.kind === 'line')
    out.push({ param: 'on', reference: op.on, surface: op.on })
  for (const p of quantityParams(op)) {
    const refs = referencesOf(p.value)
    if (refs.isErr()) return Err(refs.unwrapErr().withContext('operationReferences', { op: op.id }))
    for (const r of refs.unwrap())
      out.push({ param: p.path, reference: r, surface: surfaceOfReference(r) })
  }
  return Ok(out)
}

/**
 * Dependants of each surface in `surfaces` (docs/modes/construction-surfaces.md#check-dfmsurfacecutaway):
 * the operations whose `on` or a formula references it, or that depend on such an operation
 * (reference one of its surfaces, or chamfer its edge via `edgeOf`), transitively. Owned
 * operations of features count like any other. Ids in design order; surfaces without
 * dependants are left out.
 */
export function surfaceDependants(
  ops: readonly Operation[],
  table: SurfaceTable,
  surfaces: Iterable<string>,
): AppResult<Record<string, string[]>> {
  // per operation: the surfaces it references and the earlier operations it depends on
  const refs: Set<string>[] = []
  const on: Set<number>[] = []
  const index = new Map(ops.map((o, i) => [o.id, i]))
  for (const op of ops) {
    const r = operationReferences(op)
    if (r.isErr()) return Err(r.unwrapErr().withContext('surfaceDependants', { op: op.id }))
    const names = new Set(r.unwrap().map((x) => x.surface))
    const deps = new Set<number>()
    for (const n of names) {
      const e = table.get(n)
      if (e.isSome() && e.unwrap().owner >= 0) deps.add(e.unwrap().owner)
    }
    if (op.kind === 'chamfer' && index.has(op.edgeOf)) deps.add(index.get(op.edgeOf)!)
    refs.push(names)
    on.push(deps)
  }
  const out: Record<string, string[]> = {}
  for (const surface of new Set(surfaces)) {
    const found = new Set<number>()
    // dependencies always point to earlier operations: one pass in design order
    ops.forEach((_, i) => {
      if (refs[i]!.has(surface) || [...on[i]!].some((d) => found.has(d))) found.add(i)
    })
    if (found.size > 0) out[surface] = [...found].map((i) => ops[i]!.id)
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
    // a chamfer's edge is an operation, not a surface (design-v0.4.md § Chamfer operation, Order)
    if (op.kind === 'chamfer' && !ops.slice(0, i).some((o) => o.id === op.edgeOf))
      dependants.push({ operationId: op.id, param: 'edgeOf', reference: op.edgeOf })
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
 * Nodes: each expression parameter (depends on what it references) and each surface's coordinate
 * (`.z`, or `.x` / `.y` on side faces)
 * (depends on its `on` surface, its operation's parameters as a whole and each of its
 * operation's expression parameters, so a chain through an operation's own formula is complete:
 * `facing1.floor.z` → `pocket1#depth` → `pocket1.floor.z` → `pocket2#depth`).
 */
export function designGraph(ops: readonly Operation[], stock: Stock): AppResult<DependencyGraph> {
  const table = SurfaceTable.build(ops, stock)
  const nodes = new Map<string, readonly string[]>()
  for (const [i, op] of ops.entries()) {
    const formulas: string[] = []
    for (const p of quantityParams(op)) {
      const refs = referencesOf(p.value)
      if (refs.isErr()) return Err(refs.unwrapErr())
      if (refs.unwrap().length === 0) continue
      const node = paramNode(op.id, p.path)
      nodes.set(node, refs.unwrap())
      formulas.push(node)
    }
    const onEntry = table.get(op.on)
    const on = onEntry.isSome() ? [coordinateName(onEntry.unwrap())] : []
    for (const e of table.before(i + 1))
      if (e.owner === i) nodes.set(coordinateName(e), [...on, paramsNode(op.id), ...formulas])
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
  return Ok(followRound(followEdges(next)))
}

/**
 * DF120: every Round rectangle's `cornerRadius` set to half its narrowest side again, after a
 * recalculation changed its sizes (docs/modes/hole-slots-and-round-corners.md#model). Pure;
 * unchanged operations keep their identity.
 */
export function followRound(ops: readonly Operation[]): Operation[] {
  return ops.map((op) => {
    if (op.kind !== 'pocket' && op.kind !== 'profile') return op
    const s = op.shape
    if (s.kind !== 'rectangle' || s.round !== true) return op
    if (roundRadiusHolds(s.length, s.width, s.cornerRadius)) return op
    return { ...op, shape: { ...s, cornerRadius: roundRadius(s.length, s.width) } }
  })
}

/**
 * Chamfers keep their edge's face: each chamfer's `on` is set to its `edgeOf` operation's `on`
 * (an edited drilling moved to another face takes its chamfers along). A bottom chamfer (E4b)
 * stays on the face opposite its through profile's; one whose profile stopped being through (or
 * moved to a side) follows the profile's face. A one-sided chamfer of a top-face Line on a top
 * facing's floor stays there (DF155). Pure; unchanged operations keep their identity.
 */
export function followEdges(ops: readonly Operation[]): Operation[] {
  const byId = new Map(ops.map((o) => [o.id, o]))
  return ops.map((op) => {
    if (op.kind !== 'chamfer') return op
    const edge = byId.get(op.edgeOf)
    if (edge === undefined || edge.on === op.on || op.on === bottomEdgeFace(edge)) return op
    // DF155: a one-sided chamfer of a top-face Line may stand on a top facing's floor
    const floor = ops.find((o) => `${o.id}.floor` === op.on)
    if (
      edge.kind === 'line' &&
      edge.on === STOCK_TOP &&
      op.edgeSide.isSome() &&
      floor?.kind === 'facing' &&
      floor.on === STOCK_TOP
    )
      return op
    return { ...op, on: edge.on }
  })
}

function dependantError(e: AppError, opId: string, path: string): AppError {
  return e
    .prefixIssues('operations', opId, ...path.split('.'))
    .withContext('recalculate', { operationId: opId, param: path })
}
