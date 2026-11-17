/**
 * Save history: file names and the fixed retention limits.
 * Doc: docs/architecture/persistence.md#save-history-retention
 */
import { join } from 'node:path'
import type { Logger } from '../../shared/logging'
import { tryAsync, type AsyncAppResult } from '../../shared/result'
import type { PersistFs } from './fs'
import { projectPaths, projectsRoot } from './paths'

const MB = 1024 * 1024

/** Fixed in v0.1 (no settings). */
export const RETENTION_LIMITS = {
  maxSaves: 20,
  maxProjectBytes: 200 * MB,
  maxTotalBytes: 2048 * MB,
} as const

export type RetentionLimits = { readonly [K in keyof typeof RETENTION_LIMITS]: number }

const SAVE_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-r\d+\.dfyom$/

/** `<savedAt>-r<revision>.dfyom` with `:` → `-` (valid on Windows); sorts by time. */
export function saveFileName(savedAt: string, revision: number): string {
  return `${savedAt.replaceAll(':', '-')}-r${revision}.dfyom`
}

export function isSaveFileName(name: string): boolean {
  return SAVE_NAME.test(name)
}

export interface SaveFile {
  /** Project folder key. */
  readonly key: string
  readonly name: string
  readonly size: number
}

/** Files to delete: oldest first; a project's newest save is never deleted. */
export function planRetention(
  files: readonly SaveFile[],
  limits: RetentionLimits = RETENTION_LIMITS,
): SaveFile[] {
  const byName = (a: SaveFile, b: SaveFile) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const projects = new Map<string, SaveFile[]>()
  for (const f of files) projects.set(f.key, [...(projects.get(f.key) ?? []), f])
  const deleted: SaveFile[] = []
  const kept: SaveFile[] = []
  const newest = new Set<SaveFile>()
  for (const list of projects.values()) {
    const sorted = [...list].sort(byName)
    let bytes = sorted.reduce((s, f) => s + f.size, 0)
    while (
      sorted.length > 1 &&
      (sorted.length > limits.maxSaves || bytes > limits.maxProjectBytes)
    ) {
      const f = sorted.shift() as SaveFile
      bytes -= f.size
      deleted.push(f)
    }
    newest.add(sorted.at(-1) as SaveFile)
    kept.push(...sorted)
  }
  let total = kept.reduce((s, f) => s + f.size, 0)
  for (const f of kept.sort(byName)) {
    if (total <= limits.maxTotalBytes) break
    if (newest.has(f)) continue
    deleted.push(f)
    total -= f.size
  }
  return deleted
}

/** Scans `<appData>/projects/<key>/saves/` and deletes what `planRetention` selects. */
export async function applyRetention(o: {
  readonly fs: PersistFs
  readonly appData: string
  readonly log: Logger
  readonly limits?: RetentionLimits
}): AsyncAppResult<{ readonly deleted: readonly SaveFile[] }> {
  return tryAsync(
    async () => {
      const root = projectsRoot(o.appData)
      if ((await o.fs.stat(root)) === undefined) return { deleted: [] }
      const files: SaveFile[] = []
      for (const key of await o.fs.readdir(root)) {
        const saves = projectPaths(o.appData, key).saves
        if ((await o.fs.stat(saves))?.isDirectory !== true) continue
        for (const name of await o.fs.readdir(saves)) {
          if (!isSaveFileName(name)) continue
          const st = await o.fs.stat(join(saves, name))
          if (st !== undefined && !st.isDirectory) files.push({ key, name, size: st.size })
        }
      }
      const deleted = planRetention(files, o.limits)
      for (const f of deleted) await o.fs.rm(join(projectPaths(o.appData, f.key).saves, f.name))
      if (deleted.length > 0) o.log.info({ count: deleted.length }, 'save history trimmed')
      return { deleted }
    },
    'persist.io',
    'applying the save-history limits failed',
  )
}
