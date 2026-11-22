/**
 * Operation tool field (v0.2): `design.operation.tool.set/lock/unlock`, `design.snapshot.update`,
 * the `design.tool.candidates` query and the auto choice as the apply hook
 * `design.toolAutoChoice` (registered in `APPLY_HOOKS`), and the tool part of the consistency scan
 * on open.
 * Doc: docs/modes/design-v0.2.md#operation-tool, docs/modes/design-v0.2.md#commands-and-queries-v02,
 * docs/architecture/apply.md#apply-hooks
 */
import type { Draft } from 'immer'
import { z } from 'zod'
import { Err, fail, Ok, Some, type AppResult } from '../../shared/result'
import type { PendingChange, ToolChange } from '../commands/apply'
import type { CommandContext } from '../commands/context'
import {
  defineCommand,
  defineQuery,
  type AnyCommand,
  type ApplyHook,
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
import type { Operation } from './operation'
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
  resolveDesignTool,
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
  return toGeometryInput(loaded.part, loaded.stock, region2d).map((input) => (index, op) => ({
    op: op ?? loaded.part.operations[index]!,
    geometry: input.operations[index]!,
    stock: input.stock,
    units: loaded.units,
    materialClass: loaded.stock.material.class,
    library,
    snapshots,
    ...(region2d !== undefined && { region2d }),
  }))
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
      const ops = l.part.operations.map((o, k) => (k === i ? op.unwrap() : o))
      return withWarnings({}, l, ops, ctx, name)
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

const CandidatesResult = z.object({
  fitting: z
    .array(
      z.object({
        toolLibraryItemId: z.string(),
        name: z.string(),
        type: z.enum(TOOL_TYPES).describe('Tool type (the tool picker shows its icon)'),
        diameter: z.number().describe('mm'),
        reasons: z.array(z.string()),
      }),
    )
    .describe('Fitting library tools in auto-choice order'),
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

const toolCandidates = defineQuery({
  name: 'design.tool.candidates',
  summary: "The tools that can make an operation (the tool field's list) and the current one.",
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
    if (op.tool.isSome()) {
      const resolved = resolveDesignTool(op.tool.unwrap(), doc.snapshots)
      const unfit = resolved.isSome() ? fitOf(resolved.unwrap(), input) : undefined
      current = {
        tool: designToolToDTO(op.tool.unwrap()),
        locked: op.toolLocked,
        fits: resolved.isSome() && unfit === undefined,
        ...(unfit === undefined ? {} : { rule: unfit.rule, detail: unfit.detail }),
      }
    }
    return Ok({
      fitting: fittingLibraryTools(input).map((c) => ({
        toolLibraryItemId: c.item.id,
        name: c.tool.name,
        type: c.tool.type,
        diameter: c.tool.diameter.canonical,
        reasons: [...c.reasons],
      })),
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
    for (const [i, op] of l.part.operations.entries()) {
      // Clones instances follow their source's tool (`design.clonesFollow` after this hook)
      if (op.toolLocked || !ids.has(op.id) || readOnlyOwned(l, op.id)) continue
      const input = inputs.unwrap()(i, op)
      const choice = chooseTool(input)
      if (choice.kind === 'keep' || choice.kind === 'none') continue
      let to: DesignTool
      if (choice.kind === 'library') {
        const id = toolSnapshotFor(draft, choice.candidate.item, ctx)
        if (id.isErr()) return Err(id.unwrapErr().withContext(where))
        to = { kind: 'specific', snapshotId: id.unwrap() }
      } else to = choice.tool
      const from: DesignToolDTO | null = op.tool.isSome() ? designToolToDTO(op.tool.unwrap()) : null
      const old = op.tool.andThen((t) => resolveDesignTool(t, draft.snapshots))
      const reason =
        from === null
          ? 'unset'
          : old.isNone()
            ? 'unresolved'
            : (fitOf(old.unwrap(), input)?.rule ?? 'unfit')
      writeTool(draft, partId, i, to, undefined)
      changes.push({ partId, operationId: op.id, from, to: designToolToDTO(to), reason })
    }
  }
  return Ok(changes)
}

/**
 * The tool part of the consistency scan on open (docs/architecture/apply.md#opening-and-recovery):
 * every unlocked operation whose tool is absent or does not fit is pending (key field `tool`),
 * so the next Apply chooses it. A part that does not load is left out (its commands report it).
 */
export function toolScan(
  doc: ProjectDoc,
  ctx: { services: CommandContext['services'] },
): PendingChange[] {
  const library = toolItems(ctx)
  const out: PendingChange[] = []
  for (const partId of Object.keys(doc.parts)) {
    const loaded = loadPart(doc, partId, 'project.open')
    if (loaded.isErr()) continue
    const l = loaded.unwrap()
    const inputs = choiceInputs(l, library, doc.snapshots, ctx.services.region2d)
    if (inputs.isErr()) continue
    for (const [i, op] of l.part.operations.entries()) {
      if (op.toolLocked || readOnlyOwned(l, op.id)) continue
      const tool = op.tool.andThen((t) => resolveDesignTool(t, doc.snapshots))
      if (tool.isSome() && fitOf(tool.unwrap(), inputs.unwrap()(i, op)) === undefined) continue
      out.push({
        kind: 'design',
        partId,
        operationId: op.id,
        field: 'tool',
        label: `${op.name}: tool`,
      })
    }
  }
  return out
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
