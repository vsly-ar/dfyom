/**
 * Working folder: unpacking, per-commit flush (debounced, atomic per file) and `state.json`.
 * Doc: docs/architecture/persistence.md#working-folder-writes
 */
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import type { Patch } from 'immer'
import { z } from 'zod'
import type { ProjectDoc } from '../../core/project/document'
import {
  checkSchemaVersion,
  docToFiles,
  fileContent,
  PROJECT_LAYOUT,
  stableJson,
  touchedPaths,
  type FileMap,
  type ProjectLayout,
} from '../../core/project/layout'
import type { Logger } from '../../shared/logging'
import { parseWith } from '../../shared/parse'
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
import { renameWithRetry, writeFileAtomic, writeFileAtomicRaw, type PersistFs } from './fs'
import type { ProjectPaths } from './paths'

export const ProjectStateSchema = z.object({
  schemaVersion: z.number().int(),
  projectId: z.string(),
  /** Project file; `null` for a never-saved (untitled) project. */
  filePath: z.string().nullable(),
  /** `work/` holds changes not in the project file. */
  dirty: z.boolean(),
  workingRevision: z.number().int().nonnegative(),
  savedRevision: z.number().int().nonnegative().nullable(),
  /** sha256 of the archive last saved to or opened from `filePath`. */
  savedSha256: z.string().nullable(),
})

export type ProjectState = z.output<typeof ProjectStateSchema>

export const UNPROTECTED_WARNING = 'unsaved changes are not protected'

const rand = () => randomBytes(4).toString('hex')

/** `None` if there is no `state.json`; refuses a newer schema version. */
export async function readState(
  fs: PersistFs,
  paths: ProjectPaths,
): AsyncAppResult<Option<ProjectState>> {
  const where = 'workingFolder.readState'
  const exists = await tryAsync(() => fs.stat(paths.state), 'persist.io', 'stat failed')
  if (exists.isErr()) return Err(exists.unwrapErr().withContext(where, { key: paths.key }))
  if (exists.unwrap() === undefined) return Ok(None)
  const bytes = await tryAsync(() => fs.readFile(paths.state), 'persist.io', 'read failed')
  if (bytes.isErr()) return Err(bytes.unwrapErr().withContext(where, { key: paths.key }))
  const raw = tryCatch(
    () => JSON.parse(new TextDecoder().decode(bytes.unwrap())) as unknown,
    'input.malformed',
    'state.json is not JSON',
  )
  const state = raw
    .andThen((r) => checkSchemaVersion(r).map(() => r))
    .andThen((r) => parseWith(ProjectStateSchema, r, where))
  return state.isOk()
    ? Ok(Some(state.unwrap()))
    : Err(state.unwrapErr().withContext(where, { key: paths.key }))
}

export function writeState(
  fs: PersistFs,
  paths: ProjectPaths,
  state: ProjectState,
): AsyncAppResult<void> {
  return writeFileAtomic(fs, paths.state, stableJson(state)).then((r) =>
    r.mapErr((e) => e.withContext('workingFolder.writeState', { key: paths.key })),
  )
}

/** Resolves a layout path inside `work/`; refuses anything that escapes it (defense in depth). */
function inside(work: string, path: string): AppResult<string> {
  const full = resolve(work, path)
  return full.startsWith(resolve(work) + sep)
    ? Ok(full)
    : fail('input.malformed', 'path escapes the working folder', {
        where: 'workingFolder',
        data: { path },
      })
}

/**
 * Writes `files` into a new folder, swaps it in as `work/`, then writes `state` (last).
 * A crash leaves either the old or the new `work/` with the old state.
 */
export async function unpack(
  fs: PersistFs,
  paths: ProjectPaths,
  files: FileMap,
  state: ProjectState,
): AsyncAppResult<void> {
  const fresh = `${paths.work}.new-${rand()}`
  const old = `${paths.work}.old-${rand()}`
  const ran = await tryAsync(
    async () => {
      await fs.mkdir(paths.folder)
      for (const name of await fs.readdir(paths.folder))
        if (/^work\.(new|old)-[0-9a-f]+$/.test(name)) await fs.rm(join(paths.folder, name))
      await fs.mkdir(fresh)
      for (const [path, text] of files) {
        const full = inside(fresh, path)
        if (full.isErr()) throw full.unwrapErr()
        await fs.mkdir(dirname(full.unwrap()))
        await fs.writeFile(full.unwrap(), text)
        await fs.fsync(full.unwrap())
      }
      await fs.fsyncDir(fresh)
      const hadWork = (await fs.stat(paths.work)) !== undefined
      if (hadWork) await renameWithRetry(fs, paths.work, old)
      await renameWithRetry(fs, fresh, paths.work)
      await fs.fsyncDir(paths.folder)
      if (hadWork) await fs.rm(old)
      await writeFileAtomicRaw(fs, paths.state, stableJson(state))
    },
    'persist.io',
    'unpacking the working folder failed',
  )
  if (ran.isErr()) {
    await fs.rm(fresh).catch(() => undefined)
    return Err(ran.unwrapErr().withContext('workingFolder.unpack', { key: paths.key }))
  }
  return Ok(undefined)
}

/** All documents in `work/` (`<name>` and `<dir>/<name>`); leftover `*.tmp` files are ignored. */
export async function readWork(fs: PersistFs, paths: ProjectPaths): AsyncAppResult<FileMap> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const ran = await tryAsync(
    async () => {
      const files = new Map<string, string>()
      const add = async (rel: string) => {
        files.set(rel, decoder.decode(await fs.readFile(join(paths.work, rel))))
      }
      for (const name of (await fs.readdir(paths.work)).sort()) {
        if (name.endsWith('.tmp')) continue
        const st = await fs.stat(join(paths.work, name))
        if (st?.isDirectory !== true) {
          await add(name)
          continue
        }
        for (const child of (await fs.readdir(join(paths.work, name))).sort())
          if (!child.endsWith('.tmp')) await add(`${name}/${child}`)
      }
      return files
    },
    'persist.io',
    'reading the working folder failed',
  )
  return ran.mapErr((e) => e.withContext('workingFolder.read', { key: paths.key }))
}

export interface WorkingFolderOptions {
  readonly fs: PersistFs
  readonly paths: ProjectPaths
  readonly state: ProjectState
  /** What `work/` currently holds (after unpack or restore). */
  readonly files: FileMap
  readonly log: Logger
  readonly layout?: ProjectLayout
  /** Delay between the first unflushed commit and the write (default 500 ms). */
  readonly debounceMs?: number
  /** Called when a write fails; the UI shows it as a persistent warning. */
  readonly onWarning?: (message: string) => void
}

/** Keeps `work/` current: `changed` after each commit, `flush` before save and close. */
export class WorkingFolder {
  private current: ProjectState
  private readonly written: Map<string, string>
  private pending: Set<string> | 'all' = new Set()
  private latest: { doc: ProjectDoc; revision: number } | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private readonly layout: ProjectLayout

  constructor(private readonly o: WorkingFolderOptions) {
    this.current = o.state
    this.written = new Map(o.files)
    this.layout = o.layout ?? PROJECT_LAYOUT
  }

  get state(): ProjectState {
    return this.current
  }

  /** Records a commit; schedules a debounced flush. Never throws. */
  changed(patches: readonly Patch[], doc: ProjectDoc, revision: number): void {
    const touched = touchedPaths(patches, this.layout)
    if (touched === 'all' || this.pending === 'all') this.pending = 'all'
    else for (const p of touched) this.pending.add(p)
    this.latest = { doc, revision }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.flush()
      }, this.o.debounceMs ?? 500)
      this.timer.unref?.()
    }
  }

  /** Writes pending changes; serialized. On failure the changes stay pending. */
  flush(): AsyncAppResult<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const run = this.chain.then(() => this.flushNow())
    this.chain = run.catch(() => undefined)
    return run
  }

  /** Updates `state.json` (save step 6); serialized with flushes. */
  updateState(patch: Partial<ProjectState>): AsyncAppResult<void> {
    const run = this.chain.then(async () => {
      const next = { ...this.current, ...patch }
      const r = await writeState(this.o.fs, this.o.paths, next)
      if (r.isOk()) this.current = next
      return r
    })
    this.chain = run.catch(() => undefined)
    return run
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private async flushNow(): AsyncAppResult<void> {
    const latest = this.latest
    const pending = this.pending
    if (latest === undefined || (pending !== 'all' && pending.size === 0)) return Ok(undefined)
    this.pending = new Set()
    const wanted = this.contents(latest.doc, pending)
    const r = await tryAsync(
      async () => {
        if (wanted.isErr()) throw wanted.unwrapErr()
        for (const [path, text] of wanted.unwrap()) {
          if (this.written.get(path) === text) continue
          const full = inside(this.o.paths.work, path)
          if (full.isErr()) throw full.unwrapErr()
          if (text === undefined) {
            await this.o.fs.rm(full.unwrap())
            this.written.delete(path)
            continue
          }
          await this.o.fs.mkdir(dirname(full.unwrap()))
          await writeFileAtomicRaw(this.o.fs, full.unwrap(), text)
          this.written.set(path, text)
        }
        const next: ProjectState = {
          ...this.current,
          dirty: true,
          workingRevision: latest.revision,
        }
        await writeFileAtomicRaw(this.o.fs, this.o.paths.state, stableJson(next))
        this.current = next
      },
      'persist.io',
      'writing the working folder failed',
    )
    if (r.isOk()) return r
    // Keep everything pending: `written` tells the retry which files are already current.
    this.pending = 'all'
    const e = r.unwrapErr().withContext('workingFolder.flush', { key: this.o.paths.key })
    this.o.log.warn(
      { err: e.toJSON(), project: this.current.projectId },
      'working folder write failed',
    )
    this.o.onWarning?.(UNPROTECTED_WARNING)
    return Err(e)
  }

  /** Target content per path (`undefined` = delete). */
  private contents(
    doc: ProjectDoc,
    pending: Set<string> | 'all',
  ): AppResult<Map<string, string | undefined>> {
    const out = new Map<string, string | undefined>()
    if (pending === 'all') {
      const files = docToFiles(doc, this.layout)
      if (files.isErr()) return Err(files.unwrapErr())
      for (const path of this.written.keys()) out.set(path, undefined)
      for (const [path, text] of files.unwrap()) out.set(path, text)
      return Ok(out)
    }
    for (const path of pending) {
      const c = fileContent(doc, path, this.layout)
      out.set(path, c.isSome() ? c.unwrap() : undefined)
    }
    return Ok(out)
  }
}
