/**
 * `ProjectStorage` port, the per-project `ProjectSession` used by `project.save`, and the
 * app-level recovery operations. Doc: docs/architecture/persistence.md#files
 *
 * Headless: src/main/persistence implements the port; adapters (UI, MCP, CLI) call the
 * operations here, so the confirmation rule for discarding lives in one place.
 */
import type { Patch } from 'immer'
import { z } from 'zod'
import { parseWith } from '../../shared/parse'
import { Err, fail, type AppResult, type AsyncAppResult } from '../../shared/result'
import type { HistoryView } from '../commands/context'
import type { Dispatcher } from '../commands/dispatcher'
import type { AssetRef } from './assets'
import type { ProjectDoc } from './document'

export interface SaveOutcome {
  readonly filePath: string
  readonly revision: number
  readonly savedAt: string
  readonly sha256: string
  /** Steps after the replace that failed (save history, state.json); the save itself succeeded. */
  readonly warnings: readonly string[]
}

export interface SaveOptions {
  /** Save As: a `.dfyom` path; omit to save to the current file. */
  readonly target?: string
  /** Required to replace an existing file that is not this project's file. */
  readonly confirm?: boolean
}

/** Project folder key: `<project id>` or `<project id>~<n>` – never a path. */
export const PROJECT_KEY = /^[A-Za-z0-9_-]{1,128}(~\d{1,6})?$/

export function isProjectKey(key: string): boolean {
  return PROJECT_KEY.test(key)
}

/** `.dfyom`, case-insensitive. */
export function isProjectFileName(path: string): boolean {
  return /\.dfyom$/i.test(path)
}

/** One open project's persistence; injected as `ctx.services.project`. */
export interface ProjectSession {
  /** Project folder key (`<id>` or `<id>~2`, …). */
  readonly key: string
  readonly projectId: string
  /** `null` until the first save of an untitled project. */
  readonly filePath: string | null
  readonly dirty: boolean
  /** Records a commit; the working folder is written debounced. Never throws. */
  changed(patches: readonly Patch[], doc: ProjectDoc, revision: number): void
  /** Writes pending changes to the working folder now. */
  flush(): AsyncAppResult<void>
  /** Flush, build, verify and replace; `target` = Save As. */
  save(doc: ProjectDoc, opts?: SaveOptions): AsyncAppResult<SaveOutcome>
  /**
   * Copies a local file into the working folder's `assets/` (hashed while copying, atomic);
   * the same content is stored once. Records then name the returned path
   * (docs/architecture/persistence.md#assets-and-references-v02). A source that is not a
   * readable regular file, or is larger than `maxBytes`, is `input.malformed` (rules
   * `unreadableFile`, `tooLarge`) and nothing is stored.
   */
  importAsset(source: string, opts?: { readonly maxBytes?: number }): AsyncAppResult<AssetRef>
  /** Absolute path of a stored asset (`assets/<sha256>.stl`), e.g. for the parser to read. */
  assetFile(path: string): AppResult<string>
  /** The dispatcher's undo/redo stacks: save keeps the assets their entries name. */
  useHistory(history: () => HistoryView): void
}

export interface OpenedProject {
  readonly session: ProjectSession
  readonly doc: ProjectDoc
  /** Start the dispatcher at this revision, with an empty undo history. */
  readonly revision: number
}

export interface RecoverableProject {
  readonly key: string
  readonly projectId: string
  /** `null` for a never-saved project. */
  readonly filePath: string | null
  readonly workingRevision: number
  readonly savedRevision: number | null
}

export type OpenOutcome =
  | { readonly kind: 'opened'; readonly project: OpenedProject }
  /** The working folder holds unsaved changes: resolve with `recover` first. */
  | { readonly kind: 'recoverable'; readonly recoverable: RecoverableProject }

export type RecoveryAction = 'restore' | 'discard'

export interface ProjectStorage {
  /** A new, untitled project (working folder and lock, no project file yet). */
  create(doc: ProjectDoc): AsyncAppResult<OpenedProject>
  /** `persist.locked` if another live instance has it open. */
  open(filePath: string): AsyncAppResult<OpenOutcome>
  /** Projects with unsaved changes in their working folder and no live lock. */
  listRecoverable(): AsyncAppResult<readonly RecoverableProject[]>
  /**
   * `restore`: open the working folder as a dirty project. `discard`: delete the working folder,
   * then open the project file (`undefined` for an untitled project). Callers confirm first:
   * use `resolveRecovery`.
   */
  recover(key: string, action: RecoveryAction): AsyncAppResult<OpenedProject | undefined>
  /** Flushes, stops the heartbeat and releases the lock; unsaved changes stay recoverable. */
  close(key: string): AsyncAppResult<void>
}

// ---------------------------------------------------------------------------
// App-level operations (no project dispatcher exists yet when they run)

export const RecoverArgsSchema = z.object({
  key: z
    .string()
    .regex(PROJECT_KEY, 'not a project folder key')
    .describe('Project folder key from project.recovery.list'),
  action: z.enum(['restore', 'discard']).describe('Restore the unsaved changes or discard them'),
  confirm: z
    .boolean()
    .default(false)
    .describe('Must be true to discard: deletes the unsaved changes for good'),
})

/** `project.recovery.list`: projects with unsaved changes left by a crash or close. */
export function listRecovery(
  storage: ProjectStorage,
): AsyncAppResult<readonly RecoverableProject[]> {
  return storage.listRecoverable()
}

/** `project.recovery.resolve`: discarding deletes data, so it needs `confirm: true`. */
export async function resolveRecovery(
  storage: ProjectStorage,
  rawArgs: unknown,
): AsyncAppResult<OpenedProject | undefined> {
  const args = parseWith(RecoverArgsSchema, rawArgs, 'project.recovery.resolve')
  if (args.isErr()) return Err(args.unwrapErr())
  const { key, action, confirm } = args.unwrap()
  if (action === 'discard' && !confirm)
    return fail('input.malformed', 'discarding unsaved changes needs confirmation', {
      where: 'project.recovery.resolve',
      issues: [
        { path: ['confirm'], rule: 'confirmRequired', message: 'set confirm: true to discard' },
      ],
    })
  return storage.recover(key, action)
}

/**
 * Feeds every commit (command, undo, redo) of a dispatcher to the session's working folder and
 * lets the session see the undo history (assets kept by save). Returns the unsubscribe function.
 */
export function attachSession(dispatcher: Dispatcher, session: ProjectSession): () => void {
  session.useHistory(() => dispatcher.history)
  return dispatcher.log.subscribe({ withPatches: true }, (e) => {
    if ('patches' in e && e.patches !== undefined && e.patches.length > 0)
      session.changed(e.patches, dispatcher.doc, e.revision)
  })
}
