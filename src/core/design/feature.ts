/**
 * The feature model (v0.4 F1): feature kinds, the expansion contract, owned operations with ids
 * by role, feature blocks in the design order and the consistency check on load.
 * Doc: docs/modes/features.md#expansion-and-owned-operations (A1–A6),
 * docs/modes/design-v0.4.md#implementation-f1
 *
 * A feature never makes geometry: its kind expands it to an ordered list of operations (role →
 * operation), which are stored in the part's operation list as the feature's owned operations,
 * contiguous (its **block**), each with `owner = { featureId, role }` and the id
 * `<featureId>_<role>`. Every consumer (geometry, DFM, tool choice, Plan) sees operations only.
 */
import type { Issue, IssuePath } from '../../shared/errors/app-error'
import { Err, fail, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import type { Region2dPort } from '../geometry/2d/port'
import type { DfmWarning, OperationGeometry } from '../geometry/model'
import type { Stock } from '../library/stock'
import type { Quantity } from '../quantity/quantity'
import type { ProjectDoc, UnitSystem } from '../project/document'
import type { FeatureDTO } from './feature.dto'
import { FEATURE_ROLE_PATTERN } from './feature.dto'
import { ID_PREFIX, type FeatureOwner, type GeneralTolerance, type Operation } from './operation'
import type { PartDTO } from './part.dto'
import type { ShapeDTO } from './shape.dto'
import type { DesignTool } from './tool'
import type { ToolType } from '../library/tool.dto'
import { holeSpec } from './hole'
import { clonesKindSpec } from './clones/clones'
import { patternSpec } from './pattern/pattern'
import { engravingSpec } from './engraving/engraving'

/** Fields every feature model has; a kind adds its parameters (as quantities). */
export interface FeatureBase {
  readonly id: string
  readonly kind: string
  readonly name: string
  /** Face target (design-v0.2.md#face-targets-generalised-on). */
  readonly on: string
}

/** Operation fields the expansion never sets: identity, and what the user keeps per role (A4). */
type Kept = 'id' | 'name' | 'generalTolerance' | 'tool' | 'toolLocked' | 'owner'

/** An operation as the expansion makes it: its geometry, without the kept fields. */
export type OwnedBody = Operation extends infer O
  ? O extends Operation
    ? Omit<O, Kept>
    : never
  : never

/**
 * One owned operation of an expansion. `role` is `<step>` or `<instance>_<step>` (feature.dto.ts
 * `FEATURE_ROLE_PATTERN`): the step names the cut (`drill`, `counterbore`; for Clones the source
 * operation id), the instance its repetition (Clones: 2…N).
 */
export interface ExpandedOperation {
  readonly role: string
  readonly operation: OwnedBody
  /**
   * The kept fields set by the kind instead of kept per role (A4): a read-only kind's operations
   * follow another operation (Clones: the source operation's name, tolerance and tool, C3).
   */
  readonly kept?: Pick<Operation, 'name' | 'generalTolerance' | 'tool' | 'toolLocked'>
}

/** What an expansion may read besides the feature: the part's earlier state. */
export interface ExpansionContext {
  readonly units: UnitSystem
  readonly stock: Stock
  /** The operations before the feature's block, in design order. */
  readonly before: readonly Operation[]
  /** The id the owned operation of `role` gets, for references inside the expansion. */
  ownedId(role: string): string
  /** The part's named shape records (`PartDTO.shapes`, [] = none): Clones `along` rows follow them (F6). */
  readonly shapes: readonly ShapeDTO[]
}

/**
 * A feature kind. The expansion is the contract F3 (hole) and F5 (Clones) implement:
 *
 * - **Pure and deterministic:** the same feature and context give the same list; it decides
 *   nothing on the user's behalf (an instant reaction, apply.md#rules-for-new-reactions).
 * - **Ordered:** the list is the block's design order, references only to earlier entries or to
 *   `before`.
 * - **Step-major:** all instances of one step are adjacent, steps in cut order (Clones: source
 *   operation A on every position in path order, then B, features.md#plan-and-cut-order), so
 *   Plan's default order cuts tool by tool across all instances (D34). `materialize` refuses
 *   another order as a bug.
 * - **Total on stored features:** a feature that passed its `invariants` expands; expansion
 *   errors are for values only the expansion can see.
 */
export interface FeatureKindSpec<F extends FeatureBase = FeatureBase> {
  readonly kind: string
  /** Id prefix (`hole` → `hole1`); never an operation kind's prefix. */
  readonly idPrefix: string
  /** Display label: default names ("Bolt hole 1"), command titles ("Add bolt hole"). */
  readonly label: string
  /** The model from a stored record (the kind's full schema); issues at its field paths. */
  fromDTO(dto: FeatureDTO): AppResult<F>
  toDTO(feature: F): FeatureDTO
  /** Feature invariants (`model.invariant` issues at the feature's field paths); none = valid. */
  invariants(feature: F): Issue[]
  expand(feature: F, ctx: ExpansionContext): AppResult<readonly ExpandedOperation[]>
  /**
   * The feature with every expression field re-evaluated by `at` (recalculation after an earlier
   * edit, feature-sync.ts); absent = the kind has no quantity fields. Paths as in `invariants`.
   */
  reevaluate?(feature: F, at: (q: Quantity, path: string) => AppResult<Quantity>): AppResult<F>
  /**
   * The feature field an owned operation's issue path stands for (`counterbore`, `depth` →
   * `cbDepth`), so errors name what the user edits (features.md § Validation and DFM);
   * undefined = not mapped (the issue keeps `operations.<id>.<path>`).
   */
  fieldOf?(role: string, path: IssuePath): IssuePath | undefined
  /**
   * Shapes the feature owns (patterns P1: `<id>_cells`, A1 extended to shapes), written with its
   * owned operations in the same command, read-only, removed with the feature. Each has `owner` =
   * the feature id. Absent = none.
   */
  ownedShapes?(feature: F, ctx: ExpansionContext): AppResult<readonly ShapeDTO[]>
  /**
   * Extra result fields of `design.<kind>.add` / `.update` (patterns P1: `cells`), from the
   * feature's owned shapes and the part's shapes after the edit; the port is absent headless
   * without one. `owned` (engraved patterns: `maxWidth` from the Line's tool) are the feature's
   * owned operations after the edit, `snapshots` the document's (specific tools resolve there).
   */
  resultOf?(
    feature: F,
    shapes: readonly ShapeDTO[],
    port: Region2dPort | undefined,
    owned: {
      readonly operations: readonly Operation[]
      readonly snapshots?: ProjectDoc['snapshots']
    },
  ): Record<string, number>
  /** Notes about the feature itself (`dfm.holeCustomSize`), on its owned operations' ids. */
  warnings?(feature: F, ownedId: (role: string) => string): DfmWarning[]
  /**
   * Operations the feature nests but does not own (Clones: its source, F5), in design order. They
   * stay plain operations (or another feature's block), contiguous and directly before the owned
   * block; nested and owned operations together are the feature's **span**, which moves as one
   * unit. A feature with nested operations may own none (Clones with every position skipped).
   * Absent = none.
   */
  nested?(feature: F, ops: readonly Operation[]): readonly string[]
  /**
   * Owned operations are wholly read-only (Clones instances, D26): no name, tolerance or tool
   * edits either; their kept fields come from the expansion (`ExpandedOperation.kept`).
   */
  readonly readOnly?: boolean
  /**
   * Where the feature's span goes when a command adds or changes it (F5: Clones gather their
   * source and put the block right after it): the operations in their new order and the range
   * `[start, end)` the owned block replaces. Absent: a new feature at the end, a changed one in
   * place.
   */
  arrange?(
    feature: F,
    ops: readonly Operation[],
    prev: F | undefined,
    features: readonly LoadedFeature[],
    shapes: readonly ShapeDTO[],
  ): AppResult<{ ops: readonly Operation[]; start: number; end: number }>
  /**
   * Fields a command refills from other fields (the hole's table sizes from its fastener): while a
   * `drivers` field is pending, changed `derived` fields fold into it and are no keys of their own
   * (features.md § Apply and pending changes: choosing M4 counts 1). Absent = every changed field
   * is its own key.
   */
  readonly pendingFolds?: {
    readonly drivers: readonly string[]
    readonly derived: readonly string[]
  }
  /**
   * DFM warnings about the feature's whole span (Clones: `dfm.clone*`, which look at the source
   * and the positions); their `operation` is the feature id. Absent = none.
   */
  spanWarnings?(
    feature: F,
    ops: readonly Operation[],
    stock: Stock,
    units: UnitSystem,
    shapes: readonly ShapeDTO[],
    geometry: SpanGeometry,
  ): readonly DfmWarning[]
}

/**
 * What span warnings read beside the design (hardening B3, Clones footprints): the part's
 * geometry input operations (`toGeometryInput`, placed shapes) and the 2D port when the host has
 * one.
 */
export interface SpanGeometry {
  readonly operations: readonly OperationGeometry[]
  readonly region2d?: Region2dPort | undefined
}

// ── kind registry ──────────────────────────────────────────────────────────────────────────

/**
 * The app's kinds are registered here, so every reader of a part (the renderer's `loadPart`
 * too) knows them without the command registry; their command modules register the same kind
 * again with its command parameters (`featureKindCommands`).
 */
const BUILT_IN_KINDS: readonly FeatureKindSpec[] = [
  holeSpec as unknown as FeatureKindSpec,
  clonesKindSpec as unknown as FeatureKindSpec,
  patternSpec as unknown as FeatureKindSpec,
  engravingSpec as unknown as FeatureKindSpec,
]

const kinds = new Map<string, FeatureKindSpec>(BUILT_IN_KINDS.map((k) => [k.kind, k]))

/**
 * Registers a kind (its command module does; tests register test-only kinds). The same kind
 * again (the same spec, or a command spec spreading it: same name and `fromDTO`) replaces it; a
 * second kind of the same name or prefix, or an operation prefix, is a bug.
 */
export function registerFeatureKind<F extends FeatureBase>(
  spec: FeatureKindSpec<F>,
): AppResult<void> {
  const same = (k: FeatureKindSpec) =>
    k === (spec as unknown) ||
    (k.kind === spec.kind && k.idPrefix === spec.idPrefix && k.fromDTO === spec.fromDTO)
  const clash = [...kinds.values()].find(
    (k) => !same(k) && (k.kind === spec.kind || k.idPrefix === spec.idPrefix),
  )
  if (clash !== undefined || Object.values(ID_PREFIX).includes(spec.idPrefix))
    return fail('internal.unexpected', `feature kind ${spec.kind} clashes with another kind`, {
      where: 'registerFeatureKind',
      data: { kind: spec.kind, idPrefix: spec.idPrefix },
    })
  kinds.set(spec.kind, spec as unknown as FeatureKindSpec)
  return Ok(undefined)
}

export function featureKind(kind: string): Option<FeatureKindSpec> {
  const spec = kinds.get(kind)
  return spec === undefined ? None : Some(spec)
}

// ── ids, roles, blocks ─────────────────────────────────────────────────────────────────────

export const ownedOperationId = (featureId: string, role: string): string => `${featureId}_${role}`

/** The cut a role makes (`3_pocket2` → `pocket2`, `drill` → `drill`). */
export function stepOf(role: string): string {
  const m = /^[1-9]\d*_(.+)$/.exec(role)
  return m === null ? role : m[1]!
}

/** The instance a role repeats its step for; 1 for an unrepeated role. */
export function instanceOf(role: string): number {
  const m = /^([1-9]\d*)_/.exec(role)
  return m === null ? 1 : Number(m[1])
}

export const ownerOf = (op: { readonly owner: Option<FeatureOwner> }): string | undefined =>
  op.owner.isSome() ? op.owner.unwrap().featureId : undefined

/** The feature's block: `[start, end)` in `ops`; `start === end` when it owns none. */
export function featureBlock(
  ops: readonly { readonly owner: Option<FeatureOwner> }[],
  featureId: string,
): { start: number; end: number } {
  const start = ops.findIndex((o) => ownerOf(o) === featureId)
  if (start < 0) return { start: ops.length, end: ops.length }
  let end = start
  while (end < ops.length && ownerOf(ops[end]!) === featureId) end++
  return { start, end }
}

/**
 * A feature's span in `ops`: its nested operations `[start, ownedStart)` and its owned block
 * `[ownedStart, end)` (feature.ts `FeatureKindSpec.nested`). Assumes a checked part (contiguous).
 */
export function featureSpan(
  ops: readonly Operation[],
  lf: { readonly spec: FeatureKindSpec; readonly feature: FeatureBase },
): { start: number; ownedStart: number; end: number } {
  const block = featureBlock(ops, lf.feature.id)
  const nested = lf.spec.nested?.(lf.feature, ops) ?? []
  const first = nested.length === 0 ? -1 : ops.findIndex((o) => o.id === nested[0])
  if (first < 0) return { start: block.start, ownedStart: block.start, end: block.end }
  const ownedStart = first + nested.length
  return { start: first, ownedStart, end: block.start === block.end ? ownedStart : block.end }
}

/**
 * The feature nesting operation `id` (Clones whose source it is), if any; the innermost one when
 * Clones nest (Clones v2: an outer Clones nests its member Clones' source too).
 */
export function nestingFeature(
  ops: readonly Operation[],
  features: readonly LoadedFeature[],
  id: string,
): LoadedFeature | undefined {
  let best: { lf: LoadedFeature; size: number } | undefined
  for (const lf of features) {
    const nested = lf.spec.nested?.(lf.feature, ops)
    if (nested?.includes(id) !== true) continue
    if (best === undefined || nested.length < best.size) best = { lf, size: nested.length }
  }
  return best?.lf
}

/**
 * The outermost unit of each operation in the design order: the feature whose span holds it
 * (nesting before owning), else undefined (a plain operation).
 */
export function spanUnits(
  ops: readonly Operation[],
  features: readonly LoadedFeature[],
): (string | undefined)[] {
  const out: (string | undefined)[] = ops.map(ownerOf)
  // inner spans first, so an outer span (Clones v2) overwrites them
  const spans = features
    .filter((lf) => lf.spec.nested !== undefined)
    .map((lf) => ({ id: lf.feature.id, ...featureSpan(ops, lf) }))
    .sort((a, b) => a.end - a.start - (b.end - b.start))
  for (const { id, start, end } of spans) for (let i = start; i < end; i++) out[i] = id
  return out
}

/**
 * The design order as units: a feature (its block) counts once, a plain operation once. Ids of
 * features and operations never clash (`registerFeatureKind`). Works on DTOs and models.
 */
export function designUnits(
  ops: readonly { readonly id: string; readonly featureId?: string | undefined }[],
): { readonly id: string; readonly feature: boolean }[] {
  const out: { id: string; feature: boolean }[] = []
  for (const op of ops) {
    const id = op.featureId ?? op.id
    if (out.at(-1)?.id === id) continue
    out.push({ id, feature: op.featureId !== undefined })
  }
  return out
}

/** `design.featureOwned`: an owned operation's geometry, order and life go through its feature. */
export function featureOwnedError(
  operationId: string,
  owner: FeatureOwner,
  featureName: string,
  where: string,
): AppResult<never> {
  return fail(
    'design.featureOwned',
    `${operationId} belongs to ${featureName} (${owner.featureId}); edit the feature instead`,
    {
      issues: [
        {
          path: ['operationId'],
          rule: 'featureOwned',
          message: `edited through ${featureName}`,
          params: { featureId: owner.featureId },
        },
      ],
      data: { operationId, featureId: owner.featureId, role: owner.role },
      where,
    },
  )
}

// ── materialize ────────────────────────────────────────────────────────────────────────────

const NO_TOLERANCE: GeneralTolerance = { length: None, angle: None }

/**
 * Whether a tool of `type` can cut an operation of `kind` at all (its sizes are the fit rules'):
 * a pocket takes a flat or bull-nose end mill, a drilling a drill or a flat end mill
 * (tool-fit.ts). Other kinds never change under a role.
 */
function toolSuitsKind(type: ToolType | undefined, kind: Operation['kind']): boolean {
  if (kind === 'pocket') return type === 'flatEndMill' || type === 'bullNoseEndMill'
  if (kind === 'drilling') return type === 'drill' || type === 'flatEndMill'
  return false
}

/** Default name of an owned operation: "Hole 1 · counterbore". */
export const ownedName = (featureName: string, role: string): string => `${featureName} · ${role}`

/**
 * The owned operations of an expansion: ids by role (A3), and per surviving role the kept fields
 * of the previous owned operation (name, general tolerance, tool field; A4). A default name
 * follows a renamed feature. Roles that break the contract (pattern, duplicates, not step-major)
 * are a bug of the kind: `internal.unexpected`.
 */
export function materialize(
  feature: FeatureBase,
  expanded: readonly ExpandedOperation[],
  prev: readonly Operation[],
  prevFeatureName: string = feature.name,
  /** A feature with nested operations may own none (F5). */
  allowEmpty = false,
  /** The type of a kept tool (a specific tool's from its snapshot); undefined = unknown. */
  toolType: (t: DesignTool) => ToolType | undefined = (t) =>
    t.kind === 'generalized' ? t.type : undefined,
): AppResult<Operation[]> {
  const bad = (message: string, role: string) =>
    fail('internal.unexpected', `${feature.kind} expansion: ${message}`, {
      where: 'materialize',
      data: { featureId: feature.id, role },
    })
  const byId = new Map(prev.map((o) => [o.id, o]))
  const seen = new Set<string>()
  const closedSteps = new Set<string>()
  let step: string | undefined
  const out: Operation[] = []
  for (const { role, operation, kept } of expanded) {
    if (!FEATURE_ROLE_PATTERN.test(role)) return bad('invalid role', role)
    if (seen.has(role)) return bad('duplicate role', role)
    seen.add(role)
    const s = stepOf(role)
    if (s !== step) {
      if (closedSteps.has(s)) return bad('not step-major (a step comes back)', role)
      if (step !== undefined) closedSteps.add(step)
      step = s
    }
    const id = ownedOperationId(feature.id, role)
    if (kept !== undefined) {
      out.push({
        ...operation,
        ...kept,
        id,
        owner: Some({ featureId: feature.id, role }),
      } as Operation)
      continue
    }
    const old = byId.get(id)
    const name =
      old === undefined || old.name === ownedName(prevFeatureName, role)
        ? ownedName(feature.name, role)
        : old.name
    // a role whose kind changed (a hole switched round ↔ slotted, H2) keeps its tool only when
    // the tool's type can cut the new kind (a drill bit never cuts a pocket)
    const keepTool =
      old !== undefined &&
      (old.kind === operation.kind ||
        old.tool.mapOr(false, (t) => toolSuitsKind(toolType(t), operation.kind)))
    out.push({
      ...operation,
      id,
      name,
      generalTolerance: old?.generalTolerance ?? NO_TOLERANCE,
      tool: keepTool ? old.tool : None,
      toolLocked: keepTool ? old.toolLocked : false,
      owner: Some({ featureId: feature.id, role }),
    } as Operation)
  }
  if (out.length === 0 && !allowEmpty) return bad('no operations', '')
  return Ok(out)
}

// ── loading and the consistency check ──────────────────────────────────────────────────────

export interface LoadedFeature {
  readonly spec: FeatureKindSpec
  readonly feature: FeatureBase
}

/** The part's features as models (registered kinds only); a broken one is `input.malformed`. */
export function loadFeatures(dto: Pick<PartDTO, 'features'>): AppResult<LoadedFeature[]> {
  const out: LoadedFeature[] = []
  const ids = new Set<string>()
  for (const [i, f] of (dto.features ?? []).entries()) {
    const issue = (rule: string, message: string, path: (string | number)[] = []) =>
      fail('input.malformed', `feature ${f.id}: ${message}`, {
        issues: [{ path: ['features', i, ...path], rule, message }],
        data: { featureId: f.id },
      })
    if (ids.has(f.id)) return issue('unique', 'duplicate feature id', ['id'])
    ids.add(f.id)
    const spec = featureKind(f.kind)
    if (spec.isNone())
      return issue('unknownFeatureKind', `unknown feature kind ${f.kind}`, ['kind'])
    const s = spec.unwrap()
    if (!new RegExp(`^${s.idPrefix}[1-9]\\d*$`).test(f.id))
      return issue('featureId', `id must be ${s.idPrefix}<n>`, ['id'])
    const feature = s.fromDTO(f)
    if (feature.isErr()) return Err(feature.unwrapErr().prefixIssues('features', i))
    out.push({ spec: s, feature: feature.unwrap() })
  }
  return Ok(out)
}

/**
 * The consistency check's expansions, as `role:kind` lists, cached by the feature record and the
 * records before its block (both frozen objects of a committed document, so identity is enough):
 * loading a part no longer re-runs every expansion (F1 known issue, F5).
 */
const expansionCache = new WeakMap<object, { key: readonly unknown[]; roles: readonly string[] }>()

/**
 * The records a part was loaded from (`baseOf` of a draft's part), for the expansion cache;
 * only the frozen ones among them are used as keys.
 */
export interface FrozenRecords {
  readonly features: readonly object[]
  readonly operations: readonly object[]
  readonly stock: object
  /** The part's shape records (undefined: none), which Clones `along` rows read. */
  readonly shapes: readonly object[] | undefined
}

function expansionOf(
  spec: FeatureKindSpec,
  feature: FeatureBase,
  ops: readonly Operation[],
  start: number,
  stock: Stock,
  units: UnitSystem,
  shapes: readonly ShapeDTO[],
  record: object | undefined,
  records: FrozenRecords | undefined,
): AppResult<readonly string[]> {
  // only frozen records key the cache: a committed document's, and a draft's unmodified ones
  // (a command's load after an edit before this feature's block expands it anew)
  const key =
    records === undefined || record === undefined || !Object.isFrozen(record)
      ? undefined
      : [records.stock, units, records.shapes, ...records.operations.slice(0, start)]
  const cacheable =
    key !== undefined && key.every((k) => typeof k !== 'object' || Object.isFrozen(k))
  const hit = cacheable ? expansionCache.get(record!) : undefined
  if (hit !== undefined && sameKey(hit.key, key!)) return Ok(hit.roles)
  return spec
    .expand(feature, {
      units,
      stock,
      before: ops.slice(0, start),
      ownedId: (role) => ownedOperationId(feature.id, role),
      shapes,
    })
    .map((list) => {
      const roles = list.map((e) => `${e.role}:${e.operation.kind}`)
      if (cacheable) expansionCache.set(record!, { key: key!, roles })
      return roles
    })
}

const sameKey = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Consistency of features and owned operations (features.md § Persistence): every owner names a
 * feature, ids are `<featureId>_<role>`, each block is contiguous and holds exactly the roles and
 * kinds of the feature's expansion, in order; nested operations (F5) exist, are nested by one
 * feature only and sit contiguous right before its block. A mismatch is corruption, never
 * repaired silently: `input.malformed`. Owned values are not compared with a fresh expansion
 * (commands are their only writers, and recalculation updates them in place). With `records`
 * the expansions are cached per feature record.
 */
export function checkFeatures(
  dto: Pick<PartDTO, 'features' | 'shapes'> & Partial<Pick<PartDTO, 'derivedFrom'>>,
  ops: readonly Operation[],
  stock: Stock,
  units: UnitSystem,
  records?: FrozenRecords,
  /** Skip the role comparison of nesting kinds (Clones) that are about to follow (`loadPart`). */
  following = false,
): AppResult<LoadedFeature[]> {
  const loaded = loadFeatures(dto)
  if (loaded.isErr()) return loaded
  const features = new Map(loaded.unwrap().map((l) => [l.feature.id, l]))
  const malformed = (message: string, path: (string | number)[], rule: string, data: object) =>
    fail('input.malformed', message, { issues: [{ path, rule, message }], data: { ...data } })
  for (const [i, op] of ops.entries()) {
    if (op.owner.isNone()) continue
    const { featureId, role } = op.owner.unwrap()
    if (!features.has(featureId))
      return malformed(
        `${op.id}: no feature ${featureId}`,
        ['operations', i, 'featureId'],
        'unknownFeature',
        {
          operationId: op.id,
        },
      )
    if (op.id !== ownedOperationId(featureId, role))
      return malformed(
        `${op.id}: id must be ${featureId}_${role}`,
        ['operations', i, 'id'],
        'ownedId',
        {
          operationId: op.id,
        },
      )
  }
  // owned shapes (patterns P1): each names a feature that owns shapes, and such a feature has one;
  // a split piece keeps its source's owned shapes without the features (patterns P2)
  for (const [k, sh] of (dto.shapes ?? []).entries()) {
    if (sh.owner === undefined || dto.derivedFrom !== undefined) continue
    if (features.get(sh.owner)?.spec.ownedShapes === undefined)
      return malformed(
        `shape ${sh.id}: no feature ${sh.owner} owning shapes`,
        ['shapes', k, 'owner'],
        'unknownFeature',
        { shapeId: sh.id },
      )
  }
  for (const { spec, feature } of loaded.unwrap())
    if (spec.ownedShapes !== undefined && !(dto.shapes ?? []).some((sh) => sh.owner === feature.id))
      return malformed(`feature ${feature.id} has no owned shape`, ['features'], 'featureShape', {
        featureId: feature.id,
      })
  const nestedBy = new Map<string, string>()
  // spans as id sets: an operation nested by two features is fine when one span lies wholly in
  // the other's nested operations (Clones v2: an outer Clones holds an inner one with its source)
  const spanIds = new Map<string, { nested: Set<string>; span: string[] }>()
  for (const lf of loaded.unwrap()) {
    const nested = lf.spec.nested?.(lf.feature, ops) ?? []
    const span = [...nested, ...ops.filter((o) => ownerOf(o) === lf.feature.id).map((o) => o.id)]
    spanIds.set(lf.feature.id, { nested: new Set(nested), span })
  }
  const inside = (inner: string, outer: string) => {
    const a = spanIds.get(inner)
    const b = spanIds.get(outer)
    return a !== undefined && b !== undefined && a.span.every((id) => b.nested.has(id))
  }
  for (const [i, { spec, feature }] of loaded.unwrap().entries()) {
    const { start, end } = featureBlock(ops, feature.id)
    const data = { featureId: feature.id }
    const nested = spec.nested?.(feature, ops) ?? []
    if (start === end && nested.length === 0)
      return malformed(
        `feature ${feature.id} owns no operations`,
        ['features'],
        'emptyFeature',
        data,
      )
    const owned = ops.filter((o) => ownerOf(o) === feature.id)
    if (owned.length !== end - start)
      return malformed(
        `the operations of ${feature.id} are not contiguous`,
        ['features'],
        'featureBlock',
        data,
      )
    // nested operations (F5): each exists, nested once, contiguous right before the owned block
    const first = nested.length === 0 ? -1 : ops.findIndex((o) => o.id === nested[0])
    const blockAt = start === end ? first + nested.length : start
    for (const [k, id] of nested.entries()) {
      const other = nestedBy.get(id)
      nestedBy.set(id, feature.id)
      const laminar = other === undefined || inside(other, feature.id) || inside(feature.id, other)
      if (first < 0 || ops[first + k]?.id !== id || !laminar || first + k >= blockAt)
        return malformed(
          `the nested operations of ${feature.id} are not right before its block`,
          ['features'],
          'featureNested',
          { ...data, operationId: id },
        )
    }
    if (nested.length > 0 && blockAt !== first + nested.length)
      return malformed(
        `the nested operations of ${feature.id} are not right before its block`,
        ['features'],
        'featureNested',
        data,
      )
    const at = start === end ? blockAt : start
    if (following && spec.nested !== undefined) continue
    const expanded = expansionOf(
      spec,
      feature,
      ops,
      at,
      stock,
      units,
      dto.shapes ?? [],
      records?.features[i],
      records,
    )
    if (expanded.isErr())
      return fail('input.malformed', `feature ${feature.id} does not expand`, {
        cause: expanded.unwrapErr(),
        data,
        where: 'checkFeatures',
      })
    const want = expanded.unwrap()
    const have = owned.map((o) => `${o.owner.unwrap().role}:${o.kind}`)
    if (want.join(',') !== have.join(','))
      return malformed(
        `the operations of ${feature.id} differ from its expansion`,
        ['features'],
        'featureExpansion',
        { ...data, expected: want, actual: have },
      )
  }
  return loaded
}
