/**
 * Feature commands (v0.4 F1): the shared `design.feature.remove` / `.move` and the query
 * `design.feature.list` (with `featureId` it is the folded `get`, Q32 A), plus the factory every
 * feature kind builds its `design.<kind>.add` / `.update` with (hole F3, Clones F5).
 * Doc: docs/modes/features.md#commands-sketch, docs/modes/design-v0.4.md#implementation-f1
 *
 * A feature command runs the expansion inside the command (one undo step, A2): the owned
 * operations are replaced by role, then the whole part is checked as after any edit
 * (references, recalculation of dependants, every operation's constraints). Undo replays the
 * patches, never the expansion.
 */
import type { Draft } from 'immer'
import { z } from 'zod'
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import { defineCommand, defineQuery, type AnyCommand, type QueryDef } from '../commands/define'
import type { CommandContext } from '../commands/context'
import { deepEqual } from '../library/snapshot'
import type { Stock } from '../library/stock'
import type { ProjectDoc } from '../project/document'
import {
  defaultOn,
  Fields,
  invalid,
  load,
  NameArg,
  OnArg,
  PartArg,
  shapeEnv,
  splitFeature,
  Warnings,
  withWarnings,
  writeOperationList,
  type ShapeEnv,
} from './commands'
import {
  featureBlock,
  materialize,
  ownedOperationId,
  registerFeatureKind,
  type FeatureBase,
  type FeatureKindSpec,
  type LoadedFeature,
} from './feature'
import { FeatureDtoSchema, FeatureIdSchema, type FeatureDTO } from './feature.dto'
import type { LoadedPart } from './load'
import { operationToDTO, shapesOf, type Operation } from './operation'
import { OperationIdSchema, PartIdSchema, type OperationDTO, type PartDTO } from './part.dto'
import { shapeFacts } from './placement'
import { checkReferences, recalculate, SurfaceTable } from './surfaces'
import { checkOperations } from './validate'

const FeatureArg = { partId: PartIdSchema, featureId: FeatureIdSchema }

/** Result of every feature command (features.md § Commands). */
const FeatureResult = z.object({
  featureId: FeatureIdSchema,
  operationIds: z
    .array(OperationIdSchema)
    .describe('Owned operations in design order (remove: the removed ones)'),
  warnings: Warnings,
})

// ── shared steps ───────────────────────────────────────────────────────────────────────────

function unknownFeature(featureId: string, where: string): AppResult<never> {
  return fail('input.malformed', `feature ${featureId} does not exist in the part`, {
    issues: [{ path: ['featureId'], rule: 'unknownFeature', message: 'no such feature' }],
    where,
  })
}

function findFeature(
  loaded: LoadedPart,
  featureId: string,
  where: string,
): AppResult<{ index: number; loaded: LoadedFeature }> {
  const index = loaded.features.findIndex((l) => l.feature.id === featureId)
  if (index < 0) return unknownFeature(featureId, where)
  return Ok({ index, loaded: loaded.features[index]! })
}

/**
 * Whole-part check after the block `[start, start + owned.length)` was replaced: references
 * (a role that disappeared while a later operation refers to it is `design.referenced`),
 * recalculation of what depends on the owned operations (on update), every operation's
 * constraints (issues at `operations.<id>.<path>`).
 */
function settleBlock(
  ops: readonly Operation[],
  owned: readonly Operation[],
  stock: Stock,
  recalc: boolean,
  where: string,
  env: ShapeEnv,
): AppResult<readonly Operation[]> {
  const shapes = shapesOf(ops, env.dto)
  if (shapes.isErr()) return Err(shapes.unwrapErr().withContext(where))
  const facts = shapeFacts(ops, shapes.unwrap(), env.port)
  if (facts.isErr()) return Err(facts.unwrapErr().withContext(where))
  const refs = checkReferences(ops, stock)
  if (refs.isErr()) return Err(refs.unwrapErr().withContext(where))
  let next: readonly Operation[] = ops
  if (recalc)
    for (const op of owned) {
      const r = recalculate(next, stock, op.id)
      if (r.isErr()) return Err(r.unwrapErr().withContext(where))
      next = r.unwrap()
    }
  return checkOperations(next, stock, undefined, facts.unwrap(), shapes.unwrap())
    .map(() => next)
    .mapErr((e) => e.withContext(where))
}

/**
 * Expands `feature` and puts its owned operations in place of its block (or at the end for a
 * new one), then checks the whole part. Returns all operations and the owned ones; writes nothing.
 */
export function placeFeature<F extends FeatureBase>(
  loaded: LoadedPart,
  spec: FeatureKindSpec<F>,
  feature: F,
  prev: F | undefined,
  where: string,
  env: ShapeEnv,
): AppResult<{
  ops: readonly Operation[]
  owned: readonly Operation[]
  start: number
  replaced: number
}> {
  const { part, stock, units } = loaded
  const ops = part.operations
  const { start, end } =
    prev === undefined ? { start: ops.length, end: ops.length } : featureBlock(ops, feature.id)
  const issues = spec.invariants(feature)
  if (issues.length > 0) return invalid(issues, where)
  const expanded = spec.expand(feature, {
    units,
    stock,
    before: ops.slice(0, start),
    ownedId: (role) => ownedOperationId(feature.id, role),
  })
  if (expanded.isErr()) return Err(expanded.unwrapErr().withContext(where))
  const owned = materialize(feature, expanded.unwrap(), ops.slice(start, end), prev?.name)
  if (owned.isErr()) return Err(owned.unwrapErr().withContext(where))
  const next = [...ops.slice(0, start), ...owned.unwrap(), ...ops.slice(end)]
  return settleBlock(next, owned.unwrap(), stock, prev !== undefined, where, env).map((all) => ({
    ops: all,
    owned: all.slice(start, start + owned.unwrap().length),
    start,
    replaced: end - start,
  }))
}

/**
 * Writes a placed feature: the block's DTOs (unchanged owned operations keep their record), the
 * operations recalculation changed, and the feature record.
 */
function writePlaced(
  draft: Draft<ProjectDoc>,
  partId: string,
  placed: {
    ops: readonly Operation[]
    owned: readonly Operation[]
    start: number
    replaced: number
  },
  feature: FeatureDTO,
): void {
  const target = draft.parts[partId]!
  const list = target.operations
  const old = new Map(
    list.slice(placed.start, placed.start + placed.replaced).map((o) => [o.id, o]),
  )
  const block = placed.owned.map((op): OperationDTO => {
    const dto = operationToDTO(op)
    const prev = old.get(op.id)
    return prev !== undefined && deepEqual(prev, dto) ? prev : dto
  })
  list.splice(placed.start, placed.replaced, ...block)
  writeOperationList(list, placed.ops)
  const features = (target.features ??= [])
  const i = features.findIndex((f) => f.id === feature.id)
  if (i < 0) features.push(feature)
  else if (!deepEqual(features[i], feature)) features[i] = feature
}

function nextFeatureNumber(dto: PartDTO, prefix: string): number {
  let max = 0
  for (const f of dto.features ?? [])
    if (f.id.startsWith(prefix) && /^\d+$/.test(f.id.slice(prefix.length)))
      max = Math.max(max, Number(f.id.slice(prefix.length)))
  return max + 1
}

// ── per-kind add / update ──────────────────────────────────────────────────────────────────

/** What a kind's `build` gets besides its args. */
export interface FeatureBuildContext {
  readonly f: Fields
  readonly id: string
  readonly name: string
  readonly on: string
  /** The operations before the feature's block. */
  readonly before: readonly Operation[]
}

/** A feature kind with its command parameters (`design.<kind>.add` / `.update`). */
export interface FeatureCommandSpec<
  P extends z.ZodRawShape,
  F extends FeatureBase,
> extends FeatureKindSpec<F> {
  readonly params: P
  /** Parameters required on add (all are optional on update). */
  readonly required: readonly (keyof P & string)[]
  /** The feature from args as entered (parsed through `c.f`) and its previous version. */
  build(args: Partial<z.output<z.ZodObject<P>>>, prev: F | undefined, c: FeatureBuildContext): F
}

/**
 * `design.<kind>.add` and `.update` of a feature kind; registers the kind. Results carry
 * `{ featureId, operationIds, warnings }`.
 */
export function featureKindCommands<P extends z.ZodRawShape, F extends FeatureBase>(
  spec: FeatureCommandSpec<P, F>,
): AppResult<AnyCommand[]> {
  const registered = registerFeatureKind(spec)
  if (registered.isErr()) return registered
  const lower = spec.label.toLowerCase()
  const optional = (required: boolean) =>
    Object.fromEntries(
      Object.entries(spec.params).map(([k, s]) => [
        k,
        required && spec.required.includes(k) ? s : (s as z.ZodType).optional(),
      ]),
    ) as P
  type Args = { partId: string; name?: string; on?: string } & Partial<z.output<z.ZodObject<P>>>

  const add = defineCommand({
    kind: 'document',
    name: `design.${spec.kind}.add`,
    summary: `Add a ${lower} feature at the end of the part; it creates its operations.`,
    title: () => `Add ${lower}`,
    machine: false,
    args: z.object({
      ...PartArg,
      name: NameArg.optional(),
      on: OnArg.optional(),
      ...optional(true),
    }),
    result: FeatureResult,
    run(draft, rawArgs, ctx) {
      const where = `design.${spec.kind}.add`
      const args = rawArgs as Args
      const loaded = load(draft, args.partId, where)
      if (loaded.isErr()) return loaded
      const l = loaded.unwrap()
      const ops = l.part.operations
      const env = shapeEnv(l, ctx.services.region2d)
      const f = new Fields(l.units, SurfaceTable.build(ops, l.stock).resolver(ops.length), env)
      const n = nextFeatureNumber(l.dto, spec.idPrefix)
      const id = `${spec.idPrefix}${n}`
      const name = args.name ?? `${spec.label} ${n}`
      const feature = spec.build(args, undefined, {
        f,
        id,
        name,
        on: args.on ?? defaultOn(ops),
        before: ops,
      })
      const parsed = f.done()
      if (parsed.isErr()) return Err(parsed.unwrapErr().withContext(where))
      return finish(draft, args.partId, l, spec, feature, undefined, where, ctx)
    },
  })

  const update = defineCommand({
    kind: 'document',
    name: `design.${spec.kind}.update`,
    summary: `Change parameters of a ${lower} feature; its operations are regenerated.`,
    title: () => `Update ${lower}`,
    machine: false,
    args: z.object({
      ...FeatureArg,
      name: NameArg.optional(),
      on: OnArg.optional(),
      ...optional(false),
    }),
    result: FeatureResult,
    run(draft, rawArgs, ctx) {
      const where = `design.${spec.kind}.update`
      const args = rawArgs as Args & { featureId: string }
      const loaded = load(draft, args.partId, where)
      if (loaded.isErr()) return loaded
      const l = loaded.unwrap()
      const found = findFeature(l, args.featureId, where)
      if (found.isErr()) return found
      if (found.unwrap().loaded.spec.kind !== spec.kind)
        return fail(
          'input.malformed',
          `${args.featureId} is a ${found.unwrap().loaded.spec.kind}, not a ${spec.kind}`,
          {
            issues: [
              { path: ['featureId'], rule: 'featureKind', message: `not a ${lower} feature` },
            ],
            where,
          },
        )
      const prev = found.unwrap().loaded.feature as F
      const { start } = featureBlock(l.part.operations, prev.id)
      const env = shapeEnv(l, ctx.services.region2d)
      const f = new Fields(
        l.units,
        SurfaceTable.build(l.part.operations, l.stock).resolver(start),
        env,
      )
      const feature = spec.build(args, prev, {
        f,
        id: prev.id,
        name: args.name ?? prev.name,
        on: args.on ?? prev.on,
        before: l.part.operations.slice(0, start),
      })
      const parsed = f.done()
      if (parsed.isErr()) return Err(parsed.unwrapErr().withContext(where))
      return finish(draft, args.partId, l, spec, feature, prev, where, ctx)
    },
  })
  return Ok([add, update])
}

function finish<F extends FeatureBase>(
  draft: Draft<ProjectDoc>,
  partId: string,
  loaded: LoadedPart,
  spec: FeatureKindSpec<F>,
  feature: F,
  prev: F | undefined,
  where: string,
  ctx: CommandContext,
) {
  const placed = placeFeature(
    loaded,
    spec,
    feature,
    prev,
    where,
    shapeEnv(loaded, ctx.services.region2d),
  )
  if (placed.isErr()) return placed
  writePlaced(draft, partId, placed.unwrap(), spec.toDTO(feature))
  const result = { featureId: feature.id, operationIds: placed.unwrap().owned.map((o) => o.id) }
  return withWarnings(result, loaded, placed.unwrap().ops, ctx, where)
}

// ── shared commands ────────────────────────────────────────────────────────────────────────

const featureRemove = defineCommand({
  kind: 'document',
  name: 'design.feature.remove',
  summary: 'Remove a feature and its operations (design.referenced if later ones use them).',
  title: () => 'Remove feature',
  machine: false,
  args: z.object(FeatureArg),
  result: FeatureResult,
  run(draft, args, ctx) {
    const where = 'design.feature.remove'
    const loaded = load(draft, args.partId, where)
    if (loaded.isErr()) return loaded
    const l = loaded.unwrap()
    const found = findFeature(l, args.featureId, where)
    if (found.isErr()) return found
    const ops = l.part.operations
    const { start, end } = featureBlock(ops, args.featureId)
    const next = [...ops.slice(0, start), ...ops.slice(end)]
    const refs = checkReferences(next, l.stock)
    if (refs.isErr()) return Err(refs.unwrapErr().withContext(where, { featureId: args.featureId }))
    const target = draft.parts[args.partId]!
    target.operations.splice(start, end - start)
    target.features!.splice(
      target.features!.findIndex((f) => f.id === args.featureId),
      1,
    )
    if (target.features!.length === 0) delete target.features
    const result = {
      featureId: args.featureId,
      operationIds: ops.slice(start, end).map((o) => o.id),
    }
    return withWarnings(result, l, next, ctx, where)
  },
})

const featureMove = defineCommand({
  kind: 'document',
  name: 'design.feature.move',
  summary: "Move a feature's operations as one block.",
  title: () => 'Move feature',
  machine: false,
  args: z.object({
    ...FeatureArg,
    toIndex: z.number().int().min(0).describe('New 0-based index of its first operation'),
  }),
  result: FeatureResult,
  run(draft, args, ctx) {
    const where = 'design.feature.move'
    const loaded = load(draft, args.partId, where)
    if (loaded.isErr()) return loaded
    const l = loaded.unwrap()
    const found = findFeature(l, args.featureId, where)
    if (found.isErr()) return found
    const ops = l.part.operations
    const { start, end } = featureBlock(ops, args.featureId)
    const size = end - start
    const max = ops.length - size
    if (args.toIndex > max)
      return fail('input.malformed', 'toIndex is past the end of the operation list', {
        issues: [
          { path: ['toIndex'], rule: 'range', message: `must be at most ${max}`, params: { max } },
        ],
        where,
      })
    const operationIds = ops.slice(start, end).map((o) => o.id)
    if (args.toIndex === start)
      return withWarnings({ featureId: args.featureId, operationIds }, l, ops, ctx, where)
    const rest = [...ops.slice(0, start), ...ops.slice(end)]
    const next = [
      ...rest.slice(0, args.toIndex),
      ...ops.slice(start, end),
      ...rest.slice(args.toIndex),
    ]
    const split = splitFeature(next, args.toIndex, args.toIndex + size, where)
    if (split.isErr()) return split
    const refs = checkReferences(next, l.stock)
    if (refs.isErr()) return Err(refs.unwrapErr().withContext(where, { featureId: args.featureId }))
    const list = draft.parts[args.partId]!.operations
    const block = list.splice(start, size)
    list.splice(args.toIndex, 0, ...block)
    return withWarnings({ featureId: args.featureId, operationIds }, l, next, ctx, where)
  },
})

const FeatureEntry = z.object({
  feature: FeatureDtoSchema.describe('The feature record (kind parameters included)'),
  index: z.number().int().describe('Operation index of its first owned operation'),
  operationIds: z.array(OperationIdSchema).describe('Owned operations in design order'),
})

const featureList = defineQuery({
  name: 'design.feature.list',
  summary: "List a part's features and their operations (featureId: one).",
  args: z.object({ ...PartArg, featureId: FeatureIdSchema.optional() }),
  result: z.object({ features: z.array(FeatureEntry) }),
  run(doc, args) {
    const where = 'design.feature.list'
    const loaded = load(doc as Draft<ProjectDoc>, args.partId, where)
    if (loaded.isErr()) return loaded
    const l = loaded.unwrap()
    const ops = l.part.operations
    const entry = ({ feature }: LoadedFeature) => {
      const { start, end } = featureBlock(ops, feature.id)
      const dto = l.dto.features!.find((f) => f.id === feature.id)!
      return { feature: dto, index: start, operationIds: ops.slice(start, end).map((o) => o.id) }
    }
    if (args.featureId !== undefined) {
      const found = findFeature(l, args.featureId, where)
      if (found.isErr()) return found
      return Ok({ features: [entry(found.unwrap().loaded)] })
    }
    const features = l.features.map(entry).sort((a, b) => a.index - b.index)
    return Ok({ features })
  },
})

export const FEATURE_COMMANDS: readonly AnyCommand[] = [featureRemove, featureMove]
export const FEATURE_QUERIES: readonly QueryDef[] = [featureList]
