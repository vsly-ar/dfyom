// Opening `.dfyom` files from Finder (hardening U5): the paths of macOS `open-file`, the first
// launch's arguments and a second launch's arguments, and the project window that takes each.
// Kept free of Electron so it is unit-tested; src/main/index.ts wires it to the app events, and
// the window runs File → Open's own path with the file (`files.openFile`).
// Doc: docs/conventions/ui.md#project-files
import { isAbsolute, resolve } from 'node:path'
import { DATA_DIR_FLAG } from './persistence/paths'

/** The project file extension (packaging.md#file-association). */
export const PROJECT_EXTENSION = '.dfyom'

export function isProjectFile(path: string): boolean {
  return path.toLowerCase().endsWith(PROJECT_EXTENSION)
}

/** Flags whose value may follow as the next argument (its value is never a file to open). */
const FLAGS_WITH_VALUE: readonly string[] = [DATA_DIR_FLAG]

/**
 * The project files named in a launch's arguments, absolute (relative ones resolve against `cwd`,
 * the launching process's folder): arguments ending in `.dfyom` that are not flags (`-…`) or a
 * flag's value. `argv[0]` (the executable) is skipped; the script path of an unpackaged run
 * (`electron out/main/index.js`) never ends in `.dfyom`.
 */
export function projectFilesFromArgv(argv: readonly string[], cwd: string): string[] {
  const files: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a.startsWith('-')) {
      if (FLAGS_WITH_VALUE.includes(a)) i++
      continue
    }
    if (isProjectFile(a)) files.push(isAbsolute(a) ? a : resolve(cwd, a))
  }
  return files
}

/** A project window as the routing sees it (the Library and licences windows are left out). */
export interface FileWindow {
  readonly id: number
  /** Whether the window shows a project. */
  readonly hasProject: boolean
}

/** Which window takes a file. */
export type FileRoute =
  /** The window runs File → Open with the file. */
  | { readonly kind: 'window'; readonly id: number }
  /** No project window is open: a new empty window takes it. */
  | { readonly kind: 'newWindow' }

/**
 * The window that opens a file: the last focused project window when it has no project, else any
 * project window without one (reused, as File → Open reuses an empty window), else the last
 * focused project window (its Open puts the file into a new window, or brings the window that
 * already shows it to the front), else the first project window, else a new window.
 */
export function fileRoute(
  windows: readonly FileWindow[],
  lastFocused: number | undefined,
): FileRoute {
  const last = windows.find((w) => w.id === lastFocused)
  if (last !== undefined && !last.hasProject) return { kind: 'window', id: last.id }
  const empty = windows.find((w) => !w.hasProject)
  if (empty !== undefined) return { kind: 'window', id: empty.id }
  const target = last ?? windows[0]
  return target === undefined ? { kind: 'newWindow' } : { kind: 'window', id: target.id }
}

/**
 * Whether this launch takes the single-instance lock (one instance per data folder): a packaged
 * app always; an unpackaged one only with `--data-dir`, so the development build (`npm run dev`,
 * no `--data-dir`) never hands itself to an installed DFYOM on the same folder.
 */
export function takesInstanceLock(packaged: boolean, dataDir: string | undefined): boolean {
  return packaged || dataDir !== undefined
}

/**
 * Files that arrive before the app can open them (macOS sends `open-file` before `ready` when a
 * file launched the app): queued until `start`, then handed on at once.
 */
export function createFileQueue(): {
  push(file: string): void
  /** Hands on the queued files, then every later one. */
  start(open: (file: string) => void): void
} {
  let queued: string[] = []
  let opener: ((file: string) => void) | undefined
  return {
    push(file) {
      if (opener === undefined) queued.push(file)
      else opener(file)
    },
    start(open) {
      opener = open
      const files = queued
      queued = []
      for (const f of files) open(f)
    },
  }
}
