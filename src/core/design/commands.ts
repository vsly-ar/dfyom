/**
 * Design commands and queries (v0.1): parts, facing, pocket, drilling, profile with tabs.
 * Doc: docs/modes/design.md#commands-and-queries-v01, docs/modes/design.md#implementation-task-25
 *
 * All commands are `document` commands (one gesture = one undo step). Quantities arrive as
 * entered and are parsed here against the design reference resolver; every edit then checks the
 * whole part: own constraints, references (`design.referenced`), recalculation of dependants,
 * constraints of the others. Every command on a part returns the part's DFM parameter and tool
 * warnings with its result (docs/modes/design.md#dfm-warnings-task-28-wiring); a warning never
 * fails a command.
 */
import type { Draft } from 'immer'
import { z } from 'zod'
import type { Issue } from '../../shared/errors/app-error'
import {
  collect,
  Err,
  fail,
  None,
  Ok,
  Some,
  type AppResult,
  type Option,
} from '../../shared/result'
import { defineCommand, defineQuery, type AnyCommand, type QueryDef } from '../commands/define'
import type { PendingChange } from '../commands/apply'
import type { CommandContext } from '../commands/context'
import type { ReferenceResolver } from '../expression/evaluate'
import { quantityFromSource } from '../expression/quantity'
import { ItemIdSchema, NAME_MAX } from '../library/item'
import { deepEqual, SnapshotDtoSchema, takeSnapshot } from '../library/snapshot'
import type { Stock } from '../library/stock'
import type { ProjectDoc, UnitSystem } from '../project/document'
import { Quantity } from '../quantity/quantity'
import { Rational } from '../quantity/rational'
import { loadPart, unknownPart, type LoadedPart } from './load'
import {
  CENTRE_ANCHOR,
  DEFAULTS,
  fieldContext,
  generalToleranceToDTO,
  ID_PREFIX,
  KIND_LABEL,
  operationToDTO,
  isGeneralShape,
  shapesOf,
  type Anchor,
  type FeatureOwner,
  type FieldKind,
  type GeneralTolerance,
  type Operation,
  type Part,
  type Shape,
} from './operation'
import {
  AnchorDtoSchema,
  DesignToolDtoSchema,
  DRILL_BOTTOMS,
  OperationDtoSchema,
  type OperationDTO,
  OperationIdSchema,
  PartDtoSchema,
  type PartDTO,
  PartIdSchema,
  PROFILE_SIDES,
  SurfaceIdSchema,
  type OperationKind,
} from './part.dto'
import { checkReferences, recalculate, STOCK_TOP, SurfaceTable } from './surfaces'
import { checkOperations, operationIssues } from './validate'
import {
  EvaluationErrorSchema,
  EvaluationStatusSchema,
  partEvaluate,
  warningsWithEvaluation,
} from './evaluation'
import { DfmWarningSchema, libraryTools, partWarnings } from './warnings'
import { ToolArg, toolFromArg, type ToolArgs } from './tool-args'
import { designToolToDTO, type DesignTool } from './tool'
import { reanchor, type Extents } from './anchor'
import type { Region2dPort } from '../geometry/2d/port'
import { exactExtents, placeShape, shapeFacts } from './placement'
import { requirePort, shapeFromDTO as namedShapeFromDTO } from './shape'
import { SHAPE_ID_PATTERN } from './shape.dto'

import { designChangeTargets } from './shape-users'
import { featureOwnedError, nestingFeature, spanUnits, type LoadedFeature } from './feature'
import { mapFeatureIssues, settleFeatures } from './feature-sync'
import { derivedLength } from './hole'

// ── arg schemas ───────────────────────────────────────────────────────────────────────────

export const Src = z
  .string()
  .min(1)
  .max(256)
  .describe('Literal (`1/16"`, `6 ±0.05`) or formula (`facing1.floor.z - 2`)')
export const PointArg = z.tuple([Src, Src]).describe('[u, v] in the face frame')
const RotationArg = Src.optional().describe('CCW about the anchor point; default 0°')
const ShapeArg = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('rectangle'),
      center: PointArg,
      length: Src.describe('Size along u'),
      width: Src.describe('Size along v'),
      cornerRadius: Src.optional().describe('Default 3 mm / 1/8"'),
      rotation: RotationArg,
    }),
    z.object({ kind: z.literal('circle'), center: PointArg, diameter: Src }),
    z.object({
      kind: z.literal('named'),
      shapeId: z.string().regex(SHAPE_ID_PATTERN),
      center: PointArg,
      rotation: RotationArg,
      mirror: z.literal(true).optional().describe('Flip x before rotating'),
    }),
  ])
  .describe('center = anchor point; named places a part shape. Replaces the shape on update')
export const AnchorArg = AnchorDtoSchema.describe(
  'Placed-box point center gives; default centre; update keeps the feature in place',
)
export const ToleranceArg = z
  .object({
    length: Src.nullable().optional().describe('Lengths, e.g. "0.1 mm"; null clears'),
    angle: Src.nullable().optional().describe('Angles, e.g. "0.5°"; null clears'),
  })
  .describe('General ± for untoleranced values')
export const NameArg = z.string().min(1).max(NAME_MAX).describe('Display label')
export const OnArg = SurfaceIdSchema.describe(
  'Start face: stock.top/bottom/side[0..3] or an earlier floor / tab top; default last top facing floor',
)
const StockFaceArg = SurfaceIdSchema.describe(
  'Stock face it starts from: stock.top (default), stock.bottom or stock.side[0..3]',
)
export const PartArg = { partId: PartIdSchema }
const OpArg = { partId: PartIdSchema, operationId: OperationIdSchema }
const TabsArg = z.object({
  count: Src.optional().describe('Whole number ≥ 0; default 4'),
  width: Src.optional().describe('Default 6 mm / 1/4"'),
  thickness: Src.optional().describe('Up from the opposite stock face; default 2 mm / 1/16"'),
  positions: z
    .array(Src)
    .nullable()
    .optional()
    .describe('Along the loop from its start point; replace count; null clears'),
})

const facingParams = {
  on: StockFaceArg.optional(),
  depth: Src.optional().describe('Default 0.5 mm / 1/64"'),
}
const pocketParams = {
  on: OnArg.optional(),
  shape: ShapeArg,
  anchor: AnchorArg.optional(),
  depth: Src,
  floorRadius: Src.optional().describe('Floor fillet radius; default 0'),
}
const drillingParams = {
  on: OnArg.optional(),
  center: PointArg,
  diameter: Src,
  bottom: z.enum(DRILL_BOTTOMS).optional().describe('Default through'),
  depth: Src.optional().describe('To full diameter; required unless through'),
  pointAngle: Src.optional().describe('drillPoint only; default 118°'),
}
const profileParams = {
  on: StockFaceArg.optional(),
  shape: ShapeArg,
  anchor: AnchorArg.optional(),
  side: z.enum(PROFILE_SIDES).optional().describe('Default outside; on: centred on the line'),
  slotWidth: Src.optional().describe('Default 6 mm / 1/4"'),
  depth: Src.nullable().optional().describe('on only: blind groove depth; null = through'),
  tabs: TabsArg.optional(),
}

const chamferParams = {
  edgeOf: OperationIdSchema.describe('Earlier drilling or circle pocket'),
  diameter: Src.describe('Default edge Ø + 1 mm'),
  angle: Src.describe('Default 90°'),
}

type ShapeArgs = z.output<typeof ShapeArg>

/**
 * Where an edit's named shapes come from: the part's shape DTOs (the draft's, so a shape command
 * sees its own edit) and the 2D port that places them (`services.region2d`).
 */
export interface ShapeEnv {
  readonly dto: Pick<PartDTO, 'shapes'>
  readonly port?: Region2dPort
}

export const shapeEnv = (loaded: LoadedPart, port: Region2dPort | undefined): ShapeEnv => ({
  dto: loaded.dto,
  ...(port === undefined ? {} : { port }),
})
export type ToleranceArgs = z.output<typeof ToleranceArg>

// ── field parsing ─────────────────────────────────────────────────────────────────────────

const toPath = (path: string) => path.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s))

/**
 * Parses the sources of one operation against its resolver, collecting every error. Values it
 * returns are only meaningful once `done()` is Ok.
 */
export class Fields {
  private readonly results: AppResult<unknown>[] = []
  constructor(
    readonly units: UnitSystem,
    private readonly resolver: ReferenceResolver,
    private readonly env: ShapeEnv = { dto: {} },
  ) {}

  q(path: string, kind: FieldKind, source: string): Quantity {
    const r = quantityFromSource(source, fieldContext(kind, this.units), this.resolver).mapErr(
      (e) => e.prefixIssues(...toPath(path)),
    )
    this.results.push(r)
    return r.unwrapOr(undefined as unknown as Quantity)
  }

  /** `source` if given, else `prev` (a required parameter: always given on add). */
  val(
    path: string,
    kind: FieldKind,
    source: string | undefined,
    prev: Quantity | undefined,
  ): Quantity {
    return source !== undefined ? this.q(path, kind, source) : prev!
  }

  /** `source` if given, else `prev`, else the design.md default. */
  pick(
    path: string,
    kind: FieldKind,
    source: string | undefined,
    prev: Quantity | undefined,
    def: keyof typeof DEFAULTS,
  ): Quantity {
    if (source !== undefined) return this.q(path, kind, source)
    return prev ?? this.q(path, kind, DEFAULTS[def][this.units])
  }

  /** The shape from its args; `center` gives the point `anchor` names. */
  shape(a: ShapeArgs, anchor: Anchor): Shape {
    const center = [
      this.q('shape.center.0', 'length', a.center[0]),
      this.q('shape.center.1', 'length', a.center[1]),
    ] as const
    if (a.kind === 'circle')
      return {
        kind: 'circle',
        center,
        anchor,
        diameter: this.q('shape.diameter', 'length', a.diameter),
      }
    const rotation: Option<Quantity> =
      a.rotation === undefined ? None : Some(this.q('shape.rotation', 'angle', a.rotation))
    if (a.kind === 'named') {
      if (!(this.env.dto.shapes ?? []).some((s) => s.id === a.shapeId))
        this.results.push(
          fail('input.malformed', `shape ${a.shapeId} does not exist in the part`, {
            issues: [
              { path: ['shape', 'shapeId'], rule: 'unknownShape', message: 'no such shape' },
            ],
          }),
        )
      return {
        kind: 'named',
        center,
        anchor,
        shapeId: a.shapeId,
        rotation,
        mirror: a.mirror === true,
      }
    }
    return {
      kind: 'rectangle',
      center,
      anchor,
      length: this.q('shape.length', 'length', a.length),
      width: this.q('shape.width', 'length', a.width),
      cornerRadius: this.pick(
        'shape.cornerRadius',
        'length',
        a.cornerRadius,
        undefined,
        'cornerRadius',
      ),
      rotation,
    }
  }

  /** `source` if given (null: None), else `prev`, else None. */
  opt(
    path: string,
    kind: FieldKind,
    source: string | null | undefined,
    prev: Option<Quantity> | undefined,
  ): Option<Quantity> {
    if (source === null) return None
    if (source !== undefined) return Some(this.q(path, kind, source))
    return prev ?? None
  }

  /** The placed box of a general shape as exact extents (re-anchoring, anchor.ts). */
  private extents(shape: Shape): AppResult<Extents | undefined> {
    if (!isGeneralShape(shape)) return Ok(undefined)
    const where = 'placedShape'
    return requirePort(this.env.port, where).andThen((port) =>
      this.shapesFor(shape)
        .andThen((shapes) => placeShape(port, shape, shapes))
        .map((p) => exactExtents(p.size)),
    )
  }

  /** The named shape `shape` places, loaded (absent for other kinds). */
  private shapesFor(shape: Shape): AppResult<Part['shapes']> {
    if (shape.kind !== 'named') return Ok(undefined)
    const dto = this.env.dto.shapes?.find((s) => s.id === shape.shapeId)
    if (dto === undefined)
      return fail('input.malformed', `shape ${shape.shapeId} does not exist in the part`, {
        issues: [{ path: ['shape', 'shapeId'], rule: 'unknownShape', message: 'no such shape' }],
      })
    return namedShapeFromDTO(dto).map((n) => new Map([[shape.shapeId, n]]))
  }

  /**
   * The shape of an operation: on add (no `prev`) `center` gives `anchor` (default centre); on
   * update a new shape keeps the previous anchor, then a given `anchor` re-anchors it without
   * moving the feature (design-v0.2.md#placement-anchors).
   */
  placedShape(
    a: ShapeArgs | undefined,
    anchor: Anchor | undefined,
    prev: Shape | undefined,
  ): Shape {
    if (prev === undefined) return this.shape(a!, anchor ?? CENTRE_ANCHOR)
    const shape = a !== undefined ? this.shape(a, prev.anchor) : prev
    if (anchor === undefined) return shape
    // a shape arg that failed to parse has holes: its own errors are reported instead
    if (this.results.some((r) => r.isErr())) return shape
    const r = this.extents(shape).andThen((extents) => reanchor(shape, anchor, extents))
    this.results.push(r)
    return r.unwrapOr(shape)
  }

  tolerance(a: ToleranceArgs | undefined, prev: GeneralTolerance): GeneralTolerance {
    const one = (kind: 'length' | 'angle', prevValue: Option<Quantity>): Option<Quantity> => {
      const src = a?.[kind]
      if (src === undefined) return prevValue
      if (src === null) return None
      const path = ['generalTolerance', kind]
      const r = Quantity.parse(src, fieldContext(kind, this.units))
        .mapErr((e) => e.prefixIssues(...path))
        .andThen((v) =>
          v.exact.compare(Rational.ZERO) >= 0 && v.tolerance.isNone()
            ? Ok(v)
            : fail('model.invariant', 'general tolerance must be a deviation ≥ 0', {
                issues: [
                  { path, rule: 'nonNegative', message: 'must be a ± deviation ≥ 0, e.g. 0.1 mm' },
                ],
              }),
        )
      this.results.push(r)
      return r.isOk() ? Some(r.unwrap()) : None
    }
    return { length: one('length', prev.length), angle: one('angle', prev.angle) }
  }

  /**
   * A value that is missing or not allowed with the other args (`model.invariant` at `path`,
   * e.g. rule `required`); like a failed parse, the returned value is unusable and `done()` fails.
   */
  issue(path: string, rule: string, message: string): Quantity {
    this.results.push(
      fail('model.invariant', `${path} ${message}`, {
        issues: [{ path: toPath(path), rule, message }],
      }),
    )
    return undefined as unknown as Quantity
  }

  done(): AppResult<void> {
    return collect(this.results).map(() => undefined)
  }
}

// ── warnings ──────────────────────────────────────────────────────────────────────────────

export const Warnings = z
  .array(DfmWarningSchema)
  .describe('DFM parameter and tool warnings of the part after the command; they never block')

/**
 * `value` plus the part's warnings against the current tool library. Without a library service
 * only the geometric rules run, so an edit never fails because of the checks; a mapper error is
 * a bug (`internal.unexpected`).
 */
export function withWarnings<R extends object>(
  value: R,
  loaded: LoadedPart,
  operations: readonly Operation[],
  ctx: CommandContext,
  where: string,
  /** The part's features after the command (a feature command changed them). */
  features: readonly LoadedFeature[] = loaded.features,
) {
  const library = ctx.services.library
  const tools = library === undefined ? [] : libraryTools(library)
  return shapesOf(operations, loaded.dto)
    .andThen((shapes) =>
      partWarnings(
        { ...loaded.part, operations, ...(shapes.size === 0 ? {} : { shapes }) },
        loaded.stock,
        loaded.units,
        tools,
        loaded.snapshots,
        ctx.services.region2d,
        features,
      ),
    )
    .map((warnings) => ({ ...value, warnings }))
    .mapErr((e) => e.withContext(where))
}

// ── part editing ──────────────────────────────────────────────────────────────────────────

export const NO_TOLERANCE: GeneralTolerance = { length: None, angle: None }

export function load(
  draft: Draft<ProjectDoc>,
  partId: string,
  where: string,
): AppResult<LoadedPart> {
  return loadPart(draft as ProjectDoc, partId, where)
}

export function invalid(issues: Issue[], where: string): AppResult<never> {
  return fail('model.invariant', `${issues.length} invalid value(s)`, { issues, where })
}

/**
 * Whole-part check after an edit of `edited`: its constraints, references of all operations,
 * recalculation of its dependants (`recalc`), constraints of the others. Named shapes are loaded
 * from `env` and placed for their checks (validate.ts `ShapeFacts`).
 */
export function settle(
  ops: readonly Operation[],
  stock: Stock,
  edited: string | undefined,
  recalc: boolean,
  where: string,
  env: ShapeEnv = { dto: {} },
): AppResult<readonly Operation[]> {
  const loadedShapes = shapesOf(ops, env.dto)
  if (loadedShapes.isErr()) return Err(loadedShapes.unwrapErr().withContext(where))
  const shapes = loadedShapes.unwrap()
  const facts = shapeFacts(ops, shapes, env.port)
  if (facts.isErr()) return Err(facts.unwrapErr().withContext(where))
  if (edited !== undefined) {
    const own = operationIssues(
      ops,
      ops.findIndex((o) => o.id === edited),
      stock,
      SurfaceTable.build(ops, stock, shapes),
      facts.unwrap(),
    )
    if (own.length > 0) return invalid(own, where)
  }
  const refs = checkReferences(ops, stock)
  if (refs.isErr()) return Err(refs.unwrapErr().withContext(where))
  const next = recalc && edited !== undefined ? recalculate(ops, stock, edited) : Ok([...ops])
  if (next.isErr()) return Err(next.unwrapErr().withContext(where))
  return checkOperations(next.unwrap(), stock, edited, facts.unwrap(), shapes)
    .map(() => next.unwrap())
    .mapErr((e) => e.withContext(where))
}

/** Writes operations whose DTO changed (and appended ones) to the draft. */
function writeOperations(draft: Draft<ProjectDoc>, partId: string, ops: readonly Operation[]) {
  writeOperationList(draft.parts[partId]!.operations, ops)
}

/**
 * Writes operations whose DTO changed (and appended ones) to a DTO list (a draft's part or a
 * plan's design snapshot); the list must not be longer than `ops`.
 */
export function writeOperationList(list: OperationDTO[], ops: readonly Operation[]): void {
  ops.forEach((op, i) => {
    const dto = operationToDTO(op)
    if (i >= list.length) list.push(dto)
    else if (!deepEqual(list[i], dto)) list[i] = dto
  })
}

/** Writes the records of the features in `changed` (recalculated, feature-sync.ts). */
export function writeFeatures(
  draft: Draft<ProjectDoc>,
  partId: string,
  features: readonly LoadedFeature[],
  changed: readonly string[],
): void {
  const records = draft.parts[partId]!.features
  if (records === undefined) return
  for (const id of changed) {
    const l = features.find((f) => f.feature.id === id)
    const i = records.findIndex((f) => f.id === id)
    if (l !== undefined && i >= 0) records[i] = l.spec.toDTO(l.feature)
  }
}

function nextNumber(part: Part, kind: OperationKind): number {
  const prefix = ID_PREFIX[kind]
  let max = 0
  for (const o of part.operations)
    if (o.id.startsWith(prefix) && /^\d+$/.test(o.id.slice(prefix.length)))
      max = Math.max(max, Number(o.id.slice(prefix.length)))
  return max + 1
}

/** design.md: the last top facing's floor, else `stock.top`. */
export function defaultOn(ops: readonly Operation[]): string {
  const facing = ops.findLast((o) => o.kind === 'facing' && o.on === STOCK_TOP)
  return facing === undefined ? STOCK_TOP : `${facing.id}.floor`
}

export function findOperation(
  part: Part,
  operationId: string,
  kind: OperationKind | undefined,
  where: string,
): AppResult<number> {
  const index = part.operations.findIndex((o) => o.id === operationId)
  const issue = (rule: string, message: string) =>
    fail('input.malformed', `${operationId}: ${message}`, {
      issues: [{ path: ['operationId'], rule, message }],
      where,
    })
  if (index < 0) return issue('unknownOperation', 'no such operation in the part')
  if (kind !== undefined && part.operations[index]!.kind !== kind)
    return issue('operationKind', `is a ${part.operations[index]!.kind}, not a ${kind}`)
  return Ok(index)
}

/**
 * `design.featureOwned` when the operation at `index` is owned by a feature (A4, A5): its geometry,
 * order and life go through the feature.
 */
export function refuseOwned(
  loaded: LoadedPart,
  index: number,
  where: string,
  /** Also refuse an operation another feature nests (a Clones source, F5): its order and life go through that feature. */
  nested = false,
): AppResult<void> {
  const op = loaded.part.operations[index]!
  if (nested && op.owner.isNone()) {
    const outer = nestingFeature(loaded.part.operations, loaded.features, op.id)
    if (outer !== undefined)
      return fail(
        'design.featureOwned',
        `${op.id} is nested in ${outer.feature.name} (${outer.feature.id}); change that feature instead`,
        {
          issues: [
            {
              path: ['operationId'],
              rule: 'featureNested',
              message: `nested in ${outer.feature.name}`,
              params: { featureId: outer.feature.id },
            },
          ],
          data: { operationId: op.id, featureId: outer.feature.id },
          where,
        },
      )
  }
  if (op.owner.isNone()) return Ok(undefined)
  const owner = op.owner.unwrap()
  const name = loaded.dto.features?.find((f) => f.id === owner.featureId)?.name ?? owner.featureId
  return featureOwnedError(op.id, owner, name, where)
}

/** The operation is owned by a read-only kind (Clones instances): not even name or tool edits. */
export function readOnlyOwned(loaded: LoadedPart, operationId: string): boolean {
  const op = loaded.part.operations.find((o) => o.id === operationId)
  if (op === undefined || op.owner.isNone()) return false
  const featureId = op.owner.unwrap().featureId
  return loaded.features.find((l) => l.feature.id === featureId)?.spec.readOnly === true
}

/** Args an owned operation still takes on `design.<kind>.update` (A4: kept per operation). */
const OWNED_EDITABLE: ReadonlySet<string> = new Set([
  'partId',
  'operationId',
  'name',
  'generalTolerance',
])

interface BuildContext {
  readonly f: Fields
  readonly id: string
  readonly name: string
  readonly ops: readonly Operation[]
}

/** One operation kind: its parameter args and how args (plus the previous version) build it. */
interface KindSpec<P extends z.ZodRawShape, O extends Operation> {
  readonly kind: O['kind']
  readonly params: P
  /** Parameters required on add (all are optional on update). */
  readonly required: readonly (keyof P & string)[]
  /** The tool field is not a parameter: add and update set it (design-v0.2.md § Operation tool). */
  build(
    args: Partial<z.output<z.ZodObject<P>>>,
    prev: O | undefined,
    c: BuildContext,
  ): Omit<O, 'tool' | 'toolLocked' | 'owner'>
}

type Args<P extends z.ZodRawShape> = Partial<z.output<z.ZodObject<P>>>

const facingSpec: KindSpec<typeof facingParams, Extract<Operation, { kind: 'facing' }>> = {
  kind: 'facing',
  params: facingParams,
  required: [],
  build: (a, prev, { f, id, name }) => ({
    kind: 'facing',
    id,
    name,
    generalTolerance: prev?.generalTolerance ?? NO_TOLERANCE,
    on: a.on ?? prev?.on ?? STOCK_TOP,
    depth: f.pick('depth', 'length', a.depth, prev?.depth, 'facingDepth'),
  }),
}

const pocketSpec: KindSpec<typeof pocketParams, Extract<Operation, { kind: 'pocket' }>> = {
  kind: 'pocket',
  params: pocketParams,
  required: ['shape', 'depth'],
  build: (a, prev, { f, id, name, ops }) => ({
    kind: 'pocket',
    id,
    name,
    generalTolerance: prev?.generalTolerance ?? NO_TOLERANCE,
    on: a.on ?? prev?.on ?? defaultOn(ops),
    shape: f.placedShape(a.shape, a.anchor, prev?.shape),
    depth: f.val('depth', 'length', a.depth, prev?.depth),
    floorRadius: f.pick('floorRadius', 'length', a.floorRadius, prev?.floorRadius, 'floorRadius'),
  }),
}

const drillingSpec: KindSpec<typeof drillingParams, Extract<Operation, { kind: 'drilling' }>> = {
  kind: 'drilling',
  params: drillingParams,
  required: ['center', 'diameter'],
  build: (a, prev, { f, id, name, ops }) => {
    const bottom = a.bottom ?? prev?.bottom ?? 'through'
    // a bottom that does not use depth / pointAngle drops them; drillPoint defaults to 118°
    const depth: Option<Quantity> =
      a.depth !== undefined
        ? Some(f.q('depth', 'length', a.depth))
        : bottom === 'through'
          ? None
          : (prev?.depth ?? None)
    const pointAngle: Option<Quantity> =
      a.pointAngle !== undefined
        ? Some(f.q('pointAngle', 'angle', a.pointAngle))
        : bottom !== 'drillPoint'
          ? None
          : prev !== undefined && prev.pointAngle.isSome()
            ? prev.pointAngle
            : Some(f.q('pointAngle', 'angle', DEFAULTS.pointAngle[f.units]))
    return {
      kind: 'drilling',
      id,
      name,
      generalTolerance: prev?.generalTolerance ?? NO_TOLERANCE,
      on: a.on ?? prev?.on ?? defaultOn(ops),
      center:
        a.center !== undefined
          ? [f.q('center.0', 'length', a.center[0]), f.q('center.1', 'length', a.center[1])]
          : prev!.center,
      diameter: f.val('diameter', 'length', a.diameter, prev?.diameter),
      bottom,
      depth,
      pointAngle,
    }
  },
}

const profileSpec: KindSpec<typeof profileParams, Extract<Operation, { kind: 'profile' }>> = {
  kind: 'profile',
  params: profileParams,
  required: ['shape'],
  build: (a, prev, { f, id, name }) => ({
    kind: 'profile',
    id,
    name,
    generalTolerance: prev?.generalTolerance ?? NO_TOLERANCE,
    on: a.on ?? prev?.on ?? STOCK_TOP,
    shape: f.placedShape(a.shape, a.anchor, prev?.shape),
    side: a.side ?? prev?.side ?? 'outside',
    slotWidth: f.pick('slotWidth', 'length', a.slotWidth, prev?.slotWidth, 'slotWidth'),
    depth: f.opt('depth', 'length', a.depth, prev?.depth),
    tabs: {
      count: f.pick('tabs.count', 'scalar', a.tabs?.count, prev?.tabs.count, 'tabCount'),
      width: f.pick('tabs.width', 'length', a.tabs?.width, prev?.tabs.width, 'tabWidth'),
      thickness: f.pick(
        'tabs.thickness',
        'length',
        a.tabs?.thickness,
        prev?.tabs.thickness,
        'tabThickness',
      ),
      positions:
        a.tabs?.positions === undefined
          ? (prev?.tabs.positions ?? None)
          : a.tabs.positions === null
            ? None
            : Some(a.tabs.positions.map((p, i) => f.q(`tabs.positions.${i}`, 'length', p))),
    },
  }),
}

/**
 * v0.4 chamfer (design-v0.4.md § Chamfer operation): `on` is not an argument, it is the edge's
 * face; the default diameter is the edge's + 1 mm (1/32" in inch projects).
 */
const chamferSpec: KindSpec<typeof chamferParams, Extract<Operation, { kind: 'chamfer' }>> = {
  kind: 'chamfer',
  params: chamferParams,
  required: ['edgeOf'],
  build: (a, prev, { f, id, name, ops }) => {
    const edgeOf = a.edgeOf ?? prev!.edgeOf
    const index = ops.findIndex((o) => o.id === id)
    const edge = (index < 0 ? ops : ops.slice(0, index)).find((o) => o.id === edgeOf)
    const edgeDiameter =
      edge?.kind === 'drilling'
        ? edge.diameter
        : edge?.kind === 'pocket' && edge.shape.kind === 'circle'
          ? edge.shape.diameter
          : undefined
    const diameter = (): Quantity => {
      if (a.diameter !== undefined) return f.q('diameter', 'length', a.diameter)
      if (prev !== undefined && a.edgeOf === undefined) return prev.diameter
      if (edgeDiameter === undefined)
        return f.issue('edgeOf', 'chamferEdge', 'must be an earlier drilling or circle pocket')
      const widen = f.q('diameter', 'length', DEFAULTS.chamferWidening[f.units])
      if (widen === undefined) return widen
      return derivedLength(edgeDiameter.exact.add(widen.exact), f.units).unwrap()
    }
    return {
      kind: 'chamfer',
      id,
      name,
      generalTolerance: prev?.generalTolerance ?? NO_TOLERANCE,
      on: edge?.on ?? prev?.on ?? STOCK_TOP,
      edgeOf,
      diameter: diameter(),
      angle: f.pick('angle', 'angle', a.angle, prev?.angle, 'chamferAngle'),
    }
  },
}

/**
 * `lean` (v0.4 chamfer, tools/list budget): no `tool` and `generalTolerance` args (the tool via
 * `design.operation.tool.set` or Apply's auto choice, tolerances on the values themselves).
 */
function kindCommands<P extends z.ZodRawShape, O extends Operation>(
  spec: KindSpec<P, O>,
  lean = false,
): AnyCommand[] {
  const label = KIND_LABEL[spec.kind]
  const lower = label.toLowerCase()
  const optionalParams = Object.fromEntries(
    Object.entries(spec.params).map(([k, s]) => [k, (s as z.ZodType).optional()]),
  ) as unknown as { [K in keyof P]: z.ZodOptional<P[K]> }
  const addParams = Object.fromEntries(
    Object.entries(spec.params).map(([k, s]) => [
      k,
      spec.required.includes(k) ? s : (s as z.ZodType).optional(),
    ]),
  ) as P

  const add = defineCommand({
    kind: 'document',
    name: `design.${spec.kind}.add`,
    summary: lean
      ? `Add a ${lower} at the end of the part.`
      : `Add a ${lower} operation at the end of the part; omitted parameters take defaults.`,
    title: () => `Add ${lower}`,
    machine: false,
    args: z.object({
      ...PartArg,
      name: NameArg.optional(),
      ...(lean ? {} : { generalTolerance: ToleranceArg.optional() }),
      ...addParams,
      ...(lean ? {} : { tool: ToolArg.optional() }),
    }),
    result: z.object({
      operationId: OperationIdSchema,
      tool: DesignToolDtoSchema.optional().describe('Absent: chosen on Apply'),
      toolLocked: z.boolean(),
      warnings: Warnings,
    }),
    run(draft, rawArgs, ctx) {
      const where = `design.${spec.kind}.add`
      const args = rawArgs as {
        partId: string
        name?: string
        generalTolerance?: ToleranceArgs
        tool?: ToolArgs
      } & Args<P>
      const loaded = load(draft, args.partId, where)
      if (loaded.isErr()) return loaded
      const { part, stock, units } = loaded.unwrap()
      const ops = part.operations
      const env = shapeEnv(loaded.unwrap(), ctx.services.region2d)
      const f = new Fields(units, SurfaceTable.build(ops, stock).resolver(ops.length), env)
      const n = nextNumber(part, spec.kind)
      const id = `${ID_PREFIX[spec.kind]}${n}`
      const built = spec.build(args, undefined, { f, id, name: args.name ?? `${label} ${n}`, ops })
      const generalTolerance = f.tolerance(args.generalTolerance, NO_TOLERANCE)
      const parsed = f.done()
      if (parsed.isErr()) return Err(parsed.unwrapErr().withContext(where))
      // a given tool is a user choice, so it is locked (design-v0.2.md § Tool lock)
      const tool: AppResult<Option<DesignTool>> =
        args.tool === undefined
          ? Ok(None)
          : toolFromArg(args.tool, draft, units, ctx, where).map((t) => Some(t))
      if (tool.isErr()) return tool
      const op = {
        ...built,
        generalTolerance,
        tool: tool.unwrap(),
        toolLocked: args.tool !== undefined,
        owner: None as Option<FeatureOwner>,
      } as O
      const settled = settle([...ops, op], stock, id, false, where, env)
      if (settled.isErr()) return settled
      writeOperations(draft, args.partId, settled.unwrap())
      const result = {
        operationId: id,
        ...(op.tool.isSome() ? { tool: designToolToDTO(op.tool.unwrap()) } : {}),
        toolLocked: op.toolLocked,
      }
      return withWarnings(result, loaded.unwrap(), settled.unwrap(), ctx, where)
    },
  })

  const update = defineCommand({
    kind: 'document',
    name: `design.${spec.kind}.update`,
    summary: lean
      ? `Change a ${lower}.`
      : `Change parameters of a ${lower} operation; dependent formulas are recalculated.`,
    title: () => `Update ${lower}`,
    machine: false,
    args: z.object({
      ...OpArg,
      name: NameArg.optional(),
      ...(lean ? {} : { generalTolerance: ToleranceArg.optional() }),
      ...optionalParams,
    }),
    result: z.object({ warnings: Warnings }),
    run(draft, rawArgs, ctx) {
      const where = `design.${spec.kind}.update`
      const args = rawArgs as { partId: string; operationId: string } & UpdateArgs<P>
      const loaded = load(draft, args.partId, where)
      if (loaded.isErr()) return loaded
      // an owned operation keeps only its name and tolerance; its geometry is the feature's; a
      // read-only kind's operations (Clones instances) keep nothing of their own
      const geometric = Object.keys(args).some(
        (k) => !OWNED_EDITABLE.has(k) && (args as Record<string, unknown>)[k] !== undefined,
      )
      if (geometric || readOnlyOwned(loaded.unwrap(), args.operationId)) {
        const found = findOperation(loaded.unwrap().part, args.operationId, spec.kind, where)
        if (found.isErr()) return found
        const owned = refuseOwned(loaded.unwrap(), found.unwrap(), where)
        if (owned.isErr()) return owned
      }
      const l = loaded.unwrap()
      const settled = applyUpdate(spec, l, args.operationId, args, where, ctx.services.region2d)
      if (settled.isErr())
        return Err(mapFeatureIssues(settled.unwrapErr(), l.part.operations, l.features))
      // feature fields written as expressions follow the edit (design-v0.4.md#implementation-f3)
      const env = shapeEnv(l, ctx.services.region2d)
      const synced = settleFeatures(settled.unwrap(), l.features, l.stock, l.units, where, env)
      if (synced.isErr()) return synced
      const { ops, features, changed } = synced.unwrap()
      writeOperations(draft, args.partId, ops)
      writeFeatures(draft, args.partId, features, changed)
      return withWarnings({}, l, ops, ctx, where, features)
    },
  })
  return [add, update]
}

type UpdateArgs<P extends z.ZodRawShape> = {
  name?: string
  generalTolerance?: ToleranceArgs
} & Args<P>

/**
 * One operation of a loaded part updated from args as entered, with the whole-part check
 * (`settle`). Returns all operations; writes nothing.
 */
function applyUpdate<P extends z.ZodRawShape, O extends Operation>(
  spec: KindSpec<P, O>,
  loaded: LoadedPart,
  operationId: string,
  args: UpdateArgs<P>,
  where: string,
  port?: Region2dPort,
): AppResult<readonly Operation[]> {
  const { part, stock, units } = loaded
  const env = shapeEnv(loaded, port)
  const index = findOperation(part, operationId, spec.kind, where)
  if (index.isErr()) return index
  const i = index.unwrap()
  const ops = part.operations
  const prev = ops[i] as O
  const f = new Fields(units, SurfaceTable.build(ops, stock).resolver(i), env)
  const built = spec.build(args, prev, { f, id: prev.id, name: args.name ?? prev.name, ops })
  const op = {
    ...built,
    generalTolerance: f.tolerance(args.generalTolerance, prev.generalTolerance),
    tool: prev.tool,
    toolLocked: prev.toolLocked,
    owner: prev.owner,
  } as O
  const parsed = f.done()
  if (parsed.isErr()) return Err(parsed.unwrapErr().withContext(where))
  const next = ops.map((o, k) => (k === i ? op : o))
  return settle(next, stock, prev.id, true, where, env)
}

// ── part and shared operation commands ────────────────────────────────────────────────────

const partAdd = defineCommand({
  kind: 'document',
  name: 'design.part.add',
  summary: 'Create the part from a block stock of the library (v0.1: one part per project).',
  title: () => 'Add part',
  machine: false,
  args: z.object({
    name: NameArg,
    stockLibraryItemId: ItemIdSchema.describe('Library stock to take a snapshot of'),
  }),
  result: z.object({ partId: PartIdSchema }),
  run(draft, args, ctx) {
    const where = 'design.part.add'
    if (Object.keys(draft.parts).length > 0)
      return invalid([{ path: [], rule: 'onePart', message: 'v0.1 projects have one part' }], where)
    // a synchronous, read-only library lookup (docs/architecture/commands.md#command-definition)
    const library = ctx.services.library
    if (library === undefined)
      return fail('internal.unexpected', 'no library service configured', { where })
    const found = library.lookup('stock', args.stockLibraryItemId)
    if (found.state !== 'found')
      return fail('input.malformed', `stock ${args.stockLibraryItemId} is not in the library`, {
        issues: [
          {
            path: ['stockLibraryItemId'],
            rule: found.state === 'missing' ? 'unknownItem' : 'unreadableItem',
            message:
              found.state === 'missing' ? 'no such library stock' : 'the stock file does not load',
          },
        ],
        where,
      })
    const snapshotId = ctx.ids.next('snapshot')
    const partId = ctx.ids.next('part')
    const snap = takeSnapshot(found.item, snapshotId, new Date(ctx.clock.now()).toISOString())
    if (snap.isErr()) return Err(snap.unwrapErr().withContext(where))
    draft.snapshots[snapshotId] = snap.unwrap().toDTO()
    draft.parts[partId] = { id: partId, name: args.name, stock: snapshotId, operations: [] }
    return Ok({ partId })
  },
})

const partUpdate = defineCommand({
  kind: 'document',
  name: 'design.part.update',
  summary: 'Rename the part or change its general tolerance.',
  title: () => 'Update part',
  machine: false,
  args: z.object({
    ...PartArg,
    name: NameArg.optional(),
    generalTolerance: ToleranceArg.optional(),
  }),
  result: z.object({ warnings: Warnings }),
  run(draft, args, ctx) {
    const where = 'design.part.update'
    const loaded = load(draft, args.partId, where)
    if (loaded.isErr()) return loaded
    const { part, stock, units } = loaded.unwrap()
    const f = new Fields(units, SurfaceTable.build(part.operations, stock).resolver(0))
    const tol = f.tolerance(args.generalTolerance, part.generalTolerance)
    const parsed = f.done()
    if (parsed.isErr()) return Err(parsed.unwrapErr().withContext(where))
    const target = draft.parts[args.partId]!
    if (args.name !== undefined) target.name = args.name
    const dto = generalToleranceToDTO(tol)
    if (dto === undefined) delete target.generalTolerance
    else if (!deepEqual(target.generalTolerance, dto)) target.generalTolerance = dto
    return withWarnings({}, loaded.unwrap(), part.operations, ctx, where)
  },
})

const operationRemove = defineCommand({
  kind: 'document',
  name: 'design.operation.remove',
  summary: 'Remove an operation; fails with design.referenced if later operations refer to it.',
  title: () => 'Remove operation',
  machine: false,
  args: z.object(OpArg),
  result: z.object({ warnings: Warnings }),
  run(draft, args, ctx) {
    const where = 'design.operation.remove'
    const loaded = load(draft, args.partId, where)
    if (loaded.isErr()) return loaded
    const { part, stock } = loaded.unwrap()
    const index = findOperation(part, args.operationId, undefined, where)
    if (index.isErr()) return index
    const owned = refuseOwned(loaded.unwrap(), index.unwrap(), where, true)
    if (owned.isErr()) return owned
    const next = part.operations.filter((_, k) => k !== index.unwrap())
    const refs = checkReferences(next, stock)
    if (refs.isErr())
      return Err(refs.unwrapErr().withContext(where, { operationId: args.operationId }))
    draft.parts[args.partId]!.operations.splice(index.unwrap(), 1)
    return withWarnings({}, loaded.unwrap(), next, ctx, where)
  },
})

const operationMove = defineCommand({
  kind: 'document',
  name: 'design.operation.move',
  summary: 'Move an operation to another position; references must still point to earlier ones.',
  title: () => 'Move operation',
  machine: false,
  args: z.object({
    ...OpArg,
    toIndex: z.number().int().min(0).describe('New 0-based position in the operation list'),
  }),
  result: z.object({ warnings: Warnings }),
  run(draft, args, ctx) {
    const where = 'design.operation.move'
    const loaded = load(draft, args.partId, where)
    if (loaded.isErr()) return loaded
    const { part, stock } = loaded.unwrap()
    const index = findOperation(part, args.operationId, undefined, where)
    if (index.isErr()) return index
    const from = index.unwrap()
    const owned = refuseOwned(loaded.unwrap(), from, where, true)
    if (owned.isErr()) return owned
    if (args.toIndex >= part.operations.length)
      return fail('input.malformed', 'toIndex is past the end of the operation list', {
        issues: [
          {
            path: ['toIndex'],
            rule: 'range',
            message: `must be at most ${part.operations.length - 1}`,
            params: { max: part.operations.length - 1 },
          },
        ],
        where,
      })
    if (from === args.toIndex) return withWarnings({}, loaded.unwrap(), part.operations, ctx, where)
    const next = [...part.operations]
    const [moved] = next.splice(from, 1)
    next.splice(args.toIndex, 0, moved!)
    const split = splitFeature(
      next,
      args.toIndex,
      args.toIndex + 1,
      where,
      loaded.unwrap().features,
    )
    if (split.isErr()) return split
    const refs = checkReferences(next, stock)
    if (refs.isErr())
      return Err(refs.unwrapErr().withContext(where, { operationId: args.operationId }))
    const list = draft.parts[args.partId]!.operations
    const [dto] = list.splice(from, 1)
    list.splice(args.toIndex, 0, dto!)
    return withWarnings({}, loaded.unwrap(), next, ctx, where)
  },
})

/**
 * `input.malformed` (`insideFeature`) when the unit at `[start, end)` of `ops` (a moved operation
 * or block) sits inside another feature's block: a block stays contiguous (features.md § Order
 * and references).
 */
export function splitFeature(
  ops: readonly Operation[],
  start: number,
  end: number,
  where: string,
  features: readonly LoadedFeature[] = [],
): AppResult<void> {
  // spans (nested operations plus the block, F5) count as their feature
  const units = spanUnits(ops, features)
  const before = start > 0 ? units[start - 1] : undefined
  const after = end < ops.length ? units[end] : undefined
  if (before === undefined || before !== after) return Ok(undefined)
  return fail('input.malformed', `position ${start} is inside feature ${before}`, {
    issues: [
      {
        path: ['toIndex'],
        rule: 'insideFeature',
        message: `inside feature ${before}: move before or after it`,
        params: { featureId: before },
      },
    ],
    where,
  })
}

// ── queries ───────────────────────────────────────────────────────────────────────────────

const partList = defineQuery({
  name: 'design.part.list',
  summary: 'List the parts of the project (v0.1: at most one) with their ids.',
  args: z.object({}),
  result: z.object({ parts: z.array(z.object({ id: PartIdSchema, name: z.string() })) }),
  run(doc) {
    return Ok({ parts: Object.values(doc.parts).map((p) => ({ id: p.id, name: p.name })) })
  },
})

const partGet = defineQuery({
  name: 'design.part.get',
  summary: 'Get a part with its operations and its stock snapshot.',
  args: z.object(PartArg),
  result: z.object({ part: PartDtoSchema, stock: SnapshotDtoSchema }),
  run(doc, args) {
    const part = Object.hasOwn(doc.parts, args.partId) ? doc.parts[args.partId] : undefined
    if (part === undefined) return unknownPart(args.partId, 'design.part.get')
    const stock = Object.hasOwn(doc.snapshots, part.stock) ? doc.snapshots[part.stock] : undefined
    if (stock === undefined)
      return fail('input.malformed', `stock snapshot ${part.stock} is missing`, {
        where: 'design.part.get',
      })
    return Ok({ part, stock })
  },
})

const operationList = defineQuery({
  name: 'design.operation.list',
  summary: 'List the operations of a part in design order.',
  args: z.object(PartArg),
  result: z.object({ operations: z.array(OperationDtoSchema) }),
  run(doc, args) {
    const part = Object.hasOwn(doc.parts, args.partId) ? doc.parts[args.partId] : undefined
    if (part === undefined) return unknownPart(args.partId, 'design.operation.list')
    return Ok({ operations: part.operations })
  },
})

/** Rules against the operation's own tool: Apply may swap an unlocked tool and clear them. */
const TOOL_RULES: ReadonlySet<string> = new Set(['dfm.toolUnfit', 'dfm.toolNotInLibrary'])

/**
 * Operations of a part whose tool Apply chooses again: unlocked, with a pending change (a new
 * part or a changed stock: all of them; a shape: the operations using it), as the
 * `design.toolAutoChoice` hook targets them (docs/architecture/apply.md#queries-for-pending-state).
 */
function choosesAgain(
  part: {
    readonly operations: readonly {
      readonly id: string
      readonly toolLocked?: boolean | undefined
      readonly shape?: unknown
    }[]
  },
  partId: string,
  pending: readonly PendingChange[],
): Set<string> {
  const out = new Set<string>()
  for (const c of pending) {
    if (c.kind !== 'design' || c.partId !== partId) continue
    for (const id of designChangeTargets(part, c)) out.add(id)
  }
  for (const op of part.operations) if (op.toolLocked === true) out.delete(op.id)
  return out
}

const warningList = defineQuery({
  name: 'design.warning.list',
  summary:
    "List a part's DFM warnings: parameter and tool checks now against the whole tool library, plus the geometry warnings once its evaluation is done.",
  args: z.object(PartArg),
  result: z.object({
    warnings: z
      .array(
        z.intersection(
          DfmWarningSchema,
          z.object({
            pendingApply: z
              .literal(true)
              .exactOptional()
              .describe('May change on Apply: a check against an unlocked tool chosen again'),
          }),
        ),
      )
      .describe('In design order; geometry ones only when done'),
    evaluation: EvaluationStatusSchema,
    error: EvaluationErrorSchema.optional(),
  }),
  run(doc, args, ctx) {
    const where = 'design.warning.list'
    const library = ctx.services.library
    if (library === undefined)
      return fail('internal.unexpected', 'no library service configured', { where })
    const loaded = loadPart(doc, args.partId, where)
    if (loaded.isErr()) return loaded
    const { part, stock, units, features } = loaded.unwrap()
    const state = ctx.services.evaluations?.state(doc, args.partId) ?? { status: 'pending' }
    const again = choosesAgain(doc.parts[args.partId]!, args.partId, ctx.apply?.pending() ?? [])
    return partWarnings(
      part,
      stock,
      units,
      libraryTools(library),
      doc.snapshots,
      ctx.services.region2d,
      features,
    )
      .map((warnings) => {
        const r = warningsWithEvaluation(doc, args.partId, warnings, state)
        return {
          ...r,
          warnings: r.warnings.map((w) =>
            TOOL_RULES.has(w.code) && again.has(w.operation)
              ? { ...w, pendingApply: true as const }
              : w,
          ),
        }
      })
      .mapErr((e) => e.withContext(where))
  },
})

const KIND_SPECS = {
  facing: facingSpec,
  pocket: pocketSpec,
  drilling: drillingSpec,
  profile: profileSpec,
  chamfer: chamferSpec,
} as const

type AnyParamKey =
  | keyof typeof facingParams
  | keyof typeof pocketParams
  | keyof typeof drillingParams
  | keyof typeof profileParams
  | keyof typeof chamferParams

/**
 * The parameter args of `design.<kind>.update` for every kind, all optional (equal names share
 * one schema). Used by `plan.design.operation.update` (docs/modes/plan-v0.1.md#plans-are-snapshots).
 */
export const OPERATION_UPDATE_ARGS = {
  name: NameArg.optional(),
  generalTolerance: ToleranceArg.optional(),
  // equal names keep the last kind's schema; the chamfer adds only `angle` (its edge is not
  // re-pointed from a plan, its `diameter` shares the drilling's)
  ...Object.fromEntries(
    Object.values(KIND_SPECS)
      .filter((spec) => spec.kind !== 'chamfer')
      .flatMap((spec) =>
        Object.entries(spec.params).map(([k, schema]) => [k, (schema as z.ZodType).optional()]),
      ),
  ),
  angle: chamferParams.angle.optional(),
} as unknown as {
  name: z.ZodOptional<typeof NameArg>
  generalTolerance: z.ZodOptional<typeof ToleranceArg>
} & { [K in AnyParamKey]: z.ZodOptional<z.ZodType> }

/**
 * Updates any operation of a loaded part with the rules of `design.<its kind>.update`, so a
 * plan's design snapshot is edited exactly like the design. Parameters of another kind are
 * `input.malformed` (rule `notForKind`). Returns all operations; writes nothing.
 */
export function updateOperation(
  loaded: LoadedPart,
  operationId: string,
  args: Readonly<Record<string, unknown>>,
  where: string,
  port?: Region2dPort,
): AppResult<readonly Operation[]> {
  const found = findOperation(loaded.part, operationId, undefined, where)
  if (found.isErr()) return found
  const kind = loaded.part.operations[found.unwrap()]!.kind
  const spec = KIND_SPECS[kind] as unknown as KindSpec<z.ZodRawShape, Operation>
  const allowed = new Set(['name', 'generalTolerance', ...Object.keys(spec.params)])
  const foreign = Object.keys(args).filter((k) => args[k] !== undefined && !allowed.has(k))
  if (foreign.length > 0)
    return fail('input.malformed', `${foreign.join(', ')}: not a parameter of a ${kind}`, {
      issues: foreign.map((k) => ({
        path: [k],
        rule: 'notForKind',
        message: `not a parameter of a ${kind} operation`,
      })),
      where,
    })
  return applyUpdate(spec, loaded, operationId, args as UpdateArgs<z.ZodRawShape>, where, port)
}

export const DESIGN_COMMANDS: readonly AnyCommand[] = [
  partAdd,
  partUpdate,
  ...kindCommands(facingSpec),
  ...kindCommands(pocketSpec),
  ...kindCommands(drillingSpec),
  ...kindCommands(profileSpec),
  ...kindCommands(chamferSpec, true),
  operationRemove,
  operationMove,
  partEvaluate,
]

export const DESIGN_QUERIES: readonly QueryDef[] = [partList, partGet, operationList, warningList]
