// Test helpers: archives as bytes over the streaming API. Doc: docs/architecture/persistence.md#files
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileMap } from '../../core/project/layout'
import type { AppResult } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import {
  loadArchive,
  readArchive,
  sha256,
  writeArchive,
  type ArchiveAsset,
  type ArchiveInfo,
  type LoadedArchive,
  type ReadArchive,
  type ReadOptions,
  type WrittenArchive,
} from './archive'
import { testFs } from './fs.testing'

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'dfyom-archive-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** `writeArchive` into memory (tests only: the app never holds an archive in memory). */
export function buildArchive(
  files: FileMap,
  info: ArchiveInfo,
  assets: readonly ArchiveAsset[] = [],
): Promise<WrittenArchive & { readonly bytes: Uint8Array }> {
  return withTemp(async (dir) => {
    const path = join(dir, 'a.dfyom')
    const w = expectOk(await writeArchive(testFs, path, files, assets, info))
    const bytes = new Uint8Array(await readFile(path))
    if (sha256(bytes) !== w.sha256) throw new Error('archive hash differs from its file')
    return { ...w, bytes }
  })
}

/** `readArchive` of bytes. */
export function readArchiveBytes(
  bytes: Uint8Array,
  opts: ReadOptions = {},
): Promise<AppResult<ReadArchive>> {
  return withTemp(async (dir) => {
    const path = join(dir, 'a.dfyom')
    await writeFile(path, bytes)
    return readArchive(testFs, path, opts)
  })
}

/** `loadArchive` of bytes. */
export function loadArchiveBytes(bytes: Uint8Array): Promise<AppResult<LoadedArchive>> {
  return withTemp(async (dir) => {
    const path = join(dir, 'a.dfyom')
    await writeFile(path, bytes)
    return loadArchive(testFs, path)
  })
}
