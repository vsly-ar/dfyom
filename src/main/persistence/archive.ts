/**
 * Project archive: zip build/read, hashing, entry and zip-slip checks.
 * Doc: docs/architecture/persistence.md#files-and-folders
 *
 * Zip library: fflate (MIT, GPL-3.0-or-later compatible, no native code). v0.1 archives hold
 * only JSON documents, so they are built and read in memory; streaming comes with `assets/`.
 */
import { createHash } from 'node:crypto'
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import type { ProjectDoc } from '../../core/project/document'
import {
  loadProjectFiles,
  MANIFEST_FILE,
  parseManifest,
  PROJECT_SCHEMA_VERSION,
  stableJson,
  type FileMap,
  type Manifest,
} from '../../core/project/layout'
import { Err, fail, Ok, tryCatch, type AppResult } from '../../shared/result'

/** Uncompressed size limit of an archive (zip-bomb guard); v0.1 projects are small JSON. */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Relative, forward-slash, no `.`/`..`/empty segments, no drive letter, no NUL. */
export function isSafeEntryName(name: string): boolean {
  if (name === '' || name.includes('\\') || name.includes('\0')) return false
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false
  return name.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
}

export interface ArchiveInfo {
  readonly projectId: string
  readonly appVersion: string
  readonly savedAt: string
  readonly revision: number
}

export interface BuiltArchive {
  readonly bytes: Uint8Array
  readonly manifest: Manifest
  readonly sha256: string
}

/** Documents first (deflated), `manifest.json` last; deterministic for the same input. */
export function buildArchive(files: FileMap, info: ArchiveInfo): BuiltArchive {
  const entries: Zippable = {}
  const listed: Manifest['files'][number][] = []
  for (const [path, text] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const bytes = strToU8(text)
    entries[path] = bytes
    listed.push({ path, size: bytes.length, sha256: sha256(bytes) })
  }
  const manifest: Manifest = {
    format: 'dfyom-project',
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId: info.projectId,
    appVersion: info.appVersion,
    savedAt: info.savedAt,
    revision: info.revision,
    files: listed,
  }
  entries[MANIFEST_FILE] = strToU8(stableJson(manifest))
  const bytes = zipSync(entries, { level: 6, mtime: new Date(info.savedAt) })
  return { bytes, manifest, sha256: sha256(bytes) }
}

export interface ReadArchive {
  readonly manifest: Manifest
  readonly files: FileMap
}

const malformed = (message: string, data?: Record<string, unknown>) =>
  fail(
    'input.malformed',
    message,
    data === undefined ? { where: 'archive.read' } : { where: 'archive.read', data },
  )

/**
 * Unzips and checks: safe entry names, size limit, manifest (incl. schema version), entry set
 * equal to the manifest's files, and each entry's size and sha256.
 */
export function readArchive(
  bytes: Uint8Array,
  opts: { readonly maxBytes?: number } = {},
): AppResult<ReadArchive> {
  const maxBytes = opts.maxBytes ?? MAX_ARCHIVE_BYTES
  let unsafe: string | undefined
  let total = 0
  const unzipped = tryCatch(
    () =>
      unzipSync(bytes, {
        filter: (f) => {
          if (!isSafeEntryName(f.name)) unsafe ??= f.name
          total += f.originalSize
          return unsafe === undefined && total <= maxBytes
        },
      }),
    'input.malformed',
    'not a valid zip archive',
  )
  if (unzipped.isErr()) return Err(unzipped.unwrapErr().withContext('archive.read'))
  if (unsafe !== undefined) return malformed('unsafe entry name (zip-slip)', { entry: unsafe })
  if (total > maxBytes) return malformed('archive is too large', { maxBytes })
  const entries = unzipped.unwrap()
  const manifestBytes = entries[MANIFEST_FILE]
  if (manifestBytes === undefined) return malformed('archive has no manifest.json')
  const raw = tryCatch(
    () => JSON.parse(strFromU8(manifestBytes)) as unknown,
    'input.malformed',
    'manifest.json is not JSON',
  )
  if (raw.isErr()) return Err(raw.unwrapErr().withContext('archive.read'))
  const parsed = parseManifest(raw.unwrap())
  if (parsed.isErr()) return Err(parsed.unwrapErr().withContext('archive.read'))
  const manifest = parsed.unwrap()

  const listed = new Set(manifest.files.map((f) => f.path))
  for (const name of Object.keys(entries))
    if (name !== MANIFEST_FILE && !listed.has(name))
      return malformed('archive entry not listed in the manifest', { path: name })
  const files = new Map<string, string>()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (const f of manifest.files) {
    const data = entries[f.path]
    if (data === undefined)
      return malformed('manifest file missing from the archive', { path: f.path })
    if (data.length !== f.size || sha256(data) !== f.sha256)
      return malformed('archive entry does not match the manifest', { path: f.path })
    const text = tryCatch(() => decoder.decode(data), 'input.malformed', 'entry is not UTF-8')
    if (text.isErr()) return Err(text.unwrapErr().withContext('archive.read', { path: f.path }))
    files.set(f.path, text.unwrap())
  }
  return Ok({ manifest, files })
}

export interface LoadedArchive extends ReadArchive {
  readonly doc: ProjectDoc
}

/** `readArchive` plus the full load pipeline of every document. */
export function loadArchive(bytes: Uint8Array): AppResult<LoadedArchive> {
  return readArchive(bytes).andThen((r) => loadProjectFiles(r.files).map((doc) => ({ ...r, doc })))
}
