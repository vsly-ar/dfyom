import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeClock } from '../../core/commands/testing'
import { noopLogger, type Logger } from '../../shared/logging'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { nodeFs } from './fs'
import { faultFs, useTempDir } from './fs.testing'
import { acquireLock, inspectLock, LOCK_STALE_MS, type LockOwner } from './lock'

const tmp = useTempDir()
const T0 = Date.parse('2026-11-17T10:00:00.000Z')
const me: LockOwner = { instanceId: 'inst-a', pid: 100, host: 'host-1' }
const other: LockOwner = { instanceId: 'inst-b', pid: 200, host: 'host-1' }
const lockPath = () => join(tmp.dir, 'p', 'lock.json')
const readLock = async () => JSON.parse(await readFile(lockPath(), 'utf8'))

function deps(
  owner: LockOwner,
  alive: (pid: number) => boolean = () => true,
  clock = fakeClock(T0),
) {
  return { fs: nodeFs, path: lockPath(), owner, clock, isPidAlive: alive, log: noopLogger }
}

const warnLog = (sink: string[]): Logger => ({
  ...noopLogger,
  warn: (...a: unknown[]) => void sink.push(String(a.at(-1))),
  child: () => warnLog(sink),
})

describe('acquireLock', () => {
  it('creates lock.json with owner, startedAt and heartbeatAt', async () => {
    await mkdir(join(tmp.dir, 'p'))
    const lock = expectOk(await acquireLock(deps(me)))
    expect(await readLock()).toEqual({
      instanceId: 'inst-a',
      pid: 100,
      host: 'host-1',
      startedAt: '2026-11-17T10:00:00.000Z',
      heartbeatAt: '2026-11-17T10:00:00.000Z',
    })
    expectOk(await lock.release())
    expect((await inspectLock(deps(me))).unwrap()).toEqual({ state: 'none' })
  })

  it('refuses a live lock of another instance with persist.locked', async () => {
    await mkdir(join(tmp.dir, 'p'))
    expectOk(await acquireLock(deps(other)))
    const e = expectErrCode(await acquireLock(deps(me)), 'persist.locked')
    expect(e.frames[0]?.data).toMatchObject({
      holder: 'inst-b',
      startedAt: '2026-11-17T10:00:00.000Z',
    })
  })

  it('takes over a lock whose PID is dead on this host, and logs it', async () => {
    await mkdir(join(tmp.dir, 'p'))
    expectOk(await acquireLock(deps(other)))
    const warned: string[] = []
    const lock = expectOk(
      await acquireLock({ ...deps(me, (pid) => pid !== 200), log: warnLog(warned) }),
    )
    expect((await readLock()).instanceId).toBe('inst-a')
    expect(warned).toEqual(['stale lock taken over'])
    expect(lock.owner.instanceId).toBe('inst-a')
  })

  it('a PID of another host is not checked; only the heartbeat decides', async () => {
    await mkdir(join(tmp.dir, 'p'))
    expectOk(await acquireLock(deps({ ...other, host: 'host-2' })))
    expectErrCode(await acquireLock(deps(me, () => false)), 'persist.locked')
  })

  it('takes over a lock whose heartbeat is older than 2 minutes', async () => {
    await mkdir(join(tmp.dir, 'p'))
    expectOk(await acquireLock(deps(other)))
    const later = fakeClock(T0 + LOCK_STALE_MS + 1)
    expectOk(await acquireLock(deps(me, () => true, later)))
    expect((await readLock()).instanceId).toBe('inst-a')
  })

  it('treats an unreadable lock file as stale', async () => {
    await mkdir(join(tmp.dir, 'p'))
    await writeFile(lockPath(), '')
    expectOk(await acquireLock(deps(me)))
  })

  it('refresh moves heartbeatAt; a heartbeat keeps the lock live', async () => {
    await mkdir(join(tmp.dir, 'p'))
    const clock = fakeClock(T0)
    const lock = expectOk(await acquireLock(deps(other, () => true, clock)))
    clock.advance(LOCK_STALE_MS)
    expectOk(await lock.refresh())
    expect((await readLock()).heartbeatAt).toBe(new Date(T0 + LOCK_STALE_MS).toISOString())
    const r = await inspectLock(deps(me, () => true, fakeClock(T0 + LOCK_STALE_MS + 1)))
    expect(r.unwrap()).toMatchObject({ state: 'live' })
  })

  it('refresh reports a lock another instance took over, and release leaves it alone', async () => {
    await mkdir(join(tmp.dir, 'p'))
    const lock = expectOk(await acquireLock(deps(other)))
    expectOk(await acquireLock(deps(me, () => true, fakeClock(T0 + LOCK_STALE_MS + 1))))
    expectErrCode(await lock.refresh(), 'persist.locked')
    expectOk(await lock.release())
    expect((await readLock()).instanceId).toBe('inst-a')
  })

  it('a failed create returns persist.io and leaves no lock', async () => {
    await mkdir(join(tmp.dir, 'p'))
    const fs = faultFs((op) => (op === 'writeFile' ? 'fail' : undefined))
    expectErrCode(await acquireLock({ ...deps(me), fs }), 'persist.io')
    expect((await inspectLock(deps(me))).unwrap()).toEqual({ state: 'none' })
  })
})
