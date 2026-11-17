/**
 * Project lock: exclusive create, heartbeat, stale detection and takeover.
 * Doc: docs/architecture/persistence.md#lock
 *
 * - Create: write a temp file, then hard-link it to `lock.json` (fails if one exists), so a lock
 *   is never visible half-written. Lock-free: only mutex holders ever remove a `lock.json`.
 * - Takeover, refresh and release run only while holding the mutex `lock.json.takeover`
 *   (created the same exclusive way, with a unique token). Inside it they re-read `lock.json`
 *   and act only if it is still the stale lock (takeover) or ours (refresh, release).
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
import { errnoCode, renameWithRetry, type PersistFs } from './fs'

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
  /** Age after which a takeover mutex counts as left by a crashed instance (default 10 s). */
  readonly mutexStaleMs?: number
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

/** A mutex older than this was left by a crashed instance and is broken. */
export const LOCK_MUTEX_STALE_MS = 10_000
const MUTEX_ATTEMPTS = 20

const unique = (path: string, tag: string) => `${path}.${randomBytes(4).toString('hex')}.${tag}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Temp file with `text` (fsynced), ready to be linked or renamed into place. */
async function prepare(fs: PersistFs, path: string, text: string): Promise<string> {
  const tmp = unique(path, 'tmp')
  await fs.writeFile(tmp, text)
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

const MutexSchema = z.object({ token: z.string(), at: z.iso.datetime() })

async function readMutex(
  fs: PersistFs,
  path: string,
): Promise<z.output<typeof MutexSchema> | 'missing' | undefined> {
  let bytes: Uint8Array
  try {
    bytes = await fs.readFile(path)
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return 'missing'
    throw e
  }
  const parsed = tryCatch(
    () => MutexSchema.parse(JSON.parse(new TextDecoder().decode(bytes))),
    'input.malformed',
    'bad mutex',
  )
  return parsed.isOk() ? parsed.unwrap() : undefined
}

/**
 * Runs `body` while holding `<lock>.takeover`; `'busy'` if another instance holds it after brief
 * retries. Its age is judged by wall time (it only guards sections of a few file operations).
 */
async function withMutex<T>(d: LockDeps, body: () => Promise<T>): Promise<T | 'busy'> {
  const { fs } = d
  const mutex = `${d.path}.takeover`
  const token = randomBytes(8).toString('hex')
  const tmp = await prepare(fs, mutex, stableJson({ token, at: new Date().toISOString() }))
  let held = false
  try {
    for (let attempt = 1; attempt <= MUTEX_ATTEMPTS && !held; attempt++) {
      if (await linkIfAbsent(fs, tmp, mutex)) {
        held = true
        break
      }
      const other = await readMutex(fs, mutex)
      if (other === 'missing') continue
      if (
        other === undefined ||
        Date.now() - Date.parse(other.at) > (d.mutexStaleMs ?? LOCK_MUTEX_STALE_MS)
      ) {
        // Left by a crashed instance. Two instances breaking it at once is a known tiny race.
        d.log.warn({ path: mutex }, 'stale lock mutex broken')
        await fs.rm(mutex)
        continue
      }
      await sleep(2 + Math.random() * 8)
    }
  } finally {
    await fs.rm(tmp).catch(() => undefined)
  }
  if (!held) return 'busy'
  try {
    return await body()
  } finally {
    const current = await readMutex(fs, mutex).catch(() => undefined)
    if (typeof current === 'object' && current.token === token) await fs.rm(mutex)
  }
}

const sameLock = (a: LockInfo | 'missing' | undefined, b: LockInfo | undefined): boolean =>
  typeof a === 'object' && b !== undefined
    ? a.instanceId === b.instanceId && a.heartbeatAt === b.heartbeatAt
    : a === undefined && b === undefined

/** Exclusive create; a stale lock is replaced under the mutex, and the takeover is logged. */
export async function acquireLock(d: LockDeps): AsyncAppResult<Lock> {
  const now = new Date(d.clock.now()).toISOString()
  const info: LockInfo = { ...d.owner, startedAt: now, heartbeatAt: now }
  let tmp: string | undefined
  const ran = await tryAsync(
    async (): Promise<AppResult<Lock>> => {
      const created = await prepare(d.fs, d.path, stableJson(info))
      tmp = created
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (await linkIfAbsent(d.fs, created, d.path)) return Ok(new HeldLock(d, info))
        const existing = await inspectLock(d)
        if (existing.isErr()) return Err(existing.unwrapErr())
        const s = existing.unwrap()
        if (s.state === 'live') return lockedError(s.info, d.path)
        if (s.state === 'none') continue
        const took = await withMutex(d, async () => {
          // Still the same stale lock? Then nobody else took it over meanwhile.
          if (!sameLock(await readInfoAt(d.fs, d.path), s.info)) return false
          await d.fs.rm(d.path)
          return linkIfAbsent(d.fs, created, d.path)
        })
        if (took === 'busy') return lockedError(s.info, d.path)
        if (!took) continue
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
        return Ok(new HeldLock(d, info))
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

  /** Under the mutex: atomic replace (temp + rename) if the lock is still ours. */
  async refresh(): AsyncAppResult<void> {
    const { fs, path } = this.d
    const next = { ...this.info, heartbeatAt: new Date(this.d.clock.now()).toISOString() }
    const ran = await tryAsync(
      () =>
        withMutex(this.d, async (): Promise<AppResult<void>> => {
          const current = await readInfoAt(fs, path)
          if (!this.ours(current))
            return lockedError(
              typeof current === 'object' ? current : undefined,
              path,
              'lock.refresh',
            )
          const tmp = await prepare(fs, path, stableJson(next))
          try {
            await renameWithRetry(fs, tmp, path)
          } catch (e) {
            await fs.rm(tmp).catch(() => undefined)
            throw e
          }
          this.info = next
          return Ok(undefined)
        }),
      'persist.io',
      'refreshing the lock failed',
    )
    if (ran.isErr()) return Err(ran.unwrapErr().withContext('lock.refresh', { path }))
    const r = ran.unwrap()
    // Busy: not lost; the next heartbeat tries again.
    return r === 'busy'
      ? fail('persist.io', 'the lock mutex is busy', { where: 'lock.refresh', data: { path } })
      : r
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

  /** Under the mutex: deletes the lock if it is still ours. */
  async release(): AsyncAppResult<void> {
    this.stop()
    const { fs, path } = this.d
    const ran = await tryAsync(
      () =>
        withMutex(this.d, async () => {
          if (this.ours(await readInfoAt(fs, path))) await fs.rm(path)
        }),
      'persist.io',
      'releasing the lock failed',
    )
    if (ran.isErr()) return Err(ran.unwrapErr().withContext('lock.release', { path }))
    return ran.unwrap() === 'busy'
      ? fail('persist.io', 'the lock mutex is busy', { where: 'lock.release', data: { path } })
      : Ok(undefined)
  }
}
