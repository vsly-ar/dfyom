/**
 * Clones commands (v0.4 F5): `design.clones.add` / `.update` (built by `featureKindCommands`),
 * the query `design.clones.preview`, and `design.clonesFollow`, the document and apply hook that
 * re-runs every Clones expansion whose source changed, in the same command (one undo step,
 * features.md § Editing the source).
 * Doc: docs/modes/features.md#clones, docs/modes/design-v0.4.md#implementation-f5
 */
import type { Draft } from 'immer'
import { z } from 'zod'
import { AppError } from '../../../shared/errors/app-error'
import { Err, fail, Ok, type AppResult } from '../../../shared/result'
import {
  defineQuery,
  type AnyCommand,
  type ApplyHook,
  type DocumentHook,
  type QueryDef,
} from '../../commands/define'
import type { CommandContext } from '../../commands/context'
import { deepEqual } from '../../library/snapshot'
import type { ProjectDoc } from '../../project/document'
import { Fields, invalid, load, PartArg, settle, shapeEnv, Src } from '../commands'
import { DfmWarningSchema } from '../warnings'
import { toGeometryInput } from '../geometry-input'
import { shapesOf } from '../operation'
import { featureSpan, materialize, ownedOperationId, type FeatureKindSpec } from '../feature'
import { featureKindCommands, type FeatureCommandSpec } from '../feature-commands'
import { FeatureIdSchema } from '../feature.dto'
import { loadPart } from '../load'
import { operationToDTO, recordOf } from '../operation'
import { baseOf, isFrozenRecord } from '../frozen-memo'
import { ShapeIdSchema } from '../shape.dto'
import { SurfaceTable } from '../surfaces'
import {
  CLONE_ROW_MAX,
  CLONE_ROWS_MAX,
  clonesKindSpec,
  clonesWarnings,
  ClonesSourceSchema,
  expandClones,
  featurePath,
  mapRow,
  normalizeSource,
  rowIssues,
  sourceFace,
  sourceIssues,
  sourceMembers,
  sourceOperations,
  type CloneRow,
  type Clones,
} from './clones'

const count = z.number().int().min(1).max(CLONE_ROW_MAX)
const skip = z.array(z.number().int().min(0)).max(CLONE_ROW_MAX).optional()

// Field meanings live in one description on `rows` (tools/list budget, llm-api.md § Implementation).
const RowArg = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('grid'), cols: count, rows: count, du: Src, dv: Src, skip }),
  z.object({ kind: z.literal('offset'), count, du: Src, dv: Src, skip }),
  z.object({ kind: z.literal('polar'), count, angle: Src, distance: Src, skip }),
  z.object({ kind: z.literal('arc'), radius: Src, angle: Src, arc: Src, step: Src, skip }),
  z.object({ kind: z.literal('point'), u: Src, v: Src, skip }),
  z.object({
    kind: z.literal('along'),
    shapeId: ShapeIdSchema,
    start: Src.optional(),
    spacing: Src.optional(),
    count: count.optional(),
    skip,
  }),
])
type RowArgs = z.output<typeof RowArg>

const RowsArg = z
  .array(RowArg)
  .max(CLONE_ROWS_MAX)
  .describe(
    'From the source, each row from the last position of the one before. grid: cols × rows cells, the first on that position (cols·rows−1 clones; du/dv 0 only with 1 col/row). offset, polar: count steps beyond it (count clones). polar: angle from +u CCW. arc: centre radius away at angle, sweep arc (±360°, + CCW) every step. point: absolute u v. along: a one-item shape with its start on that position; from arc length start (0), every spacing or count evenly (one at length 0 is no clone). skip: indices of the row points from 0 (first row: instance n is n-2), left out, numbers kept.',
  )

const params = {
  source: ClonesSourceSchema.describe(
    'Existing operations, one feature, or a group: featureIds (a Clones brings its source) + operationIds',
  ),
  rows: RowsArg,
}

/**
 * `source` and `rows` as the update and preview tools list them (`listedArgs`): their full
 * schemas are listed on design.clones.add only; both tools validate them in full (tools/list
 * budget, llm-api.md#schemas).
 */
const AS_ADD = {
  source: z.looseObject({}).describe('As design.clones.add source'),
  rows: z.array(z.looseObject({})).max(CLONE_ROWS_MAX).describe('As design.clones.add rows'),
}

function parseRow(f: Fields, r: RowArgs, i: number): CloneRow {
  return mapRow<string, unknown>(r, (src, k, kind) =>
    f.q(`rows.${i}.${k}`, kind, src),
  ) as unknown as CloneRow
}

export const clonesSpec: FeatureCommandSpec<typeof params, Clones> = {
  ...clonesKindSpec,
  params,
  required: ['source', 'rows'],
  updateParams: AS_ADD,
  onArg: false,
  addSummary: 'Clone operations or a feature along a path; instances go right after the source.',
  build: (a, prev, { f, id, name, before, on, features }) => {
    // a member Clones brings its own source members into the group (G2)
    const source =
      a.source === undefined ? prev!.source : normalizeSource(a.source, features, before)
    const rows = a.rows !== undefined ? a.rows.map((r, i) => parseRow(f, r, i)) : prev!.rows
    return {
      kind: 'clones',
      id,
      name,
      on: sourceFace(sourceOperations(source, before)) ?? prev?.on ?? on,
      source,
      rows,
    }
  },
}

/** `design.clones.add` / `.update`; registers the kind once per module instance. */
const built = featureKindCommands(clonesSpec)
// a kind clash is a bug in the registry (error-handling rule 3 b)
if (built.isErr()) throw built.unwrapErr()
const CLONES_KIND_COMMANDS = built.unwrap()

// ── follow: re-run the expansion when the source changed ─────────────────────────────────────

/**
 * Every Clones feature of every part brought in line with its source: re-expanded, the owned
 * block rewritten where it differs (and the feature's `on` where the source moved face), then
 * the whole part checked. A source edit that breaks the Clones (a source on two faces, a role
 * that disappears while referenced, over the limit) fails the command.
 */
export function followClones(draft: Draft<ProjectDoc>, ctx: CommandContext): AppResult<void> {
  const where = 'design.clonesFollow'
  for (const partId of Object.keys(draft.parts)) {
    const features = draft.parts[partId]!.features
    if (features === undefined || !features.some((f) => f.kind === 'clones')) continue
    const loaded = loadPart(draft as ProjectDoc, partId, where, true)
    if (loaded.isErr()) {
      // an edit a Clones cannot follow (a shape an `along` row reads, F6) is the expansion's own
      // refusal, not a corrupt part
      const e = loaded.unwrapErr()
      const c = e.cause
      return Err(c instanceof AppError && c.code === 'model.invariant' ? c.withContext(where) : e)
    }
    const l = loaded.unwrap()
    let ops = l.part.operations
    let changed = false
    const ons = new Map<string, string>()
    // the records the part was loaded from: unchanged ones are frozen (P5, frozen-memo.ts)
    const records = baseOf(draft.parts[partId]!)
    const stockRecord = baseOf(draft.snapshots[records.stock])
    // in design order of their spans: a member Clones (G2) lies inside its outer one's source and
    // is followed first, so the outer copies its new instances
    const order = [...l.features.entries()]
      .filter(([, lf]) => lf.spec === (clonesSpec as unknown as FeatureKindSpec))
      .map(([k, lf]) => ({ k, lf, at: featureSpan(ops, lf).ownedStart }))
      .sort((a, b) => a.at - b.at)
    for (const { k, lf } of order) {
      const c = lf.feature as Clones
      const issues = sourceIssues(c, ops, l.features)
      if (issues.length > 0)
        return invalid(issues, where).mapErr((e) => e.withContext(where, { featureId: c.id }))
      const on = sourceFace(sourceOperations(c.source, ops))
      if (on !== undefined && on !== c.on) ons.set(c.id, on)
      const span = featureSpan(ops, lf)
      // inputs and block as a committed document had them, already in line: nothing to redo
      const key = changed
        ? undefined
        : [stockRecord, l.units, records.shapes, ...records.operations.slice(0, span.end)]
      const record = records.features?.[k]
      const cacheable =
        key !== undefined &&
        isFrozenRecord(record) &&
        key.every((x) => typeof x !== 'object' || Object.isFrozen(x))
      if (cacheable && sameKey(followed.get(record), key)) continue
      const expanded = expandClones(c, {
        units: l.units,
        stock: l.stock,
        before: ops.slice(0, span.ownedStart),
        ownedId: (role) => ownedOperationId(c.id, role),
        shapes: l.dto.shapes ?? [],
      })
      if (expanded.isErr()) return Err(expanded.unwrapErr().withContext(where, { featureId: c.id }))
      const prevBlock = ops.slice(span.ownedStart, span.end)
      const owned = materialize(c, expanded.unwrap(), prevBlock, c.name, true)
      if (owned.isErr()) return owned
      const same =
        owned.unwrap().length === prevBlock.length &&
        owned.unwrap().every((o, i) => deepEqual(operationToDTO(o), operationToDTO(prevBlock[i]!)))
      if (same) {
        if (cacheable) followed.set(record, key)
        continue
      }
      ops = [...ops.slice(0, span.ownedStart), ...owned.unwrap(), ...ops.slice(span.end)]
      changed = true
    }
    if (changed) {
      const settled = settle(
        ops,
        l.stock,
        undefined,
        false,
        where,
        shapeEnv(l, ctx.services.region2d),
        l.part.operations,
      )
      if (settled.isErr()) return settled
      const list = draft.parts[partId]!.operations
      const base = baseOf(list)
      const byId = new Map(list.map((o, i) => [o.id, { prev: o, record: base[i] }]))
      const next = settled.unwrap().map((op) => {
        const was = byId.get(op.id)
        // loaded from the record it writes back as (P5): kept without converting
        if (was !== undefined && recordOf(op) === was.record) return was.prev
        const dto = operationToDTO(op)
        return was !== undefined && deepEqual(was.prev, dto) ? was.prev : dto
      })
      if (next.length !== list.length || next.some((o, i) => o !== list[i]))
        list.splice(0, list.length, ...next)
    }
    for (const [id, on] of ons) {
      const f = draft.parts[partId]!.features!.find((x) => x.id === id)
      if (f !== undefined) f.on = on
    }
  }
  return Ok(undefined)
}

/**
 * The inputs (stock snapshot, units, shape records, the operation records up to the end of its
 * block) with which a Clones feature record was found in line with its source, all frozen: the
 * same inputs again need no expansion and comparison (hardening P5).
 */
const followed = new WeakMap<object, readonly unknown[]>()

const sameKey = (a: readonly unknown[] | undefined, b: readonly unknown[]) =>
  a !== undefined && a.length === b.length && a.every((x, i) => x === b[i])

/** Some part has a Clones whose group holds a Clones (Clones v2, G2). */
function holdsNestedClones(draft: Draft<ProjectDoc>): boolean {
  return Object.values(draft.parts).some((p) =>
    (p.features ?? []).some((f) => {
      if (f.kind !== 'clones') return false
      const s = ClonesSourceSchema.safeParse((f as Record<string, unknown>)['source'])
      return s.success && sourceMembers(s.data).featureIds.some((id) => id.startsWith('clones'))
    }),
  )
}

/** After every document command (commands.md#document-hooks). */
export const clonesFollowHook: DocumentHook = {
  name: 'design.clonesFollow',
  after: (draft, command, ctx) =>
    // every part with Clones is loaded, from cached models of its unchanged records, and a Clones
    // whose inputs are all unchanged is skipped (P5); `design.clones.*` already wrote the expansion,
    // unless a Clones holds another one (G4: the outer follows the edited inner)
    command.name.startsWith('design.clones.') && !holdsNestedClones(draft)
      ? Ok(undefined)
      : followClones(draft, ctx),
}

/** After the tool choice on Apply: instances take their source's new tool (C3). */
export const clonesFollowApply: ApplyHook = {
  name: 'design.clonesFollow',
  apply: (draft, _pending, ctx) => followClones(draft, ctx),
}

// ── preview ────────────────────────────────────────────────────────────────────────────────

const UVOut = z.tuple([z.number(), z.number()])

const clonesPreview = defineQuery({
  name: 'design.clones.preview',
  summary: 'Clone positions, numbers and warnings of a Clones feature or a draft; changes nothing.',
  args: z.object({
    ...PartArg,
    featureId: FeatureIdSchema.optional().describe('Absent: a draft from source and rows'),
    source: params.source.optional(),
    rows: RowsArg.optional(),
  }),
  // the draft's source and rows are listed in full on design.clones.add only
  listedArgs: AS_ADD,
  result: z.object({
    on: z.string(),
    instances: z.array(z.object({ n: z.number(), at: UVOut })).describe('1 = the source'),
    rows: z.array(
      z.object({
        start: UVOut,
        end: UVOut,
        path: z.array(UVOut).describe('Drawn path: straight, along the arc or the shape'),
        centre: UVOut.optional().describe('arc'),
        points: z.array(
          z.object({
            at: UVOut,
            kind: z.enum(['clone', 'skipped', 'closes', 'duplicate']),
            n: z.number().optional(),
          }),
        ),
      }),
    ),
    // the draft's own warnings, not the part's: not `Warnings`, which the agent boundary turns
    // into changes against the part's last warnings (llm-api.md#result-size)
    warnings: z.array(DfmWarningSchema).describe("The Clones' own warnings (clone*)"),
  }),
  run(doc, args, ctx) {
    const where = 'design.clones.preview'
    const loaded = load(doc as Draft<ProjectDoc>, args.partId, where)
    if (loaded.isErr()) return loaded
    const l = loaded.unwrap()
    const ops = l.part.operations
    const prev = l.features.find((f) => f.feature.id === args.featureId)?.feature as
      Clones | undefined
    if (args.featureId !== undefined && prev?.kind !== 'clones')
      return fail('input.malformed', `${args.featureId} is not a Clones feature of the part`, {
        issues: [
          { path: ['featureId'], rule: 'unknownFeature', message: 'no such Clones feature' },
        ],
        where,
      })
    const draftArgs = args
    const source =
      draftArgs.source === undefined
        ? prev?.source
        : normalizeSource(draftArgs.source, l.features, ops)
    if (source === undefined || (draftArgs.rows === undefined && prev === undefined))
      return fail('input.malformed', 'a draft needs source and rows', {
        issues: [
          { path: ['source'], rule: 'required', message: 'give featureId or source and rows' },
        ],
        where,
      })
    const f = new Fields(l.units, SurfaceTable.build(ops, l.stock).resolver(ops.length))
    const rows = draftArgs.rows?.map((r, i) => parseRow(f, r, i)) ?? prev!.rows
    const parsed = f.done()
    if (parsed.isErr()) return Err(parsed.unwrapErr().withContext(where))
    const draft: Clones = {
      kind: 'clones',
      id: prev?.id ?? 'clones0',
      name: prev?.name ?? 'Clones',
      on: sourceFace(sourceOperations(source, ops)) ?? 'stock.top',
      source,
      rows,
    }
    const shapes = l.dto.shapes ?? []
    const issues = [...rowIssues(rows, shapes), ...sourceIssues(draft, ops, l.features)]
    if (issues.length > 0) return invalid(issues, where)
    const path = featurePath(draft, ops, shapes)
    // the source's footprint reads the placed shapes (B3)
    const region2d = ctx.services.region2d
    const input = shapesOf(ops, l.dto).andThen((placed) =>
      toGeometryInput(
        { ...l.part, ...(placed.size === 0 ? {} : { shapes: placed }) },
        l.stock,
        region2d,
      ),
    )
    if (input.isErr()) return Err(input.unwrapErr().withContext(where))
    const geometry = { operations: input.unwrap().operations, region2d }
    const uv = (p: { u: number; v: number }): [number, number] => [p.u, p.v]
    return Ok({
      on: draft.on,
      instances: path.instances.map((i) => ({ n: i.number, at: uv(i.at) })),
      rows: path.rows.map((r) => ({
        start: uv(r.start),
        end: uv(r.end),
        path: (r.curve ?? r.line).map(uv),
        ...(r.arc === undefined ? {} : { centre: uv(r.arc.centre) }),
        points: r.points.map((p) => ({
          at: uv(p.at),
          kind: p.kind,
          ...(p.number === undefined ? {} : { n: p.number }),
        })),
      })),
      warnings: clonesWarnings(draft, ops, l.stock, l.units, shapes, geometry),
    })
  },
})

export const CLONES_COMMANDS: readonly AnyCommand[] = CLONES_KIND_COMMANDS
export const CLONES_QUERIES: readonly QueryDef[] = [clonesPreview]
