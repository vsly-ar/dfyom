/**
 * Project archive: streamed zip write/read, hashing, entry and zip-slip checks.
 * Doc: docs/architecture/persistence.md#assets-and-references-v02 (streaming),
 * docs/architecture/persistence.md#files-and-folders
 *
 * Zip library: fflate (MIT, GPL-3.0-or-later compatible, no native code), streaming API
 * (`Zip`/`ZipDeflate` to write, `Inflate` to read). Reading takes each entry's place and size from
 * the central directory, not fflate's `Unzip` (see `readCentralDirectory`). The archive is never
 * built or read in memory: files go through in `CHUNK_BYTES` pieces. Documents (small JSON) are collected for the load
 * pipeline; assets are only hashed (verify) or written to a folder (unpack) while streaming.
 */
import { createHash, type Hash } from 'node:crypto'
import { join } from 'node:path'
import { Inflate, Zip, ZipDeflate } from 'fflate'
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

/** A central directory record: what the reader trusts for an entry's place and size. */
interface CentralEntry {
  readonly name: string
  readonly compression: number
  readonly compressedSize: number
  readonly size: number
  readonly offset: number
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_END = 0x06054b50
const END_BYTES = 22
const MAX_COMMENT = 0xffff
/** The central directory is held in memory: under a hundred bytes per entry. */
const MAX_CENTRAL_BYTES = 64 * 1024 * 1024

const notZip = (data?: Record<string, unknown>) => malformed('not a valid zip archive', data)

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)

/**
 * The central directory, found from the end-of-central-directory record at the end of the file.
 * Entry places and sizes come from here, never from scanning the data: fflate's streaming
 * `Unzip` finds the end of an entry with a data descriptor (every entry `Zip` writes) by
 * searching for the next zip signature, so those 4 bytes inside an asset's stored (incompressible)
 * data cut the entry short and made the project unopenable (backlog B17). Zip64 is not supported
 * (the asset limits keep archives below 4 GiB).
 */
async function readCentralDirectory(
  fs: PersistFs,
  path: string,
  fileSize: number,
): Promise<CentralEntry[]> {
  const tailBytes = Math.min(fileSize, END_BYTES + MAX_COMMENT)
  if (tailBytes < END_BYTES) throw notZip()
  const tailStart = fileSize - tailBytes
  const tail = await fs.readRange(path, tailStart, tailBytes)
  const tv = view(tail)
  let end = -1
  for (let at = tail.length - END_BYTES; at >= 0; at--) {
    const commentBytes = tv.getUint16(at + 20, true)
    if (tv.getUint32(at, true) === SIG_END && at + END_BYTES + commentBytes === tail.length) {
      end = at
      break
    }
  }
  if (end < 0) throw notZip()
  if (tv.getUint16(end + 4, true) !== 0 || tv.getUint16(end + 6, true) !== 0)
    throw malformed('multi-disk zip archives are not supported')
  const count = tv.getUint16(end + 10, true)
  const cdSize = tv.getUint32(end + 12, true)
  const cdOffset = tv.getUint32(end + 16, true)
  if (count !== tv.getUint16(end + 8, true) || count === 0xffff || cdOffset === 0xffffffff)
    throw malformed('zip64 archives are not supported')
  if (cdSize > MAX_CENTRAL_BYTES || cdOffset + cdSize > tailStart + end) throw notZip()
  const cd = await fs.readRange(path, cdOffset, cdSize)
  if (cd.length !== cdSize) throw notZip()
  const cv = view(cd)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const out: CentralEntry[] = []
  let at = 0
  for (let i = 0; i < count; i++) {
    if (at + 46 > cd.length || cv.getUint32(at, true) !== SIG_CENTRAL) throw notZip()
    const flags = cv.getUint16(at + 8, true)
    const nameBytes = cv.getUint16(at + 28, true)
    const next = at + 46 + nameBytes + cv.getUint16(at + 30, true) + cv.getUint16(at + 32, true)
    if (next > cd.length) throw notZip()
    if ((flags & 1) !== 0) throw malformed('encrypted zip entries are not supported')
    const name = tryCatch(
      () => decoder.decode(cd.subarray(at + 46, at + 46 + nameBytes)),
      'input.malformed',
      'zip entry name is not UTF-8',
    )
    if (name.isErr()) throw name.unwrapErr()
    out.push({
      name: name.unwrap(),
      compression: cv.getUint16(at + 10, true),
      compressedSize: cv.getUint32(at + 20, true),
      size: cv.getUint32(at + 24, true),
      offset: cv.getUint32(at + 42, true),
    })
    at = next
  }
  return out
}

/** Reads a file front to back once in `CHUNK_BYTES` reads, hashing every byte. */
class SequentialReader {
  pos = 0
  private buffered: Uint8Array = new Uint8Array(0)
  private readonly source: AsyncGenerator<Uint8Array>
  private readonly hash: Hash = createHash('sha256')

  constructor(fs: PersistFs, path: string) {
    this.source = chunks(fs, path)
  }

  /** Up to `max` next bytes (a view into the read chunk); empty at the end of the file. */
  private async next(max: number): Promise<Uint8Array> {
    if (this.buffered.length === 0) {
      const r = await this.source.next()
      if (r.done === true) return new Uint8Array(0)
      this.hash.update(r.value)
      this.buffered = r.value
    }
    const piece = this.buffered.subarray(0, max)
    this.buffered = this.buffered.subarray(piece.length)
    this.pos += piece.length
    return piece
  }

  /** Exactly `n` bytes in pieces of at most `max`; the file ending first is malformed. */
  async *take(n: number, max = PUSH_BYTES): AsyncGenerator<Uint8Array> {
    for (let left = n; left > 0;) {
      const piece = await this.next(Math.min(left, max))
      if (piece.length === 0) throw notZip()
      left -= piece.length
      yield piece
    }
  }

  async bytes(n: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = []
    for await (const p of this.take(n)) parts.push(p)
    return join8(parts)
  }

  async skip(n: number): Promise<void> {
    for await (const _ of this.take(n, CHUNK_BYTES)) void _
  }

  /** Reads to the end; the file's sha256 and size. */
  async finish(): Promise<{ readonly sha256: string; readonly size: number }> {
    while ((await this.next(CHUNK_BYTES)).length > 0);
    return { sha256: this.hash.digest('hex'), size: this.pos }
  }
}

/** Inflate errors (corrupt or cut-short deflate data) are a malformed archive. */
function pushInflate(inflate: Inflate, data: Uint8Array, final: boolean, path: string): void {
  try {
    inflate.push(data, final)
  } catch {
    throw notZip({ path })
  }
}

/**
 * Entries in file order, each read for exactly its central-directory compressed size and
 * inflated in `PUSH_BYTES` slices; the whole file is read once (and hashed) front to back.
 */
async function readEntries(fs: PersistFs, path: string, opts: ReadOptions): Promise<ReadEntries> {
  const maxBytes = opts.maxBytes ?? MAX_ARCHIVE_BYTES
  const maxAssetBytes = opts.maxAssetBytes ?? MAX_ASSET_BYTES
  const maxAssetsBytes = opts.maxAssetsBytes ?? MAX_ASSETS_TOTAL_BYTES
  const extract = opts.extract
  const entries = new Map<string, Entry>()
  let failure: AppError | undefined
  let total = 0
  let assetsTotal = 0
  // Asset writes are queued by the (synchronous) inflate callbacks and awaited per input slice.
  let writes: Promise<void> = Promise.resolve()
  const queue = (op: () => Promise<void>) => {
    writes = writes.then(op)
  }
  const settle = async () => {
    await writes
    if (failure !== undefined) throw failure
  }

  const stat = await fs.stat(path)
  // A missing path or a folder: the read reports the file system's own error.
  if (stat === undefined || stat.isDirectory) await fs.readRange(path, 0, 1)
  if (stat === undefined || stat.isDirectory) throw notZip()
  const central = await readCentralDirectory(fs, path, stat.size)

  for (const c of central) {
    const name = c.name
    if (!isSafeEntryName(name)) throw malformed('unsafe entry name (zip-slip)', { entry: name })
    if (entries.has(name)) throw malformed('archive lists an entry twice', { path: name })
    const asset = name.startsWith(`${ASSET_DIR}/`)
    if (asset && !isAssetPath(name)) throw malformed('unexpected file in assets/', { path: name })
    if (!asset && name !== MANIFEST_FILE && !isLayoutPath(name))
      throw malformed('archive entry not listed in the manifest', { path: name })
    if (c.compression !== 0 && c.compression !== 8)
      throw malformed('unsupported compression', { path: name })
    const target = asset && extract?.want(name) === true ? join(extract.dir, name) : undefined
    entries.set(name, {
      name,
      hash: createHash('sha256'),
      size: 0,
      done: false,
      ...(asset ? {} : { parts: [] }),
      ...(target === undefined ? {} : { target }),
    })
  }

  if (extract !== undefined) await fs.mkdir(join(extract.dir, ASSET_DIR))
  const reader = new SequentialReader(fs, path)
  for (const c of [...central].sort((a, b) => a.offset - b.offset)) {
    const entry = entries.get(c.name)
    if (entry === undefined) throw notZip()
    const { name, target } = entry
    const asset = entry.parts === undefined
    if (c.offset < reader.pos) throw notZip({ path: name })
    await reader.skip(c.offset - reader.pos)
    const header = view(await reader.bytes(30))
    if (header.getUint32(0, true) !== SIG_LOCAL || header.getUint16(8, true) !== c.compression)
      throw notZip({ path: name })
    const localName = await reader.bytes(header.getUint16(26, true))
    if (new TextDecoder().decode(localName) !== name) throw notZip({ path: name })
    await reader.skip(header.getUint16(28, true))

    if (target !== undefined) queue(() => fs.writeFile(target, new Uint8Array(0)))
    const ondata = (data: Uint8Array, final: boolean): void => {
      if (failure !== undefined) return
      if (asset) {
        assetsTotal += data.length
        if (entry.size + data.length > maxAssetBytes) {
          failure = malformed('archive asset is too large', { path: name, maxAssetBytes })
          return
        }
        if (assetsTotal > maxAssetsBytes) {
          failure = malformed('archive assets are too large', { maxAssetsBytes })
          return
        }
      } else {
        total += data.length
        if (total > maxBytes) {
          failure = malformed('archive is too large', { maxBytes })
          return
        }
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
    // Stored pieces are views into a read chunk: copy what is kept or written later.
    const inflate = c.compression === 8 ? new Inflate(ondata) : undefined
    const feed = (piece: Uint8Array, final: boolean) =>
      inflate === undefined
        ? ondata(piece.slice(), final)
        : pushInflate(inflate, piece, final, name)
    // Small pushes bound what one push inflates (deflate expands up to ~1000×) before the size
    // guard sees it, and how many asset writes queue up.
    if (c.compressedSize === 0) feed(new Uint8Array(0), true)
    let left = c.compressedSize
    for await (const piece of reader.take(c.compressedSize)) {
      left -= piece.length
      feed(piece, left === 0)
      await settle()
    }
    await settle()
    if (entry.size !== c.size)
      throw malformed('archive entry does not match the central directory', { path: name })
  }
  const whole = await reader.finish()
  await settle()
  return { entries, ...whole }
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
