/**
 * Project archive: streamed zip write/read, hashing, entry and zip-slip checks.
 * Doc: docs/architecture/persistence.md#assets-and-references-v02 (streaming),
 * docs/architecture/persistence.md#files-and-folders
 *
 * Zip library: fflate (MIT, GPL-3.0-or-later compatible, no native code), streaming API
 * (`Zip`/`ZipDeflate`, `Unzip`/`UnzipInflate`). The archive is never built or read in memory:
 * files go through in `CHUNK_BYTES` pieces. Documents (small JSON) are collected for the load
 * pipeline; assets are only hashed (verify) or written to a folder (unpack) while streaming.
 */
import { createHash, type Hash } from 'node:crypto'
import { join } from 'node:path'
import { Unzip, UnzipInflate, Zip, ZipDeflate, type UnzipFile } from 'fflate'
import {
  ASSET_DIR,
  isAssetPath,
  MAX_ASSET_BYTES,
  MAX_ASSETS_TOTAL_BYTES,
  referencedAssets,
} from '../../core/project/assets'
import type { ProjectDoc } from '../../core/project/document'
import {
  isLayoutPath,
  loadProjectFiles,
  MANIFEST_FILE,
  parseManifest,
  PROJECT_SCHEMA_VERSION,
  stableJson,
  type FileMap,
  type Manifest,
} from '../../core/project/layout'
import { AppError } from '../../shared/errors/app-error'
import {
  Err,
  Ok,
  tryAsync,
  tryCatch,
  type AppResult,
  type AsyncAppResult,
} from '../../shared/result'
import type { PersistFs } from './fs'

/**
 * Uncompressed size limit of an archive's documents (zip-bomb guard), counted while inflating.
 * Documents are collected in memory; assets are streamed to disk and have their own limits
 * (`MAX_ASSET_BYTES` each, `MAX_ASSETS_TOTAL_BYTES` together), so an asset near the import
 * limit never makes a project unopenable (docs/architecture/persistence.md#assets-and-references-v02).
 */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

/** Read and write granularity of streamed files. */
export const CHUNK_BYTES = 1024 * 1024

/** Input slice per inflate push. */
const PUSH_BYTES = 64 * 1024

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** sha256 and size of a file, streamed. */
export async function hashFile(
  fs: PersistFs,
  path: string,
): Promise<{ readonly sha256: string; readonly size: number }> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of chunks(fs, path)) {
    hash.update(chunk)
    size += chunk.length
  }
  return { sha256: hash.digest('hex'), size }
}

/** The file in `CHUNK_BYTES` pieces; the last one may be shorter. */
export async function* chunks(fs: PersistFs, path: string): AsyncGenerator<Uint8Array> {
  for (let offset = 0; ;) {
    const chunk = await fs.readRange(path, offset, CHUNK_BYTES)
    if (chunk.length > 0) yield chunk
    if (chunk.length < CHUNK_BYTES) return
    offset += chunk.length
  }
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

/** An asset to store: its archive path (`assets/<sha256>.stl`) and the file holding it. */
export interface ArchiveAsset {
  readonly path: string
  readonly source: string
}

export interface WrittenArchive {
  readonly manifest: Manifest
  /** sha256 and size of the archive file. */
  readonly sha256: string
  readonly size: number
}

/** Buffers zip output and appends it to a file in `CHUNK_BYTES` pieces, hashing it. */
class ChunkSink {
  private parts: Uint8Array[] = []
  private buffered = 0
  private readonly hash: Hash = createHash('sha256')
  size = 0

  constructor(
    private readonly fs: PersistFs,
    private readonly path: string,
  ) {}

  push(data: Uint8Array): void {
    this.hash.update(data)
    this.size += data.length
    this.parts.push(data)
    this.buffered += data.length
  }

  /** Writes what is buffered once it reaches a chunk (or always, with `all`). */
  async drain(all = false): Promise<void> {
    if (this.buffered === 0 || (!all && this.buffered < CHUNK_BYTES)) return
    const out = new Uint8Array(this.buffered)
    let at = 0
    for (const p of this.parts) {
      out.set(p, at)
      at += p.length
    }
    this.parts = []
    this.buffered = 0
    await this.fs.appendFile(this.path, out)
  }

  digest(): string {
    return this.hash.digest('hex')
  }
}

/**
 * Streams documents (sorted, deflated), then assets (sorted, deflated, read in chunks and hashed
 * on the way), then `manifest.json` into a new file at `path` (created or truncated). Memory
 * stays at a few chunks whatever the asset sizes. Deterministic for the same input. Not fsynced.
 */
export async function writeArchive(
  fs: PersistFs,
  path: string,
  docs: FileMap,
  assets: readonly ArchiveAsset[],
  info: ArchiveInfo,
): AsyncAppResult<WrittenArchive> {
  return tryAsync(
    async () => {
      const sink = new ChunkSink(fs, path)
      let failure: Error | undefined
      const zip = new Zip((err, data) => {
        if (err !== null) failure ??= err
        else sink.push(data)
      })
      const mtime = new Date(info.savedAt)
      const entry = (name: string) => {
        const f = new ZipDeflate(name, { level: 6 })
        f.mtime = mtime
        zip.add(f)
        return f
      }
      const check = () => {
        if (failure !== undefined) throw failure
      }
      await fs.writeFile(path, new Uint8Array(0))
      const listed: Manifest['files'][number][] = []
      const encoder = new TextEncoder()
      for (const [name, text] of [...docs].sort(([a], [b]) => compare(a, b))) {
        const bytes = encoder.encode(text)
        entry(name).push(bytes, true)
        listed.push({ path: name, size: bytes.length, sha256: sha256(bytes) })
        check()
        await sink.drain()
      }
      for (const asset of [...assets].sort((a, b) => compare(a.path, b.path))) {
        const f = entry(asset.path)
        const hash = createHash('sha256')
        let size = 0
        for await (const chunk of chunks(fs, asset.source)) {
          hash.update(chunk)
          size += chunk.length
          f.push(chunk)
          check()
          await sink.drain()
        }
        f.push(new Uint8Array(0), true)
        listed.push({ path: asset.path, size, sha256: hash.digest('hex') })
        check()
        await sink.drain()
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
      entry(MANIFEST_FILE).push(encoder.encode(stableJson(manifest)), true)
      zip.end()
      check()
      await sink.drain(true)
      return { manifest, sha256: sink.digest(), size: sink.size }
    },
    'persist.io',
    'writing the archive failed',
  ).then((r) => r.mapErr((e) => e.withContext('archive.write', { path })))
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export interface ReadArchive {
  readonly manifest: Manifest
  /** The documents (assets are not held in memory). */
  readonly files: FileMap
  /** sha256 and size of the archive file. */
  readonly sha256: string
  readonly size: number
}

export interface ReadOptions {
  /** Documents together (default `MAX_ARCHIVE_BYTES`). */
  readonly maxBytes?: number
  /** One asset (default `MAX_ASSET_BYTES`). */
  readonly maxAssetBytes?: number
  /** All assets together (default `MAX_ASSETS_TOTAL_BYTES`). */
  readonly maxAssetsBytes?: number
  /**
   * Unpack: write the asset entries `want` accepts to `<dir>/assets/` (and fsync them). Without
   * it, assets are only hashed. On failure, files already written stay: `dir` is a scratch
   * folder the caller discards.
   */
  readonly extract?: { readonly dir: string; readonly want: (path: string) => boolean }
}

const malformed = (message: string, data?: Record<string, unknown>) =>
  new AppError(
    'input.malformed',
    message,
    data === undefined ? { where: 'archive.read' } : { where: 'archive.read', data },
  )

interface Entry {
  readonly name: string
  readonly hash: Hash
  size: number
  done: boolean
  /** Documents and the manifest are collected; assets are not. */
  readonly parts?: Uint8Array[]
  readonly target?: string
}

/**
 * Streams the archive file and checks: safe entry names (zip-slip), the size limit (counted
 * while inflating), manifest (incl. schema version), entry set equal to the manifest's files,
 * each entry's size and sha256, and each asset's hash against its name.
 */
export async function readArchive(
  fs: PersistFs,
  path: string,
  opts: ReadOptions = {},
): AsyncAppResult<ReadArchive> {
  const r = await tryAsync(
    () => readEntries(fs, path, opts),
    'persist.io',
    'reading the archive failed',
  )
  if (r.isErr()) return Err(r.unwrapErr().withContext('archive.read', { path }))
  return checkEntries(r.unwrap()).mapErr((e) => e.withContext('archive.read', { path }))
}

interface ReadEntries {
  readonly entries: Map<string, Entry>
  readonly sha256: string
  readonly size: number
}

async function readEntries(fs: PersistFs, path: string, opts: ReadOptions): Promise<ReadEntries> {
  const maxBytes = opts.maxBytes ?? MAX_ARCHIVE_BYTES
  const maxAssetBytes = opts.maxAssetBytes ?? MAX_ASSET_BYTES
  const maxAssetsBytes = opts.maxAssetsBytes ?? MAX_ASSETS_TOTAL_BYTES
  const extract = opts.extract
  const entries = new Map<string, Entry>()
  let failure: AppError | undefined
  let total = 0
  let assetsTotal = 0
  // Asset writes are queued by the (synchronous) inflate callbacks and awaited per input chunk.
  let writes: Promise<void> = Promise.resolve()
  const queue = (op: () => Promise<void>) => {
    writes = writes.then(op)
  }
  const fail = (e: AppError, file?: UnzipFile) => {
    failure ??= e
    file?.terminate()
  }

  const unzip = new Unzip((file) => {
    if (failure !== undefined) return
    const name = file.name
    if (!isSafeEntryName(name))
      return fail(malformed('unsafe entry name (zip-slip)', { entry: name }))
    if (entries.has(name)) return fail(malformed('archive lists an entry twice', { path: name }))
    const asset = name.startsWith(`${ASSET_DIR}/`)
    if (asset && !isAssetPath(name))
      return fail(malformed('unexpected file in assets/', { path: name }))
    if (!asset && name !== MANIFEST_FILE && !isLayoutPath(name))
      return fail(malformed('archive entry not listed in the manifest', { path: name }))
    const target = asset && extract?.want(name) === true ? join(extract.dir, name) : undefined
    const entry: Entry = {
      name,
      hash: createHash('sha256'),
      size: 0,
      done: false,
      ...(asset ? {} : { parts: [] }),
      ...(target === undefined ? {} : { target }),
    }
    entries.set(name, entry)
    if (target !== undefined) queue(() => fs.writeFile(target, new Uint8Array(0)))
    file.ondata = (err, data, final) => {
      if (failure !== undefined) return
      if (err !== null) return fail(malformed('not a valid zip archive', { path: name }), file)
      if (asset) {
        assetsTotal += data.length
        if (entry.size + data.length > maxAssetBytes)
          return fail(malformed('archive asset is too large', { path: name, maxAssetBytes }), file)
        if (assetsTotal > maxAssetsBytes)
          return fail(malformed('archive assets are too large', { maxAssetsBytes }), file)
      } else {
        total += data.length
        if (total > maxBytes) return fail(malformed('archive is too large', { maxBytes }), file)
      }
      entry.hash.update(data)
      entry.size += data.length
      entry.parts?.push(data)
      if (target !== undefined && data.length > 0) queue(() => fs.appendFile(target, data))
      if (final) {
        entry.done = true
        if (target !== undefined) queue(() => fs.fsync(target))
      }
    }
    try {
      file.start()
    } catch {
      fail(malformed('unsupported compression', { path: name }), file)
    }
  })
  unzip.register(UnzipInflate)

  if (extract !== undefined) await fs.mkdir(join(extract.dir, ASSET_DIR))
  const archiveHash = createHash('sha256')
  let size = 0
  let sawAny = false
  for await (const chunk of chunks(fs, path)) {
    sawAny = true
    archiveHash.update(chunk)
    size += chunk.length
    const last = chunk.length < CHUNK_BYTES
    // Small pushes bound what one push inflates (deflate expands up to ~1000×) before the size
    // guard sees it, and how many asset writes queue up.
    for (let at = 0; at < chunk.length; at += PUSH_BYTES) {
      try {
        unzip.push(chunk.subarray(at, at + PUSH_BYTES), last && at + PUSH_BYTES >= chunk.length)
      } catch {
        fail(malformed('not a valid zip archive'))
      }
      await writes
      if (failure !== undefined) throw failure
    }
  }
  if (!sawAny || size % CHUNK_BYTES === 0) {
    try {
      unzip.push(new Uint8Array(0), true)
    } catch {
      fail(malformed('not a valid zip archive'))
    }
  }
  await writes
  if (failure !== undefined) throw failure
  return { entries, sha256: archiveHash.digest('hex'), size }
}

function checkEntries(r: ReadEntries): AppResult<ReadArchive> {
  const { entries } = r
  if (entries.size === 0) return Err(malformed('not a valid zip archive'))
  for (const e of entries.values())
    if (!e.done) return Err(malformed('archive entry is truncated', { path: e.name }))
  const manifestEntry = entries.get(MANIFEST_FILE)
  if (manifestEntry === undefined) return Err(malformed('archive has no manifest.json'))
  const raw = tryCatch(
    () => JSON.parse(new TextDecoder().decode(join8(manifestEntry.parts ?? []))) as unknown,
    'input.malformed',
    'manifest.json is not JSON',
  )
  if (raw.isErr()) return Err(raw.unwrapErr())
  const parsed = parseManifest(raw.unwrap())
  if (parsed.isErr()) return Err(parsed.unwrapErr())
  const manifest = parsed.unwrap()

  const listed = new Set(manifest.files.map((f) => f.path))
  for (const name of entries.keys())
    if (name !== MANIFEST_FILE && !listed.has(name))
      return Err(malformed('archive entry not listed in the manifest', { path: name }))
  const files = new Map<string, string>()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (const f of manifest.files) {
    const e = entries.get(f.path)
    if (e === undefined)
      return Err(malformed('manifest file missing from the archive', { path: f.path }))
    // An asset's manifest hash equals its name (parseManifest), so this also checks the name.
    if (e.size !== f.size || e.hash.digest('hex') !== f.sha256)
      return Err(malformed('archive entry does not match the manifest', { path: f.path }))
    if (e.parts === undefined) continue
    const text = tryCatch(
      () => decoder.decode(join8(e.parts ?? [])),
      'input.malformed',
      'entry is not UTF-8',
    )
    if (text.isErr()) return Err(text.unwrapErr().withContext('archive.read', { path: f.path }))
    files.set(f.path, text.unwrap())
  }
  return Ok({ manifest, files, sha256: r.sha256, size: r.size })
}

function join8(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1 && parts[0] !== undefined) return parts[0]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export interface LoadedArchive extends ReadArchive {
  readonly doc: ProjectDoc
}

/** `readArchive` plus the full load pipeline of every document; every asset a record names is in the archive. */
export async function loadArchive(
  fs: PersistFs,
  path: string,
  opts: ReadOptions = {},
): AsyncAppResult<LoadedArchive> {
  const r = await readArchive(fs, path, opts)
  return r.andThen((a) =>
    loadProjectFiles(a.files)
      .andThen((doc): AppResult<LoadedArchive> => {
        const listed = new Set(a.manifest.files.map((f) => f.path))
        for (const asset of referencedAssets(doc))
          if (!listed.has(asset))
            return Err(malformed('a referenced asset is missing from the archive', { path: asset }))
        return Ok({ ...a, doc })
      })
      .mapErr((e) => e.withContext('archive.read', { path })),
  )
}
