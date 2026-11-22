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
import { Fields, invalid, load, PartArg, settle, shapeEnv, Src, Warnings } from '../commands'
import { featureSpan, materialize, ownedOperationId, type FeatureKindSpec } from '../feature'
import { featureKindCommands, type FeatureCommandSpec } from '../feature-commands'
import { FeatureIdSchema } from '../feature.dto'
import { loadPart } from '../load'
import { operationToDTO } from '../operation'
import { ShapeIdSchema } from '../shape.dto'
import { SurfaceTable } from '../surfaces'
import { parseWith } from '../../../shared/parse'
import {
  CLONE_ROW_MAX,
  CLONE_ROWS_MAX,
  clonesKindSpec,
  clonesWarnings,
  ClonesSourceSchema,
  expandClones,
  featurePath,
  mapRow,
  rowIssues,
  sourceFace,
  sourceIssues,
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
    'From the source, each row from the last position of the one before. polar: angle from +u CCW. arc: centre radius away at angle, sweep arc (±360°, + CCW) every step. point: absolute u v. along: a one-item shape with its start on that position; from arc length start (0), every spacing or count evenly. skip: 0-based point indices left out, numbers kept.',
  )

const params = {
  source: ClonesSourceSchema.describe('Existing operations, or one feature'),
  rows: RowsArg,
}

/**
 * `source` and `rows` as the update and preview tools show them: their full schemas are on
 * design.clones.add only and are checked in `run` (tools/list budget, llm-api.md § Implementation).
 */
const AS_ADD = {
  source: z.looseObject({}).describe('As design.clones.add'),
  rows: z.array(z.looseObject({})).max(CLONE_ROWS_MAX).describe('As design.clones.add'),
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
  build: (a, prev, { f, id, name, before, on }) => {
    const source = a.source ?? prev!.source
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
    const loaded = loadPart(draft as ProjectDoc, partId, where)
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
    for (const lf of l.features) {
      if (lf.spec !== (clonesSpec as unknown as FeatureKindSpec)) continue
      const c = lf.feature as Clones
      const issues = sourceIssues(c, ops, l.features)
      if (issues.length > 0)
        return invalid(issues, where).mapErr((e) => e.withContext(where, { featureId: c.id }))
      const on = sourceFace(sourceOperations(c.source, ops))
      if (on !== undefined && on !== c.on) ons.set(c.id, on)
      const span = featureSpan(ops, lf)
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
      if (same) continue
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
      )
      if (settled.isErr()) return settled
      const list = draft.parts[partId]!.operations
      const byId = new Map(list.map((o) => [o.id, o]))
      const next = settled.unwrap().map((op) => {
        const dto = operationToDTO(op)
        const prev = byId.get(op.id)
        return prev !== undefined && deepEqual(prev, dto) ? prev : dto
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

/** After every document command (commands.md#document-hooks). */
export const clonesFollowHook: DocumentHook = {
  name: 'design.clonesFollow',
  after: (draft, command, ctx) =>
    // a feature or undo-free command that cannot touch a source still costs one load per part
    // with Clones; `design.clones.*` already wrote the expansion
    command.name.startsWith('design.clones.') ? Ok(undefined) : followClones(draft, ctx),
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
  // the draft's source and rows are checked in `run`: their full schemas are on design.clones.add
  args: z.object({
    ...PartArg,
    featureId: FeatureIdSchema.optional().describe('Absent: a draft from source and rows'),
    source: AS_ADD.source.optional(),
    rows: AS_ADD.rows.optional(),
  }),
  result: z.object({
    on: z.string(),
    instances: z.array(z.object({ n: z.number(), at: UVOut })).describe('1 = the source'),
    rows: z.array(
      z.object({
        start: UVOut,
        end: UVOut,
        points: z.array(
          z.object({
            at: UVOut,
            kind: z.enum(['clone', 'skipped', 'closes', 'duplicate']),
            n: z.number().optional(),
          }),
        ),
      }),
    ),
    warnings: Warnings,
  }),
  run(doc, args) {
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
    const given = parseWith(
      z.object({ source: ClonesSourceSchema.optional(), rows: RowsArg.optional() }),
      { source: args.source, rows: args.rows },
      where,
    )
    if (given.isErr()) return given
    const draftArgs = given.unwrap()
    const source = draftArgs.source ?? prev?.source
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
    const uv = (p: { u: number; v: number }): [number, number] => [p.u, p.v]
    return Ok({
      on: draft.on,
      instances: path.instances.map((i) => ({ n: i.number, at: uv(i.at) })),
      rows: path.rows.map((r) => ({
        start: uv(r.start),
        end: uv(r.end),
        points: r.points.map((p) => ({
          at: uv(p.at),
          kind: p.kind,
          ...(p.number === undefined ? {} : { n: p.number }),
        })),
      })),
      warnings: clonesWarnings(draft, ops, l.stock, l.units, shapes),
    })
  },
})

export const CLONES_COMMANDS: readonly AnyCommand[] = CLONES_KIND_COMMANDS
export const CLONES_QUERIES: readonly QueryDef[] = [clonesPreview]
