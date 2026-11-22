/**
 * Patch-based execution of document commands and the linear undo/redo history.
 * Doc: docs/architecture/commands.md#undo--redo
 *
 * Immer setup (decided with the implementation, see the doc's "Immer configuration"):
 * - a dedicated `Immer` instance, so no other code's global Immer settings affect the document;
 * - `enablePatches()` (process-global plugin registration, idempotent);
 * - auto-freeze ON: committed documents are deeply frozen, so effect/job snapshots, replicas and
 *   history can never be mutated by accident. Cost: freezing new subtrees on each commit.
 */
import { enablePatches, freeze, Immer, isDraft, type Patch } from 'immer'
import { z } from 'zod'
import { parseArgs } from './args'
import { Err, fail, Ok, tryCatch, type AppResult } from '../../shared/result'
import type { ProjectDoc } from '../project/document'
import type { CommandContext, Source } from './context'
import {
  defineQuery,
  type ApplyContribution,
  type ApplyHook,
  type BuiltinCommand,
  type DocumentCommand,
  type DocumentHook,
} from './define'
import type { PendingChange } from './apply'

enablePatches()
const immer = new Immer({ autoFreeze: true })

export type { Patch }

export interface DocumentRun<R> {
  readonly result: AppResult<R>
  /** The committed document; the input `doc` itself on `Err` or when nothing changed. */
  readonly next: ProjectDoc
  readonly patches: readonly Patch[]
  readonly inversePatches: readonly Patch[]
}

/**
 * Runs a document handler on a draft, then the document hooks on the same draft. `Err` (or a
 * stray throw → `internal.unexpected`) of either drops the draft: no partial patches. Args must
 * already be parsed.
 */
export function executeDocumentCommand<S extends z.ZodType, R, P = unknown>(
  doc: ProjectDoc,
  def: DocumentCommand<S, R, P>,
  args: z.output<S>,
  ctx: CommandContext,
  hooks: readonly DocumentHook[] = [],
  prepared?: P,
): DocumentRun<R> {
  const draft = immer.createDraft(doc)
  const ran = tryCatch(
    () => {
      const r = def.run(draft, args, ctx, prepared as P)
      if (r.isErr()) return r
      for (const hook of hooks) {
        const h = hook.after(draft, { name: def.name, args }, ctx)
        if (h.isErr()) return Err(h.unwrapErr().withContext(`hook ${hook.name}`))
      }
      return r
    },
    'internal.unexpected',
    `${def.name} threw`,
  )
  const result = ran.isOk() ? ran.unwrap() : Err(ran.unwrapErr())
  if (result.isErr()) return { result, next: doc, patches: [], inversePatches: [] }
  // Draft proxies are revoked by finishDraft: a result holding one would poison the log.
  if (containsDraft(result.unwrap()))
    return {
      result: fail('internal.unexpected', `${def.name} returned an Immer draft in its result`, {
        where: def.name,
      }),
      next: doc,
      patches: [],
      inversePatches: [],
    }
  let patches: Patch[] = []
  let inversePatches: Patch[] = []
  const next = immer.finishDraft(draft, (p, ip) => {
    patches = p
    inversePatches = ip
  }) as ProjectDoc
  // Frozen once, then shared read-only by history, log events and subscribers.
  return {
    result,
    next,
    patches: freeze(patches, true),
    inversePatches: freeze(inversePatches, true),
  }
}

/**
 * The document phase of `project.apply`: the apply hooks in order on one draft, with the pending
 * set (docs/architecture/apply.md#steps). `Err` or a throw of any hook drops the draft.
 */
export function executeApplyHooks(
  doc: ProjectDoc,
  hooks: readonly ApplyHook[],
  pending: readonly PendingChange[],
  ctx: CommandContext,
): DocumentRun<ApplyContribution[]> {
  const draft = immer.createDraft(doc)
  const ran = tryCatch(
    (): AppResult<ApplyContribution[]> => {
      const out: ApplyContribution[] = []
      for (const hook of hooks) {
        const h = hook.apply(draft, pending, ctx)
        if (h.isErr()) return Err(h.unwrapErr().withContext(`apply hook ${hook.name}`))
        const c = h.unwrap()
        if (c !== undefined) out.push(c)
      }
      return Ok(out)
    },
    'internal.unexpected',
    'project.apply: an apply hook threw',
  )
  const result = ran.isOk() ? ran.unwrap() : Err(ran.unwrapErr())
  if (result.isErr() || containsDraft(result.unwrap())) {
    return {
      result: result.isErr()
        ? result
        : fail('internal.unexpected', 'an apply hook returned an Immer draft', {
            where: 'project.apply',
          }),
      next: doc,
      patches: [],
      inversePatches: [],
    }
  }
  let patches: Patch[] = []
  let inversePatches: Patch[] = []
  const next = immer.finishDraft(draft, (p, ip) => {
    patches = p
    inversePatches = ip
  }) as ProjectDoc
  return {
    result,
    next,
    patches: freeze(patches, true),
    inversePatches: freeze(inversePatches, true),
  }
}

/** Deep check for Immer drafts in a handler result (plain objects and arrays). */
function containsDraft(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (isDraft(value)) return true
  if (seen.has(value)) return false
  seen.add(value)
  return Object.values(value).some((v) => containsDraft(v, seen))
}

/** Parses raw args with the command's schema, then executes. */
export function parseAndExecute<S extends z.ZodType, R>(
  doc: ProjectDoc,
  def: DocumentCommand<S, R>,
  rawArgs: unknown,
  ctx: CommandContext,
  hooks: readonly DocumentHook[] = [],
): DocumentRun<R> {
  const args = parseArgs(def.args, rawArgs, def.name)
  if (args.isErr())
    return { result: Err(args.unwrapErr()), next: doc, patches: [], inversePatches: [] }
  return executeDocumentCommand(doc, def, args.unwrap(), ctx, hooks)
}

/** Applies patches to a (frozen) document; a patch that does not fit is a bug. */
export function applyDocPatches(doc: ProjectDoc, patches: readonly Patch[]): AppResult<ProjectDoc> {
  return tryCatch(
    () => immer.applyPatches(doc, patches as Patch[]),
    'internal.unexpected',
    'patches do not apply to the document',
  )
}

/** One undo step. `seq` is the action-log seq of the command event that created it. */
export interface HistoryEntry {
  readonly seq: number
  readonly command: string
  readonly args: unknown
  readonly source: Source
  readonly title: string
  readonly patches: readonly Patch[]
  readonly inversePatches: readonly Patch[]
  readonly revisionBefore: number
  readonly revisionAfter: number
  readonly at: string
  /** Live-edit gesture whose steps were merged into this entry (commands.md#gestures-live-edits). */
  readonly gesture?: string
}

export interface HistoryLimits {
  /** Max undo entries kept (oldest dropped first). */
  readonly maxEntries: number
  /**
   * Max total JSON size of all undo entries (args + patches + inverse patches), in characters.
   * Oldest dropped first; the newest entry is always kept.
   */
  readonly maxChars: number
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = { maxEntries: 500, maxChars: 50_000_000 }

/** JSON size of an entry's payload; throws on unserializable data (callers wrap in tryCatch). */
export function entrySize(e: Pick<HistoryEntry, 'args' | 'patches' | 'inversePatches'>): number {
  return (
    (JSON.stringify(e.args) ?? '').length +
    JSON.stringify(e.patches).length +
    JSON.stringify(e.inversePatches).length
  )
}

interface Sized {
  readonly entry: HistoryEntry
  readonly size: number
  /**
   * Apply marker: the document after this entry, set by a successful Apply on the top entry
   * (docs/architecture/apply.md#baseline-and-undo). Moves with the entry through undo and redo.
   */
  marker?: ProjectDoc
}

/** Linear, memory-only undo/redo stacks of one project. */
export class History {
  private readonly undoStack: Sized[] = []
  private redoStack: Sized[] = []
  private totalSize = 0
  /**
   * The newest marker without an entry: of a marked entry the cap dropped, or of an Apply while
   * the undo stack was empty. The baseline when no entry on the stack is marked.
   */
  private floorMarker: ProjectDoc | undefined

  constructor(private readonly limits: HistoryLimits = DEFAULT_HISTORY_LIMITS) {}

  /** A new document commit: push and clear redo. `size` from `entrySize`, computed beforehand. */
  push(entry: HistoryEntry, size: number): void {
    this.undoStack.push({ entry, size })
    this.totalSize += size
    this.redoStack = []
    this.trim()
  }

  /**
   * A gesture step merged into the top entry (`mergeTop`'s caller checked it may merge): patches
   * appended, inverse patches prepended; args, title, revisionAfter and at from the step; seq and
   * revisionBefore kept. Clears redo like `push`; the step's size is added to the entry.
   */
  mergeTop(step: HistoryEntry, size: number): void {
    const top = this.undoStack.pop()
    if (top === undefined) return this.push(step, size)
    const e = top.entry
    const merged: HistoryEntry = {
      ...step,
      seq: e.seq,
      revisionBefore: e.revisionBefore,
      patches: freeze([...e.patches, ...step.patches], true),
      inversePatches: freeze([...step.inversePatches, ...e.inversePatches], true),
    }
    this.totalSize -= top.size
    this.push(merged, top.size + size)
  }

  /** Drops the top undo entry without keeping it for redo (a cancelled gesture). */
  discardTop(): void {
    const top = this.undoStack.pop()
    if (top !== undefined) this.totalSize -= top.size
  }

  private trim(): void {
    while (
      this.undoStack.length > this.limits.maxEntries ||
      (this.totalSize > this.limits.maxChars && this.undoStack.length > 1)
    ) {
      const dropped = this.undoStack.shift()
      if (dropped !== undefined) this.totalSize -= dropped.size
      if (dropped?.marker !== undefined) this.floorMarker = dropped.marker
    }
  }

  /** Puts the apply marker on the top undo entry (with none, it becomes the floor marker). */
  markApplied(doc: ProjectDoc): void {
    const top = this.undoStack.at(-1)
    if (top === undefined) this.floorMarker = doc
    else top.marker = doc
  }

  /** Whether the top undo entry carries an apply marker (an Apply ended its gesture). */
  topApplied(): boolean {
    return this.undoStack.at(-1)?.marker !== undefined
  }

  /**
   * The marker of the newest marked entry on the undo stack, else the floor marker; undefined
   * when there is none (the baseline is then the document at open).
   */
  baseline(): ProjectDoc | undefined {
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      const m = this.undoStack[i]?.marker
      if (m !== undefined) return m
    }
    return this.floorMarker
  }

  get undoable(): readonly HistoryEntry[] {
    return this.undoStack.map((e) => e.entry)
  }

  get redoable(): readonly HistoryEntry[] {
    return this.redoStack.map((e) => e.entry)
  }

  peekUndo(): HistoryEntry | undefined {
    return this.undoStack.at(-1)?.entry
  }

  peekRedo(): HistoryEntry | undefined {
    return this.redoStack.at(-1)?.entry
  }

  /** Moves the top undo entry to the redo stack (after its inverse patches were applied). */
  markUndone(): void {
    const top = this.undoStack.pop()
    if (top === undefined) return
    this.totalSize -= top.size
    this.redoStack.push(top)
  }

  /** Moves the top redo entry back to the undo stack (after its patches were re-applied). */
  markRedone(): void {
    const top = this.redoStack.pop()
    if (top === undefined) return
    this.undoStack.push(top)
    this.totalSize += top.size
    this.trim()
  }
}

const HistoryStepResult = z
  .object({
    entrySeq: z
      .number()
      .int()
      .nullable()
      .describe('Seq of the undone/redone entry; null when there was nothing to do'),
  })
  .describe('History step result')
const NoArgs = z.object({})
const UndoArgs = z.object({
  gesture: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "UI only: cancel this live-edit gesture – undo only the caller's top entry of it and discard it (no redo)",
    ),
})
type HistoryStep = BuiltinCommand<typeof NoArgs, z.output<typeof HistoryStepResult>>

export const historyUndo: BuiltinCommand<typeof UndoArgs, z.output<typeof HistoryStepResult>> = {
  kind: 'builtin',
  name: 'history.undo',
  summary: 'Undo the most recent document change, whoever made it.',
  title: () => 'Undo',
  machine: false,
  args: UndoArgs,
  result: HistoryStepResult,
}

export const historyRedo: HistoryStep = {
  kind: 'builtin',
  name: 'history.redo',
  summary: 'Redo the most recently undone document change.',
  title: () => 'Redo',
  machine: false,
  args: NoArgs,
  result: HistoryStepResult,
}

const HistoryItemSchema = z.object({
  seq: z.number().int().describe('Action-log seq of the command that made the step'),
  command: z.string(),
  title: z.string(),
  source: z.object({ kind: z.string(), id: z.string() }).describe('Who made the step'),
  revisionBefore: z.number().int(),
  revisionAfter: z.number().int(),
  at: z.string(),
})

const historyItem = (e: HistoryEntry): z.output<typeof HistoryItemSchema> => ({
  seq: e.seq,
  command: e.command,
  title: e.title,
  source: { kind: e.source.kind, id: e.source.id },
  revisionBefore: e.revisionBefore,
  revisionAfter: e.revisionAfter,
  at: e.at,
})

/**
 * `history.list`: the undo and redo stacks, top first, so an agent sees whose step it would undo
 * (docs/architecture/llm-api.md#undo-and-history). Reads dispatcher state, not the document.
 */
export const historyList = defineQuery({
  name: 'history.list',
  summary: 'List the undo and redo stacks, next step first, with who made each step.',
  args: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(20)
      .describe('Max entries per stack (default 20)'),
  }),
  result: z.object({
    undo: z.array(HistoryItemSchema).describe('history.undo undoes the first entry'),
    redo: z.array(HistoryItemSchema).describe('history.redo redoes the first entry'),
  }),
  readsDocument: false,
  run(_doc, args, ctx) {
    const h = ctx.history
    if (h === undefined)
      return fail('internal.unexpected', 'no history (query run outside a dispatcher)', {
        where: 'history.list',
      })
    const top = (entries: readonly HistoryEntry[]) =>
      [...entries].reverse().slice(0, args.limit).map(historyItem)
    return Ok({ undo: top(h.undoable), redo: top(h.redoable) })
  },
})
