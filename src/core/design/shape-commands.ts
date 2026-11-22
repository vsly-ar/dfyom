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
import { Err, fail, None, Ok, type AppResult } from '../../shared/result'
import { defineCommand, defineQuery, type AnyCommand, type QueryDef } from '../commands/define'
import type { CommandContext } from '../commands/context'
import type { ReferenceResolver } from '../expression/evaluate'
import { quantityFromSource, reevaluate } from '../expression/quantity'
import type { Region2dPort } from '../geometry/2d/port'
import { NAME_MAX, quantityFromDTO } from '../library/item'
import type { ProjectDoc, UnitSystem } from '../project/document'
import type { Quantity } from '../quantity/quantity'
import type { QuantityDTO } from '../quantity/quantity.dto'
import { findOperation, Warnings, withWarnings, writeOperationList } from './commands'
import { loadPart, type LoadedPart } from './load'
import { DEFAULTS, fieldContext, type FieldKind, type Operation } from './operation'
import { OperationIdSchema, PartIdSchema } from './part.dto'
import {
  definitionOf,
  itemToDTO,
  mapItem,
  requirePort,
  resolveShape,
  shapeFromDTO,
  shapeName,
  shapeSummary,
} from './shape'
import {
  ShapeDtoSchema,
  ShapeIdSchema,
  ShapeItemArgSchema,
  SHAPE_ITEMS_MAX,
  type ShapeDTO,
  type ShapeItem,
  type ShapeOp,
  type ShapeItemDTO,
} from './shape.dto'
import { operationsUsingShape } from './shape-users'
import { SurfaceTable } from './surfaces'
import { ABSOLUTE_PATH } from './reference-commands'
import { svgShapeItems } from './shape-import'
import type { SvgImport } from '../import/svg'
import { svgImportTask, SvgImportReportSchema } from '../import/svg/task'

// ── args ────────────────────────────────────────────────────────────────────────────────────

const PartArg = { partId: PartIdSchema }
const ShapeArg = { partId: PartIdSchema, shapeId: ShapeIdSchema }
const NameArg = z.string().min(1).max(NAME_MAX).describe('Display label')
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
    return fail(bad[0]!.code, `${issues.length} invalid value(s)`, { issues })
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
  for (const s of shapes) max = Math.max(max, Number(s.id.slice('shape'.length)))
  return max + 1
}

/** Resolves the items (the shape's invariants) and returns their DTOs. */
function settleItems(
  port: Region2dPort,
  items: readonly ShapeItem<Quantity>[],
  where: string,
): AppResult<ShapeItemDTO[]> {
  const r = resolveShape(port, definitionOf(items))
  if (r.isErr()) return Err(r.unwrapErr().withContext(where))
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
  result: z.object({ shapeId: ShapeIdSchema, warnings: Warnings }),
  run(draft, args, ctx) {
    const where = 'design.shape.add'
    const c = load(draft as ProjectDoc, args.partId, ctx, where)
    if (c.isErr()) return c
    const { loaded, port, shapes } = c.unwrap()
    const units = loaded.units
    const items = parseItems(
      args.items.map((a) => withDefaults(a, units)),
      0,
      units,
      shapeResolver(loaded),
    )
    if (items.isErr()) return Err(items.unwrapErr().withContext(where))
    const dtos = settleItems(port, items.unwrap(), where)
    if (dtos.isErr()) return dtos
    const n = nextShapeNumber(shapes)
    const shapeId = `shape${n}`
    draftShapes(draft, args.partId).push({
      id: shapeId,
      name: args.name ?? shapeName(n),
      items: dtos.unwrap(),
    })
    return withWarnings({ shapeId }, loaded, loaded.part.operations, ctx, where)
  },
})

const shapeUpdate = defineCommand({
  kind: 'document',
  name: 'design.shape.update',
  summary: 'Rename a shape or replace its item list; every operation using it follows.',
  title: () => 'Update shape',
  machine: false,
  args: z.object({ ...ShapeArg, name: NameArg.optional(), items: ItemsArg.optional() }),
  result: z.object({ warnings: Warnings }),
  run(draft, args, ctx) {
    const where = 'design.shape.update'
    const c = load(draft as ProjectDoc, args.partId, ctx, where)
    if (c.isErr()) return c
    const { loaded, port, shapes } = c.unwrap()
    const index = findShape(shapes, args.shapeId, where)
    if (index.isErr()) return index
    const target = draftShapes(draft, args.partId)[index.unwrap()]!
    if (args.items !== undefined) {
      const units = loaded.units
      const items = parseItems(
        args.items.map((a) => withDefaults(a, units)),
        0,
        units,
        shapeResolver(loaded),
      )
      if (items.isErr()) return Err(items.unwrapErr().withContext(where))
      const dtos = settleItems(port, items.unwrap(), where)
      if (dtos.isErr()) return dtos
      target.items = dtos.unwrap()
    }
    if (args.name !== undefined) target.name = args.name
    return withWarnings({}, loaded, loaded.part.operations, ctx, where)
  },
})

/** Parameters of `design.shape.item.update` by item kind (besides `op`). */
const ITEM_FIELDS: Record<ShapeItem<unknown>['kind'], readonly string[]> = {
  rectangle: ['center', 'length', 'width', 'cornerRadius', 'rotation'],
  circle: ['center', 'diameter'],
  obround: ['center', 'length', 'width', 'rotation'],
  polygon: ['center', 'sides', 'diameter', 'across', 'cornerRadius', 'rotation'],
  path: ['start', 'segments', 'closed', 'fillets'],
}

/** Every item field, optional (equal names share one schema); `kind` is not changeable. */
const ITEM_UPDATE_ARGS = (() => {
  const out: Record<string, z.ZodType> = {}
  for (const option of (ShapeItemArgSchema as unknown as { options: z.ZodObject[] }).options)
    for (const [k, s] of Object.entries(option.shape))
      if (k !== 'kind' && out[k] === undefined) out[k] = (s as z.ZodType).optional()
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
  result: z.object({ warnings: Warnings }),
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
    const merged = withDefaults(
      { ...model.unwrap(), ...given } as ShapeItem<Quantity | string>,
      loaded.units,
    )
    const parsed = parseItems([merged], n, loaded.units, shapeResolver(loaded))
    if (parsed.isErr()) return Err(parsed.unwrapErr().withContext(where))
    // the other items as stored (loaded once per edit; the resolve is cached by value)
    const all: ShapeItem<Quantity>[] = []
    for (const [k, dto] of shape.items.entries()) {
      if (k === n) {
        all.push(parsed.unwrap()[0]!)
        continue
      }
      const l = loadItem(dto, k)
      if (l.isErr()) return Err(l.unwrapErr().withContext(where))
      all.push(l.unwrap())
    }
    const dtos = settleItems(port, all, where)
    if (dtos.isErr()) return dtos
    draftShapes(draft, args.partId)[index.unwrap()]!.items[n] = dtos.unwrap()[n]!
    return withWarnings({}, loaded, loaded.part.operations, ctx, where)
  },
})

const shapeRemove = defineCommand({
  kind: 'document',
  name: 'design.shape.remove',
  summary: 'Remove a shape; fails with design.referenced while an operation uses it.',
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
    const users = operationsUsingShape(l.dto, args.shapeId)
    if (users.length > 0)
      return fail('design.referenced', `${args.shapeId} is used by ${users.join(', ')}`, {
        issues: users.map((id) => ({
          path: ['operations', id, 'shape'],
          rule: 'referenced',
          message: `uses ${args.shapeId}`,
          params: { operationId: id, shapeId: args.shapeId },
        })),
        where,
        data: { dependants: users },
      })
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
    "Move a pocket's or profile's inline rectangle or circle into a new named shape the operation then places (one undo step).",
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
    const op = loaded.part.operations[found.unwrap()]!
    if (op.kind !== 'pocket' && op.kind !== 'profile')
      return fail('input.malformed', `${op.id} is a ${op.kind}, which has no shape`, {
        issues: [
          { path: ['operationId'], rule: 'operationKind', message: 'must be a pocket or profile' },
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
          }
    const errors: AppResult<unknown>[] = []
    const item = mapItem(raw, (q, path) => {
      const r = reevaluate(q, resolver).mapErr((e) => e.prefixIssues('shape', ...path))
      errors.push(r)
      return r.unwrapOr(q)
    })
    const bad = errors.find((r) => r.isErr())
    if (bad !== undefined) return Err(bad.unwrapErr().withContext(where))
    const dtos = settleItems(port, [item], where)
    if (dtos.isErr()) return dtos
    const n = nextShapeNumber(shapes)
    const shapeId = `shape${n}`
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

const shapeImport = defineCommand({
  kind: 'document',
  name: 'design.shape.import',
  summary:
    'Import an SVG as named shapes of line/arc paths (curves fitted to 0.01 mm); returns an import report.',
  title: () => 'Import SVG',
  machine: false,
  args: z.object({
    ...PartArg,
    path: z.string().max(4096).describe('Absolute local path'),
    unit: z.enum(['mm', 'in', 'px96', 'px72']).optional().describe('For unitless files; px96'),
    split: z
      .enum(['element', 'file', 'loop'])
      .optional()
      .describe('Shape per top-level element (default), file or outer loop'),
  }),
  result: z.object({
    shapeIds: z.array(ShapeIdSchema),
    report: SvgImportReportSchema,
    warnings: Warnings,
  }),
  async prepare(doc, args, ctx: CommandContext): Promise<AppResult<SvgImport>> {
    const where = 'design.shape.import'
    const c = load(doc, args.partId, ctx, where)
    if (c.isErr()) return c
    if (!ABSOLUTE_PATH.test(args.path))
      return fail('input.malformed', `${args.path}: not an absolute path`, {
        issues: [{ path: ['path'], rule: 'absolutePath', message: 'must be an absolute path' }],
        where,
      })
    const r = await ctx.services.workers.run(
      svgImportTask,
      { path: args.path, unit: args.unit, split: args.split },
      { signal: new AbortController().signal, progress: () => undefined },
    )
    return r.isErr() ? Err(r.unwrapErr().withContext(where, { path: args.path })) : r
  },
  run(draft, args, ctx, prepared: SvgImport) {
    const where = 'design.shape.import'
    const c = load(draft as ProjectDoc, args.partId, ctx, where)
    if (c.isErr()) return c
    const { loaded, port, shapes } = c.unwrap()
    const file = args.path.split(/[\\/]/).pop() || args.path
    let n = nextShapeNumber(shapes)
    const added: ShapeDTO[] = []
    for (const s of prepared.shapes) {
      const items = svgShapeItems(s, loaded.units)
      if (items.isErr()) return Err(items.unwrapErr().withContext(where))
      const dtos = settleItems(port, items.unwrap(), where)
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
    const result = { shapeIds: added.map((s) => s.id), report: prepared.report }
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
      .describe('Smallest corner radius a tool meets inside the region (0 = sharp); mm'),
  })
  .describe('The shape resolved in its frame')
const IssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  rule: z.string(),
  message: z.string(),
})

/** The resolved summary, or the issues of a stored shape that no longer resolves. */
function resolved(port: Region2dPort, s: ShapeDTO) {
  const r = shapeFromDTO(s).andThen((m) => resolveShape(port, definitionOf(m.items)))
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
      shapes: shapes.map((s) => {
        const r = resolved(port, s).resolved
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
    return Ok({ shape: s, usedBy: operationsUsingShape(loaded.dto, s.id), ...resolved(port, s) })
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
