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
import { enablePatches, Immer, type Patch } from 'immer'
import { z } from 'zod'
import { parseWith } from '../../shared/parse'
import { Err, tryCatch, type AppResult } from '../../shared/result'
import type { ProjectDoc } from '../project/document'
import type { CommandContext, Source } from './context'
import type { BuiltinCommand, DocumentCommand } from './define'

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
 * Runs a document handler on a draft. `Err` (or a stray throw → `internal.unexpected`) drops the
 * draft: no partial patches. Args must already be parsed.
 */
export function executeDocumentCommand<S extends z.ZodType, R>(
  doc: ProjectDoc,
  def: DocumentCommand<S, R>,
  args: z.output<S>,
  ctx: CommandContext,
): DocumentRun<R> {
  const draft = immer.createDraft(doc)
  const ran = tryCatch(() => def.run(draft, args, ctx), 'internal.unexpected', `${def.name} threw`)
  const result = ran.isOk() ? ran.unwrap() : Err(ran.unwrapErr())
  if (result.isErr()) return { result, next: doc, patches: [], inversePatches: [] }
  let patches: Patch[] = []
  let inversePatches: Patch[] = []
  const next = immer.finishDraft(draft, (p, ip) => {
    patches = p
    inversePatches = ip
  }) as ProjectDoc
  return { result, next, patches, inversePatches }
}

/** Parses raw args with the command's schema, then executes. */
export function parseAndExecute<S extends z.ZodType, R>(
  doc: ProjectDoc,
  def: DocumentCommand<S, R>,
  rawArgs: unknown,
  ctx: CommandContext,
): DocumentRun<R> {
  const args = parseWith(def.args, rawArgs, def.name)
  if (args.isErr())
    return { result: Err(args.unwrapErr()), next: doc, patches: [], inversePatches: [] }
  return executeDocumentCommand(doc, def, args.unwrap(), ctx)
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
}

export interface HistoryLimits {
  /** Max undo entries kept (oldest dropped first). */
  readonly maxEntries: number
  /** Max total JSON size of all entries' patches, in characters (oldest dropped first). */
  readonly maxPatchChars: number
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = { maxEntries: 500, maxPatchChars: 50_000_000 }

function entrySize(e: HistoryEntry): number {
  return JSON.stringify(e.patches).length + JSON.stringify(e.inversePatches).length
}

/** Linear, memory-only undo/redo stacks of one project. */
export class History {
  private readonly undoStack: { entry: HistoryEntry; size: number }[] = []
  private redoStack: HistoryEntry[] = []
  private totalSize = 0

  constructor(private readonly limits: HistoryLimits = DEFAULT_HISTORY_LIMITS) {}

  /** A new document commit: push and clear redo. */
  push(entry: HistoryEntry): void {
    const size = entrySize(entry)
    this.undoStack.push({ entry, size })
    this.totalSize += size
    this.redoStack = []
    while (
      this.undoStack.length > this.limits.maxEntries ||
      (this.totalSize > this.limits.maxPatchChars && this.undoStack.length > 0)
    ) {
      const dropped = this.undoStack.shift()
      if (dropped !== undefined) this.totalSize -= dropped.size
    }
  }

  get undoable(): readonly HistoryEntry[] {
    return this.undoStack.map((e) => e.entry)
  }

  get redoable(): readonly HistoryEntry[] {
    return [...this.redoStack]
  }

  peekUndo(): HistoryEntry | undefined {
    return this.undoStack.at(-1)?.entry
  }

  peekRedo(): HistoryEntry | undefined {
    return this.redoStack.at(-1)
  }

  /** Moves the top undo entry to the redo stack (after its inverse patches were applied). */
  markUndone(): void {
    const top = this.undoStack.pop()
    if (top === undefined) return
    this.totalSize -= top.size
    this.redoStack.push(top.entry)
  }

  /** Moves the top redo entry back to the undo stack (after its patches were re-applied). */
  markRedone(): void {
    const top = this.redoStack.pop()
    if (top === undefined) return
    const size = entrySize(top)
    this.undoStack.push({ entry: top, size })
    this.totalSize += size
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
type HistoryStep = BuiltinCommand<typeof NoArgs, z.output<typeof HistoryStepResult>>

export const historyUndo: HistoryStep = {
  kind: 'builtin',
  name: 'history.undo',
  summary: 'Undo the most recent document change, whoever made it.',
  title: () => 'Undo',
  machine: false,
  args: NoArgs,
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
