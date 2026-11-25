/**
 * Split parts 4a: `design.split.set` (the whole split of a source part, one folded tool), the
 * piece writer (pieces are derived part records, regenerated in the same command as any source
 * edit), the `design.splitFollow` document and apply hooks, and the read-only rule for pieces.
 * Doc: docs/modes/split-parts.md#model, docs/modes/split-parts.md#agent-api
 */
import type { Draft } from 'immer'
import { z } from 'zod'
import type { Issue } from '../../../shared/errors/app-error'
import { Err, fail, Ok, type AppResult } from '../../../shared/result'
import {
  defineCommand,
  type AnyCommand,
  type ApplyHook,
  type DocumentHook,
} from '../../commands/define'
import type { CommandContext } from '../../commands/context'
import { deepEqual } from '../../library/snapshot'
import type { DfmWarning } from '../../geometry/model'
import type { SnapshotDTO } from '../../library/snapshot'
import type { ProjectDoc, UnitSystem } from '../../project/document'
import { Fields, invalid, load, PartArg, Src, withWarnings, Warnings } from '../commands'
import { baseOf, isFrozenRecord } from '../frozen-memo'
import { loadPart, unknownPart, type LoadedPart } from '../load'
import { type PartDTO, PartIdSchema, type SplitDTO, SPLIT_JOINTS } from '../part.dto'
import { SurfaceTable } from '../surfaces'
import { requirePort } from '../shape'
import { dropUnusedToolSnapshot } from '../tool-args'
import { DfmWarningSchema } from '../warnings'
import { lengthDTO, pieceName, pieceRecord, planPieces, type PiecePlan } from './pieces'
import { splitWarnings } from './findings'
import { derivedPartError } from './derived'
import { completeDowels } from './dowels'
import { DOWEL_DEPTH_MAX, DOWEL_DIAMETER_MAX, DOWEL_DIAMETER_MIN } from '../dowel'
import { isKeyKind, KEY_CLEARANCE_DEFAULT, KEY_CLEARANCE_MAX } from './keys'

export { derivedPartError }

/** The split id of 4a: one split per part (SP-D). */
export const SPLIT_ID = 'split1'

/** The pieces of a source part in the document, by their number. */
export function piecesOf(doc: ProjectDoc, sourceId: string): PartDTO[] {
  return Object.values(doc.parts)
    .filter((p) => p.derivedFrom?.partId === sourceId)
    .sort((a, b) => a.derivedFrom!.index - b.derivedFrom!.index)
}

/** What `design.split.set` and the follow report per piece. */
export interface PieceInfo {
  readonly partId: string
  readonly name: string
  readonly index: number
  /** Blank length, width, thickness (mm). */
  readonly blank: readonly [number, number, number]
}

export interface SplitOutcome {
  readonly pieces: readonly PieceInfo[]
  readonly removedPlans: readonly string[]
  readonly findings: readonly DfmWarning[]
}

const mmOf = (q: { exact: { num: string; den: string } }) =>
  Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))

/** A kept name when the user renamed the piece; the default "<source> · <n>" follows the source. */
function keptName(prev: PartDTO | undefined, plan: PiecePlan): string {
  if (prev === undefined || /^.* · \d+$/.test(prev.name)) return plan.name
  return prev.name
}

/**
 * An own block snapshot with the source stock's values and the given sizes (mm), named
 * "<label> L × W × T": a piece's blank, a Test fit coupon's block.
 */
export function ownBlock(
  sourceStock: SnapshotDTO,
  size: { readonly length: number; readonly width: number; readonly thickness: number },
  label: string,
  id: string,
  takenAt: string,
  units: UnitSystem,
): SnapshotDTO {
  const { libraryItemId: _, ...base } = sourceStock as SnapshotDTO & { libraryItemId?: string }
  const values = base.values as Extract<SnapshotDTO['values'], { kind: 'stock' }>
  const fmt = (mm: number) => +mm.toFixed(3)
  return {
    ...base,
    id,
    takenAt,
    values: {
      ...values,
      name: `${label} ${fmt(size.length)} × ${fmt(size.width)} × ${fmt(size.thickness)}`,
      length: lengthDTO(size.length, units),
      width: lengthDTO(size.width, units),
      thickness: lengthDTO(size.thickness, units),
    },
  } as SnapshotDTO
}

/**
 * Removes pieces (and their plans, blank snapshots and unused tool snapshots). Plans need
 * `confirm`; an `inUse` plan refuses (as `design.part.remove`).
 */
function removePieces(
  draft: Draft<ProjectDoc>,
  pieces: readonly PartDTO[],
  confirm: boolean,
  where: string,
): AppResult<string[]> {
  const ids = new Set(pieces.map((p) => p.id))
  const plans = Object.values(draft.plans).filter((p) => ids.has(p.design.partId))
  const inUse = plans.find((p) => p.status === 'inUse')
  if (inUse !== undefined)
    return invalid(
      [
        {
          path: ['split'],
          rule: 'planInUse',
          message: `plan ${inUse.name} is in use; archive it first`,
        },
      ],
      where,
    )
  if (plans.length > 0 && !confirm) {
    const names = pieces.filter((p) => plans.some((q) => q.design.partId === p.id))
    return fail(
      'input.malformed',
      `${names.map((p) => p.name).join(', ')} ha${names.length === 1 ? 's' : 've'} ${plans.length} plan(s); pass confirm: true to remove them with the piece(s)`,
      {
        issues: [
          {
            path: ['confirm'],
            rule: 'pieceHasPlans',
            message: `removing the piece(s) removes ${plans.length} plan(s); pass confirm: true`,
            params: { pieces: names.map((p) => p.id), plans: plans.map((p) => p.id) },
          },
        ],
        where,
      },
    )
  }
  for (const p of pieces) {
    const tools = new Set(
      p.operations.flatMap((o) => (o.tool?.kind === 'specific' ? [o.tool.snapshotId] : [])),
    )
    delete draft.parts[p.id]
    if (!Object.values(draft.parts).some((q) => q.stock === p.stock))
      delete draft.snapshots[p.stock]
    for (const id of tools) dropUnusedToolSnapshot(draft, id)
  }
  for (const p of plans) delete draft.plans[p.id]
  return Ok(plans.map((p) => p.id))
}

/**
 * Regenerates the pieces of `sourceId` from its split (none when it has no split) in the draft:
 * a piece keeps its id, blank snapshot id, a renamed name and its generated operations' tool
 * fields by its number; records are written only when they change.
 */
export function regeneratePieces(
  draft: Draft<ProjectDoc>,
  sourceId: string,
  ctx: CommandContext,
  confirm: boolean,
  where: string,
): AppResult<SplitOutcome> {
  const existing = piecesOf(draft as ProjectDoc, sourceId)
  const source = Object.hasOwn(draft.parts, sourceId) ? draft.parts[sourceId] : undefined
  const split = source?.split
  if (source === undefined || split === undefined) {
    const removed = removePieces(draft, existing, confirm, where)
    if (removed.isErr()) return removed
    return Ok({ pieces: [], removedPlans: removed.unwrap(), findings: [] })
  }
  const loaded = load(draft, sourceId, where)
  if (loaded.isErr()) return loaded
  const port = requirePort(ctx.services.region2d, where)
  if (port.isErr()) return port
  const planned = planPieces(loaded.unwrap(), split, port.unwrap())
  if (planned.isErr()) return Err(planned.unwrapErr().withContext(where))
  const { pieces } = planned.unwrap()
  const byIndex = new Map(existing.map((p) => [p.derivedFrom!.index, p]))
  const gone = existing.filter((p) => !pieces.some((q) => q.n === p.derivedFrom!.index))
  const removed = removePieces(draft, gone, confirm, where)
  if (removed.isErr()) return removed
  const sourceStock = draft.snapshots[source.stock] as SnapshotDTO
  const units = draft.unitSystem
  const out: PieceInfo[] = []
  for (const plan of pieces) {
    const prev = byIndex.get(plan.n)
    const partId = prev?.id ?? ctx.ids.next('part')
    const snapshotId = prev?.stock ?? ctx.ids.next('snapshot')
    const record = pieceRecord(plan, baseOf(source), split, units)
    // generated operations keep the tool the piece's Apply chose (A4: kept per operation)
    const ops = record.operations.map((o) => {
      if (!o.id.startsWith(`${split.id}_`) || o.tool !== undefined) return o
      const before = prev?.operations.find((p) => p.id === o.id)
      if (before?.tool === undefined) return o
      return {
        ...o,
        tool: before.tool,
        ...(before.toolLocked === undefined ? {} : { toolLocked: before.toolLocked }),
      }
    })
    const dto: PartDTO = {
      ...record,
      operations: ops,
      id: partId,
      name: keptName(prev, plan),
      stock: snapshotId,
    }
    const prevSnap = prev === undefined ? undefined : draft.snapshots[snapshotId]
    const snap = ownBlock(
      baseOf(sourceStock),
      plan.blank,
      'Blank',
      snapshotId,
      prevSnap?.takenAt ?? new Date(ctx.clock.now()).toISOString(),
      units,
    )
    if (prevSnap === undefined || !deepEqual(baseOf(prevSnap), snap))
      draft.snapshots[snapshotId] = snap
    if (prev === undefined || !deepEqual(baseOf(prev), dto)) draft.parts[partId] = dto
    out.push({
      partId,
      name: dto.name,
      index: plan.n,
      blank: [plan.blank.length, plan.blank.width, plan.blank.thickness],
    })
  }
  return Ok({ pieces: out, removedPlans: removed.unwrap(), findings: planned.unwrap().findings })
}

// ── design.split.set ──────────────────────────────────────────────────────────────────────

const LineArg = z.object({
  axis: z.enum(['x', 'y']).describe('x: the plane x = at (runs along Y)'),
  at: Src,
})

const SplitArg = z
  .object({
    lines: z.array(LineArg).max(20).optional().describe('Vertical cuts; default none'),
    levels: z
      .array(Src)
      .max(20)
      .optional()
      .describe('Horizontal cuts: part-frame z, between -thickness and 0; default none'),
    margin: Src.optional().describe('Blank margin per side; default 5 mm'),
    joint: z.enum(SPLIT_JOINTS).optional().describe("Lines' joint; default butt"),
    clearance: Src.optional().describe('Key socket clearance; default 0.15 mm'),
    dowels: z
      .object({
        diameter: Src.optional().describe('Dowel Ø; default: fits'),
        depth: Src.optional().describe('Per piece; default 2.5Ø + 1 mm'),
        holes: z
          .array(z.object({ level: z.number().int().min(0), at: z.tuple([Src, Src]) }))
          .max(64)
          .optional()
          .describe('level: index in levels; at: part X, Y. Levels without holes get placed'),
      })
      .nullable()
      .optional()
      .describe('Dowels on levels; absent = butt'),
  })
  .nullable()
  .describe('The whole split; null removes it and its pieces')

const PieceOut = z.object({
  partId: PartIdSchema,
  name: z.string(),
  index: z.number(),
  blank: z.array(z.number()).describe('Length, width, thickness (mm)'),
})

const splitSet = defineCommand({
  kind: 'document',
  name: 'design.split.set',
  summary:
    'Split a part into pieces by straight lines and levels; pieces are derived parts kept in sync, each with its own blank.',
  title: () => 'Split part',
  machine: false,
  args: z.object({
    ...PartArg,
    split: SplitArg,
    confirm: z.literal(true).optional().describe('Required when removed pieces have plans'),
  }),
  result: z.object({
    pieces: z.array(PieceOut),
    removedPlans: z.array(z.string()),
    findings: z.array(DfmWarningSchema).describe("The split's findings (design.split)"),
    warnings: Warnings,
  }),
  run(draft, args, ctx) {
    const where = 'design.split.set'
    const loaded = load(draft, args.partId, where)
    if (loaded.isErr()) return loaded
    const l = loaded.unwrap()
    if (l.dto.derivedFrom !== undefined) return derivedPartError(draft, l.dto, where)
    const target = draft.parts[args.partId]!
    if (args.split === null) delete target.split
    else {
      const parsed = parseSplit(args.split, l, baseOf(target).split)
      if (parsed.isErr()) return Err(parsed.unwrapErr().withContext(where))
      const port = requirePort(ctx.services.region2d, where)
      if (port.isErr()) return port
      const units = draft.unitSystem
      const done = completeDowels(l, parsed.unwrap().split, port.unwrap(), parsed.unwrap(), (mm) =>
        lengthDTO(mm, units),
      )
      if (done.isErr()) return Err(done.unwrapErr().withContext(where))
      if (!deepEqual(baseOf(target).split, done.unwrap())) target.split = done.unwrap()
    }
    const r = regeneratePieces(draft, args.partId, ctx, args.confirm === true, where)
    if (r.isErr()) return r
    const after = load(draft, args.partId, where)
    if (after.isErr()) return after
    const findings = splitWarnings(draft as ProjectDoc, after.unwrap(), ctx.services)
    return withWarnings(
      {
        pieces: r.unwrap().pieces.map((p) => ({ ...p, blank: [...p.blank] })),
        removedPlans: [...r.unwrap().removedPlans],
        findings,
      },
      after.unwrap(),
      after.unwrap().part.operations,
      ctx,
      where,
    )
  },
})

/**
 * The split record from its args (lines and levels in range, distinct; margin ≥ 0; dowels in
 * range), and the dowel Ø and depth the args (or the previous dowels) fix: undefined = the
 * placement chooses the Ø, the depth defaults for it.
 */
function parseSplit(
  a: NonNullable<z.output<typeof SplitArg>>,
  l: LoadedPart,
  prev: SplitDTO | undefined,
): AppResult<{
  split: SplitDTO
  diameter: number | undefined
  depth: number | undefined
}> {
  const f = new Fields(l.units, SurfaceTable.build(l.part.operations, l.stock).resolver(0))
  const lines = (a.lines ?? []).map((line, i) => ({
    axis: line.axis,
    at: f.q(`split.lines.${i}.at`, 'length', line.at),
  }))
  const levels = (a.levels ?? []).map((s, i) => f.q(`split.levels.${i}`, 'length', s))
  const margin = f.q('split.margin', 'length', a.margin ?? (l.units === 'inch' ? '0.2"' : '5 mm'))
  // keys (4b-2): the clearance given, else the previous one, else the default
  const kind = a.joint ?? 'butt'
  const clearance = isKeyKind(kind)
    ? a.clearance !== undefined
      ? f.q('split.clearance', 'length', a.clearance)
      : prev?.joint.clearance === undefined
        ? f.q('split.clearance', 'length', `${KEY_CLEARANCE_DEFAULT} mm`)
        : undefined
    : undefined
  const clearanceDto =
    (clearance?.toDTO() as SplitDTO['margin'] | undefined) ??
    (isKeyKind(kind) ? prev?.joint.clearance : undefined)
  // dowels: the Ø and depth given, else the previous ones (the depth while the Ø is unchanged)
  const dw = a.dowels ?? undefined
  const before = prev?.joint.dowels
  const dia =
    dw?.diameter !== undefined ? f.q('split.dowels.diameter', 'length', dw.diameter) : undefined
  const diaDto = (dia?.toDTO() as SplitDTO['margin'] | undefined) ?? before?.diameter
  const depth = dw?.depth !== undefined ? f.q('split.dowels.depth', 'length', dw.depth) : undefined
  const sameDia =
    before !== undefined && diaDto !== undefined && mmOf(before.diameter) === mmOf(diaDto)
  const depthDto =
    (depth?.toDTO() as SplitDTO['margin'] | undefined) ?? (sameDia ? before.depth : undefined)
  const holes = (dw?.holes ?? []).map((h, i) => ({
    level: h.level,
    at: [
      f.q(`split.dowels.holes.${i}.at.0`, 'length', h.at[0]),
      f.q(`split.dowels.holes.${i}.at.1`, 'length', h.at[1]),
    ] as const,
  }))
  const done = f.done()
  if (done.isErr()) return done
  const L = l.stock.length.canonical
  const W = l.stock.width.canonical
  const T = l.stock.thickness.canonical
  const issues: Issue[] = []
  const seen = new Set<string>()
  lines.forEach((line, i) => {
    const max = line.axis === 'x' ? L : W
    const v = line.at.canonical
    if (!(v > 0 && v < max))
      issues.push({
        path: ['split', 'lines', i, 'at'],
        rule: 'range',
        message: `must lie inside the stock: between 0 and ${+max.toFixed(3)} mm`,
        params: { min: 0, max },
      })
    const key = `${line.axis}:${v}`
    if (seen.has(key))
      issues.push({
        path: ['split', 'lines', i, 'at'],
        rule: 'duplicate',
        message: 'the same line twice',
      })
    seen.add(key)
  })
  levels.forEach((q, i) => {
    const v = q.canonical
    if (!(v < 0 && v > -T))
      issues.push({
        path: ['split', 'levels', i],
        rule: 'range',
        message: `must lie inside the stock: between ${-T} and 0 mm (z down from the top)`,
        params: { min: -T, max: 0 },
      })
    if (levels.slice(0, i).some((p) => p.canonical === v))
      issues.push({
        path: ['split', 'levels', i],
        rule: 'duplicate',
        message: 'the same level twice',
      })
  })
  if (margin.canonical < 0)
    issues.push({ path: ['split', 'margin'], rule: 'nonNegative', message: 'must be ≥ 0' })
  if (a.clearance !== undefined && !isKeyKind(kind))
    issues.push({
      path: ['split', 'clearance'],
      rule: 'keysOnly',
      message: 'a clearance needs a puzzle or dovetail joint',
    })
  if (
    clearance !== undefined &&
    !(clearance.canonical >= 0 && clearance.canonical <= KEY_CLEARANCE_MAX)
  )
    issues.push({
      path: ['split', 'clearance'],
      rule: 'range',
      message: `must be between 0 and ${KEY_CLEARANCE_MAX} mm`,
      params: { min: 0, max: KEY_CLEARANCE_MAX },
    })
  if (
    dia !== undefined &&
    !(dia.canonical >= DOWEL_DIAMETER_MIN && dia.canonical <= DOWEL_DIAMETER_MAX)
  )
    issues.push({
      path: ['split', 'dowels', 'diameter'],
      rule: 'range',
      message: `must be between ${DOWEL_DIAMETER_MIN} and ${DOWEL_DIAMETER_MAX} mm`,
      params: { min: DOWEL_DIAMETER_MIN, max: DOWEL_DIAMETER_MAX },
    })
  if (depth !== undefined && !(depth.canonical > 0 && depth.canonical <= DOWEL_DEPTH_MAX))
    issues.push({
      path: ['split', 'dowels', 'depth'],
      rule: 'range',
      message: `must be more than 0 and at most ${DOWEL_DEPTH_MAX} mm`,
      params: { min: 0, max: DOWEL_DEPTH_MAX },
    })
  holes.forEach((h, i) => {
    if (h.level >= levels.length)
      issues.push({
        path: ['split', 'dowels', 'holes', i, 'level'],
        rule: 'range',
        message: `no level ${h.level}: the split has ${levels.length}`,
        params: { min: 0, max: levels.length - 1 },
      })
  })
  if (issues.length > 0) return invalid(issues, 'design.split.set')
  const D = (q: { toDTO(): unknown }) => q.toDTO() as SplitDTO['margin']
  const dowels =
    dw === undefined
      ? undefined
      : {
          // placeholders until completeDowels fixes them (the given ones are kept)
          diameter: diaDto ?? D(margin),
          depth: depthDto ?? D(margin),
          holes: holes.map((h) => ({
            level: h.level,
            at: [D(h.at[0]), D(h.at[1])] as [SplitDTO['margin'], SplitDTO['margin']],
          })),
        }
  return Ok({
    split: {
      id: SPLIT_ID,
      lines: lines.map((x) => ({ axis: x.axis, at: D(x.at) })),
      levels: levels.map(D),
      margin: D(margin),
      joint: {
        kind,
        ...(clearanceDto === undefined ? {} : { clearance: clearanceDto }),
        ...(dowels === undefined ? {} : { dowels }),
      },
    },
    diameter: diaDto === undefined ? undefined : mmOf(diaDto),
    depth: depthDto === undefined ? undefined : mmOf(depthDto),
  })
}

// ── follow ────────────────────────────────────────────────────────────────────────────────

/** Design commands a piece takes: its name only (split-parts.md § Source and pieces). */
function allowedOnPiece(name: string, args: Record<string, unknown>): boolean {
  if (name === 'design.part.update')
    return Object.keys(args).every(
      (k) => k === 'partId' || k === 'name' || k === 'expectedRevision',
    )
  return false
}

/**
 * Regenerates the pieces of every split source whose record or stock this command changed (an
 * unchanged source is a committed document's frozen record); removes orphan pieces. `refuse`:
 * a design command on a piece fails (`derivedPart`).
 */
export function followSplits(
  draft: Draft<ProjectDoc>,
  ctx: CommandContext,
  command: { readonly name: string; readonly args: unknown } | undefined,
): AppResult<void> {
  const where = 'design.splitFollow'
  if (command !== undefined && command.name.startsWith('design.')) {
    const args = (command.args ?? {}) as Record<string, unknown>
    const partId = typeof args['partId'] === 'string' ? args['partId'] : undefined
    const base = Object.hasOwn(draft.parts, partId ?? '') ? draft.parts[partId!] : undefined
    // a part the command removed is looked up in the document before it
    const piece = base ?? undefined
    if (piece?.derivedFrom !== undefined && !allowedOnPiece(command.name, args))
      return derivedPartError(
        draft,
        piece,
        command.name,
        typeof args['operationId'] === 'string' ? args['operationId'] : undefined,
      )
  }
  for (const id of Object.keys(draft.parts)) {
    const part = draft.parts[id]!
    if (part.derivedFrom !== undefined) {
      const src = Object.hasOwn(draft.parts, part.derivedFrom.partId)
        ? draft.parts[part.derivedFrom.partId]
        : undefined
      if (src?.split === undefined) {
        const r = regeneratePieces(draft, part.derivedFrom.partId, ctx, true, where)
        if (r.isErr()) return r
      }
      continue
    }
    if (part.split === undefined) continue
    const record = baseOf(part)
    const stock = Object.hasOwn(draft.snapshots, part.stock)
      ? baseOf(draft.snapshots[part.stock])
      : undefined
    if (isFrozenRecord(record) && isFrozenRecord(stock)) continue
    const r = regeneratePieces(draft, id, ctx, false, where)
    if (r.isErr()) return r
  }
  return Ok(undefined)
}

export const splitFollowHook: DocumentHook = {
  name: 'design.splitFollow',
  after: (draft, command, ctx) =>
    command.name === 'design.split.set' ? Ok(undefined) : followSplits(draft, ctx, command),
}

/** After the tool choice on Apply: mapped operations take their source's chosen tool. */
export const splitFollowApply: ApplyHook = {
  name: 'design.splitFollow',
  apply: (draft, _pending, ctx) => {
    for (const id of Object.keys(draft.parts)) {
      if (draft.parts[id]!.split === undefined) continue
      const r = regeneratePieces(draft, id, ctx, false, 'design.splitFollow')
      if (r.isErr()) return r
    }
    return Ok({})
  },
}

export { pieceName, mmOf, unknownPart, loadPart }

export const SPLIT_COMMANDS: readonly AnyCommand[] = [splitSet]
