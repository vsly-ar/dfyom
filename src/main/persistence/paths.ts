/**
 * `<appData>` resolution and the per-project folder layout.
 * Doc: docs/architecture/persistence.md#files-and-folders
 *
 * Electron's `userData` is passed in by the caller, so nothing here imports Electron.
 */
import { join } from 'node:path'

export const DATA_DIR_FLAG = '--data-dir'

/** `--data-dir=x` / `--data-dir x` wins over Electron's `userData`. */
export function resolveAppData(
  argv: readonly string[],
  electronUserData?: string,
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a.startsWith(`${DATA_DIR_FLAG}=`)) return a.slice(DATA_DIR_FLAG.length + 1)
    if (a === DATA_DIR_FLAG && argv[i + 1] !== undefined) return argv[i + 1]
  }
  return electronUserData
}

export interface ProjectPaths {
  readonly key: string
  readonly folder: string
  readonly work: string
  readonly state: string
  readonly lock: string
  readonly saves: string
}

export function projectsRoot(appData: string): string {
  return join(appData, 'projects')
}

export function projectPaths(appData: string, key: string): ProjectPaths {
  const folder = join(projectsRoot(appData), key)
  return {
    key,
    folder,
    work: join(folder, 'work'),
    state: join(folder, 'state.json'),
    lock: join(folder, 'lock.json'),
    saves: join(folder, 'saves'),
  }
}

/** `<id>`, `<id>~2`, `<id>~3`, … */
export function candidateKey(projectId: string, n: number): string {
  return n <= 1 ? projectId : `${projectId}~${n}`
}
