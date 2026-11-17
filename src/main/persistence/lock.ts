/**
 * Project lock: exclusive create, heartbeat, stale detection and takeover.
 * Doc: docs/architecture/persistence.md#lock
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

export interface LockDeps {
  readonly fs: PersistFs
  readonly path: string
  readonly owner: LockOwner
  readonly clock: Clock
  /** Whether a PID is alive on this host (`isPidAlive` below in the app). */
  readonly isPidAlive: (pid: number) => boolean
  readonly log: Logger
}

export type LockState =
  | { readonly state: 'none' }
  | { readonly state: 'live'; readonly info: LockInfo }
  /** `info` is undefined when the file could not be parsed (e.g. a crash while creating it). */
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

function isStale(info: LockInfo, d: LockDeps): boolean {
  if (info.host === d.owner.host && info.pid !== d.owner.pid && !d.isPidAlive(info.pid)) return true
  return d.clock.now() - Date.parse(info.heartbeatAt) > LOCK_STALE_MS
}

async function readInfo(d: LockDeps): Promise<LockInfo | 'missing' | undefined> {
  let bytes: Uint8Array
  try {
    bytes = await d.fs.readFile(d.path)
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
  const r = await tryAsync(() => readInfo(d), 'persist.io', 'reading the lock failed')
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

const lockedError = (info: LockInfo, path: string) =>
  fail('persist.locked', 'the project is open in another instance', {
    where: 'lock.acquire',
    data: { holder: info.instanceId, startedAt: info.startedAt, host: info.host, path },
  })

/** Exclusive create; a stale lock is replaced (temp + rename) and the takeover is logged. */
export async function acquireLock(d: LockDeps): AsyncAppResult<Lock> {
  const now = new Date(d.clock.now()).toISOString()
  const info: LockInfo = { ...d.owner, startedAt: now, heartbeatAt: now }
  const created = await tryAsync(
    async () => {
      try {
        await d.fs.writeFile(d.path, stableJson(info), { exclusive: true })
        return true
      } catch (e) {
        if (errnoCode(e) === 'EEXIST') return false
        throw e
      }
    },
    'persist.io',
    'creating the lock failed',
  )
  if (created.isErr()) {
    // A partly written lock of ours must not block the next attempt.
    await d.fs.rm(d.path).catch(() => undefined)
    return Err(created.unwrapErr().withContext('lock.acquire', { path: d.path }))
  }
  if (!created.unwrap()) {
    const existing = await inspectLock(d)
    if (existing.isErr()) return Err(existing.unwrapErr())
    const s = existing.unwrap()
    if (s.state === 'live') return lockedError(s.info, d.path)
    const took = await replace(d, info)
    if (took.isErr()) return Err(took.unwrapErr())
    const holder = await tryAsync(() => readInfo(d), 'persist.io', 'reading the lock failed')
    if (holder.isErr()) return Err(holder.unwrapErr())
    const h = holder.unwrap()
    // Two instances taking over at once: the last rename wins, the other one backs off.
    if (typeof h === 'object' && h.instanceId !== d.owner.instanceId) return lockedError(h, d.path)
    d.log.warn(
      {
        path: d.path,
        previous:
          s.state === 'stale' && s.info !== undefined
            ? {
                instance: s.info.instanceId,
                pid: s.info.pid,
                host: s.info.host,
                heartbeatAt: s.info.heartbeatAt,
              }
            : null,
      },
      'stale lock taken over',
    )
  }
  return Ok(new HeldLock(d, info))
}

function replace(d: LockDeps, info: LockInfo): AsyncAppResult<void> {
  const tmp = `${d.path}.${randomBytes(4).toString('hex')}.tmp`
  return tryAsync(
    async () => {
      await d.fs.writeFile(tmp, stableJson(info))
      await d.fs.fsync(tmp)
      await renameWithRetry(d.fs, tmp, d.path)
    },
    'persist.io',
    'writing the lock failed',
  ).then(async (r) => {
    if (r.isErr()) await d.fs.rm(tmp).catch(() => undefined)
    return r.mapErr((e) => e.withContext('lock.write', { path: d.path }))
  })
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

  async refresh(): AsyncAppResult<void> {
    const current = await tryAsync(() => readInfo(this.d), 'persist.io', 'reading the lock failed')
    if (current.isErr()) return Err(current.unwrapErr())
    const c = current.unwrap()
    if (typeof c === 'object' && c.instanceId !== this.d.owner.instanceId)
      return lockedError(c, this.d.path)
    const next = { ...this.info, heartbeatAt: new Date(this.d.clock.now()).toISOString() }
    const r = await replace(this.d, next)
    if (r.isOk()) this.info = next
    return r
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
    const current = await tryAsync(() => readInfo(this.d), 'persist.io', 'reading the lock failed')
    if (current.isErr()) return Err(current.unwrapErr())
    const c = current.unwrap()
    if (typeof c === 'object' && c.instanceId !== this.d.owner.instanceId) return Ok(undefined)
    return tryAsync(() => this.d.fs.rm(this.d.path), 'persist.io', 'deleting the lock failed')
  }
}
