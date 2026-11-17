/**
 * Project lock: exclusive create, heartbeat, stale detection and takeover.
 * Doc: docs/architecture/persistence.md#lock
 *
 * Every change is a compare-and-swap on the file system:
 * - create: write a temp file, then hard-link it to `lock.json` (fails if one exists), so a lock
 *   is never visible half-written;
 * - takeover, refresh, release: first rename `lock.json` aside to a unique name (only one rename
 *   of the same file succeeds), check what was moved, then link the new lock (or put the old one
 *   back with a link that fails if someone else created a lock meanwhile).
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Clock } from '../../core/commands/context'
import { stableJson } from '../../core/project/layout'
import type { Logger } from '../../shared/logging'
import {
  Err,
  fail,
  Ok,
  tryAsync,
  tryCatch,
  type AppResult,
  type AsyncAppResult,
} from '../../shared/result'
import { errnoCode, type PersistFs } from './fs'

export const LOCK_HEARTBEAT_MS = 30_000
export const LOCK_STALE_MS = 2 * 60_000
const MAX_ATTEMPTS = 5

export interface LockOwner {
  readonly instanceId: string
  readonly pid: number
  readonly host: string
}

const LockInfoSchema = z.object({
  instanceId: z.string(),
  pid: z.number().int(),
  host: z.string(),
  startedAt: z.iso.datetime(),
  heartbeatAt: z.iso.datetime(),
})
export type LockInfo = z.output<typeof LockInfoSchema>

/** Per lock path: a foreign host's `heartbeatAt` and since when (local time) it is unchanged. */
export type LockObservations = Map<string, { heartbeatAt: string; since: number }>

export interface LockDeps {
  readonly fs: PersistFs
  readonly path: string
  readonly owner: LockOwner
  readonly clock: Clock
  /** Whether a PID is alive on this host (`isPidAlive` below in the app). */
  readonly isPidAlive: (pid: number) => boolean
  readonly log: Logger
  /** Kept for the life of the instance, so a foreign host's lock can age in local time. */
  readonly observed: LockObservations
}

export type LockState =
  | { readonly state: 'none' }
  | { readonly state: 'live'; readonly info: LockInfo }
  /** `info` is undefined when the file could not be parsed (corrupt). */
  | { readonly state: 'stale'; readonly info: LockInfo | undefined }

/** `process.kill(pid, 0)`: ESRCH = dead; EPERM = alive but not ours. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return errnoCode(e) === 'EPERM'
  }
}

/**
 * Same host: the clocks agree, so the heartbeat's age decides (> 2 min); a dead PID counts only
 * if the heartbeat is also older than one interval, because PID namespaces (Flatpak, Snap,
 * containers) share the host name but not the PIDs. Other host: clocks may differ, so the lock is
 * stale only once its `heartbeatAt` has not changed for 2 min of local time.
 */
function isStale(info: LockInfo, d: LockDeps): boolean {
  const now = d.clock.now()
  if (info.host === d.owner.host) {
    const age = now - Date.parse(info.heartbeatAt)
    if (age > LOCK_STALE_MS) return true
    return info.pid !== d.owner.pid && age > LOCK_HEARTBEAT_MS && !d.isPidAlive(info.pid)
  }
  const seen = d.observed.get(d.path)
  if (seen === undefined || seen.heartbeatAt !== info.heartbeatAt) {
    d.observed.set(d.path, { heartbeatAt: info.heartbeatAt, since: now })
    return false
  }
  return now - seen.since > LOCK_STALE_MS
}

async function readInfoAt(fs: PersistFs, path: string): Promise<LockInfo | 'missing' | undefined> {
  let bytes: Uint8Array
  try {
    bytes = await fs.readFile(path)
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return 'missing'
    throw e
  }
  const parsed = tryCatch(
    () => LockInfoSchema.parse(JSON.parse(new TextDecoder().decode(bytes))),
    'input.malformed',
    'bad lock',
  )
  return parsed.isOk() ? parsed.unwrap() : undefined
}

/** Reads the lock without changing it. */
export async function inspectLock(d: LockDeps): AsyncAppResult<LockState> {
  const r = await tryAsync(() => readInfoAt(d.fs, d.path), 'persist.io', 'reading the lock failed')
  return r.map((info): LockState => {
    if (info === 'missing') return { state: 'none' }
    if (info === undefined) return { state: 'stale', info }
    return isStale(info, d) ? { state: 'stale', info } : { state: 'live', info }
  })
}

export interface Lock {
  readonly owner: LockOwner
  /** Moves `heartbeatAt`; `persist.locked` if another instance took the lock over. */
  refresh(): AsyncAppResult<void>
  /** Calls `refresh` every 30 s; `onLost` when the lock is gone or taken over. */
  startHeartbeat(onLost: (e: AppResult<never>) => void, intervalMs?: number): void
  /** Stops the heartbeat; deletes the lock only if it is still ours. */
  release(): AsyncAppResult<void>
}

const lockedError = (info: LockInfo | undefined, path: string, where = 'lock.acquire') =>
  fail('persist.locked', 'the project is open in another instance', {
    where,
    data:
      info === undefined
        ? { path }
        : { holder: info.instanceId, startedAt: info.startedAt, host: info.host, path },
  })

const unique = (path: string, tag: string) => `${path}.${randomBytes(4).toString('hex')}.${tag}`

/** Temp file with the lock's content (fsynced), ready to be linked into place. */
async function prepare(fs: PersistFs, path: string, info: LockInfo): Promise<string> {
  const tmp = unique(path, 'tmp')
  await fs.writeFile(tmp, stableJson(info))
  await fs.fsync(tmp)
  return tmp
}

/** `link(from, to)`: true if created, false if `to` exists. */
async function linkIfAbsent(fs: PersistFs, from: string, to: string): Promise<boolean> {
  try {
    await fs.link(from, to)
    return true
  } catch (e) {
    if (errnoCode(e) === 'EEXIST') return false
    throw e
  }
}

/** Renames the lock aside; `undefined` if there was none (someone else moved it first). */
async function moveAside(fs: PersistFs, path: string): Promise<string | undefined> {
  const aside = unique(path, 'aside')
  try {
    await fs.rename(path, aside)
    return aside
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return undefined
    throw e
  }
}

const sameLock = (a: LockInfo | 'missing' | undefined, b: LockInfo | undefined): boolean =>
  typeof a === 'object' && b !== undefined
    ? a.instanceId === b.instanceId && a.heartbeatAt === b.heartbeatAt
    : a === undefined && b === undefined

/** Exclusive create; a stale lock is moved aside and replaced, and the takeover is logged. */
export async function acquireLock(d: LockDeps): AsyncAppResult<Lock> {
  const now = new Date(d.clock.now()).toISOString()
  const info: LockInfo = { ...d.owner, startedAt: now, heartbeatAt: now }
  let tmp: string | undefined
  const ran = await tryAsync(
    async (): Promise<AppResult<Lock>> => {
      tmp = await prepare(d.fs, d.path, info)
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (await linkIfAbsent(d.fs, tmp, d.path)) return Ok(new HeldLock(d, info))
        const existing = await inspectLock(d)
        if (existing.isErr()) return Err(existing.unwrapErr())
        const s = existing.unwrap()
        if (s.state === 'live') return lockedError(s.info, d.path)
        if (s.state === 'none') continue
        const aside = await moveAside(d.fs, d.path)
        if (aside === undefined) continue // another instance moved it first
        const moved = await readInfoAt(d.fs, aside)
        if (!sameLock(moved, s.info)) {
          // Refreshed or replaced since we looked: put it back unless a new lock exists.
          await linkIfAbsent(d.fs, aside, d.path)
          await d.fs.rm(aside)
          continue
        }
        await d.fs.rm(aside)
        d.log.warn(
          {
            path: d.path,
            previous:
              s.info === undefined
                ? null
                : {
                    instance: s.info.instanceId,
                    pid: s.info.pid,
                    host: s.info.host,
                    heartbeatAt: s.info.heartbeatAt,
                  },
          },
          'stale lock taken over',
        )
      }
      return lockedError(undefined, d.path)
    },
    'persist.io',
    'creating the lock failed',
  )
  if (tmp !== undefined) await d.fs.rm(tmp).catch(() => undefined)
  if (ran.isErr()) return Err(ran.unwrapErr().withContext('lock.acquire', { path: d.path }))
  return ran.unwrap()
}

class HeldLock implements Lock {
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly d: LockDeps,
    private info: LockInfo,
  ) {}

  get owner(): LockOwner {
    return this.d.owner
  }

  private ours(i: LockInfo | 'missing' | undefined): i is LockInfo {
    return typeof i === 'object' && i.instanceId === this.d.owner.instanceId
  }

  async refresh(): AsyncAppResult<void> {
    const { fs, path } = this.d
    const next = { ...this.info, heartbeatAt: new Date(this.d.clock.now()).toISOString() }
    let tmp: string | undefined
    const ran = await tryAsync(
      async (): Promise<AppResult<void>> => {
        tmp = await prepare(fs, path, next)
        const aside = await moveAside(fs, path)
        const moved = aside === undefined ? 'missing' : await readInfoAt(fs, aside)
        if (aside !== undefined && !this.ours(moved)) {
          await linkIfAbsent(fs, aside, path)
          await fs.rm(aside)
          return lockedError(typeof moved === 'object' ? moved : undefined, path, 'lock.refresh')
        }
        // Ours (or gone: nobody holds it): link the new lock unless someone created one.
        const linked = await linkIfAbsent(fs, tmp, path)
        if (aside !== undefined) await fs.rm(aside)
        if (!linked) {
          const holder = await readInfoAt(fs, path)
          return lockedError(typeof holder === 'object' ? holder : undefined, path, 'lock.refresh')
        }
        this.info = next
        return Ok(undefined)
      },
      'persist.io',
      'refreshing the lock failed',
    )
    if (tmp !== undefined) await fs.rm(tmp).catch(() => undefined)
    return ran.isOk() ? ran.unwrap() : Err(ran.unwrapErr().withContext('lock.refresh', { path }))
  }

  startHeartbeat(onLost: (e: AppResult<never>) => void, intervalMs = LOCK_HEARTBEAT_MS): void {
    this.timer ??= setInterval(() => {
      void this.refresh().then((r) => {
        if (r.isOk()) return
        if (r.unwrapErr().code === 'persist.locked') {
          this.stop()
          onLost(Err(r.unwrapErr()))
        } else this.d.log.warn({ err: r.unwrapErr().toJSON() }, 'lock heartbeat failed')
      })
    }, intervalMs)
    this.timer.unref?.()
  }

  private stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  async release(): AsyncAppResult<void> {
    this.stop()
    const { fs, path } = this.d
    return tryAsync(
      async () => {
        const aside = await moveAside(fs, path)
        if (aside === undefined) return
        if (!this.ours(await readInfoAt(fs, aside))) await linkIfAbsent(fs, aside, path)
        await fs.rm(aside)
      },
      'persist.io',
      'releasing the lock failed',
    )
  }
}
