// App state the main process remembers between runs but never shows as a setting: the last
// window's bounds and the last folder of each kind of file dialog. Written to
// `<appData>/app-state.json` (atomic, serialized, debounced); main-only, never pushed to windows
// and not reachable by agents. Doc: docs/conventions/ui.md#remembered-window-state-and-dialog-folders
import { join } from 'node:path'
import { z } from 'zod'
import type { Logger } from '../../shared/logging'
import { parseWith } from '../../shared/parse'
import { tryCatch } from '../../shared/result'
import { errnoCode, nodeFs, writeFileAtomic, type PersistFs } from '../persistence/fs'

export const APP_STATE_FILE = 'app-state.json'

/**
 * The kinds of file dialog with their own remembered folder. A new dialog adds its kind here
 * (`reference-import` is for the reference STL/STEP import, task R3; `svg-import` for the SVG
 * shape import, I1).
 */
export const DIALOG_KINDS = ['project', 'gcode-export', 'reference-import', 'svg-import'] as const
export type DialogKind = (typeof DIALOG_KINDS)[number]

const RectSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})

/** A window's normal (not maximized, not full-screen) bounds and its state. */
export const WindowStateSchema = z.object({
  bounds: RectSchema,
  maximized: z.boolean().default(false),
  fullScreen: z.boolean().default(false),
})
export type WindowState = Readonly<z.output<typeof WindowStateSchema>>

/** Each field falls back on its own, so a bad window entry does not drop the dialog folders. */
export const AppStateSchema = z.object({
  window: WindowStateSchema.optional().catch(undefined),
  /** The Library window's own bounds (docs/conventions/ui-library-window.md, L1). */
  libraryWindow: WindowStateSchema.optional().catch(undefined),
  dialogFolders: z.record(z.string(), z.string().min(1)).default({}).catch({}),
})
export type AppState = Readonly<z.output<typeof AppStateSchema>>

export const EMPTY_APP_STATE: AppState = AppStateSchema.parse({})

export interface AppStateStore {
  get(): AppState
  /** The last window's state (the most recently moved, resized or closed window). */
  setWindow(state: WindowState): void
  /** The Library window's state (moved, resized or closed). */
  setLibraryWindow(state: WindowState): void
  dialogFolder(kind: DialogKind): string | undefined
  rememberDialogFolder(kind: DialogKind, folder: string): void
  /** Writes a pending change now and resolves when every write has finished (tests, quit). */
  flush(): Promise<void>
}

/**
 * Reads the state file. Missing → empty; unreadable or invalid → empty with a warning (replaced
 * on the next change). Remembered state is not user data: no confirmation, no migration
 * (docs/conventions/error-handling/migrations.md).
 */
export async function loadAppState(
  appData: string,
  log: Logger,
  fs: PersistFs = nodeFs,
): Promise<AppState> {
  const file = join(appData, APP_STATE_FILE)
  let text: string
  try {
    text = new TextDecoder().decode(await fs.readFile(file))
  } catch (e) {
    if (errnoCode(e) !== 'ENOENT') log.warn({ file, err: String(e) }, 'app state unreadable')
    return EMPTY_APP_STATE
  }
  const parsed = tryCatch(() => JSON.parse(text) as unknown, 'input.malformed', 'not JSON').andThen(
    (raw) => parseWith(AppStateSchema, raw, 'loadAppState'),
  )
  if (parsed.isErr()) {
    log.warn({ file, err: parsed.unwrapErr().toJSON() }, 'app state invalid; starting empty')
    return EMPTY_APP_STATE
  }
  return parsed.unwrap()
}

/** Window moves and resizes arrive many times a second; one write after they settle. */
export const APP_STATE_WRITE_DELAY_MS = 500

export function createAppStateStore(o: {
  readonly appData: string
  readonly initial: AppState
  readonly log: Logger
  readonly fs?: PersistFs
  readonly delayMs?: number
}): AppStateStore {
  const fs = o.fs ?? nodeFs
  const file = join(o.appData, APP_STATE_FILE)
  const delay = o.delayMs ?? APP_STATE_WRITE_DELAY_MS
  let current = o.initial
  let timer: ReturnType<typeof setTimeout> | undefined
  // Writes run one after another, each writing the state current when it starts.
  let tail: Promise<void> = Promise.resolve()
  const write = () => {
    timer = undefined
    tail = tail.then(async () => {
      const r = await writeFileAtomic(fs, file, `${JSON.stringify(current, null, 2)}\n`)
      if (r.isErr()) o.log.warn({ file, err: r.unwrapErr().toJSON() }, 'app state not saved')
    })
  }
  const change = (next: AppState) => {
    current = next
    if (timer === undefined) timer = setTimeout(write, delay)
  }
  return {
    get: () => current,
    setWindow(state) {
      change({ ...current, window: state })
    },
    setLibraryWindow(state) {
      change({ ...current, libraryWindow: state })
    },
    dialogFolder: (kind) => current.dialogFolders[kind],
    rememberDialogFolder(kind, folder) {
      if (current.dialogFolders[kind] === folder) return
      change({ ...current, dialogFolders: { ...current.dialogFolders, [kind]: folder } })
    },
    flush() {
      if (timer !== undefined) {
        clearTimeout(timer)
        write()
      }
      return tail
    },
  }
}
