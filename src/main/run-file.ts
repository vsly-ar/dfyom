// Run an external gCode file (hardening DF93): File → "Run gCode file…" and the Run inspector's
// button ask main, which shows the open dialog (dialog kind `gcode-run`) unless a path is given,
// and picks the window: the asking one when it has no project, else a new window without one.
// The window then reads the file (`run.readFile`) and shows it in Run mode; the run itself is
// `run.job.start { file }`, the same command agents call.
// Doc: docs/modes/run.md#run-an-external-g-code-file-df93, docs/conventions/ui.md#project-files
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { dirname } from 'node:path'
import { agentError } from '../core/agent/results'
import {
  GCODE_RUN_EXTENSIONS,
  isRunnableGcodeFileName,
  type GcodeFiles,
} from '../core/run/gcode-file'
import { IPC, type RunFileOpened, type RunFileReadReply } from '../shared/preload-api'
import { startFolder, type DialogFolders } from './file-dialogs'
import { isSafeAbsolutePath } from './persistence/export-file'

/** The remembered recent files (an `AppStateStore`). */
export interface RecentRunFiles {
  get(): { readonly recentRunFiles: readonly string[] }
  rememberRunFile(path: string): void
  forgetRunFile(path: string): void
}

export interface RunFileDeps {
  readonly folders: DialogFolders
  readonly recent: RecentRunFiles
  readonly files: GcodeFiles
  /** A window of the app's sessions (not the Library or licences window). */
  isWindow(webContentsId: number): boolean
  hasProject(webContentsId: number): boolean
  /** A new window without a project. */
  openWindow(): BrowserWindow
  /** Sends `path` to `win` once it has loaded, and brings it to the front. */
  show(win: BrowserWindow, path: string): void
}

/** The window that shows the file: the asking window unless it has a project (DF93 D1). */
export function runFileWindow(askingHasProject: boolean): RunFileOpened['window'] {
  return askingHasProject ? 'new' : 'this'
}

/** The "Run gCode file" dialog, starting in the last run file's folder. */
async function chooseRunFile(
  win: BrowserWindow | null,
  folders: DialogFolders,
): Promise<string | null> {
  const folder = await startFolder(folders, 'gcode-run')
  const o: Electron.OpenDialogOptions = {
    title: 'Run gCode file',
    filters: [{ name: 'gCode', extensions: GCODE_RUN_EXTENSIONS.map((e) => e.slice(1)) }],
    properties: ['openFile'],
    ...(folder === undefined ? {} : { defaultPath: folder }),
  }
  const r = win === null ? await dialog.showOpenDialog(o) : await dialog.showOpenDialog(win, o)
  const file = r.canceled ? undefined : r.filePaths[0]
  if (file === undefined) return null
  folders.rememberDialogFolder('gcode-run', dirname(file))
  return file
}

/**
 * Opens a gCode file for a run from `asking` (the window whose button or menu item asked; none:
 * a new window): the dialog unless `given`, then the window that shows it.
 */
export async function openRunFile(
  asking: BrowserWindow | undefined,
  given: string | undefined,
  deps: RunFileDeps,
): Promise<RunFileOpened | null> {
  const path = given ?? (await chooseRunFile(asking ?? null, deps.folders))
  if (path === null || !isSafeAbsolutePath(path) || !isRunnableGcodeFileName(path)) return null
  const here = asking !== undefined && !asking.isDestroyed()
  const window = here ? runFileWindow(deps.hasProject(asking.webContents.id)) : 'new'
  deps.show(window === 'this' && here ? asking : deps.openWindow(), path)
  return { path, window }
}

export function registerRunFileIpc(deps: RunFileDeps): void {
  const fromWindow = (event: IpcMainInvokeEvent) => deps.isWindow(event.sender.id)
  ipcMain.handle(IPC.runFileOpen, (event, given: unknown): Promise<RunFileOpened | null> | null => {
    const asking = fromWindow(event) ? BrowserWindow.fromWebContents(event.sender) : null
    if (asking === null || (given !== undefined && typeof given !== 'string')) return null
    return openRunFile(asking, given, deps)
  })
  ipcMain.handle(IPC.runFileRead, async (event, path: unknown): Promise<RunFileReadReply> => {
    if (!fromWindow(event) || typeof path !== 'string' || !isRunnableGcodeFileName(path))
      return {
        ok: false,
        error: { code: 'input.malformed', message: 'not a gCode file', issues: [], frames: [] },
      }
    const text = await deps.files.read(path)
    if (text.isErr()) {
      const e = text.unwrapErr()
      if (e.code === 'persist.io') deps.recent.forgetRunFile(path)
      return { ok: false, error: agentError(e).error }
    }
    deps.recent.rememberRunFile(path)
    return { ok: true, text: text.unwrap() }
  })
  ipcMain.handle(IPC.runFileRecent, (event): readonly string[] =>
    fromWindow(event) ? deps.recent.get().recentRunFiles : [],
  )
}
