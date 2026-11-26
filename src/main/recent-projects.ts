// Recent projects (hardening DF114): one list in app-state.json (`recentProjects`), fed by every
// project opened or saved with a file (`AppHost.onProjectFile`), shown by the start panel (above
// "Unsaved changes from an earlier session") and File → Open Recent. The views and menu labels are
// Electron-free and unit-tested; the IPC handlers are window plumbing (agents name files, they
// need no recent list). Doc: docs/conventions/ui.md#project-files
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { stat } from 'node:fs/promises'
import { basename, dirname, sep } from 'node:path'
import { IPC, type RecentProjectView } from '../shared/preload-api'
import { PROJECT_EXTENSION } from './open-file'
import type { RecentProject } from './settings/app-state'

/** The remembered recent projects (an `AppStateStore`). */
export interface RecentProjects {
  get(): { readonly recentProjects: readonly RecentProject[] }
  forgetProject(path: string): void
}

/** The file name without `.dfyom`. */
export function projectName(path: string): string {
  const name = basename(path)
  return name.toLowerCase().endsWith(PROJECT_EXTENSION)
    ? name.slice(0, -PROJECT_EXTENSION.length)
    : name
}

/** The file's folder with the home folder shortened to `~` (`~/parts`). */
export function shortFolder(path: string, home: string): string {
  const folder = dirname(path)
  if (home === '' || home === sep) return folder
  if (folder === home) return '~'
  return folder.startsWith(home + sep) ? `~${folder.slice(home.length)}` : folder
}

export function recentProjectViews(
  entries: readonly RecentProject[],
  home: string,
  exists: (path: string) => boolean,
): RecentProjectView[] {
  return entries.map((e) => ({
    path: e.path,
    name: projectName(e.path),
    folder: shortFolder(e.path, home),
    openedAt: e.openedAt,
    missing: !exists(e.path),
  }))
}

/** File → Open Recent labels: the name; names that occur twice get their folder too. */
export function recentMenuLabels(paths: readonly string[], home: string): string[] {
  const names = paths.map(projectName)
  return paths.map((p, i) =>
    names.filter((n) => n === names[i]).length > 1
      ? `${names[i]} — ${shortFolder(p, home)}`
      : (names[i] ?? p),
  )
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export function registerRecentProjectsIpc(deps: {
  readonly recent: RecentProjects
  readonly home: string
  /** A project window (the app shell) owns these web contents. */
  isProjectWindow(webContentsId: number): boolean
  /** The list changed (File → Open Recent is rebuilt). */
  changed(): void
}): void {
  const fromWindow = (event: IpcMainInvokeEvent) => deps.isProjectWindow(event.sender.id)
  ipcMain.handle(IPC.fileRecent, async (event): Promise<RecentProjectView[]> => {
    if (!fromWindow(event)) return []
    const entries = deps.recent.get().recentProjects
    const present = new Set<string>()
    await Promise.all(
      entries.map(async (e) => {
        if (await isFile(e.path)) present.add(e.path)
      }),
    )
    return recentProjectViews(entries, deps.home, (p) => present.has(p))
  })
  ipcMain.handle(IPC.fileForgetRecent, (event, path: unknown): void => {
    if (!fromWindow(event) || typeof path !== 'string') return
    deps.recent.forgetProject(path)
    deps.changed()
  })
}
