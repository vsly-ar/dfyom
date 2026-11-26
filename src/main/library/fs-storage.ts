/**
 * Filesystem `LibraryStorage`: one JSON file per item under `<appData>/library/`.
 * Doc: docs/architecture/library.md#storage
 *
 * Layout: `library.json` (manifest), `stock/`, `tools/`, `machines/`, `workholding/` with `<id>.json` each.
 * Writes are atomic per file (temp + fsync + rename + directory fsync). Every app instance shares
 * the folder; read → revision check → write/delete runs under a per-item lock file
 * (`<id>.json.lock`, created with `wx`), so two instances cannot both pass the check. Locks and
 * temp files left by a crashed instance are broken / swept once they are stale.
 */
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AppError } from '../../shared/errors/app-error'
import {
  Err,
  fail,
  None,
  Ok,
  Some,
  tryAsync,
  tryCatch,
  type AppResult,
  type AsyncAppResult,
  type Option,
} from '../../shared/result'
import { ITEM_ID_PATTERN, ITEM_ID_RULE, type LibraryItemKind } from '../../core/library/item'
import type { LibraryItemDTO } from '../../core/library/library-item'
import {
  checkPut,
  checkRemove,
  type LibraryStorage,
  type StoredEntry,
} from '../../core/library/storage'

export const LIBRARY_MANIFEST = { format: 'dfyom-library', schemaVersion: 1 } as const

const FOLDER: Record<LibraryItemKind, string> = {
  stock: 'stock',
  tool: 'tools',
  machine: 'machines',
  workholding: 'workholding',
}
const ITEM_FILE = /^([a-z0-9_-]{1,120})\.json$/
const TEMP_FILE = /\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LOCK_FILE = /\.json\.lock$/

export interface FsLibraryOptions {
  /** Attempts to take a held item lock before `command.conflict` (default 100). */
  readonly lockRetries?: number
  /** Wait between attempts (default 20 ms). */
  readonly lockRetryMs?: number
  /** A lock older than this was left by a crashed instance and is broken (default 30 s). */
  readonly staleLockMs?: number
  /** Temp files older than this are swept on open (default 10 min). */
  readonly staleTempMs?: number
}

/** Opens (and on first use creates) the library folder `root` = `<appData>/library`. */
export async function createFsLibraryStorage(
  root: string,
  options: FsLibraryOptions = {},
): AsyncAppResult<LibraryStorage> {
  const opts = {
    lockRetries: options.lockRetries ?? 100,
    lockRetryMs: options.lockRetryMs ?? 20,
    staleLockMs: options.staleLockMs ?? 30_000,
    staleTempMs: options.staleTempMs ?? 10 * 60_000,
  }
  const ready = await prepare(root, opts)
  if (ready.isErr()) return ready

  const fileOf = (kind: LibraryItemKind, id: string) => join(root, FOLDER[kind], `${id}.json`)

  const read = async (kind: LibraryItemKind, id: string): AsyncAppResult<Option<StoredEntry>> => {
    const file = fileOf(kind, id)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (cause) {
      if (isMissing(cause)) return Ok(None)
      return Ok(
        Some({
          id,
          content: Err(new AppError('persist.io', `cannot read ${file}`, { cause, where: file })),
        }),
      )
    }
    return Ok(Some({ id, content: parseJson(text, file) }))
  }

  return Ok({
    async list(kind) {
      const dir = join(root, FOLDER[kind])
      let listed: string[]
      try {
        listed = await readdir(dir)
      } catch (cause) {
        // A kind's missing folder means no items (workholding-library.md#snapshots-and-persistence).
        if (isMissing(cause)) return Ok([])
        return fail('persist.io', `cannot list ${dir}`, { cause, where: dir })
      }
      const names = Ok(listed)
      const ids = names
        .unwrap()
        .flatMap((n) => {
          const m = ITEM_FILE.exec(n)
          return m?.[1] === undefined ? [] : [m[1]]
        })
        .sort()
      const entries: StoredEntry[] = []
      for (const id of ids) {
        const e = await read(kind, id)
        if (e.isErr()) return e
        if (e.unwrap().isSome()) entries.push(e.unwrap().unwrap()) // vanished meanwhile: skip
      }
      return Ok(entries)
    },

    async get(kind, id) {
      const valid = checkId(id)
      if (valid.isErr()) return valid
      return read(kind, id)
    },

    async put(kind, dto: LibraryItemDTO, expected) {
      const valid = checkId(dto.id)
      if (valid.isErr()) return valid
      const file = fileOf(kind, dto.id)
      return withLock(file, opts, async () => {
        const current = await read(kind, dto.id)
        if (current.isErr()) return current
        const ok = checkPut(kind, dto.id, current.unwrap(), expected)
        if (ok.isErr()) return ok
        return writeAtomic(file, `${JSON.stringify(dto, null, 2)}\n`)
      })
    },

    async remove(kind, id, expected) {
      const valid = checkId(id)
      if (valid.isErr()) return valid
      const file = fileOf(kind, id)
      return withLock(file, opts, async () => {
        const current = await read(kind, id)
        if (current.isErr()) return current
        const ok = checkRemove(kind, id, current.unwrap(), expected)
        if (ok.isErr()) return ok
        return tryAsync(
          async () => {
            await unlink(file)
            await syncDir(dirname(file))
          },
          'persist.io',
          `cannot delete ${file}`,
        )
      })
    },
  })
}

async function prepare(root: string, opts: Required<FsLibraryOptions>): AsyncAppResult<void> {
  for (const sub of Object.values(FOLDER)) {
    const dir = join(root, sub)
    const made = await tryAsync(
      () => mkdir(dir, { recursive: true }),
      'persist.io',
      `cannot create ${dir}`,
    )
    if (made.isErr()) return made.map(() => undefined)
  }
  for (const dir of [root, ...Object.values(FOLDER).map((sub) => join(root, sub))])
    await sweep(dir, opts)
  const manifest = join(root, 'library.json')
  let text: string
  try {
    text = await readFile(manifest, 'utf8')
  } catch (cause) {
    if (!isMissing(cause))
      return fail('persist.io', `cannot read ${manifest}`, { cause, where: manifest })
    return writeAtomic(manifest, `${JSON.stringify(LIBRARY_MANIFEST, null, 2)}\n`)
  }
  const parsed = parseJson(text, manifest)
  if (parsed.isErr()) return parsed
  const m = parsed.unwrap() as { format?: unknown; schemaVersion?: unknown } | null
  if (m === null || typeof m !== 'object' || m.format !== LIBRARY_MANIFEST.format)
    return fail('input.malformed', `${manifest} is not a DFYOM library manifest`, {
      where: manifest,
    })
  if (m.schemaVersion !== LIBRARY_MANIFEST.schemaVersion)
    // Pre-alpha: no migrations; an incompatible library is reset only after user confirmation.
    return fail(
      'persist.migration',
      `library schemaVersion ${String(m.schemaVersion)} is not supported`,
      {
        where: manifest,
        data: { found: m.schemaVersion, supported: LIBRARY_MANIFEST.schemaVersion },
      },
    )
  return Ok(undefined)
}

/** Write `file.tmp-<random>`, fsync, rename over `file`; the temp file is removed on failure. */
async function writeAtomic(file: string, text: string): AsyncAppResult<void> {
  const tmp = `${file}.tmp-${crypto.randomUUID()}`
  const r = await tryAsync(
    async () => {
      const fh = await open(tmp, 'w')
      try {
        await fh.writeFile(text, 'utf8')
        await fh.sync() // writable handle: fsync on a read-only handle fails on Windows
      } finally {
        await fh.close()
      }
      await rename(tmp, file)
      await syncDir(dirname(file))
    },
    'persist.io',
    `cannot write ${file}`,
  )
  if (r.isErr()) await unlink(tmp).catch(() => undefined)
  return r.mapErr((e) => e.withContext('writeAtomic', { file }))
}

/** Persist the rename/unlink itself. Windows cannot open a directory for fsync: skipped there. */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  const fh = await open(dir, 'r')
  try {
    await fh.sync()
  } finally {
    await fh.close()
  }
}

/**
 * Runs `fn` while holding `<file>.lock` (created exclusively). A held lock is retried, then
 * reported as `command.conflict` (retryable); a stale lock is broken.
 */
async function withLock<T>(
  file: string,
  opts: Required<FsLibraryOptions>,
  fn: () => AsyncAppResult<T>,
): AsyncAppResult<T> {
  const lock = `${file}.lock`
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await open(lock, 'wx')
      await fh.writeFile(`${process.pid}\n`, 'utf8').finally(() => fh.close())
      break
    } catch (cause) {
      if (!hasCode(cause, 'EEXIST'))
        return fail('persist.io', `cannot lock ${file}`, { cause, where: lock })
    }
    const age = await stat(lock).then(
      (st) => Date.now() - st.mtimeMs,
      () => 0,
    )
    if (age > opts.staleLockMs) await unlink(lock).catch(() => undefined)
    else if (attempt >= opts.lockRetries)
      return fail('command.conflict', `${file} is being written by another instance; retry`, {
        where: lock,
      })
    else await new Promise((r) => setTimeout(r, opts.lockRetryMs))
  }
  try {
    return await fn()
  } finally {
    await unlink(lock).catch(() => undefined)
  }
}

/** Best effort: removes temp files and locks left by a crashed instance. */
async function sweep(dir: string, opts: Required<FsLibraryOptions>): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[])
  const now = Date.now()
  for (const n of names) {
    const maxAge = TEMP_FILE.test(n)
      ? opts.staleTempMs
      : LOCK_FILE.test(n)
        ? opts.staleLockMs
        : undefined
    if (maxAge === undefined) continue
    const p = join(dir, n)
    const st = await stat(p).catch(() => undefined)
    if (st !== undefined && now - st.mtimeMs > maxAge) await unlink(p).catch(() => undefined)
  }
}

function parseJson(text: string, where: string): AppResult<unknown> {
  return tryCatch(
    () => JSON.parse(text) as unknown,
    'input.malformed',
    `${where} is not valid JSON`,
  )
}

function checkId(id: string): AppResult<void> {
  return ITEM_ID_PATTERN.test(id)
    ? Ok(undefined)
    : fail('input.malformed', `invalid library item id`, {
        issues: [{ path: ['id'], rule: 'pattern', message: ITEM_ID_RULE }],
        where: 'fs-storage',
        data: { id },
      })
}

const hasCode = (e: unknown, code: string): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code
const isMissing = (e: unknown): boolean => hasCode(e, 'ENOENT')
