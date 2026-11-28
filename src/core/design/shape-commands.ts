/**
 * Shape commands and queries (v0.3 K2): `design.shape.add/update/item.update/remove/convert`,
 * `design.shape.import` (I1), `design.shape.list/get`. Doc: docs/modes/design-v0.3.md#commands-and-queries-v03,
 * docs/architecture/shapes.md#implementation-k2
 *
 * `document` commands (one gesture = one undo step). Item quantities arrive as entered and are
 * parsed against the stock's faces (a shape belongs to the part, not to an operation, so its
 * formulas may name `stock.*` surfaces only). Every edit resolves the shape synchronously through
 * the 2D port (`services.region2d`; absent = the commands fail) and is refused with
 * `model.invariant` issues at `items.<n>.<param>` when it does not resolve. Results carry the
 * part's DFM warnings like every design command.
 */
import type { Draft } from 'immer'
import { z } from 'zod'
import { collect, Err, fail, None, Ok, type AppResult } from '../../shared/result'
import { defineCommand, defineQuery, type AnyCommand, type QueryDef } from '../commands/define'
import { listedAs } from '../commands/json-schema'
import type { CommandContext } from '../commands/context'
import type { ReferenceResolver } from '../expression/evaluate'
import { quantityFromSource, reevaluate } from '../expression/quantity'
import type { Region2dPort } from '../geometry/2d/port'
import { NAME_MAX, quantityFromDTO } from '../library/item'
import type { ProjectDoc, UnitSystem } from '../project/document'
import type { Quantity } from '../quantity/quantity'
import type { QuantityDTO } from '../quantity/quantity.dto'
import { findOperation, refuseOwned, Warnings, withWarnings, writeOperationList } from './commands'
import { loadPart, type LoadedPart } from './load'
import {
  CENTRE_ANCHOR,
  DEFAULTS,
  fieldContext,
  isInlinePath,
  type FieldKind,
  type Operation,
} from './operation'
import { inlineElement, inlineGeometry } from './line-inline'
import { OperationIdSchema, PartIdSchema } from './part.dto'
import {
  definitionOf,
  itemToDTO,
  lookupInDtos,
  mapItem,
  requirePort,
  resolveShape,
  shapeFromDTO,
  shapeName,
  shapeSummary,
  withOffsetSources,
  type ShapeLookup,
} from './shape'
import {
  ShapeDtoSchema,
  ShapeIdSchema,
  ShapeItemArgSchema,
  ShapeSrcSchema,
  SHAPE_ITEMS_MAX,
  type ShapeDTO,
  type ShapeItem,
  type ShapeOp,
  type ShapeSegment,
  type ShapeItemDTO,
} from './shape.dto'
import { featuresUsingShape, operationsUsingShape, shapesOffsetting } from './shape-users'
import { SurfaceTable } from './surfaces'
import { AdjustedSchema, ROUND, settleRound, type Adjusted } from './round'
import { ABSOLUTE_PATH } from './reference-commands'
import { sectionShapeItems, svgShapeItems } from './shape-import'
import {
  FaceArg,
  fitOptions,
  fittedSection,
  lengthArg,
  referenceView,
  sectionName,
  resolveFace,
  storedPlacement,
  targetReference,
} from './reference-find'
import type { FittedLoop } from './reference-section'
import { sectionShapes } from './section-shapes'
import { chainBounds, type ArcElement } from '../geometry/2d/model'
import type { SvgImport } from '../import/svg'
import { svgImportTask, SvgImportReportSchema } from '../import/svg/task'
import { issueSummary } from '../../shared/errors/app-error'

// ── args ────────────────────────────────────────────────────────────────────────────────────

const PartArg = { partId: PartIdSchema }
const ShapeArg = { partId: PartIdSchema, shapeId: ShapeIdSchema }
const NameArg = z.string().min(1).max(NAME_MAX)
const ItemsArg = z
  .array(ShapeItemArgSchema)
  .min(1)
  .max(SHAPE_ITEMS_MAX)
  .describe('Items in order, each combined with those before by its op')

// ── parsing ─────────────────────────────────────────────────────────────────────────────────

type ParamPath = readonly (string | number)[]

/** Field kind of an item quantity by its parameter path. */
function kindOf(path: ParamPath): FieldKind {
  const key = path[0]
  return key === 'rotation' ? 'angle' : key === 'sides' ? 'scalar' : 'length'
}

/** The resolver of shape formulas: the stock's faces only (no operation surfaces). */
function shapeResolver(l: LoadedPart): ReferenceResolver {
  return SurfaceTable.build(l.part.operations, l.stock).resolver(0)
}

/** An item arg's Round intent (DF120): the `round` flag, or `"round"` as its radius. */
interface RoundIntent {
  readonly round: boolean | undefined
  readonly radiusGiven: boolean
}

/**
 * Splits a rectangle item arg into the arg without its Round intent (`round` and a `"round"`
 * radius removed, so the radius takes its default or stored value) and the intent.
 */
function takeRound(arg: unknown): [Record<string, unknown>, RoundIntent] {
  const a = arg as Record<string, unknown>
  if (a['kind'] !== 'rectangle') return [a, { round: undefined, radiusGiven: false }]
  const { round, ...rest } = a
  const sentinel = rest['cornerRadius'] === ROUND
  if (sentinel) delete rest['cornerRadius']
  return [
    rest,
    {
      round: sentinel ? true : (round as boolean | undefined),
      radiusGiven: !sentinel && rest['cornerRadius'] !== undefined,
    },
  ]
}

/**
 * The DF120 apply rule on parsed items (round.ts `settleRound`): each rectangle's radius and
 * Round flag from its intent and its previous version (`prevs[k]`, same kind only).
 */
function settleItemRounds(
  items: readonly ShapeItem<Quantity>[],
  intents: readonly (readonly [unknown, RoundIntent])[],
  prevs: readonly (ShapeItem<Quantity> | undefined)[],
  first: number,
  units: UnitSystem,
): { items: ShapeItem<Quantity>[]; adjusted: Adjusted[] } {
  const adjusted: Adjusted[] = []
  const out = items.map((item, k): ShapeItem<Quantity> => {
    if (item.kind !== 'rectangle') return item
    const p = prevs[k]
    const intent = intents[k]![1]
    const r = settleRound(
      {
        length: item.length,
        width: item.width,
        cornerRadius: item.cornerRadius,
        radiusGiven: intent.radiusGiven,
        round: intent.round,
        units,
        path: `items.${first + k}.cornerRadius`,
      },
      p?.kind === 'rectangle'
        ? {
            length: p.length,
            width: p.width,
            cornerRadius: p.cornerRadius,
            round: p.round === true,
          }
        : undefined,
    )
    if (r.adjusted !== undefined) adjusted.push(r.adjusted)
    const { round: _round, ...rest } = item
    return { ...rest, cornerRadius: r.cornerRadius, ...(r.round ? { round: true as const } : {}) }
  })
  return { items: out, adjusted }
}

const adjustedOf = (adjusted: readonly Adjusted[]): { adjusted?: Adjusted[] } =>
  adjusted.length > 0 ? { adjusted: [...adjusted] } : {}

/** Fills the defaults an item arg may leave out (`op` add, rectangle `cornerRadius`, …). */
function withDefaults(arg: unknown, units: UnitSystem): ShapeItem<Quantity | string> {
  // args leave defaults out; a merged stored item has them all
  const a = arg as { kind: string; op?: ShapeOp; cornerRadius?: unknown; closed?: boolean }
  const op = a.op ?? 'add'
  if (a.kind === 'rectangle')
    return {
      ...a,
      op,
      cornerRadius: a.cornerRadius ?? DEFAULTS.cornerRadius[units],
    } as ShapeItem<string>
  if (a.kind === 'path') {
    const segments = (a as unknown as { segments: { kind: string; cw?: boolean }[] }).segments
    return {
      ...a,
      op,
      closed: a.closed ?? true,
      segments: segments.map((s) => (s.kind === 'arc' ? { ...s, cw: s.cw ?? false } : s)),
    } as ShapeItem<string>
  }
  return { ...a, op } as ShapeItem<string>
}

/**
 * Parses items whose quantities are sources (strings) or already loaded; every error is
 * collected with its `items.<n>.<param>` path.
 */
function parseItems(
  items: readonly ShapeItem<Quantity | string>[],
  first: number,
  units: UnitSystem,
  resolver: ReferenceResolver,
): AppResult<ShapeItem<Quantity>[]> {
  const errors: AppResult<unknown>[] = []
  const out = items.map((item, k) =>
    mapItem(item, (v, path): Quantity => {
      if (typeof v !== 'string') return v
      const r = quantityFromSource(v, fieldContext(kindOf(path), units), resolver).mapErr((e) =>
        e.prefixIssues('items', first + k, ...path),
      )
      errors.push(r)
      return r.unwrapOr(undefined as unknown as Quantity)
    }),
  )
  const bad = errors.filter((r) => r.isErr()).map((r) => r.unwrapErr())
  if (bad.length === 0) return Ok(out)
  if (bad.every((e) => e.code === 'model.invariant') || bad.length > 1) {
    // one error with every issue (the first error's code when they differ)
    const issues = bad.flatMap((e) => e.issues)
    return fail(bad[0]!.code, issueSummary(issues), { issues })
  }
  return Err(bad[0]!)
}

/** A stored item as the model (quantities loaded). */
function loadItem(dto: ShapeItemDTO, n: number): AppResult<ShapeItem<Quantity>> {
  const errors: AppResult<unknown>[] = []
  const item = mapItem(dto, (q: QuantityDTO, path) => {
    const r = quantityFromDTO(q, 'items', n, ...path)
    errors.push(r)
    return r.unwrapOr(undefined as unknown as Quantity)
  })
  const bad = errors.find((r) => r.isErr())
  return bad === undefined ? Ok(item) : Err(bad.unwrapErr())
}

// ── loading and writing ─────────────────────────────────────────────────────────────────────

interface ShapeContext {
  readonly loaded: LoadedPart
  readonly port: Region2dPort
  readonly shapes: readonly ShapeDTO[]
}

function load(
  doc: ProjectDoc,
  partId: string,
  ctx: { services: CommandContext['services'] },
  where: string,
): AppResult<ShapeContext> {
  const port = requirePort(ctx.services.region2d, where)
  if (port.isErr()) return port
  const loaded = loadPart(doc, partId, where)
  if (loaded.isErr()) return loaded
  const shapes = loaded.unwrap().dto.shapes ?? []
  const ids = new Set<string>()
  for (const s of shapes) {
    if (ids.has(s.id))
      return fail('input.malformed', `part ${partId} has two shapes ${s.id}`, {
        where,
        data: { partId, shapeId: s.id },
      })
    ids.add(s.id)
  }
  return Ok({ loaded: loaded.unwrap(), port: port.unwrap(), shapes })
}

function findShape(shapes: readonly ShapeDTO[], shapeId: string, where: string): AppResult<number> {
  const i = shapes.findIndex((s) => s.id === shapeId)
  if (i >= 0) return Ok(i)
  return fail('input.malformed', `${shapeId}: no such shape in the part`, {
    issues: [{ path: ['shapeId'], rule: 'unknownShape', message: 'no such shape in the part' }],
    where,
  })
}

function nextShapeNumber(shapes: readonly ShapeDTO[]): number {
  let max = 0
  // owned shapes (patterns P1, `<featureId>_cells`) are not numbered
  for (const s of shapes)
    if (s.owner === undefined) max = Math.max(max, Number(s.id.slice('shape'.length)))
  return max + 1
}

/**
 * Resolves the items of shape `self` (the shape's invariants, offset sources from the part's
 * `shapes`) and returns their DTOs. The shapes offsetting `self` through any chain are resolved
 * again with the new items: one that would no longer resolve refuses the edit, its issues at
 * `shapes.<id>.items.<n>.<param>` (docs/modes/design-llm-first.md#offset-item).
 */
function settleItems(
  port: Region2dPort,
  items: readonly ShapeItem<Quantity>[],
  where: string,
  shapes: readonly ShapeDTO[],
  self: string,
): AppResult<ShapeItemDTO[]> {
  const stored = lookupInDtos(shapes)
  const mine = definitionOf(items)
  const lookup: ShapeLookup = (id) => (id === self ? mine : stored(id))
  const r = resolveShape(port, withOffsetSources(mine, lookup, new Set([self])))
  if (r.isErr()) return Err(r.unwrapErr().withContext(where))
  for (const id of shapesOffsetting({ shapes }, self)) {
    const def = lookup(id)
    if (def === undefined) continue
    const d = resolveShape(port, withOffsetSources(def, lookup, new Set([id])))
    if (d.isErr())
      return Err(
        d
          .unwrapErr()
          .prefixIssues('shapes', id)
          .withContext(where, { dependant: id, offsets: self }),
      )
  }
  return Ok(items.map(itemToDTO))
}

/** The part's shape list in the draft (created on the first shape). */
function draftShapes(draft: Draft<ProjectDoc>, partId: string): ShapeDTO[] {
  const part = draft.parts[partId]!
  part.shapes ??= []
  return part.shapes
}

// ── commands ────────────────────────────────────────────────────────────────────────────────

const shapeAdd = defineCommand({
  kind: 'document',
  name: 'design.shape.add',
  summary: 'Add a named shape to the part: items (primitives, line/arc paths) combined in order.',
  title: () => 'Add shape',
  machine: false,
  args: z.object({ ...PartArg, name: NameArg.optional(), items: ItemsArg }),
  result: z.object({
    shapeId: ShapeIdSchema,
    warnings: Warnings,
    adjusted: AdjustedSchema.optional(),
  }),
  run(draft, args, ctx) {
    const where = 'design.shape.add'
    const c = load(draft as ProjectDoc, args.partId, ctx, where)
    if (c.isErr()) return c
    const { loaded, port, shapes } = c.unwrap()
    const units = loaded.units
    const intents = args.items.map(takeRound)
    const items = parseItems(
      intents.map(([a]) => withDefaults(a, units)),
      0,
      units,
      shapeResolver(loaded),
    )
    if (items.isErr()) return Err(items.unwrapErr().withContext(where))
    const rounded = settleItemRounds(items.unwrap(), intents, [], 0, units)
    const n = nextShapeNumber(shapes)
    const shapeId = `shape${n}`
    const dtos = settleItems(port, rounded.items, where, shapes, shapeId)
    if (dtos.isErr()) return dtos
    draftShapes(draft, args.partId).push({
      id: shapeId,
      name: args.name ?? shapeName(n),
      items: dtos.unwrap(),
    })
    return withWarnings(
      { shapeId, ...adjustedOf(rounded.adjusted) },
      loaded,
      loaded.part.operations,
      ctx,
      where,
    )
  },
})

const shapeUpdate = defineCommand({
  kind: 'document',
  name: 'design.shape.update',
  summary: 'Rename a shape or replace its item list; every operation using it follows.',
  title: () => 'Update shape',
  machine: false,
  args: z.object({ ...ShapeArg, name: NameArg.optional(), items: ItemsArg.optional() }),
  // listed in full on design.shape.add only (tools/list budget, llm-api.md#schemas)
  listedArgs: { items: listedAs('array', 'design.shape.add items') },
  result: z.object({ warnings: Warnings, adjusted: AdjustedSchema.optional() }),
  run(draft, args, ctx) {
    const where = 'design.shape.update'
    const c = load(draft as ProjectDoc, args.partId, ctx, where)
    if (c.isErr()) return c
    const { loaded, port, shapes } = c.unwrap()
    const index = findShape(shapes, args.shapeId, where)
    if (index.isErr()) return index
    const target = draftShapes(draft, args.partId)[index.unwrap()]!
    let adjusted: readonly Adjusted[] = []
    if (args.items !== undefined) {
      const units = loaded.units
      const intents = args.items.map(takeRound)
      const items = parseItems(
        intents.map(([a]) => withDefaults(a, units)),
        0,
        units,
        shapeResolver(loaded),
      )
      if (items.isErr()) return Err(items.unwrapErr().withContext(where))
      // the stored item at the same index is the previous one (a Round item keeps Round)
      const prevs = shapes[index.unwrap()]!.items.map((dto, k) => {
        const l = loadItem(dto, k)
        return l.isOk() ? l.unwrap() : undefined
      })
      const rounded = settleItemRounds(items.unwrap(), intents, prevs, 0, units)
      adjusted = rounded.adjusted
      const dtos = settleItems(port, rounded.items, where, shapes, args.shapeId)
      if (dtos.isErr()) return dtos
      target.items = dtos.unwrap()
    }
    if (args.name !== undefined) target.name = args.name
    return withWarnings(adjustedOf(adjusted), loaded, loaded.part.operations, ctx, where)
  },
})

/** Parameters of `design.shape.item.update` by item kind (besides `op`). */
const ITEM_FIELDS: Record<ShapeItem<unknown>['kind'], readonly string[]> = {
  rectangle: ['center', 'length', 'width', 'cornerRadius', 'round', 'rotation'],
  circle: ['center', 'diameter'],
  obround: ['center', 'length', 'width', 'rotation'],
  polygon: ['center', 'sides', 'diameter', 'across', 'cornerRadius', 'rotation'],
  path: ['start', 'segments', 'closed', 'fillets'],
  // the source shape is changed by design.shape.update (`shapeId` names the edited shape here)
  offset: ['distance', 'direction'],
}

/** Every item field, optional (equal names share one schema); `kind` is not changeable. */
const ITEM_UPDATE_ARGS = (() => {
  const out: Record<string, z.ZodType> = {}
  for (const option of (ShapeItemArgSchema as unknown as { options: z.ZodObject[] }).options)
    for (const [k, s] of Object.entries(option.shape))
      // an offset's `shapeId` (its source) would shadow the edited shape's id
      if (k !== 'kind' && k !== 'shapeId' && out[k] === undefined)
        out[k] = (s as z.ZodType).optional()
  return out
})()

const itemUpdate = defineCommand({
  kind: 'document',
  name: 'design.shape.item.update',
  summary:
    "Change fields of one item of a shape (the Shape Editor's commits); fields of another item kind are refused.",
  title: () => 'Edit shape item',
  machine: false,
  args: z.object({
    ...ShapeArg,
    index: z.number().int().min(0).describe('0-based item index'),
    ...ITEM_UPDATE_ARGS,
  }),
  // a path's segments and fillets are listed in full on design.shape.add only (llm-api.md#schemas)
  listedArgs: {
    segments: listedAs('array', 'design.shape.add path items'),
    fillets: listedAs('array', 'design.shape.add path items'),
  },
  result: z.object({ warnings: Warnings, adjusted: AdjustedSchema.optional() }),
  run(draft, rawArgs, ctx) {
    const where = 'design.shape.item.update'
    const args = rawArgs as { partId: string; shapeId: string; index: number } & Record<
      string,
      unknown
    >
    const c = load(draft as ProjectDoc, args.partId, ctx, where)
    if (c.isErr()) return c
    const { loaded, port, shapes } = c.unwrap()
    const index = findShape(shapes, args.shapeId, where)
    if (index.isErr()) return index
    const shape = shapes[index.unwrap()]!
    const n = args.index
    const stored = shape.items[n]
    if (stored === undefined)
      return fail('input.malformed', `${args.shapeId} has no item ${n}`, {
        issues: [
          {
            path: ['index'],
            rule: 'range',
            message: `must be at most ${shape.items.length - 1}`,
            params: { max: shape.items.length - 1 },
          },
        ],
        where,
      })
    const given = Object.fromEntries(
      Object.entries(args).filter(
        ([k, v]) => v !== undefined && k !== 'partId' && k !== 'shapeId' && k !== 'index',
      ),
    )
    const allowed = new Set(['op', ...ITEM_FIELDS[stored.kind]])
    const foreign = Object.keys(given).filter((k) => !allowed.has(k))
    if (foreign.length > 0)
      return fail(
        'input.malformed',
        `${foreign.join(', ')}: not a field of a ${stored.kind} item`,
        {
          issues: foreign.map((k) => ({
            path: [k],
            rule: 'notForKind',
            message: `not a field of a ${stored.kind} item`,
          })),
          where,
        },
      )
    const model = loadItem(stored, n)
    if (model.isErr()) return Err(model.unwrapErr().withContext(where))
    const intent = takeRound({ kind: stored.kind, ...given })
    const { kind: _kind, ...givenRest } = intent[0]
    const joined = { ...model.unwrap(), ...givenRest } as ShapeItem<Quantity | string>
    // E2: per-vertex levels go with the vertices; a path edited to another vertex count drops them
    if (
      joined.kind === 'path' &&
      Array.isArray(joined.levels) &&
      joined.levels.length !== joined.segments.length + 1
    )
      delete joined.levels
    const merged = withDefaults(joined, loaded.units)
    const parsed = parseItems([merged], n, loaded.units, shapeResolver(loaded))
    if (parsed.isErr()) return Err(parsed.unwrapErr().withContext(where))
    const rounded = settleItemRounds(parsed.unwrap(), [intent], [model.unwrap()], n, loaded.units)
    // the other items as stored (loaded once per edit; the resolve is cached by value)
    const all: ShapeItem<Quantity>[] = []
    for (const [k, dto] of shape.items.entries()) {
      if (k === n) {
        all.push(rounded.items[0]!)
        continue
      }
      const l = loadItem(dto, k)
      if (l.isErr()) return Err(l.unwrapErr().withContext(where))
      all.push(l.unwrap())
    }
    const dtos = settleItems(port, all, where, shapes, args.shapeId)
    if (dtos.isErr()) return dtos
    draftShapes(draft, args.partId)[index.unwrap()]!.items[n] = dtos.unwrap()[n]!
    return withWarnings(adjustedOf(rounded.adjusted), loaded, loaded.part.operations, ctx, where)
  },
})

const shapeRemove = defineCommand({
  kind: 'document',
  name: 'design.shape.remove',
  summary: 'Remove a shape; fails with design.referenced while an operation or split line uses it.',
  title: () => 'Remove shape',
  machine: false,
  args: z.object(ShapeArg),
  result: z.object({ warnings: Warnings }),
  run(draft, args, ctx) {
    const where = 'design.shape.remove'
    const loaded = loadPart(draft as ProjectDoc, args.partId, where)
    if (loaded.isErr()) return loaded
    const l = loaded.unwrap()
    const shapes = l.dto.shapes ?? []
    const index = findShape(shapes, args.shapeId, where)
    if (index.isErr()) return index
    const users = operationsUsingShape(l.dto, args.shapeId, false)
    // shapes with an offset item on it (design-llm-first.md § Offset item)
    const offsets = shapesOffsetting(l.dto, args.shapeId, false)
    // Clones whose `along` row follows the shape (F6)
    const features = featuresUsingShape(l.dto, args.shapeId)
    // split lines along the shape (split parts 4e)
    const lines = (l.dto.split?.lines ?? []).flatMap((x, i) =>
      'shape' in x && x.shape === args.shapeId ? [i] : [],
    )
    if (users.length + features.length + lines.length + offsets.length > 0)
      return fail(
        'design.referenced',
        `${args.shapeId} is used by ${[...users, ...features, ...offsets, ...lines.map((i) => `split line ${i + 1}`)].join(', ')}`,
        {
          issues: [
            ...users.map((id) => ({
              path: ['operations', id, 'shape'],
              rule: 'referenced',
              message: `uses ${args.shapeId}`,
              params: { operationId: id, shapeId: args.shapeId },
            })),
            ...features.map((id) => ({
              path: ['features', id, 'rows'],
              rule: 'referenced',
              message: `follows ${args.shapeId} (Clones along, pattern cell)`,
              params: { featureId: id, shapeId: args.shapeId },
            })),
            ...offsets.map((id) => ({
              path: ['shapes', id, 'items'],
              rule: 'referenced',
              message: `offsets ${args.shapeId}`,
              params: { shapeId: id, source: args.shapeId },
            })),
            ...lines.map((i) => ({
              path: ['split', 'lines', i],
              rule: 'referenced',
              message: `split line ${i + 1} runs along ${args.shapeId}`,
              params: { line: i, shapeId: args.shapeId },
            })),
          ],
          where,
          data: { dependants: [...users, ...features, ...offsets] },
        },
      )
    const list = draftShapes(draft, args.partId)
    list.splice(index.unwrap(), 1)
    if (list.length === 0) delete draft.parts[args.partId]!.shapes
    return withWarnings({}, l, l.part.operations, ctx, where)
  },
})

const shapeConvert = defineCommand({
  kind: 'document',
  name: 'design.shape.convert',
  summary:
    "Move a pocket's or profile's inline rectangle or circle, or a Line's segment or arc, into a new named shape the operation then places (one undo step).",
  title: () => 'Convert to shape',
  machine: false,
  args: z.object({ ...PartArg, operationId: OperationIdSchema }),
  result: z.object({ shapeId: ShapeIdSchema, warnings: Warnings }),
  run(draft, args, ctx) {
    const where = 'design.shape.convert'
    const c = load(draft as ProjectDoc, args.partId, ctx, where)
    if (c.isErr()) return c
    const { loaded, port, shapes } = c.unwrap()
    const found = findOperation(loaded.part, args.operationId, undefined, where)
    if (found.isErr()) return found
    const owned = refuseOwned(loaded, found.unwrap(), where)
    if (owned.isErr()) return owned
    const op = loaded.part.operations[found.unwrap()]!
    if (op.kind === 'line') return convertLine(draft, args.partId, loaded, op, port, shapes, ctx)
    if (op.kind !== 'pocket' && op.kind !== 'profile')
      return fail('input.malformed', `${op.id} is a ${op.kind}, which has no shape`, {
        issues: [
          {
            path: ['operationId'],
            rule: 'operationKind',
            message: 'must be a pocket, profile or Line',
          },
        ],
        where,
      })
    const s = op.shape
    if (s.kind === 'named')
      return fail('input.malformed', `${op.id} already places shape ${s.shapeId}`, {
        issues: [
          { path: ['operationId'], rule: 'alreadyNamed', message: 'already places a shape' },
        ],
        where,
      })
    // a named pocket has no floor fillet yet (validate.ts `floorRadiusShape`)
    if (op.kind === 'pocket' && op.floorRadius.canonical !== 0)
      return fail(
        'model.invariant',
        `${op.id} has a floor radius, which a named shape cannot keep`,
        {
          issues: [
            {
              path: ['floorRadius'],
              rule: 'floorRadiusShape',
              message: 'must be 0 to convert: a named shape has no floor fillet yet',
            },
          ],
          where,
        },
      )
    // the operation's quantities, re-evaluated against the stock's faces (a formula over an
    // operation's surface cannot move into a shape)
    const resolver = shapeResolver(loaded)
    const zero = quantityFromSource('0', fieldContext('length', loaded.units), resolver)
    if (zero.isErr()) return Err(zero.unwrapErr().withContext(where))
    const raw: ShapeItem<Quantity> =
      s.kind === 'circle'
        ? {
            kind: 'circle',
            op: 'add',
            center: [zero.unwrap(), zero.unwrap()],
            diameter: s.diameter,
          }
        : {
            kind: 'rectangle',
            op: 'add',
            center: [zero.unwrap(), zero.unwrap()],
            length: s.length,
            width: s.width,
            cornerRadius: s.cornerRadius,
            ...(s.round === true ? { round: true as const } : {}),
          }
    const errors: AppResult<unknown>[] = []
    const item = mapItem(raw, (q, path) => {
      const r = reevaluate(q, resolver).mapErr((e) => e.prefixIssues('shape', ...path))
      errors.push(r)
      return r.unwrapOr(q)
    })
    const bad = errors.find((r) => r.isErr())
    if (bad !== undefined) return Err(bad.unwrapErr().withContext(where))
    const n = nextShapeNumber(shapes)
    const shapeId = `shape${n}`
    const dtos = settleItems(port, [item], where, shapes, shapeId)
    if (dtos.isErr()) return dtos
    draftShapes(draft, args.partId).push({ id: shapeId, name: shapeName(n), items: dtos.unwrap() })
    // the operation now places the shape: same anchor point, anchor and rotation, so the placed
    // box (and the feature) stays where it was (shapes.md#implementation-k3)
    const placed: Operation = {
      ...op,
      shape: {
        kind: 'named',
        center: s.center,
        anchor: s.anchor,
        shapeId,
        rotation: s.kind === 'rectangle' ? s.rotation : None,
        mirror: false,
      },
    }
    const ops = loaded.part.operations.map((o) => (o.id === op.id ? placed : o))
    writeOperationList(draft.parts[args.partId]!.operations, ops)
    return withWarnings({ shapeId }, loaded, ops, ctx, where)
  },
})

/**
 * A Line's inline Straight / Arc (DF147 SL2) moved into a new named shape of one open path from
 * [0, 0] in its frame; the Line then places it by its bounding box's centre, so the groove stays
 * where it was (engraved-patterns.md § Simple Line). Lengths are written to 0.1 µm (an arc's
 * radius rounded up, so it still spans its chord).
 */
function convertLine(
  draft: Draft<ProjectDoc>,
  partId: string,
  loaded: LoadedPart,
  op: Extract<Operation, { kind: 'line' }>,
  port: Region2dPort,
  shapes: readonly ShapeDTO[],
  ctx: CommandContext,
) {
  const where = 'design.shape.convert'
  const p = op.paths[0]
  const inline = p !== undefined && isInlinePath(p) ? p : undefined
  const el = inline === undefined ? undefined : inlineElement(inline)
  const geometry = inline === undefined ? undefined : inlineGeometry(inline)
  if (el === undefined || geometry === undefined)
    return fail('input.malformed', `${op.id} has no straight line or arc to convert`, {
      issues: [
        {
          path: ['operationId'],
          rule: inline === undefined ? 'alreadyNamed' : 'lineTooShort',
          message: 'must be a Line in Straight or Arc mode',
        },
      ],
      where,
    })
  const resolver = shapeResolver(loaded)
  const len = (mm: number): AppResult<Quantity> =>
    quantityFromSource(`${+mm.toFixed(4)} mm`, fieldContext('length', loaded.units), resolver)
  const radius =
    el.kind === 'arc'
      ? Math.ceil(Math.hypot(el.a[0] - el.centre[0], el.a[1] - el.centre[1]) * 1e4) / 1e4
      : 0
  const values = collect([
    len(0),
    len(el.b[0] - el.a[0]),
    len(el.b[1] - el.a[1]),
    len(radius),
    len(geometry.center[0]),
    len(geometry.center[1]),
  ])
  if (values.isErr()) return Err(values.unwrapErr().withContext(where))
  const [zero, tu, tv, r, cu, cv] = values.unwrap() as Quantity[]
  const segment: ShapeSegment<Quantity> =
    el.kind === 'line'
      ? { kind: 'line', to: [tu!, tv!] }
      : {
          kind: 'arc',
          to: [tu!, tv!],
          radius: r!,
          cw: !el.ccw,
          ...(arcSweep(el) > 180 ? { large: true } : {}),
        }
  const item: ShapeItem<Quantity> = {
    kind: 'path',
    op: 'add',
    start: [zero!, zero!],
    segments: [segment],
    closed: false,
  }
  const n = nextShapeNumber(shapes)
  const shapeId = `shape${n}`
  const dtos = settleItems(port, [item], where, shapes, shapeId)
  if (dtos.isErr()) return dtos
  draftShapes(draft, partId).push({ id: shapeId, name: shapeName(n), items: dtos.unwrap() })
  const placed: Operation = {
    ...op,
    paths: [
      {
        kind: 'named',
        center: [cu!, cv!],
        anchor: CENTRE_ANCHOR,
        shapeId,
        rotation: None,
        mirror: false,
      },
    ],
  }
  const ops = loaded.part.operations.map((o) => (o.id === op.id ? placed : o))
  writeOperationList(draft.parts[partId]!.operations, ops)
  return withWarnings({ shapeId }, loaded, ops, ctx, where)
}

/** An arc element's sweep in degrees (0–360). */
function arcSweep(el: ArcElement): number {
  const a0 = Math.atan2(el.a[1] - el.centre[1], el.a[0] - el.centre[0])
  const a1 = Math.atan2(el.b[1] - el.centre[1], el.b[0] - el.centre[0])
  let s = el.ccw ? a1 - a0 : a0 - a1
  while (s <= 0) s += 2 * Math.PI
  return (s * 180) / Math.PI
}

const FromArg = z
  .object({
    referenceId: z.string().optional(),
    face: FaceArg.optional(),
    depth: ShapeSrcSchema.describe('Below the face (length)'),
    tolerance: z.number().min(0.001).max(1).optional().describe('mm, default 0.01'),
    loops: z.enum(['all', 'outer', 'holes']).optional().describe('holes: a shape per cavity'),
    roundInside: ShapeSrcSchema.optional().describe('Round sharp inside corners (radius)'),
  })
  .describe('A reference section instead of a file')

const SectionReportSchema = z.object({
  referenceId: z.string(),
  face: z.string(),
  depth: z.number().describe('mm'),
  tolerance: z.number(),
  loops: z.number().int(),
  lines: z.number().int(),
  arcs: z.number().int(),
  circles: z.number().int(),
  maxDeviation: z.number(),
  skippedOpen: z.number().int(),
  rounded: z.object({ corners: z.number().int(), maxChange: z.number() }).optional(),
  shapes: z.array(
    z.object({
      shapeId: ShapeIdSchema,
      minInsideRadius: z.number().optional().describe('As a pocket; mm'),
      sharpCount: z.number().int(),
      placeAt: z.object({
        center: z.tuple([z.number(), z.number()]),
        anchor: z.object({ u: z.literal('min'), v: z.literal('min') }),
      }),
    }),
  ),
})

type Prepared =
  | { readonly kind: 'svg'; readonly svg: SvgImport }
  | {
      readonly kind: 'section'
      readonly referenceId: string
      readonly face: string
      readonly depth: number
      readonly tolerance: number
      readonly loops: readonly FittedLoop[]
    }

const r3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000
  return r === 0 ? 0 : r
}

const shapeImport = defineCommand({
  kind: 'document',
  name: 'design.shape.import',
  summary:
    'Import an SVG (path) or a reference section (from) as named shapes of line/arc paths; returns an import report.',
  title: (a) => (a.from !== undefined ? 'Section to shape' : 'Import SVG'),
  machine: false,
  args: z.object({
    ...PartArg,
    path: z.string().max(4096).optional().describe('Absolute local path'),
    from: FromArg.optional(),
    name: NameArg.optional(),
    unit: z.enum(['mm', 'in', 'px96', 'px72']).optional().describe('For unitless files; px96'),
    split: z
      .enum(['element', 'file', 'loop'])
      .optional()
      .describe('Shape per top-level element (SVG default), file (section default) or outer loop'),
  }),
  result: z.object({
    shapeIds: z.array(ShapeIdSchema),
    report: SvgImportReportSchema.optional(),
    section: SectionReportSchema.optional(),
    warnings: Warnings,
  }),
  async prepare(doc, args, ctx: CommandContext): Promise<AppResult<Prepared>> {
    const where = 'design.shape.import'
    const c = load(doc, args.partId, ctx, where)
    if (c.isErr()) return c
    if ((args.path === undefined) === (args.from === undefined))
      return fail('input.malformed', 'give either path or from', {
        issues: [{ path: ['from'], rule: 'pathOrFrom', message: 'give either path or from' }],
        where,
      })
    if (args.from !== undefined) {
      const from = args.from
      const l = c.unwrap().loaded
      const ref = targetReference(doc, args.partId, from.referenceId, where)
      if (ref.isErr()) return Err(ref.unwrapErr().prefixIssues('from'))
      const face = resolveFace(doc, args.partId, from.face, ['from', 'face'], where)
      if (face.isErr()) return face
      const depth = lengthArg(from.depth, l, ['from', 'depth'], where)
      if (depth.isErr()) return depth
      const p = storedPlacement(ref.unwrap(), where)
      if (p.isErr()) return p
      const stock = {
        length: l.stock.length.canonical,
        width: l.stock.width.canonical,
        thickness: l.stock.thickness.canonical,
      }
      const view = referenceView(ref.unwrap(), p.unwrap(), stock, face.unwrap().direction)
      const fit = fitOptions({ tolerance: from.tolerance })
      const loops = await fittedSection(ctx, view, depth.unwrap(), fit, where)
      if (loops.isErr()) return loops
      return Ok({
        kind: 'section' as const,
        referenceId: view.ref.id,
        face: view.face,
        depth: depth.unwrap(),
        tolerance: fit.tolerance,
        loops: loops.unwrap(),
      })
    }
    const path = args.path!
    if (!ABSOLUTE_PATH.test(path))
      return fail('input.malformed', `${path}: not an absolute path`, {
        issues: [{ path: ['path'], rule: 'absolutePath', message: 'must be an absolute path' }],
        where,
      })
    const r = await ctx.services.workers.run(
      svgImportTask,
      { path, unit: args.unit, split: args.split },
      { signal: new AbortController().signal, progress: () => undefined },
    )
    return r.isErr()
      ? Err(r.unwrapErr().withContext(where, { path }))
      : Ok({ kind: 'svg' as const, svg: r.unwrap() })
  },
  run(draft, args, ctx, prepared: Prepared) {
    const where = 'design.shape.import'
    const c = load(draft as ProjectDoc, args.partId, ctx, where)
    if (c.isErr()) return c
    const { loaded, port, shapes } = c.unwrap()
    let n = nextShapeNumber(shapes)
    const added: ShapeDTO[] = []
    if (prepared.kind === 'section') {
      const from = args.from!
      let roundInside: number | undefined
      if (from.roundInside !== undefined) {
        const r = lengthArg(from.roundInside, loaded, ['from', 'roundInside'], where)
        if (r.isErr()) return r
        if (r.unwrap() < 0)
          return fail('model.invariant', 'from.roundInside: must be 0 or more', {
            issues: [
              { path: ['from', 'roundInside'], rule: 'nonNegative', message: 'must be 0 or more' },
            ],
            where,
          })
        roundInside = r.unwrap()
      }
      const split = args.split === 'loop' ? 'loop' : 'file'
      const made = sectionShapes(
        port,
        prepared.loops,
        {
          loops: from.loops ?? 'all',
          split,
          roundInside,
          bounds: (l) => {
            const b = chainBounds(l.elements)
            return b === undefined ? undefined : [b.min, b.max]
          },
        },
        where,
      )
      if (made.isErr()) return made
      const m = made.unwrap()
      if (m.shapes.length === 0)
        return fail('input.malformed', 'the section has no closed loop to make a shape of', {
          issues: [
            {
              path: ['from', 'depth'],
              rule: 'emptySection',
              message:
                prepared.loops.length === 0
                  ? 'the plane misses the reference at this depth'
                  : 'no closed loop of the kind asked for at this depth',
            },
          ],
          where,
        })
      // X2-4: the loop kind in the default name, and a number when the part already has the
      // name, so two sections at one depth (outline and cavity, top and bottom) read apart
      const kind = from.loops === 'outer' ? ' outline' : from.loops === 'holes' ? ' cavity' : ''
      const base = args.name ?? `${sectionName(prepared.depth, loaded.units)}${kind}`
      const taken = new Set(shapes.map((x) => x.name))
      let serial = 1
      const nextName = (): string => {
        for (;;) {
          const name = (serial === 1 ? base : `${base} ${serial}`).slice(0, NAME_MAX)
          serial++
          if (!taken.has(name)) {
            taken.add(name)
            return name
          }
        }
      }
      const rows: z.output<typeof SectionReportSchema>['shapes'] = []
      for (const s of m.shapes) {
        const items = sectionShapeItems(s.items, loaded.units)
        if (items.isErr()) return Err(items.unwrapErr().withContext(where))
        const id = `shape${n++}`
        const dtos = settleItems(port, items.unwrap(), where, shapes, id)
        if (dtos.isErr()) return dtos
        const name = nextName()
        added.push({ id, name, items: dtos.unwrap() })
        rows.push({
          shapeId: id,
          ...(s.minInsideRadius === undefined ? {} : { minInsideRadius: r3(s.minInsideRadius) }),
          sharpCount: s.sharpCount,
          placeAt: { center: [r3(s.min[0]), r3(s.min[1])], anchor: { u: 'min', v: 'min' } },
        })
      }
      draftShapes(draft, args.partId).push(...added)
      const used = m.shapes.flatMap((s) => s.items)
      const elements = used.flatMap((i) => (i.circle ? [] : i.loop.elements))
      const closed = prepared.loops.filter((l) => !l.open)
      const section = {
        referenceId: prepared.referenceId,
        face: prepared.face,
        depth: r3(prepared.depth),
        tolerance: prepared.tolerance,
        loops: used.length,
        lines: elements.filter((e) => e.kind === 'line').length,
        arcs: elements.filter((e) => e.kind === 'arc').length,
        circles: used.filter((i) => i.circle !== undefined).length,
        maxDeviation: r3(closed.reduce((x, l) => Math.max(x, l.maxDeviation), 0)),
        skippedOpen: m.skippedOpen,
        ...(m.rounded
          ? { rounded: { corners: m.rounded.corners, maxChange: r3(m.rounded.maxChange) } }
          : {}),
        shapes: rows,
      }
      return withWarnings(
        { shapeIds: added.map((s) => s.id), section },
        loaded,
        loaded.part.operations,
        ctx,
        where,
      )
    }
    const path = args.path ?? ''
    const file = path.split(/[\\/]/).pop() || path
    for (const s of prepared.svg.shapes) {
      const items = svgShapeItems(s, loaded.units)
      if (items.isErr()) return Err(items.unwrapErr().withContext(where))
      const dtos = settleItems(port, items.unwrap(), where, shapes, `shape${n}`)
      if (dtos.isErr()) return Err(dtos.unwrapErr().withContext(where, { shape: s.name }))
      const name = s.name.trim().slice(0, NAME_MAX)
      added.push({
        id: `shape${n}`,
        name: name.length > 0 ? name : shapeName(n),
        items: dtos.unwrap(),
        source: { file: file.slice(-1024), element: s.source.element.slice(0, NAME_MAX) },
      })
      n++
    }
    draftShapes(draft, args.partId).push(...added)
    const result = { shapeIds: added.map((s) => s.id), report: prepared.svg.report }
    return withWarnings(result, loaded, loaded.part.operations, ctx, where)
  },
})

// ── queries ─────────────────────────────────────────────────────────────────────────────────

const Vec = z.tuple([z.number(), z.number()])
const ElementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('line'), a: Vec, b: Vec }),
  z.object({ kind: z.literal('arc'), a: Vec, b: Vec, centre: Vec, ccw: z.boolean() }),
])
const ResolvedSchema = z
  .object({
    kind: z.enum(['region', 'path']),
    pieces: z
      .array(z.object({ outer: z.array(ElementSchema), holes: z.array(z.array(ElementSchema)) }))
      .optional()
      .describe('Region: outer loop counter-clockwise, holes (islands) clockwise; mm'),
    path: z.array(ElementSchema).optional().describe('Open path; mm'),
    elements: z.number().int(),
    area: z.number().describe('mm²'),
    bounds: z.object({ min: Vec, max: Vec }).describe('Exact, arcs included; mm'),
    length: z.number().describe('Boundary or path length, mm'),
    smallestInsideRadius: z
      .number()
      .optional()
      .describe(
        'Smallest inside corner radius with the region cut as a pocket (0 = sharp corner); mm',
      ),
  })
  .describe('The shape resolved in its frame')
const IssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  rule: z.string(),
  message: z.string(),
})

/** The resolved summary, or the issues of a stored shape that no longer resolves. */
function resolved(port: Region2dPort, s: ShapeDTO, shapes: readonly ShapeDTO[]) {
  const r = shapeFromDTO(s).andThen((m) =>
    resolveShape(
      port,
      withOffsetSources(definitionOf(m.items), lookupInDtos(shapes), new Set([s.id])),
    ),
  )
  if (r.isOk()) return { resolved: shapeSummary(r.unwrap()) }
  const e = r.unwrapErr()
  return {
    issues: (e.issues.length > 0 ? e.issues : [{ path: [], rule: e.code, message: e.message }]).map(
      (i) => ({
        path: [...i.path],
        rule: i.rule,
        message: i.message,
      }),
    ),
  }
}

const shapeList = defineQuery({
  name: 'design.shape.list',
  summary: "List a part's named shapes with their size, area and the operations using them.",
  args: z.object(PartArg),
  result: z.object({
    shapes: z.array(
      z.object({
        id: ShapeIdSchema,
        name: z.string(),
        items: z.number().int().describe('Item count'),
        usedBy: z.array(z.string()).describe('Operation ids'),
        kind: z.enum(['region', 'path']).optional().describe('Absent: does not resolve'),
        area: z.number().optional(),
        bounds: z.object({ min: Vec, max: Vec }).optional(),
      }),
    ),
  }),
  run(doc, args, ctx) {
    const where = 'design.shape.list'
    const c = load(doc, args.partId, ctx, where)
    if (c.isErr()) return c
    const { loaded, port, shapes } = c.unwrap()
    return Ok({
      // a feature's owned shapes (patterns P1) are the feature's, not listed
      shapes: shapes
        .filter((s) => s.owner === undefined)
        .map((s) => {
          const r = resolved(port, s, shapes).resolved
          return {
            id: s.id,
            name: s.name,
            items: s.items.length,
            usedBy: operationsUsingShape(loaded.dto, s.id),
            ...(r === undefined ? {} : { kind: r.kind, area: r.area, bounds: r.bounds }),
          }
        }),
    })
  },
})

const shapeGet = defineQuery({
  name: 'design.shape.get',
  summary:
    'Get a shape: its definition and its resolved loops (elements in mm), area, bounds and smallest inside radius.',
  args: z.object(ShapeArg),
  result: z.object({
    shape: ShapeDtoSchema,
    usedBy: z.array(z.string()).describe('Operation ids'),
    resolved: ResolvedSchema.optional(),
    issues: z.array(IssueSchema).optional().describe('Why a stored shape does not resolve'),
  }),
  run(doc, args, ctx) {
    const where = 'design.shape.get'
    const c = load(doc, args.partId, ctx, where)
    if (c.isErr()) return c
    const { loaded, port, shapes } = c.unwrap()
    const index = findShape(shapes, args.shapeId, where)
    if (index.isErr()) return index
    const s = shapes[index.unwrap()]!
    return Ok({
      shape: s,
      usedBy: operationsUsingShape(loaded.dto, s.id),
      ...resolved(port, s, shapes),
    })
  },
})

export const SHAPE_COMMANDS: readonly AnyCommand[] = [
  shapeAdd,
  shapeUpdate,
  itemUpdate,
  shapeRemove,
  shapeConvert,
  shapeImport as AnyCommand,
]
export const SHAPE_QUERIES: readonly QueryDef[] = [shapeList, shapeGet]
