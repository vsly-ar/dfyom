/**
 * Filesystem `LibraryStorage`: one JSON file per item under `<appData>/library/`.
 * Doc: docs/architecture/library.md#storage
 *
 * Layout: `library.json` (manifest), `stock/`, `tools/`, `machines/` with `<id>.json` each.
 * Writes are atomic per file (temp + fsync + rename). Every app instance shares the folder; the
 * `revision` check is done against the file on disk just before writing.
 */
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
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
import { ITEM_ID_PATTERN, type LibraryItemKind } from '../../core/library/item'
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
}
const ITEM_FILE = /^([A-Za-z0-9_-]{1,120})\.json$/

/** Opens (and on first use creates) the library folder `root` = `<appData>/library`. */
export async function createFsLibraryStorage(root: string): AsyncAppResult<LibraryStorage> {
  const ready = await prepare(root)
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
      const names = await tryAsync(() => readdir(dir), 'persist.io', `cannot list ${dir}`)
      if (names.isErr()) return names
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
      const current = await read(kind, dto.id)
      if (current.isErr()) return current
      const ok = checkPut(kind, dto.id, current.unwrap(), expected)
      if (ok.isErr()) return ok
      return writeAtomic(fileOf(kind, dto.id), `${JSON.stringify(dto, null, 2)}\n`)
    },

    async remove(kind, id, expected) {
      const valid = checkId(id)
      if (valid.isErr()) return valid
      const current = await read(kind, id)
      if (current.isErr()) return current
      const ok = checkRemove(kind, id, current.unwrap(), expected)
      if (ok.isErr()) return ok
      const file = fileOf(kind, id)
      return tryAsync(() => unlink(file), 'persist.io', `cannot delete ${file}`)
    },
  })
}

async function prepare(root: string): AsyncAppResult<void> {
  for (const sub of Object.values(FOLDER)) {
    const dir = join(root, sub)
    const made = await tryAsync(
      () => mkdir(dir, { recursive: true }),
      'persist.io',
      `cannot create ${dir}`,
    )
    if (made.isErr()) return made.map(() => undefined)
  }
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
        await fh.sync()
      } finally {
        await fh.close()
      }
      await rename(tmp, file)
    },
    'persist.io',
    `cannot write ${file}`,
  )
  if (r.isErr()) await unlink(tmp).catch(() => undefined)
  return r.mapErr((e) => e.withContext('writeAtomic', { file }))
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
        issues: [
          { path: ['id'], rule: 'pattern', message: 'must be 1–120 letters, digits, _ or -' },
        ],
        where: 'fs-storage',
        data: { id },
      })
}

const isMissing = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT'
