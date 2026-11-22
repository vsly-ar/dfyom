// Native file dialogs for New / Open / Save (task 3.6) and the gCode export (task 3.7). The window
// gets a path and then calls `project.open` / `project.save` / `plan.export` itself, the same
// commands agents call with a path; the OS dialog asked about replacing an existing file.
// Each kind of dialog starts in the folder last chosen in a dialog of that kind (`DialogKind`,
// remembered in settings/app-state.ts); the reference import (R3) uses `reference-import`.
// The window then calls `design.reference.import` with the path.
// Doc: docs/conventions/ui.md#project-files, #plan-mode-task-37, #remembered-window-state-and-dialog-folders
import { BrowserWindow, dialog } from 'electron'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isGcodeFileName } from '../core/post/plan-export'
import { isProjectFileName } from '../core/project/storage'
import type { DialogKind } from './settings/app-state'

/** The remembered folder per dialog kind (an `AppStateStore`). */
export interface DialogFolders {
  dialogFolder(kind: DialogKind): string | undefined
  rememberDialogFolder(kind: DialogKind, folder: string): void
}

/** The remembered folder of `kind` if it still exists; a folder that is gone is not offered. */
export async function startFolder(
  folders: DialogFolders,
  kind: DialogKind,
): Promise<string | undefined> {
  const folder = folders.dialogFolder(kind)
  if (folder === undefined) return undefined
  try {
    return (await stat(folder)).isDirectory() ? folder : undefined
  } catch {
    return undefined
  }
}

/** A save dialog's `defaultPath`: the file name in the remembered folder, else the name alone. */
export function saveDefaultPath(folder: string | undefined, fileName: string): string {
  return folder === undefined ? fileName : join(folder, fileName)
}

async function showOpen(
  win: BrowserWindow | null,
  folders: DialogFolders,
  kind: DialogKind,
  options: Electron.OpenDialogOptions,
): Promise<string | null> {
  const folder = await startFolder(folders, kind)
  const o = folder === undefined ? options : { ...options, defaultPath: folder }
  const r = win === null ? await dialog.showOpenDialog(o) : await dialog.showOpenDialog(win, o)
  const file = r.canceled ? undefined : r.filePaths[0]
  if (file === undefined) return null
  folders.rememberDialogFolder(kind, dirname(file))
  return file
}

async function showSave(
  win: BrowserWindow | null,
  folders: DialogFolders,
  kind: DialogKind,
  fileName: string,
  options: Electron.SaveDialogOptions,
): Promise<string | null> {
  const o = { ...options, defaultPath: saveDefaultPath(await startFolder(folders, kind), fileName) }
  const r = win === null ? await dialog.showSaveDialog(o) : await dialog.showSaveDialog(win, o)
  if (r.canceled || r.filePath === undefined || r.filePath === '') return null
  folders.rememberDialogFolder(kind, dirname(r.filePath))
  return r.filePath
}

const FILTERS = [{ name: 'DFYOM project', extensions: ['dfyom'] }]

export function chooseOpenFile(
  win: BrowserWindow | null,
  folders: DialogFolders,
): Promise<string | null> {
  return showOpen(win, folders, 'project', {
    title: 'Open project',
    filters: FILTERS,
    properties: ['openFile'],
  })
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
  folders: DialogFolders,
  defaultName: string,
): Promise<string | null> {
  const file = await showSave(win, folders, 'project', `${safeFileName(defaultName)}.dfyom`, {
    title: 'Save project',
    filters: FILTERS,
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  })
  if (file === null) return null
  return isProjectFileName(file) ? file : `${file}.dfyom`
}

const GCODE_FILTERS = [{ name: 'gCode', extensions: ['nc', 'gcode', 'ngc'] }]

/** The "Export gCode" dialog: a `.nc` file named after the plan unless another gCode extension is typed. */
export async function chooseExportFile(
  win: BrowserWindow | null,
  folders: DialogFolders,
  defaultName: string,
): Promise<string | null> {
  const file = await showSave(win, folders, 'gcode-export', `${safeFileName(defaultName)}.nc`, {
    title: 'Export gCode',
    filters: GCODE_FILTERS,
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  })
  if (file === null) return null
  return isGcodeFileName(file) ? file : `${file}.nc`
}

const STL_FILTERS = [{ name: 'STL model', extensions: ['stl'] }]

/** The "Import reference" dialog (task R3): an STL file, starting in the last import's folder. */
export function chooseReferenceFile(
  win: BrowserWindow | null,
  folders: DialogFolders,
): Promise<string | null> {
  return showOpen(win, folders, 'reference-import', {
    title: 'Import reference',
    filters: STL_FILTERS,
    properties: ['openFile'],
  })
}
