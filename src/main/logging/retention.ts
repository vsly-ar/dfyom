// Log folder retention. Doc: docs/conventions/logging.md#files-and-rotation
import { lstat, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const LOG_RETENTION = {
  rotateBytes: 10 * 1024 * 1024,
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxTotalBytes: 200 * 1024 * 1024,
  /** Files modified more recently may be open in a running instance: never deleted. */
  minAgeMs: 10 * 60 * 1000,
} as const

/** `<startedAt>-<instance uuid>.<n>.log`, as written by createMainLogging. */
const OWN_LOG_FILE =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\d+\.log$/

export function isOwnLogFile(name: string): boolean {
  return OWN_LOG_FILE.test(name)
}

/** The fs calls retention needs; injectable so tests can simulate failures. */
export interface RetentionFs {
  readdir(dir: string): Promise<string[]>
  /** Must not follow symlinks. */
  lstat(path: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean }>
  unlink(path: string): Promise<void>
}

const nodeFs: RetentionFs = { readdir: (d) => readdir(d), lstat, unlink }

export interface RetentionOptions {
  readonly dir: string
  readonly now: number
  /** Files never deleted, e.g. the file currently written (absolute paths). */
  readonly keep?: readonly string[]
  readonly maxAgeMs?: number
  readonly maxTotalBytes?: number
  readonly minAgeMs?: number
  readonly fs?: RetentionFs
}

export interface RetentionResult {
  readonly deleted: readonly string[]
  readonly failed: readonly { readonly file: string; readonly error: string }[]
}

/**
 * Considers only regular files named like DFYOM's own logs (no symlinks, no foreign files,
 * neither deleted nor counted). Deletes those older than maxAge, then oldest first until
 * they total ≤ maxTotalBytes; never deletes kept files or files modified within minAgeMs.
 */
export async function cleanupLogs(options: RetentionOptions): Promise<RetentionResult> {
  const fs = options.fs ?? nodeFs
  const maxAgeMs = options.maxAgeMs ?? LOG_RETENTION.maxAgeMs
  const maxTotalBytes = options.maxTotalBytes ?? LOG_RETENTION.maxTotalBytes
  const minAgeMs = options.minAgeMs ?? LOG_RETENTION.minAgeMs
  const keep = new Set(options.keep ?? [])
  const deleted: string[] = []
  const failed: { file: string; error: string }[] = []

  let names: string[]
  try {
    names = await fs.readdir(options.dir)
  } catch (e) {
    return { deleted, failed: [{ file: options.dir, error: String(e) }] }
  }

  const files: { path: string; size: number; mtimeMs: number }[] = []
  for (const name of names) {
    if (!isOwnLogFile(name)) continue
    const path = join(options.dir, name)
    try {
      const s = await fs.lstat(path)
      if (s.isFile()) files.push({ path, size: s.size, mtimeMs: s.mtimeMs })
    } catch {
      // Vanished meanwhile (another instance cleaned up): nothing to do.
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs)

  const remove = async (f: (typeof files)[number]): Promise<boolean> => {
    if (keep.has(f.path) || options.now - f.mtimeMs < minAgeMs) return false
    try {
      await fs.unlink(f.path)
      deleted.push(f.path)
      return true
    } catch (e) {
      failed.push({ file: f.path, error: String(e) })
      return false
    }
  }

  const remaining: typeof files = []
  for (const f of files) {
    if (options.now - f.mtimeMs > maxAgeMs && (await remove(f))) continue
    remaining.push(f)
  }
  let total = remaining.reduce((sum, f) => sum + f.size, 0)
  for (const f of remaining) {
    if (total <= maxTotalBytes) break
    if (await remove(f)) total -= f.size
  }
  return { deleted, failed }
}
