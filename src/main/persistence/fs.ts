/**
 * The file-system operations persistence uses, as an injectable port, plus atomic writes.
 * Doc: docs/architecture/persistence.md#working-folder-writes
 *
 * Tests wrap `nodeFs` with `faultFs` (fs.testing.ts) to fail or "kill the process" at any step.
 */
import { constants } from 'node:fs'
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'
import { tryAsync, type AsyncAppResult } from '../../shared/result'

export interface PersistFs {
  readFile(path: string): Promise<Uint8Array>
  /** `exclusive`: fail with EEXIST if the file exists (`wx`). */
  writeFile(path: string, data: Uint8Array | string, opts?: { exclusive?: boolean }): Promise<void>
  fsync(path: string): Promise<void>
  /** No-op on Windows (directories cannot be fsynced there). */
  fsyncDir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Like `rm -rf`: missing paths are fine. */
  rm(path: string): Promise<void>
  mkdir(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  /** `undefined` if the path does not exist. */
  stat(path: string): Promise<{ readonly size: number; readonly isDirectory: boolean } | undefined>
  /** Copy-on-write clone where the file system supports it, else a plain copy. */
  copyFile(from: string, to: string): Promise<void>
}

async function fsyncPath(path: string): Promise<void> {
  const h = await open(path, 'r')
  try {
    await h.sync()
  } finally {
    await h.close()
  }
}

export const nodeFs: PersistFs = {
  readFile: (p) => readFile(p),
  writeFile: (p, data, opts) => writeFile(p, data, { flag: opts?.exclusive === true ? 'wx' : 'w' }),
  fsync: fsyncPath,
  fsyncDir: async (p) => {
    if (process.platform !== 'win32') await fsyncPath(p)
  },
  rename: (a, b) => rename(a, b),
  rm: (p) => rm(p, { recursive: true, force: true }),
  mkdir: async (p) => {
    await mkdir(p, { recursive: true })
  },
  readdir: (p) => readdir(p),
  stat: async (p) => {
    try {
      const s = await stat(p)
      return { size: s.size, isDirectory: s.isDirectory() }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw e
    }
  },
  copyFile: (a, b) => copyFile(a, b, constants.COPYFILE_FICLONE),
}

export function errnoCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : undefined
}

/** Windows: a rename over a file another process has open fails briefly with EPERM/EBUSY. */
export async function renameWithRetry(
  fs: PersistFs,
  from: string,
  to: string,
  attempts = process.platform === 'win32' ? 10 : 1,
): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await fs.rename(from, to)
      return
    } catch (e) {
      const code = errnoCode(e)
      if (i >= attempts || (code !== 'EPERM' && code !== 'EBUSY')) throw e
      await new Promise((r) => setTimeout(r, 50 * i))
    }
  }
}

/** Write `<path>.tmp`, fsync, rename over `path`, fsync the directory. */
export async function writeFileAtomicRaw(
  fs: PersistFs,
  path: string,
  data: Uint8Array | string,
): Promise<void> {
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, data)
  await fs.fsync(tmp)
  await renameWithRetry(fs, tmp, path)
  await fs.fsyncDir(dirname(path))
}

/** `writeFileAtomicRaw` as an `AppResult` (`persist.io`). */
export function writeFileAtomic(
  fs: PersistFs,
  path: string,
  data: Uint8Array | string,
): AsyncAppResult<void> {
  return tryAsync(() => writeFileAtomicRaw(fs, path, data), 'persist.io', 'atomic write failed')
}
