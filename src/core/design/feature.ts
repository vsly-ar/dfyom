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
import type { Issue } from '../../shared/errors/app-error'
import { Err, fail, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import type { Stock } from '../library/stock'
import type { UnitSystem } from '../project/document'
import type { FeatureDTO } from './feature.dto'
import { FEATURE_ROLE_PATTERN } from './feature.dto'
import { ID_PREFIX, type FeatureOwner, type GeneralTolerance, type Operation } from './operation'
import type { PartDTO } from './part.dto'

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
}

/** What an expansion may read besides the feature: the part's earlier state. */
export interface ExpansionContext {
  readonly units: UnitSystem
  readonly stock: Stock
  /** The operations before the feature's block, in design order. */
  readonly before: readonly Operation[]
  /** The id the owned operation of `role` gets, for references inside the expansion. */
  ownedId(role: string): string
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
  /** Display label: default names ("Hole 1"), command titles. */
  readonly label: string
  /** The model from a stored record (the kind's full schema); issues at its field paths. */
  fromDTO(dto: FeatureDTO): AppResult<F>
  toDTO(feature: F): FeatureDTO
  /** Feature invariants (`model.invariant` issues at the feature's field paths); none = valid. */
  invariants(feature: F): Issue[]
  expand(feature: F, ctx: ExpansionContext): AppResult<readonly ExpandedOperation[]>
}

// ── kind registry ──────────────────────────────────────────────────────────────────────────

const kinds = new Map<string, FeatureKindSpec>()

/**
 * Registers a kind (its module does, next to its commands; tests register test-only kinds). A
 * second kind of the same name or prefix, or an operation prefix, is a bug.
 */
export function registerFeatureKind<F extends FeatureBase>(
  spec: FeatureKindSpec<F>,
): AppResult<void> {
  const clash = [...kinds.values()].find(
    (k) => k !== (spec as unknown) && (k.kind === spec.kind || k.idPrefix === spec.idPrefix),
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
  for (const { role, operation } of expanded) {
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
    const old = byId.get(id)
    const name =
      old === undefined || old.name === ownedName(prevFeatureName, role)
        ? ownedName(feature.name, role)
        : old.name
    out.push({
      ...operation,
      id,
      name,
      generalTolerance: old?.generalTolerance ?? NO_TOLERANCE,
      tool: old?.tool ?? None,
      toolLocked: old?.toolLocked ?? false,
      owner: Some({ featureId: feature.id, role }),
    } as Operation)
  }
  if (out.length === 0) return bad('no operations', '')
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
 * Consistency of features and owned operations (features.md § Persistence): every owner names a
 * feature, ids are `<featureId>_<role>`, each block is contiguous and holds exactly the roles and
 * kinds of the feature's expansion, in order. A mismatch is corruption, never repaired silently:
 * `input.malformed`. Owned values are not compared with a fresh expansion (commands are their
 * only writers, and recalculation updates them in place).
 */
export function checkFeatures(
  dto: Pick<PartDTO, 'features'>,
  ops: readonly Operation[],
  stock: Stock,
  units: UnitSystem,
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
  for (const { spec, feature } of loaded.unwrap()) {
    const { start, end } = featureBlock(ops, feature.id)
    const data = { featureId: feature.id }
    if (start === end)
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
    const expanded = spec.expand(feature, {
      units,
      stock,
      before: ops.slice(0, start),
      ownedId: (role) => ownedOperationId(feature.id, role),
    })
    if (expanded.isErr())
      return fail('input.malformed', `feature ${feature.id} does not expand`, {
        cause: expanded.unwrapErr(),
        data,
        where: 'checkFeatures',
      })
    const want = expanded.unwrap().map((e) => `${e.role}:${e.operation.kind}`)
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
