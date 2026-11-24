/**
 * Operation tool field (v0.2): `design.operation.tool.set/lock/unlock`, `design.snapshot.update`,
 * the `design.tool.candidates` query and the auto choice as the apply hook
 * `design.toolAutoChoice` (registered in `APPLY_HOOKS`), and the tool re-choice pending source
 * `design.toolRechoice` (X2 F6: library changes and opening).
 * Doc: docs/modes/design-v0.2.md#operation-tool, docs/modes/design-v0.2.md#commands-and-queries-v02,
 * docs/architecture/apply.md#apply-hooks
 */
import { produce, type Draft } from 'immer'
import { z } from 'zod'
import { Err, fail, Ok, Some, type AppResult } from '../../shared/result'
import type { PendingChange, ToolChange } from '../commands/apply'
import type { CommandContext } from '../commands/context'
import {
  defineCommand,
  defineQuery,
  type AnyCommand,
  type ApplyHook,
  type PendingSource,
  type QueryDef,
} from '../commands/define'
import type { Region2dPort } from '../geometry/2d/port'
import type { DfmWarning } from '../geometry/model'
import type { LibraryItem } from '../library/library-item'
import { deepEqual, refreshSnapshot, Snapshot } from '../library/snapshot'
import { Tool } from '../library/tool'
import { TOOL_TYPES } from '../library/tool.dto'
import type { ProjectDoc } from '../project/document'
import { findOperation, readOnlyOwned, refuseOwned, Warnings, withWarnings } from './commands'
import { toGeometryInput } from './geometry-input'
import { loadPart, type LoadedPart } from './load'
import type { Operation, Part } from './operation'
import {
  DesignToolDtoSchema,
  OperationIdSchema,
  PartIdSchema,
  type DesignToolDTO,
} from './part.dto'
import { designChangeTargets } from './shape-users'
import { designToolToDTO, type DesignTool } from './tool'
import { dropUnusedToolSnapshot, ToolArg, toolFromArg, toolSnapshotFor } from './tool-args'
import {
  chooseTool,
  fitOf,
  fittingLibraryTools,
  generalizedChoice,
  nearLibraryTool,
  orphanTool,
  resolveDesignTool,
  unfitLibraryTools,
  type ChoiceInput,
} from './tool-choice'

const OpArg = { partId: PartIdSchema, operationId: OperationIdSchema }

/** The library's readable tool items (none without a library service). */
function toolItems(ctx: { services: CommandContext['services'] }): LibraryItem[] {
  const library = ctx.services.library
  if (library === undefined) return []
  return library.list('tool').items.filter((i) => i.values instanceof Tool)
}

/** The auto-choice input of each operation of a loaded part, by index. */
function choiceInputs(
  loaded: LoadedPart,
  library: readonly LibraryItem[],
  snapshots: ProjectDoc['snapshots'],
  region2d?: Region2dPort,
): AppResult<(index: number, op?: Operation) => ChoiceInput> {
  return toGeometryInput(loaded.part, loaded.stock, region2d).map((input) => (index, op) => {
    const id = loaded.part.operations[index]!.id
    // F7: a drilling under a stepped chamfer is bored by the chamfer's end mill
    const also = input.operations.filter(
      (g) => g.kind === 'chamfer' && g.stepdown !== undefined && g.edgeOf === id,
    )
    return {
      op: op ?? loaded.part.operations[index]!,
      geometry: input.operations[index]!,
      stock: input.stock,
      units: loaded.units,
      materialClass: loaded.stock.material.class,
      library,
      snapshots,
      ...(region2d !== undefined && { region2d }),
      ...(also.length > 0 && { also }),
    }
  })
}

/**
 * The operation whose tool `op`'s auto choice takes first when it fits: a stepped chamfer's edge
 * (F7, design-v0.4.md § Stepped countersink) and a hole's counterbore's drill role
 * (design-v0.4.md § Counterbore tool); none for others.
 */
function leaderOf(part: Part, op: Operation): string | undefined {
  if (op.kind === 'chamfer' && op.stepdown.isSome()) return op.edgeOf
  if (op.kind !== 'pocket' || op.owner.isNone() || op.owner.unwrap().role !== 'counterbore')
    return undefined
  const featureId = op.owner.unwrap().featureId
  return part.operations.find((o) =>
    o.owner.mapOr(false, (w) => w.featureId === featureId && w.role === 'drill'),
  )?.id
}

/**
 * Unlocked operations following operation `index`'s tool when it fits them (`leaderOf`: stepped
 * chamfers on its mouth, F7; the counterbore of its hole). Their indices.
 */
function toolFollowers(loaded: LoadedPart, index: number): number[] {
  const id = loaded.part.operations[index]!.id
  return loaded.part.operations.flatMap((o, k) =>
    leaderOf(loaded.part, o) === id && !o.toolLocked && !readOnlyOwned(loaded, o.id) ? [k] : [],
  )
}

/** Sets the tool field of one operation in the draft (and drops a tool snapshot it no longer uses). */
function writeTool(
  draft: Draft<ProjectDoc>,
  partId: string,
  index: number,
  tool: DesignTool,
  locked: boolean | undefined,
): void {
  const dto = draft.parts[partId]!.operations[index]!
  const next = designToolToDTO(tool)
  const old = dto.tool
  if (!deepEqual(old, next)) dto.tool = next
  if (locked === true) dto.toolLocked = true
  else if (locked === false) delete dto.toolLocked
  if (old?.kind === 'specific' && old.snapshotId !== (next as { snapshotId?: string }).snapshotId)
    dropUnusedToolSnapshot(draft, old.snapshotId)
}

function opCommand(
  name: string,
  summary: string,
  title: string,
  extra: z.ZodRawShape,
  edit: (
    draft: Draft<ProjectDoc>,
    args: { partId: string; operationId: string } & Record<string, unknown>,
    loaded: LoadedPart,
    index: number,
    ctx: CommandContext,
  ) => AppResult<Operation>,
): AnyCommand {
  return defineCommand({
    kind: 'document',
    name,
    summary,
    title: () => title,
    machine: false,
    args: z.object({ ...OpArg, ...extra }),
    result: z.object({ warnings: Warnings }),
    run(draft, rawArgs, ctx) {
      const args = rawArgs as { partId: string; operationId: string } & Record<string, unknown>
      const loaded = loadPart(draft as ProjectDoc, args.partId, name)
      if (loaded.isErr()) return loaded
      const l = loaded.unwrap()
      const index = findOperation(l.part, args.operationId, undefined, name)
      if (index.isErr()) return index
      const i = index.unwrap()
      // a Clones instance follows its source operation's tool (C3)
      if (readOnlyOwned(l, args.operationId))
        return refuseOwned(l, i, name).map(() => ({ warnings: [] }))
      const op = edit(draft, args, l, i, ctx)
      if (op.isErr()) return op
      // the part as the edit left it (a tool set may also move followers along, `toolFollowers`)
      const after = loadPart(draft as ProjectDoc, args.partId, name)
      if (after.isErr()) return after
      return withWarnings({}, after.unwrap(), after.unwrap().part.operations, ctx, name)
    },
  })
}

const toolSet = opCommand(
  'design.operation.tool.set',
  "Choose an operation's tool (generalized or a library tool, snapshot taken); locks it.",
  'Set tool',
  { tool: ToolArg },
  (draft, args, loaded, i, ctx) => {
    const where = 'design.operation.tool.set'
    const tool = toolFromArg(args['tool'] as never, draft, loaded.units, ctx, where)
    if (tool.isErr()) return tool
    writeTool(draft, args.partId, i, tool.unwrap(), true)
    // unlocked stepped chamfers (F7) and the counterbore of this hole follow when the tool fits
    const followers = toolFollowers(loaded, i)
    if (followers.length > 0) {
      const inputs = choiceInputs(loaded, [], draft.snapshots, ctx.services.region2d)
      if (inputs.isErr()) return Err(inputs.unwrapErr().withContext(where))
      const resolved = resolveDesignTool(tool.unwrap(), draft.snapshots)
      for (const k of followers)
        if (resolved.isSome() && fitOf(resolved.unwrap(), inputs.unwrap()(k)) === undefined)
          writeTool(draft, args.partId, k, tool.unwrap(), undefined)
    }
    return Ok({ ...loaded.part.operations[i]!, tool: Some(tool.unwrap()), toolLocked: true })
  },
)

const toolLock = opCommand(
  'design.operation.tool.lock',
  "Lock an operation's current tool so the auto choice never changes it.",
  'Lock tool',
  {},
  (draft, args, loaded, i) => {
    const op = loaded.part.operations[i]!
    if (op.tool.isNone())
      return fail('model.invariant', `${op.id}: no tool chosen yet`, {
        issues: [
          { path: ['operationId'], rule: 'noTool', message: 'no tool yet: apply or set one' },
        ],
        where: 'design.operation.tool.lock',
      })
    draft.parts[args.partId]!.operations[i]!.toolLocked = true
    return Ok({ ...op, toolLocked: true })
  },
)

const toolUnlock = opCommand(
  'design.operation.tool.unlock',
  "Unlock an operation's tool; it is kept if it fits, else replaced on the next Apply.",
  'Unlock tool',
  {},
  (draft, args, loaded, i) => {
    delete draft.parts[args.partId]!.operations[i]!.toolLocked
    return Ok({ ...loaded.part.operations[i]!, toolLocked: false })
  },
)

const snapshotUpdate = defineCommand({
  kind: 'document',
  name: 'design.snapshot.update',
  summary: "Update a design tool or stock snapshot to its library item's current values.",
  title: () => 'Update from library',
  machine: false,
  args: z.object({ snapshotId: z.string().min(1).max(128) }),
  result: z.object({ warnings: Warnings }),
  run(draft, args, ctx) {
    const where = 'design.snapshot.update'
    const malformed = (rule: string, message: string) =>
      fail('input.malformed', `snapshot ${args.snapshotId}: ${message}`, {
        issues: [{ path: ['snapshotId'], rule, message }],
        where,
      })
    const dto = Object.hasOwn(draft.snapshots, args.snapshotId)
      ? draft.snapshots[args.snapshotId]
      : undefined
    if (dto === undefined) return malformed('unknownSnapshot', 'no such snapshot')
    if (dto.kind === 'machine') return malformed('snapshotKind', 'not a tool or stock snapshot')
    // a part's own stock follows no library item (DF13)
    if (dto.libraryItemId === undefined)
      return malformed('ownStock', "the stock is the project's own, not from the library")
    const library = ctx.services.library
    if (library === undefined)
      return fail('internal.unexpected', 'no library service configured', { where })
    const found = library.lookup(dto.kind, dto.libraryItemId)
    if (found.state !== 'found')
      return malformed(
        found.state === 'missing' ? 'unknownItem' : 'unreadableItem',
        `library item ${dto.libraryItemId} ${found.state === 'missing' ? 'no longer exists' : 'does not load'}`,
      )
    if (!deepEqual(dto.values, found.item.values.toDTO())) {
      const next = Snapshot.fromDTO(dto as never).andThen((s) =>
        refreshSnapshot(s, found.item, new Date(ctx.clock.now()).toISOString()),
      )
      if (next.isErr()) return Err(next.unwrapErr().withContext(where))
      draft.snapshots[args.snapshotId] = next.unwrap().toDTO()
    }
    // the warnings of every part that uses it
    const warnings: DfmWarning[] = []
    for (const part of Object.values(draft.parts)) {
      const uses =
        part.stock === args.snapshotId ||
        part.operations.some(
          (o) => o.tool?.kind === 'specific' && o.tool.snapshotId === args.snapshotId,
        )
      if (!uses) continue
      const loaded = loadPart(draft as ProjectDoc, part.id, where)
      if (loaded.isErr()) return loaded
      const l = loaded.unwrap()
      const w = withWarnings({}, l, l.part.operations, ctx, where)
      if (w.isErr()) return w
      warnings.push(...w.unwrap().warnings)
    }
    return Ok({ warnings })
  },
})

// ── candidates ────────────────────────────────────────────────────────────────────────────

/** A library tool as the tool field lists it: what tells tools apart at a glance. */
const LibraryToolEntry = {
  toolLibraryItemId: z.string(),
  name: z.string(),
  type: z.enum(TOOL_TYPES).describe('Tool type (the tool picker shows its icon)'),
  diameter: z.number().describe('mm'),
  cornerRadius: z.number().optional().describe('mm, bull nose only'),
  fluteCount: z.number(),
  fluteLength: z.number().describe('mm (LCF)'),
}

const CandidatesResult = z.object({
  fitting: z
    .array(z.object({ ...LibraryToolEntry, reasons: z.array(z.string()) }))
    .describe('Fitting library tools in auto-choice order'),
  unfitting: z
    .array(
      z.object({
        ...LibraryToolEntry,
        rule: z
          .string()
          .describe('The failed fit rule (never `type`); `flutes`: shorter than the wall depth'),
        detail: z.string(),
        depth: z.number().optional().describe('mm, rules reach and flutes: the depth judged'),
      }),
    )
    .describe(
      'Library tools of a type that can make the operation but failing another fit rule, nearest ' +
        'in diameter to the current (else the generalized) tool first; design.operation.tool.set ' +
        'takes them too (it locks; dfm.toolUnfit then says what does not fit)',
    ),
  nearMatch: z
    .string()
    .nullable()
    .describe(
      'For a generalized current tool no library tool matches (dfm.toolNotInLibrary): the id of ' +
        'the library tool of its type nearest in diameter (within 20 %), offered, never taken ' +
        'automatically; null otherwise',
    ),
  generalized: DesignToolDtoSchema.nullable().describe('The generalized tool auto would pick'),
  current: z
    .object({
      tool: DesignToolDtoSchema,
      locked: z.boolean(),
      fits: z.boolean(),
      rule: z.string().optional().describe('The failed fit rule'),
      detail: z.string().optional(),
    })
    .nullable()
    .describe('The current tool and its fit; null: none chosen yet'),
})

/** The listed values of a library tool (canonical mm). */
function entryOf(item: LibraryItem, tool: Tool) {
  return {
    toolLibraryItemId: item.id,
    name: tool.name,
    type: tool.type,
    diameter: tool.diameter.canonical,
    ...(tool.cornerRadius.isSome() && { cornerRadius: tool.cornerRadius.unwrap().canonical }),
    fluteCount: tool.fluteCount.canonical,
    fluteLength: tool.fluteLength.canonical,
  }
}

const toolCandidates = defineQuery({
  name: 'design.tool.candidates',
  summary:
    "The tools that can make an operation (the tool field's list), the library tools of its " +
    'type that do not fit, the near match of a generalized tool, and the current one.',
  args: z.object(OpArg),
  result: CandidatesResult,
  run(doc, args, ctx) {
    const where = 'design.tool.candidates'
    const loaded = loadPart(doc, args.partId, where)
    if (loaded.isErr()) return loaded
    const l = loaded.unwrap()
    const index = findOperation(l.part, args.operationId, undefined, where)
    if (index.isErr()) return index
    const inputs = choiceInputs(l, toolItems(ctx), doc.snapshots, ctx.services.region2d)
    if (inputs.isErr()) return Err(inputs.unwrapErr().withContext(where))
    const input = inputs.unwrap()(index.unwrap())
    const g = generalizedChoice(input)
    const op = input.op
    let current: z.output<typeof CandidatesResult>['current'] = null
    const resolved = op.tool.andThen((t) => resolveDesignTool(t, doc.snapshots))
    if (op.tool.isSome()) {
      const unfit = resolved.isSome() ? fitOf(resolved.unwrap(), input) : undefined
      current = {
        tool: designToolToDTO(op.tool.unwrap()),
        locked: op.toolLocked,
        fits: resolved.isSome() && unfit === undefined,
        ...(unfit === undefined ? {} : { rule: unfit.rule, detail: unfit.detail }),
      }
    }
    const own = op.tool.isSome() ? op.tool.unwrap() : undefined
    const near =
      own?.kind === 'generalized'
        ? nearLibraryTool(own, input)
            .map((i) => i.id)
            .into()
        : undefined
    // nearest to the current tool, else to the one auto would pick
    const reference = resolved.isSome()
      ? resolved.unwrap().diameter
      : g.isSome()
        ? g.unwrap().diameter.canonical
        : undefined
    return Ok({
      fitting: fittingLibraryTools(input).map((c) => ({
        ...entryOf(c.item, c.tool),
        reasons: [...c.reasons],
      })),
      unfitting: unfitLibraryTools(input, reference).map((m) => ({
        ...entryOf(m.item, m.tool),
        rule: m.unfit.rule,
        detail: m.unfit.detail,
        ...(typeof m.unfit.values['depth'] === 'number' && { depth: m.unfit.values['depth'] }),
      })),
      nearMatch: near ?? null,
      generalized: g.isSome() ? designToolToDTO(g.unwrap()) : null,
      current,
    })
  },
})

// ── auto choice (apply hook) ─────────────────────────────────────────────────────────────

/**
 * The auto choice of every unlocked operation with a pending change (a new part or a changed
 * stock: all of the part's operations; a shape: the operations using it), on the Apply draft (design-v0.2.md § Auto choice). Keeps a tool that fits;
 * otherwise writes the first fitting library tool (snapshot taken) or the largest fitting
 * generalized tool; nothing fits: keeps the current one. Returns one `ToolChange` per replaced or
 * first chosen tool (`from: null`, reason `unset`). A part that does not load fails the Apply.
 */
export function autoChooseTools(
  draft: Draft<ProjectDoc>,
  pending: readonly Pick<PendingChange, 'kind' | 'partId' | 'operationId' | 'shapeId' | 'field'>[],
  ctx: CommandContext,
): AppResult<ToolChange[]> {
  // per part: the operations a change is an input of (a new part or a changed stock: all; a
  // shape: the operations using it)
  const targets = new Map<string, Set<string>>()
  for (const p of pending) {
    if (p.kind !== 'design' || p.partId === undefined || !Object.hasOwn(draft.parts, p.partId))
      continue
    const t = targets.get(p.partId) ?? new Set<string>()
    for (const id of designChangeTargets(draft.parts[p.partId]!, p)) t.add(id)
    if (t.size > 0) targets.set(p.partId, t)
  }
  const where = 'design.toolAutoChoice'
  const library = toolItems(ctx)
  const changes: ToolChange[] = []
  for (const [partId, ids] of targets) {
    if (!Object.hasOwn(draft.parts, partId)) continue
    const loaded = loadPart(draft as ProjectDoc, partId, where)
    if (loaded.isErr()) return loaded
    const l = loaded.unwrap()
    const inputs = choiceInputs(l, library, draft.snapshots, ctx.services.region2d)
    if (inputs.isErr()) return Err(inputs.unwrapErr().withContext(where))
    // tools written by this pass, by operation id (a follower takes its leader's, `leaderOf`)
    const written = new Map<string, DesignTool>()
    for (const i of leadersFirst(l.part)) {
      const op = l.part.operations[i]!
      // a follower is chosen with its leader and takes the leader's tool when it fits
      const leader = leaderOf(l.part, op)
      const target = ids.has(op.id) || (leader !== undefined && ids.has(leader))
      // Clones instances follow their source's tool (`design.clonesFollow` after this hook)
      if (op.toolLocked || !target || readOnlyOwned(l, op.id)) continue
      const input = inputs.unwrap()(i, op)
      const leaderTool = leader === undefined ? undefined : leaderToolOf(l, leader, written)
      const follow =
        leaderTool !== undefined &&
        resolveDesignTool(leaderTool, draft.snapshots).mapOr(
          false,
          (t) => fitOf(t, input) === undefined,
        )
      const choice = follow ? undefined : chooseTool(input)
      if (choice !== undefined && (choice.kind === 'keep' || choice.kind === 'none')) continue
      let to: DesignTool
      if (choice === undefined) {
        to = leaderTool!
        if (op.tool.isSome() && deepEqual(designToolToDTO(op.tool.unwrap()), designToolToDTO(to)))
          continue
      } else if (choice.kind === 'library') {
        const id = toolSnapshotFor(draft, choice.candidate.item, ctx)
        if (id.isErr()) return Err(id.unwrapErr().withContext(where))
        to = { kind: 'specific', snapshotId: id.unwrap() }
      } else to = choice.tool
      const from: DesignToolDTO | null = op.tool.isSome() ? designToolToDTO(op.tool.unwrap()) : null
      const old = op.tool.andThen((t) => resolveDesignTool(t, draft.snapshots))
      const reason =
        from === null
          ? 'unset'
          : choice === undefined
            ? op.kind === 'chamfer'
              ? 'followsEdge'
              : 'followsHole'
            : old.isNone()
              ? 'unresolved'
              : (fitOf(old.unwrap(), input)?.rule ??
                // X2 F6: a fitting tool removed from the library gave way to a library tool
                (orphanTool(input)
                  ? 'libraryRemoved'
                  : // DF54: a fitting generalized tool gave way to a library tool
                    'libraryFits'))
      writeTool(draft, partId, i, to, undefined)
      written.set(op.id, to)
      changes.push({ partId, operationId: op.id, from, to: designToolToDTO(to), reason })
    }
  }
  return Ok(changes)
}

/**
 * Operation indices in design order, except that a follower whose leader comes later (a
 * counterbore before its hole's drill role) comes right after its leader (`leaderOf`).
 */
function leadersFirst(part: Part): number[] {
  const at = new Map(part.operations.map((o, i) => [o.id, i]))
  const waiting = new Map<number, number[]>()
  const out: number[] = []
  part.operations.forEach((op, i) => {
    const leader = at.get(leaderOf(part, op) ?? '')
    if (leader !== undefined && leader > i) waiting.set(leader, [...(waiting.get(leader) ?? []), i])
    else out.push(i)
    out.push(...(waiting.get(i) ?? []))
  })
  return out
}

/** The tool of a follower's leader operation: as this pass wrote it, else as stored. */
function leaderToolOf(
  l: LoadedPart,
  leader: string,
  written: ReadonlyMap<string, DesignTool>,
): DesignTool | undefined {
  const w = written.get(leader)
  if (w !== undefined) return w
  const op = l.part.operations.find((o) => o.id === leader)
  return op !== undefined && op.tool.isSome() ? op.tool.unwrap() : undefined
}

/** Cached dry runs of `rechoices`: by the document's parts, then compared by reference. */
const rechoiceCache = new WeakMap<
  object,
  {
    snapshots: object
    library: readonly LibraryItem[]
    region2d: unknown
    changes: readonly ToolChange[]
  }
>()

/** A context for a dry run: its snapshot ids and times are thrown away with the draft. */
function dryContext(services: CommandContext['services']): CommandContext {
  let n = 0
  return {
    source: { kind: 'system', id: 'design.toolRechoice' },
    ids: { next: (prefix) => `${prefix}-rechoice-${++n}` },
    clock: { now: () => 0 },
    services,
  }
}

/**
 * The tool changes Apply would make if every operation of every part were pending: a dry run of
 * the auto choice on a throw-away draft (its snapshots are dropped with it). Cached per (parts,
 * snapshots, library tool items, 2D port) by reference. A part that does not load gives none
 * (its commands report it).
 */
function rechoices(doc: ProjectDoc, services: CommandContext['services']): readonly ToolChange[] {
  const library = toolItems({ services })
  const hit = rechoiceCache.get(doc.parts)
  if (
    hit !== undefined &&
    hit.snapshots === doc.snapshots &&
    hit.region2d === services.region2d &&
    hit.library.length === library.length &&
    hit.library.every((item, i) => item === library[i])
  )
    return hit.changes
  const all: PendingChange[] = Object.values(doc.parts).flatMap((part) =>
    part.operations.map((op) => ({
      kind: 'design' as const,
      partId: part.id,
      operationId: op.id,
      field: 'tool',
      label: '',
    })),
  )
  let changes: readonly ToolChange[] = []
  if (all.length > 0)
    produce(doc, (draft) => {
      changes = autoChooseTools(draft, all, dryContext(services)).unwrapOr([])
    })
  rechoiceCache.set(doc.parts, {
    snapshots: doc.snapshots,
    library,
    region2d: services.region2d,
    changes,
  })
  return changes
}

/**
 * `design.toolRechoice` (X2 F6, docs/modes/design-v0.2.md#library-changes-and-opening-x2-f6): an
 * unlocked operation whose tool the auto choice would change is pending (key field `tool`), so a
 * library change (tool added, edited, removed) or opening a project re-chooses it on the next
 * Apply. Derived on every pending read; an operation Apply already targets through a design key
 * (its own field, stock, shape, feature, or its leader's) gets none, nor one the choice keeps or
 * nothing fits.
 */
export const toolRechoicePending: PendingSource = {
  name: 'design.toolRechoice',
  changes(doc, _baseline, design, ctx) {
    const changes = rechoices(doc, ctx.services)
    if (changes.length === 0) return []
    // per part: the operations Apply already chooses for
    const targeted = new Map<string, Set<string>>()
    for (const c of design) {
      if (c.kind !== 'design' || c.partId === undefined || !Object.hasOwn(doc.parts, c.partId))
        continue
      const t = targeted.get(c.partId) ?? new Set<string>()
      for (const id of designChangeTargets(doc.parts[c.partId]!, c)) t.add(id)
      targeted.set(c.partId, t)
    }
    const out: PendingChange[] = []
    for (const change of changes) {
      const part = Object.hasOwn(doc.parts, change.partId) ? doc.parts[change.partId] : undefined
      const op = part?.operations.find((o) => o.id === change.operationId)
      if (op === undefined) continue
      const t = targeted.get(change.partId)
      if (t !== undefined && (t.has(op.id) || followsTargeted(doc, change.partId, op.id, t)))
        continue
      out.push({
        kind: 'design',
        partId: change.partId,
        operationId: op.id,
        field: 'tool',
        label: `${op.name}: tool`,
      })
    }
    return out
  },
}

/** Whether operation `id` follows the tool of an operation in `targeted` (`leaderOf`). */
function followsTargeted(
  doc: ProjectDoc,
  partId: string,
  id: string,
  targeted: ReadonlySet<string>,
): boolean {
  const loaded = loadPart(doc, partId, 'design.toolRechoice')
  if (loaded.isErr()) return false
  const part = loaded.unwrap().part
  const op = part.operations.find((o) => o.id === id)
  const leader = op === undefined ? undefined : leaderOf(part, op)
  return leader !== undefined && targeted.has(leader)
}

/** `design.toolAutoChoice`, the first apply hook (apply.md § Apply hooks). */
export const designToolAutoChoice: ApplyHook = {
  name: 'design.toolAutoChoice',
  apply: (draft, pending, ctx) =>
    autoChooseTools(draft, pending, ctx).map((toolChanges) => ({ toolChanges })),
}

export const DESIGN_TOOL_COMMANDS: readonly AnyCommand[] = [
  toolSet,
  toolLock,
  toolUnlock,
  snapshotUpdate,
]
export const DESIGN_TOOL_QUERIES: readonly QueryDef[] = [toolCandidates]
