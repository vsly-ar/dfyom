/**
 * The Clones feature kind (v0.4 F5): a source (existing operations or one feature) nested in the
 * feature and repeated along a clone path; the clone instances are read-only owned operations,
 * step-major (source operation A on every position, then B: tool by tool, D34).
 * Doc: docs/modes/features.md#clones, docs/modes/design-v0.4.md#implementation-f5
 *
 * - **Source** (`source`): `{ operationIds }` (plain operations), `{ featureId }` (a whole
 *   feature, not Clones) or a group `{ featureIds, operationIds? }` (Clones v2, DF40: features,
 *   a Clones among them with its own source members, and plain operations). It stays where it is in the design order as instance 1, contiguous and
 *   right before the instances (the feature's span, feature.ts `nested`); its operations keep
 *   their ids and commands.
 * - **Instances** 2…N: role `<n>_<source operation id>` (id `clones1_3_pocket2`), the source
 *   operation translated in the Clones face frame, every quantity copied as a value (positions
 *   are the evaluated source position plus the path offset; expressions stay on the source). The
 *   name, tolerance and tool follow the source operation (C3, `ExpandedOperation.kept`).
 * - **Numbers are stable** (D30): every path position has a number whether or not it makes an
 *   instance (path.ts), so skipping keeps ids, references and tool fields of the others.
 */
import { z } from 'zod'
import { type Issue, type IssuePath, issueSummary } from '../../../shared/errors/app-error'
import { parseWith } from '../../../shared/parse'
import { collect, Err, fail, Ok, type AppResult } from '../../../shared/result'
import type { DfmWarning } from '../../geometry/model'
import type { Stock } from '../../library/stock'
import type { UnitSystem } from '../../project/document'
import { Quantity } from '../../quantity/quantity'
import { QuantityDtoSchema } from '../../quantity/quantity.dto'
import { Rational } from '../../quantity/rational'
import { UNITS } from '../../quantity/units'
import { isExpression, shiftLiteral } from '../anchor'
// types only: feature.ts registers this kind (BUILT_IN_KINDS) and imports this module
import type {
  ExpandedOperation,
  ExpansionContext,
  FeatureBase,
  FeatureKindSpec,
  LoadedFeature,
  SpanGeometry,
} from '../feature'
import type { FeatureDTO } from '../feature.dto'
import { NAME_MAX } from '../../library/item'
import { quantityParams, withParam, type FieldKind, type Operation } from '../operation'
import type { ShapeDTO } from '../shape.dto'
import { definitionOf, shapeFromDTO } from '../shape'
import { itemChain } from '../shape-items'
import { footprintBounds, footprintsOverlap, sourceFootprint } from './footprint'
import {
  alongStations,
  clonePath,
  rowPointCount,
  SAME_SPOT,
  type AlongChain,
  type ClonePath,
  type PathRow,
  type UV,
} from './path'

/** Most instances of one Clones feature, the source included (D36, spike S6). */
export const CLONES_MAX = 100

/** feature.ts `ownerOf`, here so this module needs no value from feature.ts (import cycle). */
const ownerOf = (op: Operation): string | undefined =>
  op.owner.isSome() ? op.owner.unwrap().featureId : undefined
/** Most positions one row may add. */
export const CLONE_ROW_MAX = 100
/** Most rows of one Clones feature. */
export const CLONE_ROWS_MAX = 20
/** Owned operations from which `dfm.clonesHeavy` notes a slower part update (S6: ≈ 3–5× the 50 ms evaluation budget at 100 holes). */
export const CLONES_HEAVY_OPERATIONS = 50

// ── rows ───────────────────────────────────────────────────────────────────────────────────

/**
 * The fields of each row kind: quantities (`q`, optional `oq`), whole numbers (`n`, optional
 * `on`) and strings (`s`: an `along` row's shape id).
 */
export const ROW_FIELDS = {
  grid: { q: { du: 'length', dv: 'length' }, oq: {}, n: ['cols', 'rows'], on: [], s: [] },
  offset: { q: { du: 'length', dv: 'length' }, oq: {}, n: ['count'], on: [], s: [] },
  polar: { q: { angle: 'angle', distance: 'length' }, oq: {}, n: ['count'], on: [], s: [] },
  arc: {
    q: { radius: 'length', angle: 'angle', arc: 'angle', step: 'angle' },
    oq: {},
    n: [],
    on: [],
    s: [],
  },
  point: { q: { u: 'length', v: 'length' }, oq: {}, n: [], on: [], s: [] },
  along: {
    q: {},
    oq: { start: 'length', spacing: 'length' },
    n: [],
    on: ['count'],
    s: ['shapeId'],
  },
} as const satisfies Record<
  PathRow['kind'],
  {
    q: Record<string, FieldKind>
    oq: Record<string, FieldKind>
    n: readonly string[]
    on: readonly string[]
    s: readonly string[]
  }
>

export type CloneRowKind = keyof typeof ROW_FIELDS
type RowFields<K extends CloneRowKind> = (typeof ROW_FIELDS)[K]
type RowOf<K extends CloneRowKind> = { readonly kind: K; readonly skip?: readonly number[] } & {
  readonly [F in keyof RowFields<K>['q']]: Quantity
} & { readonly [F in keyof RowFields<K>['oq']]?: Quantity } & {
  readonly [F in RowFields<K>['n'][number]]: number
} & { readonly [F in RowFields<K>['on'][number]]?: number } & {
  readonly [F in RowFields<K>['s'][number]]: string
}

/** One path row with quantities (path.ts `PathRow` with canonical numbers). */
export type CloneRow = { [K in CloneRowKind]: RowOf<K> }[CloneRowKind]

/** The quantity fields of a row kind, required then optional, with their kinds. */
export const rowQuantities = (kind: CloneRowKind): [string, FieldKind][] => [
  ...Object.entries(ROW_FIELDS[kind].q),
  ...Object.entries(ROW_FIELDS[kind].oq),
]

/**
 * `r` with its quantity fields mapped by `f` (absent optional ones left out), whole-number and
 * string fields copied, `skip` sorted and unique (left out when empty).
 */
export function mapRow<A, B>(
  r: { readonly kind: CloneRowKind },
  f: (a: A, field: string, kind: FieldKind) => B,
): Record<string, unknown> {
  const rec = r as unknown as Readonly<Record<string, unknown>>
  const out: Record<string, unknown> = { kind: r.kind }
  for (const [k, kind] of rowQuantities(r.kind))
    if (rec[k] !== undefined) out[k] = f(rec[k] as A, k, kind)
  const fields = ROW_FIELDS[r.kind]
  for (const k of [...fields.n, ...fields.on, ...fields.s])
    if (rec[k] !== undefined) out[k] = rec[k]
  const skip = rec['skip'] as readonly number[] | undefined
  if (skip !== undefined && skip.length > 0) out['skip'] = [...new Set(skip)].sort((a, b) => a - b)
  return out
}

export type ClonesSource =
  | { readonly operationIds: readonly string[] }
  | { readonly featureId: string }
  | {
      readonly featureIds: readonly string[]
      readonly operationIds?: readonly string[] | undefined
    }

/** Most features of a group source (Clones v2, G1). */
export const CLONES_GROUP_FEATURES = 20
/** Most owned operations of a Clones whose group holds a Clones (G2). */
export const CLONES_NESTED_OPERATIONS = 1000

/** The members of a source, any form: feature ids and plain operation ids (G1). */
export function sourceMembers(source: ClonesSource): {
  readonly featureIds: readonly string[]
  readonly operationIds: readonly string[]
} {
  if ('featureId' in source) return { featureIds: [source.featureId], operationIds: [] }
  if ('featureIds' in source)
    return { featureIds: source.featureIds, operationIds: source.operationIds ?? [] }
  return { featureIds: [], operationIds: source.operationIds }
}

/** A source in its stored form: one feature `{ featureId }`, operations only, else a group. */
export function sourceOf(
  featureIds: readonly string[],
  operationIds: readonly string[],
): ClonesSource {
  if (featureIds.length === 0) return { operationIds: [...operationIds] }
  if (featureIds.length === 1 && operationIds.length === 0 && !CLONES_ID.test(featureIds[0]!))
    return { featureId: featureIds[0]! }
  return operationIds.length === 0
    ? { featureIds: [...featureIds] }
    : { featureIds: [...featureIds], operationIds: [...operationIds] }
}

/**
 * The source as stored (G2): each member Clones' own source members joined to the group (after
 * it, in its order), operations owned by a member feature left out (they come with it), then the
 * stored form (`sourceOf`). Unknown ids stay for `sourceIssues` to name.
 */
export function normalizeSource(
  source: ClonesSource,
  features: readonly { readonly feature: FeatureBase }[],
  ops: readonly Operation[],
): ClonesSource {
  const m = sourceMembers(source)
  const fids: string[] = []
  const add = (id: string) => {
    if (!fids.includes(id)) fids.push(id)
  }
  const oids: string[] = []
  for (const id of m.featureIds) {
    add(id)
    const f = features.find((l) => l.feature.id === id)?.feature
    if (f?.kind !== 'clones') continue
    const inner = sourceMembers((f as Clones).source)
    inner.featureIds.forEach(add)
    for (const o of inner.operationIds) if (!oids.includes(o)) oids.push(o)
  }
  for (const o of m.operationIds) {
    const owner = ops.find((x) => x.id === o)
    const by = owner === undefined ? undefined : ownerOf(owner)
    if ((by === undefined || !fids.includes(by)) && !oids.includes(o)) oids.push(o)
  }
  // the group's own operations first (as given), then those its Clones members brought
  const own = m.operationIds.filter((o) => oids.includes(o))
  return sourceOf(fids, [...own, ...oids.filter((o) => !own.includes(o))])
}

export interface Clones extends FeatureBase {
  readonly kind: 'clones'
  readonly source: ClonesSource
  readonly rows: readonly CloneRow[]
}

/** The part's named shape records, which `along` rows follow (`PartDTO.shapes`; [] = none). */
export type CloneShapes = readonly ShapeDTO[]

const count = z.number().int().min(1).max(CLONE_ROW_MAX)
const Skip = z.array(z.number().int().min(0)).max(CLONE_ROW_MAX)

/** A row schema per kind with `q` as the quantity field schema (DTO or arg). */
function rowSchemas<Q extends z.ZodType>(q: Q) {
  return (Object.keys(ROW_FIELDS) as CloneRowKind[]).map((kind) => {
    const f = ROW_FIELDS[kind]
    return z.object({
      kind: z.literal(kind),
      ...Object.fromEntries(Object.keys(f.q).map((k) => [k, q])),
      ...Object.fromEntries(Object.keys(f.oq).map((k) => [k, q.optional()])),
      ...Object.fromEntries(f.n.map((k) => [k, count])),
      ...Object.fromEntries(f.on.map((k) => [k, count.optional()])),
      ...Object.fromEntries(f.s.map((k) => [k, z.string().min(1).max(64)])),
      skip: Skip.optional(),
    })
  }) as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]]
}

const OperationIdsSchema = z.array(z.string().min(1).max(128)).min(1).max(50)

export const ClonesSourceSchema = z.union([
  z.object({ operationIds: OperationIdsSchema }).strict(),
  z.object({ featureId: z.string().min(1).max(64) }).strict(),
  z
    .object({
      featureIds: z.array(z.string().min(1).max(64)).min(1).max(CLONES_GROUP_FEATURES),
      operationIds: OperationIdsSchema.optional(),
    })
    .strict(),
])

const ClonesDtoSchema = z.looseObject({
  source: ClonesSourceSchema,
  rows: z.array(z.discriminatedUnion('kind', rowSchemas(QuantityDtoSchema))).max(CLONE_ROWS_MAX),
})

/**
 * The chain of an `along` row's shape (one item: a path or a primitive's outline, in its shape
 * frame), or issues at the row's `shapeId` (`unknownShape`, `alongOneItem`, `alongShape`).
 */
export function alongChain(
  shapes: CloneShapes,
  shapeId: string,
): { chain?: AlongChain; issues: Issue[] } {
  const bad = (rule: string, message: string) => ({
    issues: [{ path: ['shapeId'], rule, message, params: { shapeId } }],
  })
  const dto = shapes.find((s) => s.id === shapeId)
  if (dto === undefined) return bad('unknownShape', 'no such shape in the part')
  const shape = shapeFromDTO(dto)
  if (shape.isErr()) return bad('alongShape', 'the shape does not load')
  const items = shape.unwrap().items
  if (items.length !== 1)
    return bad('alongOneItem', 'the shape must be one item: one path or one outline')
  const issues: Issue[] = []
  const c = itemChain(definitionOf(items)[0]!, 0, issues)
  if (c === undefined || c.loop.elements.length === 0)
    return bad('alongShape', `the shape is invalid: ${issues[0]?.message ?? 'no elements'}`)
  return { chain: { elements: c.loop.elements, closed: c.closed }, issues: [] }
}

/**
 * The rows as canonical numbers for the path walk; `along` rows take their chain from `shapes`
 * (none when the shape is unknown or invalid: `alongIssues` names it) and `start` 0 by default.
 */
export function pathRows(rows: readonly CloneRow[], shapes: CloneShapes = []): PathRow[] {
  return rows.map((r) => {
    const out = mapRow<Quantity, number>(r, (q) => q.canonical)
    if (r.kind === 'along') {
      out['chain'] = alongChain(shapes, r.shapeId).chain
      out['start'] ??= 0
    }
    return out as unknown as PathRow
  })
}

const rowToDTO = (r: CloneRow): Record<string, unknown> =>
  mapRow<Quantity, unknown>(r, (q) => q.toDTO())

function rowFromDTO(dto: Record<string, unknown>, i: number): AppResult<CloneRow> {
  const kind = dto['kind'] as CloneRowKind
  const keys = rowQuantities(kind)
    .map(([k]) => k)
    .filter((k) => dto[k] !== undefined)
  const qs = collect(
    keys.map((k) => Quantity.fromDTO(dto[k] as never).mapErr((e) => e.prefixIssues('rows', i, k))),
  )
  return qs.map((values) => {
    const byKey = new Map(keys.map((k, j) => [k, values[j]]))
    return mapRow<unknown, unknown>({ ...dto, kind }, (_, k) => byKey.get(k)) as unknown as CloneRow
  })
}

// ── source ─────────────────────────────────────────────────────────────────────────────────

/** The source operations in `ops`, in design order (missing ids are left out). */
export function sourceOperations(source: ClonesSource, ops: readonly Operation[]): Operation[] {
  if ('featureId' in source) return ops.filter((o) => ownerOf(o) === source.featureId)
  const m = sourceMembers(source)
  const ids = new Set(m.operationIds)
  const features = new Set(m.featureIds)
  return ops.filter((o) => ids.has(o.id) || features.has(ownerOf(o) ?? ''))
}

/** The surface owner of a face target: `pocket2.floor` → `pocket2`. */
const surfaceOwner = (on: string): string =>
  on.slice(0, on.indexOf('.') < 0 ? on.length : on.indexOf('.'))

/** The face the source sits on: the `on` of its operations that do not sit on another source operation. */
export function sourceFace(src: readonly Operation[]): string | undefined {
  const ids = new Set(src.map((o) => o.id))
  return src.find((o) => !ids.has(surfaceOwner(o.on)))?.on
}

/** The source's reference point: its first operation's position (anchor point), mm. */
export function referencePoint(src: readonly Operation[]): UV {
  const op = src[0]
  if (op === undefined) return { u: 0, v: 0 }
  const c =
    op.kind === 'drilling'
      ? op.center
      : op.kind === 'line'
        ? op.paths[0]?.center
        : op.kind === 'facing' || op.kind === 'chamfer'
          ? undefined
          : op.shape.center
  return c === undefined ? { u: 0, v: 0 } : { u: c[0].canonical, v: c[1].canonical }
}

const CLONES_ID = /^clones[1-9]\d*$/

/**
 * The source's rules (design-v0.4.md § Clones in v0.4, features.md § Clones v2) as
 * `model.invariant` issues at `source`: it exists and is not empty; its feature members exist and
 * are not this Clones; a member Clones has no Clones member (two levels, `clonesNestedDepth`) and
 * all its own source members are in the group (`clonesNestedSource`); a plain operation owned by
 * a feature outside the group is refused (`clonesSourceOwned`); not nested in another feature
 * (other than an outer Clones holding this one); pockets, drillings and `inside` / `on` profiles
 * only; one face.
 */
export function sourceIssues(
  feature: Clones,
  ops: readonly Operation[],
  features: readonly LoadedFeature[],
): Issue[] {
  const issues: Issue[] = []
  const at = (path: (string | number)[], rule: string, message: string) =>
    issues.push({ path: ['source', ...path], rule, message })
  const s = feature.source
  const m = sourceMembers(s)
  const featurePath = (k: number) => ('featureId' in s ? ['featureId'] : ['featureIds', k])
  const clonesOf = (id: string) => {
    const f = features.find((l) => l.feature.id === id)?.feature
    return f?.kind === 'clones' ? (f as Clones) : undefined
  }
  // an outer Clones holding this one also nests this one's source (G2)
  const holds = (outer: FeatureBase, id: string) =>
    outer.kind === 'clones' && sourceMembers((outer as Clones).source).featureIds.includes(id)
  const nestedElsewhere = (id: string) =>
    features.find(
      (l) =>
        l.feature.id !== feature.id &&
        !m.featureIds.includes(l.feature.id) &&
        !holds(l.feature, feature.id) &&
        l.spec.nested?.(l.feature, ops).includes(id) === true,
    )
  if (new Set(m.featureIds).size !== m.featureIds.length)
    at(['featureIds'], 'unique', 'a feature is listed twice')
  m.featureIds.forEach((id, k) => {
    if (id === feature.id) {
      at(featurePath(k), 'clonesNestedSelf', 'a Clones cannot be in its own source')
      return
    }
    if (!features.some((l) => l.feature.id === id)) {
      at(featurePath(k), 'unknownFeature', 'no such feature')
      return
    }
    const inner = clonesOf(id)
    if (inner === undefined) return
    const im = sourceMembers(inner.source)
    if (im.featureIds.some((x) => clonesOf(x) !== undefined))
      at(
        featurePath(k),
        'clonesNestedDepth',
        `${id} holds a Clones itself: Clones nest two levels at most; clone its source instead`,
      )
    const missing = [
      ...im.featureIds.filter((x) => !m.featureIds.includes(x)),
      ...im.operationIds.filter((x) => !m.operationIds.includes(x)),
    ]
    if (missing.length > 0)
      at(
        featurePath(k),
        'clonesNestedSource',
        `${id}'s source (${missing.join(', ')}) must be in the group with it`,
      )
  })
  // a Clones that is a member of another keeps its source while it is one (G5)
  const outer = features.find((l) => l.feature.id !== feature.id && holds(l.feature, feature.id))
  if (outer !== undefined) {
    const om = sourceMembers((outer.feature as Clones).source)
    const out = [
      ...m.featureIds.filter((x) => !om.featureIds.includes(x)),
      ...m.operationIds.filter((x) => !om.operationIds.includes(x)),
    ]
    if (out.length > 0)
      at(
        'featureId' in s ? ['featureId'] : ['operationIds'],
        'clonesNestedSource',
        `${feature.id} is in ${outer.feature.name} (${outer.feature.id}): change its source there first`,
      )
  }
  if (new Set(m.operationIds).size !== m.operationIds.length)
    at(['operationIds'], 'unique', 'an operation is listed twice')
  m.operationIds.forEach((id, k) => {
    const op = ops.find((o) => o.id === id)
    if (op === undefined) at(['operationIds', k], 'unknownOperation', 'no such operation')
    else if (
      op.owner.isSome() &&
      ownerOf(op) !== feature.id &&
      !m.featureIds.includes(ownerOf(op)!)
    )
      at(
        ['operationIds', k],
        'clonesSourceOwned',
        `belongs to ${ownerOf(op)}: add ${ownerOf(op)} to featureIds instead`,
      )
  })
  if (issues.length > 0) return issues
  const src = sourceOperations(s, ops)
  const path =
    'featureId' in s ? ['featureId'] : 'featureIds' in s ? ['featureIds'] : ['operationIds']
  if (src.length === 0) {
    at(path, 'clonesSourceEmpty', 'the source has no operations')
    return issues
  }
  for (const op of src) {
    const other = nestedElsewhere(op.id)
    if (other !== undefined) {
      at(path, 'clonesSourceTaken', `${op.id} is already in ${other.feature.name}`)
      return issues
    }
    if (op.kind === 'facing' || (op.kind === 'profile' && op.side === 'outside'))
      at(path, 'clonesSourceKind', `${op.id}: facings and outside profiles cannot be cloned`)
    // a chamfer follows its edge: it is cloned with it (design-v0.4.md#implementation-c2)
    if (op.kind === 'chamfer' && !src.some((o) => o.id === op.edgeOf))
      at(path, 'clonesChamferEdge', `${op.id}: clone its edge ${op.edgeOf} with it`)
  }
  const ids = new Set(src.map((o) => o.id))
  const faces = new Set(src.filter((o) => !ids.has(surfaceOwner(o.on))).map((o) => o.on))
  if (faces.size > 1)
    at(path, 'clonesSourceFace', `the source sits on ${faces.size} faces; Clones need one`)
  return issues
}

// ── expansion ──────────────────────────────────────────────────────────────────────────────

/** The quantity paths that hold an operation's position (moved by the clone offset). */
const POSITION: Readonly<Record<string, 0 | 1>> = {
  'center.0': 0,
  'center.1': 1,
  'shape.center.0': 0,
  'shape.center.1': 1,
}

/** mm as an exact rational (path offsets are rounded to 0.001 mm). */
const exactMm = (v: number): Rational =>
  Rational.create(BigInt(Math.round(v * 1000)), 1000n).unwrapOr(Rational.ZERO)

/**
 * `q` as a value moved by `delta` (canonical): a literal keeps its unit and tolerance as typed
 * (anchor.ts `shiftLiteral`); a formula becomes its evaluated value (expressions stay on the
 * source, design-v0.4.md § Clones in v0.4).
 */
function valueOf(q: Quantity, delta: Rational): AppResult<Quantity> {
  if (!isExpression(q)) return delta.equals(Rational.ZERO) ? Ok(q) : shiftLiteral(q, delta)
  const exact = q.exact.add(delta)
  const inUnit = exact.div(UNITS[q.defaultUnit].factor)
  if (inUnit.isErr()) return inUnit
  const v = inUnit.unwrap()
  return Quantity.create({
    kind: q.kind,
    source: v.toFixed(v.decimalDigits(6).unwrapOr(6)),
    defaultUnit: q.defaultUnit,
    exact,
    tolerance: q.tolerance,
  })
}

/** Source operation `op` as instance `n` at `offset`, references inside the source mapped. */
function instanceOf(
  op: Operation,
  n: number,
  offset: UV,
  inSource: ReadonlySet<string>,
  ctx: ExpansionContext,
): AppResult<ExpandedOperation> {
  let moved: Operation = op
  const delta = [exactMm(offset.u), exactMm(offset.v)] as const
  for (const { path, value } of quantityParams(op)) {
    const axis = POSITION[path]
    const q = valueOf(value, axis === undefined ? Rational.ZERO : delta[axis])
    if (q.isErr()) return Err(q.unwrapErr().prefixIssues(...path.split('.')))
    moved = withParam(moved, path, q.unwrap())
  }
  const owner = surfaceOwner(op.on)
  const on = inSource.has(owner) ? ctx.ownedId(`${n}_${owner}`) + op.on.slice(owner.length) : op.on
  // a chamfer bevels its edge's instance (sourceIssues keeps the edge in the source)
  if (moved.kind === 'chamfer' && inSource.has(moved.edgeOf))
    moved = { ...moved, edgeOf: ctx.ownedId(`${n}_${moved.edgeOf}`) }
  const { id: _i, name, generalTolerance, tool, toolLocked, owner: _o, ...body } = { ...moved, on }
  const suffix = ` · ${n}`
  return Ok({
    role: `${n}_${op.id}`,
    operation: body,
    kept: {
      name: name.slice(0, NAME_MAX - suffix.length) + suffix,
      generalTolerance,
      tool,
      toolLocked,
    },
  })
}

/** The clone path of a feature from its source in `ops` (the source's reference point). */
export function featurePath(
  feature: Clones,
  ops: readonly Operation[],
  shapes: CloneShapes,
): ClonePath {
  return clonePath(
    referencePoint(sourceOperations(feature.source, ops)),
    pathRows(feature.rows, shapes),
  )
}

/**
 * `model.invariant` (`clonesLimit`, at `rows`) when the path makes more than `CLONES_MAX`
 * instances, or, with `nested` (a group holding a Clones, G2) of `sourceOps` operations, more than
 * `CLONES_NESTED_OPERATIONS` owned operations.
 */
export function limitIssues(path: ClonePath, nested = false, sourceOps = 0): Issue[] {
  const n = path.instances.length
  if (n > CLONES_MAX)
    return [
      {
        path: ['rows'],
        rule: 'clonesLimit',
        message: `${n} instances; at most ${CLONES_MAX} per Clones feature`,
        params: { max: CLONES_MAX, actual: n },
      },
    ]
  const owned = sourceOps * (n - 1)
  return nested && owned > CLONES_NESTED_OPERATIONS
    ? [
        {
          path: ['rows'],
          rule: 'clonesLimit',
          message: `${owned} cloned operations; at most ${CLONES_NESTED_OPERATIONS} when the source holds a Clones`,
          params: { max: CLONES_NESTED_OPERATIONS, actual: owned, operations: true },
        },
      ]
    : []
}

/** The source holds a Clones feature (G2): its operations include a Clones' owned ones. */
const holdsClones = (src: readonly Operation[]): boolean =>
  src.some((o) => CLONES_ID.test(ownerOf(o) ?? ''))

/**
 * The instances, step-major: each source operation (design order) on every clone position in
 * number order. The source must be in `ctx.before` (it sits right before the block).
 */
export function expandClones(
  feature: Clones,
  ctx: ExpansionContext,
): AppResult<readonly ExpandedOperation[]> {
  const src = sourceOperations(feature.source, ctx.before)
  if (src.length === 0)
    return fail('input.malformed', `${feature.id}: its source is not before its instances`, {
      issues: [{ path: ['source'], rule: 'clonesSourceEmpty', message: 'no source operations' }],
      data: { featureId: feature.id },
    })
  const along = alongIssues(feature.rows, ctx.shapes)
  if (along.length > 0)
    return fail('model.invariant', `${feature.id}: ${along[0]!.message}`, {
      issues: along,
      data: { featureId: feature.id },
    })
  const path = clonePath(referencePoint(src), pathRows(feature.rows, ctx.shapes))
  const limit = limitIssues(path, holdsClones(src), src.length)
  if (limit.length > 0)
    return fail('model.invariant', limit[0]!.message, {
      issues: limit,
      data: { featureId: feature.id },
    })
  const inSource = new Set(src.map((o) => o.id))
  const out: ExpandedOperation[] = []
  for (const op of src)
    for (const inst of path.instances.slice(1)) {
      const e = instanceOf(op, inst.number, inst.offset, inSource, ctx)
      if (e.isErr()) return e
      out.push(e.unwrap())
    }
  return Ok(out)
}

// ── DTO ────────────────────────────────────────────────────────────────────────────────────

export function clonesFromDTO(dto: FeatureDTO): AppResult<Clones> {
  const parsed = parseWith(ClonesDtoSchema, dto, 'clonesFromDTO')
  if (parsed.isErr()) return parsed
  const p = parsed.unwrap()
  return collect(p.rows.map((r, i) => rowFromDTO(r as Record<string, unknown>, i))).map((rows) => ({
    kind: 'clones',
    id: dto.id,
    name: dto.name,
    on: dto.on,
    source: p.source,
    rows,
  }))
}

/** A source as a plain record (the v1 forms unchanged; a group with `operationIds` only when any). */
function sourceDTO(s: ClonesSource): ClonesSource {
  if ('featureId' in s) return { featureId: s.featureId }
  if ('featureIds' in s)
    return s.operationIds === undefined
      ? { featureIds: [...s.featureIds] }
      : { featureIds: [...s.featureIds], operationIds: [...s.operationIds] }
  return { operationIds: [...s.operationIds] }
}

export function clonesToDTO(c: Clones): FeatureDTO {
  return {
    id: c.id,
    kind: 'clones',
    name: c.name,
    on: c.on,
    source: sourceDTO(c.source),
    rows: c.rows.map(rowToDTO),
  }
}

// ── invariants ─────────────────────────────────────────────────────────────────────────────

/**
 * Row rules (features.md § Checks and DFM) as `model.invariant` issues at `rows.<i>.<field>`;
 * with `shapes` also the `along` rows' shape and length rules (`alongIssues`).
 */
export function rowIssues(rows: readonly CloneRow[], shapes?: CloneShapes): Issue[] {
  const issues: Issue[] = []
  const at = (i: number, field: string, rule: string, message: string) =>
    issues.push({ path: ['rows', i, ...(field === '' ? [] : [field])], rule, message })
  if (rows.length === 0)
    issues.push({ path: ['rows'], rule: 'clonesRows', message: 'needs at least one row' })
  for (const [i, r] of rows.entries()) {
    switch (r.kind) {
      case 'grid':
        // a step only separates cells along a direction with more than one (DF90: a 2 × 1 grid
        // with dv 0 is what design.reference.find suggests for a row of holes)
        if (r.cols > 1 && r.du.canonical === 0) at(i, 'du', 'nonZero', 'must not be 0')
        if (r.rows > 1 && r.dv.canonical === 0) at(i, 'dv', 'nonZero', 'must not be 0')
        break
      case 'offset':
        if (r.du.canonical === 0 && r.dv.canonical === 0)
          at(i, 'du', 'nonZero', 'the step is 0 in u and v')
        break
      case 'polar':
        if (r.distance.canonical <= 0) at(i, 'distance', 'positive', 'must be more than 0')
        break
      case 'arc':
        if (r.radius.canonical <= 0) at(i, 'radius', 'positive', 'must be more than 0')
        if (r.arc.canonical === 0 || Math.abs(r.arc.canonical) > 360)
          at(i, 'arc', 'range', 'must be −360° to 360°, not 0')
        if (r.step.canonical <= 0) at(i, 'step', 'positive', 'must be more than 0')
        else if (r.step.canonical > Math.abs(r.arc.canonical))
          at(i, 'step', 'stepInArc', 'must be at most the arc')
        break
      case 'point':
        break
      case 'along':
        if ((r.spacing === undefined) === (r.count === undefined))
          at(i, 'spacing', 'alongSpacingOrCount', 'give spacing or count, not both')
        else if (r.spacing !== undefined && r.spacing.canonical <= 0)
          at(i, 'spacing', 'positive', 'must be more than 0')
        if (r.start !== undefined && r.start.canonical < 0)
          at(i, 'start', 'nonNegative', 'must be 0 or more')
        break
    }
    if (shapes !== undefined && !issues.some((x) => x.path[1] === i))
      issues.push(
        ...alongIssues([r], shapes).map((x) => ({ ...x, path: ['rows', i, ...x.path.slice(2)] })),
      )
    const [row] = pathRows([r], shapes)
    if (!issues.some((x) => x.path[1] === i) && rowPointCount(row!) > CLONE_ROW_MAX)
      at(i, '', 'clonesRowMax', `more than ${CLONE_ROW_MAX} positions in one row`)
  }
  return issues
}

/**
 * The `along` rows' rules that need the part's shapes, at `rows.<i>.<field>`: the shape exists
 * and is one item (`alongChain`); `start` lies on the path (a closed loop: before its end).
 */
export function alongIssues(rows: readonly CloneRow[], shapes: CloneShapes): Issue[] {
  return rows.flatMap((r, i) => {
    if (r.kind !== 'along') return []
    const { chain, issues } = alongChain(shapes, r.shapeId)
    const at = (x: Issue): Issue => ({ ...x, path: ['rows', i, ...x.path] })
    if (chain === undefined) return issues.map(at)
    const [row] = pathRows([r], shapes)
    const { length } = alongStations(row as Extract<PathRow, { kind: 'along' }>)
    const start = r.start?.canonical ?? 0
    const past = chain.closed
      ? start >= length - SAME_SPOT && start > 0
      : start > length + SAME_SPOT
    return past
      ? [
          at({
            path: ['start'],
            rule: 'range',
            message: chain.closed ? 'must be less than the loop length' : 'must lie on the path',
            params: { length: Math.round(length * 1000) / 1000 },
          }),
        ]
      : []
  })
}

// ── warnings ───────────────────────────────────────────────────────────────────────────────

/** Size of the stock face of the Clones' face direction, `[u, v]` mm (design-v0.2.md § Face frame). */
function faceSize(
  stock: Stock,
  src: readonly Operation[],
  ops: readonly Operation[],
): [number, number] {
  const L = stock.length.canonical
  const W = stock.width.canonical
  const T = stock.thickness.canonical
  // the face's stock face: follow `on` through earlier operations to a stock face
  let on = sourceFace(src) ?? 'stock.top'
  for (let guard = 0; guard < 64 && !on.startsWith('stock.'); guard++)
    on = ops.find((o) => o.id === surfaceOwner(on))?.on ?? 'stock.top'
  if (on === 'stock.top' || on === 'stock.bottom') return [L, W]
  return on === 'stock.side[0]' || on === 'stock.side[2]' ? [L, T] : [W, T]
}

/**
 * The feature's own DFM warnings (features.md § Checks and DFM): `dfm.cloneOutsideStock`
 * (instance footprints further past a stock face edge than the source's, B3),
 * `dfm.cloneDuplicate` (positions on an earlier instance), `dfm.cloneOverlap` (info: instance
 * footprints overlap, footprint.ts), `dfm.clonesHeavy` (info: many owned operations slow the part
 * update, S6). Their `operation` is the feature id. `geometry` holds the source operations'
 * geometry input (placed shapes).
 */
export function clonesWarnings(
  feature: Clones,
  ops: readonly Operation[],
  stock: Stock,
  _units: UnitSystem,
  shapes: CloneShapes,
  geometry: SpanGeometry,
): DfmWarning[] {
  const src = sourceOperations(feature.source, ops)
  if (src.length === 0) return []
  const ref = referencePoint(src)
  const path = clonePath(ref, pathRows(feature.rows, shapes))
  const out: DfmWarning[] = []
  const w = (
    code: DfmWarning['code'],
    severity: DfmWarning['severity'],
    message: string,
    params: DfmWarning['params'],
  ) => out.push({ code, severity, message, operation: feature.id, parameter: 'rows', params })
  const [fu, fv] = faceSize(stock, src, ops)
  const ids = new Set(src.map((o) => o.id))
  const port = geometry.region2d
  const parts = sourceFootprint(
    geometry.operations.filter((g) => ids.has(g.id)),
    port,
  )
  // how far past each face edge the footprint reaches (0: inside); the source's own overhang is
  // allowed (a source open to an edge on purpose), an instance reaching further is outside
  const overhang = (d: UV): [number, number, number, number] => {
    const b = footprintBounds(parts, d)
    if (b === undefined) return [0, 0, 0, 0]
    return [
      Math.max(0, -b.min[0]),
      Math.max(0, b.max[0] - fu),
      Math.max(0, -b.min[1]),
      Math.max(0, b.max[1] - fv),
    ]
  }
  const own = overhang({ u: 0, v: 0 })
  const outside = path.instances
    .filter((i) => i.number > 1 && overhang(i.offset).some((x, k) => x > own[k]! + SAME_SPOT))
    .map((i) => i.number)
  if (outside.length > 0)
    w(
      'dfm.cloneOutsideStock',
      'warning',
      `${outside.length} clone(s) outside the stock (${outside.join(', ')}): skip them or shorten a row`,
      { count: outside.length, numbers: outside },
    )
  if (path.duplicates.length > 0)
    w(
      'dfm.cloneDuplicate',
      'warning',
      `${path.duplicates.length} position(s) on an earlier instance left out (${path.duplicates.join(', ')})`,
      { count: path.duplicates.length, numbers: path.duplicates },
    )
  const overlapping = new Set<number>()
  const list = path.instances
  // instances are translations: the answer depends on the offset between them only
  const seen = new Map<string, boolean>()
  const overlaps = (d: UV) => {
    const key = `${Math.round(d.u * 1e6)},${Math.round(d.v * 1e6)}`
    let o = seen.get(key)
    if (o === undefined) seen.set(key, (o = footprintsOverlap(parts, d, port)))
    return o
  }
  for (let a = 0; a < list.length; a++)
    for (let b = a + 1; b < list.length; b++) {
      const d = {
        u: list[b]!.offset.u - list[a]!.offset.u,
        v: list[b]!.offset.v - list[a]!.offset.v,
      }
      if (overlaps(d)) {
        overlapping.add(list[a]!.number)
        overlapping.add(list[b]!.number)
      }
    }
  if (overlapping.size > 0) {
    const numbers = [...overlapping].sort((x, y) => x - y)
    w('dfm.cloneOverlap', 'info', `instances ${numbers.join(', ')} overlap`, {
      count: numbers.length,
      numbers,
    })
  }
  const owned = src.length * (path.instances.length - 1)
  if (owned >= CLONES_HEAVY_OPERATIONS)
    w('dfm.clonesHeavy', 'info', `${owned} cloned operations: the part updates more slowly`, {
      operations: owned,
      instances: path.instances.length,
    })
  return out
}

/**
 * A Clones record's source on stored records (apply.ts, pending keys): the source operation ids
 * plus the source feature id; undefined for other kinds. Instance changes fold into the source's
 * own keys (features.md § Editing the source).
 */
export function clonesSourceIds(
  dto: FeatureDTO,
  ops: readonly { readonly id: string; readonly featureId?: string | undefined }[],
): ReadonlySet<string> | undefined {
  if (dto.kind !== 'clones') return undefined
  const s = ClonesSourceSchema.safeParse((dto as Record<string, unknown>)['source'])
  if (!s.success) return undefined
  const m = sourceMembers(s.data)
  const features = new Set(m.featureIds)
  return new Set([
    ...m.operationIds,
    ...m.featureIds,
    ...ops.filter((o) => o.featureId !== undefined && features.has(o.featureId)).map((o) => o.id),
  ])
}

// ── kind ───────────────────────────────────────────────────────────────────────────────────

/**
 * The operations with the span gathered: the source in design order, the owned block right
 * after it, both where the first of them (or the old span) was; operations taken out of the
 * source go right before the span; everything else keeps its order.
 */
function arrangeClones(
  feature: Clones,
  ops: readonly Operation[],
  prev: Clones | undefined,
  features: readonly LoadedFeature[],
  shapes: CloneShapes = [],
): AppResult<{ ops: readonly Operation[]; start: number; end: number }> {
  const where = 'design.clones'
  const issues = [...sourceIssues(feature, ops, features), ...alongIssues(feature.rows, shapes)]
  if (issues.length > 0) return fail('model.invariant', issueSummary(issues), { issues, where })
  const nested = new Set(sourceOperations(feature.source, ops).map((o) => o.id))
  const old = new Set(prev === undefined ? [] : sourceOperations(prev.source, ops).map((o) => o.id))
  const indices = ops.flatMap((o, i) =>
    nested.has(o.id) || old.has(o.id) || ownerOf(o) === feature.id ? [i] : [],
  )
  const anchor = Math.min(...indices)
  // sort keys: [position, group, index]; the span sits at `anchor`; an operation taken out of
  // the source goes before it, or after it when it sits on a source or instance surface
  const inSpan = (on: string) => {
    const owner = on.slice(0, on.indexOf('.') < 0 ? on.length : on.indexOf('.'))
    return nested.has(owner) || owner.startsWith(`${feature.id}_`)
  }
  const keyed = ops.map((o, i) => {
    const out = old.has(o.id) && !nested.has(o.id)
    const group = nested.has(o.id)
      ? 1
      : ownerOf(o) === feature.id
        ? 2
        : out
          ? inSpan(o.on)
            ? 3
            : 0
          : -1
    return { o, k: group < 0 ? [i, 0, i] : [anchor, group, i] }
  })
  keyed.sort((a, b) => a.k[0]! - b.k[0]! || a.k[1]! - b.k[1]! || a.k[2]! - b.k[2]!)
  const next = keyed.map((x) => x.o)
  const start = next.findIndex((o) => nested.has(o.id)) + nested.size // right after the source (an empty block is still there)
  const owned = next.filter((o) => ownerOf(o) === feature.id).length
  const path = featurePath(feature, next, shapes)
  const limit = limitIssues(path, holdsClones(sourceOperations(feature.source, next)), nested.size)
  if (limit.length > 0)
    return fail('model.invariant', issueSummary(limit), { issues: limit, where })
  return Ok({ ops: next, start, end: start + owned })
}

/** The row fields written as expressions, re-evaluated (feature-sync.ts, F3). */
function reevaluateClones(
  c: Clones,
  at: (q: Quantity, path: string) => AppResult<Quantity>,
): AppResult<Clones> {
  return collect(
    c.rows.map((r, i) => {
      const rec = r as unknown as Record<string, unknown>
      const keys = rowQuantities(r.kind)
        .map(([k]) => k)
        .filter((k) => rec[k] !== undefined)
      return collect(keys.map((k) => at(rec[k] as Quantity, `rows.${i}.${k}`))).map((qs) => {
        const out: Record<string, unknown> = { ...rec }
        keys.forEach((k, j) => (out[k] = qs[j]))
        return out as unknown as CloneRow
      })
    }),
  ).map((rows) => ({ ...c, rows }))
}

/**
 * An instance's issue stands for the rows (where the position comes from); the instance id goes
 * to the issue's params (feature-sync.ts `mapFeatureIssues`).
 */
function clonesFieldOf(_role: string, _path: IssuePath): IssuePath {
  return ['rows']
}

/** The Clones kind (registered built in, feature.ts; commands add params and `build`). */
export const clonesKindSpec: FeatureKindSpec<Clones> = {
  kind: 'clones',
  idPrefix: 'clones',
  label: 'Clones',
  readOnly: true,
  fromDTO: clonesFromDTO,
  toDTO: clonesToDTO,
  invariants: (c) => rowIssues(c.rows),
  expand: expandClones,
  reevaluate: reevaluateClones,
  fieldOf: clonesFieldOf,
  nested: (c, ops) => {
    const src = sourceOperations(c.source, ops).map((o) => o.id)
    // ids not in the part come last, so the consistency check names them
    for (const id of sourceMembers(c.source).operationIds) if (!src.includes(id)) src.push(id)
    return src
  },
  arrange: arrangeClones,
  spanWarnings: clonesWarnings,
}
