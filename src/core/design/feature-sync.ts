/**
 * Features and their owned operations kept in step after an edit (v0.4 F3): feature fields
 * written as expressions are re-evaluated when what they reference changed (and the feature is
 * expanded again), and owned operations' issue paths are mapped back to the feature's fields.
 * Doc: docs/modes/design-v0.4.md#implementation-f3, docs/modes/features.md#validation-and-dfm
 */
import { type AppError, issueSummary } from '../../shared/errors/app-error'
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import type { ReferenceResolver } from '../expression/evaluate'
import { reevaluate } from '../expression/quantity'
import { deepEqual } from '../library/snapshot'
import type { Stock } from '../library/stock'
import type { UnitSystem } from '../project/document'
import type { ShapeEnv } from './commands'
import type { ShapeDTO } from './shape.dto'
import { featureBlock, materialize, ownedOperationId, type LoadedFeature } from './feature'
import { shapesOf, type Operation } from './operation'
import { shapeFacts } from './placement'
import { recalculate, SurfaceTable } from './surfaces'
import { checkOperations } from './validate'
import { knownIssues, withoutKnown } from './known-issues'

const toPath = (path: string) => path.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s))

/**
 * Issues at `operations.<id>.<path>` of an owned operation, rewritten to the feature field its
 * kind names (`FeatureKindSpec.fieldOf`): the bare field for the feature being edited (the form
 * the user fills), `features.<featureId>.<field>` for another feature. The operation id moves to
 * the issue's params. Unmapped issues stay as they are.
 */
export function mapFeatureIssues(
  e: AppError,
  ops: readonly Operation[],
  features: readonly LoadedFeature[],
  edited?: string,
): AppError {
  return e.mapIssues((issue) => {
    const [head, opId, ...rest] = issue.path
    if (head !== 'operations' || typeof opId !== 'string') return issue
    const owner = ops.find((o) => o.id === opId)?.owner
    if (owner === undefined || owner.isNone()) return issue
    const { featureId, role } = owner.unwrap()
    const field = features.find((l) => l.feature.id === featureId)?.spec.fieldOf?.(role, rest)
    if (field === undefined) return issue
    return {
      ...issue,
      path: featureId === edited ? field : ['features', featureId, ...field],
      params: { ...issue.params, operationId: opId },
    }
  })
}

/**
 * Re-evaluates every feature's expression fields against the operations before its block, in
 * design order. A feature whose values changed is checked (`invariants`, issues at
 * `features.<id>.<field>`), expanded again in place (kept fields per role, A4) and what depends
 * on its owned operations is recalculated before the next feature is looked at. Unchanged
 * features are returned as they are.
 */
export function recalculateFeatures(
  ops: readonly Operation[],
  features: readonly LoadedFeature[],
  stock: Stock,
  units: UnitSystem,
  shapes: readonly ShapeDTO[],
): AppResult<{ ops: readonly Operation[]; features: LoadedFeature[]; changed: string[] }> {
  let next: readonly Operation[] = ops
  const changed: string[] = []
  const order = [...features].sort(
    (a, b) => featureBlock(ops, a.feature.id).start - featureBlock(ops, b.feature.id).start,
  )
  const out = new Map(features.map((l) => [l.feature.id, l]))
  for (const { spec, feature } of order) {
    if (spec.reevaluate === undefined) continue
    const { start, end } = featureBlock(next, feature.id)
    if (start === end) continue
    // the surface table only when a field reads a surface (P5: most fields are plain values)
    const before = next
    let table: ReferenceResolver | undefined
    const resolver: ReferenceResolver = {
      resolve: (name) =>
        (table ??= SurfaceTable.build(before, stock).resolver(start)).resolve(name),
    }
    const fresh = spec.reevaluate(feature, (q, path) =>
      reevaluate(q, resolver).mapErr((e) =>
        e.prefixIssues('features', feature.id, ...toPath(path)),
      ),
    )
    if (fresh.isErr()) return fresh
    const f = fresh.unwrap()
    if (deepEqual(spec.toDTO(f), spec.toDTO(feature))) continue
    const issues = spec.invariants(f)
    if (issues.length > 0)
      return fail('model.invariant', `${feature.id}: ${issueSummary(issues)}`, {
        issues: issues.map((i) => ({ ...i, path: ['features', feature.id, ...i.path] })),
        where: 'recalculateFeatures',
        data: { featureId: feature.id },
      })
    const expanded = spec.expand(f, {
      units,
      stock,
      before: next.slice(0, start),
      ownedId: (role) => ownedOperationId(feature.id, role),
      shapes,
    })
    if (expanded.isErr()) return expanded
    const owned = materialize(f, expanded.unwrap(), next.slice(start, end))
    if (owned.isErr()) return owned
    next = [...next.slice(0, start), ...owned.unwrap(), ...next.slice(end)]
    for (const op of owned.unwrap()) {
      const r = recalculate(next, stock, op.id)
      if (r.isErr()) return r
      next = r.unwrap()
    }
    out.set(feature.id, { spec, feature: f })
    changed.push(feature.id)
  }
  return Ok({ ops: next, features: [...out.values()], changed })
}

/**
 * `recalculateFeatures` after an edit, plus every operation's constraints again when a feature
 * was expanded anew; issues of owned operations are mapped to feature fields (`edited` = the
 * feature being edited, whose fields are the command's args).
 */
export function settleFeatures(
  ops: readonly Operation[],
  features: readonly LoadedFeature[],
  stock: Stock,
  units: UnitSystem,
  where: string,
  env: ShapeEnv,
  edited?: string,
): AppResult<{ ops: readonly Operation[]; features: LoadedFeature[]; changed: string[] }> {
  const mapped = (e: AppError, at: readonly Operation[]) =>
    Err(mapFeatureIssues(e, at, features, edited).withContext(where))
  if (features.length === 0) return Ok({ ops, features: [], changed: [] })
  const r = recalculateFeatures(ops, features, stock, units, env.dto.shapes ?? [])
  if (r.isErr()) return mapped(r.unwrapErr(), ops)
  const { changed } = r.unwrap()
  if (changed.length === 0) return r
  const next = r.unwrap().ops
  const shapes = shapesOf(next, env.dto)
  if (shapes.isErr()) return mapped(shapes.unwrapErr(), next)
  const facts = shapeFacts(next, shapes.unwrap(), env.port)
  if (facts.isErr()) return mapped(facts.unwrapErr(), next)
  const checked = withoutKnown(
    checkOperations(next, stock, undefined, facts.unwrap(), shapes.unwrap()),
    () => knownIssues(ops, stock, env),
  )
  if (checked.isErr()) return mapped(checked.unwrapErr(), next)
  return r
}
