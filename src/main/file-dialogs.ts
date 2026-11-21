// Native file dialogs for New / Open / Save (task 3.6). The window gets a path and then calls
// `project.open` / `project.save` itself, the same commands agents call with a path; the OS
// dialog asked about replacing an existing file. Doc: docs/conventions/ui.md#project-files
import { BrowserWindow, dialog } from 'electron'
import { isProjectFileName } from '../core/project/storage'

const FILTERS = [{ name: 'DFYOM project', extensions: ['dfyom'] }]

export async function chooseOpenFile(win: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Open project',
    filters: FILTERS,
    properties: ['openFile'],
  }
  const r =
    win === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(win, options)
  const file = r.canceled ? undefined : r.filePaths[0]
  return file === undefined ? null : file
}

/** A file name from the project name: no path separators or reserved characters. */
export function safeFileName(name: string): string {
  const cleaned = [...name]
    .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? ' ' : c))
    .join('')
    .trim()
  return cleaned.length === 0 ? 'Untitled' : cleaned.slice(0, 120)
}

export async function chooseSaveFile(
  win: BrowserWindow | null,
  defaultName: string,
): Promise<string | null> {
  const options: Electron.SaveDialogOptions = {
    title: 'Save project',
    defaultPath: `${safeFileName(defaultName)}.dfyom`,
    filters: FILTERS,
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  }
  const r =
    win === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(win, options)
  if (r.canceled || r.filePath === undefined || r.filePath === '') return null
  return isProjectFileName(r.filePath) ? r.filePath : `${r.filePath}.dfyom`
}
