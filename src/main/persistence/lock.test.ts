import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeClock } from '../../core/commands/testing'
import { noopLogger, type Logger } from '../../shared/logging'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { nodeFs } from './fs'
import { faultFs, useTempDir } from './fs.testing'
import {
  acquireLock,
  inspectLock,
  LOCK_HEARTBEAT_MS,
  LOCK_STALE_MS,
  type LockObservations,
  type LockOwner,
} from './lock'

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
  observed: LockObservations = new Map(),
) {
  return {
    fs: nodeFs,
    path: lockPath(),
    owner,
    clock,
    isPidAlive: alive,
    log: noopLogger,
    observed,
  }
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

  it('takes over a lock whose PID is dead on this host and whose heartbeat missed one interval', async () => {
    await mkdir(join(tmp.dir, 'p'))
    expectOk(await acquireLock(deps(other)))
    const dead = (pid: number) => pid !== 200
    // PID namespaces (Flatpak, Snap) share the host name: a fresh heartbeat wins over the PID.
    expectErrCode(
      await acquireLock(deps(me, dead, fakeClock(T0 + LOCK_HEARTBEAT_MS))),
      'persist.locked',
    )
    const warned: string[] = []
    const lock = expectOk(
      await acquireLock({
        ...deps(me, dead, fakeClock(T0 + LOCK_HEARTBEAT_MS + 1)),
        log: warnLog(warned),
      }),
    )
    expect((await readLock()).instanceId).toBe('inst-a')
    expect(warned).toEqual(['stale lock taken over'])
    expect(lock.owner.instanceId).toBe('inst-a')
  })

  it('a PID of another host is not checked; only the heartbeat decides', async () => {
    await mkdir(join(tmp.dir, 'p'))
    expectOk(await acquireLock(deps({ ...other, host: 'host-2' })))
    expectErrCode(
      await acquireLock(deps(me, () => false, fakeClock(T0 + LOCK_STALE_MS + 1))),
      'persist.locked',
    )
  })

  it("another host's lock is stale once its heartbeat has not changed for 2 min of local time", async () => {
    await mkdir(join(tmp.dir, 'p'))
    // The other host's clock is far ahead; comparing clocks would never find it stale.
    const remote = fakeClock(T0 + 3_600_000)
    const held = expectOk(await acquireLock(deps({ ...other, host: 'host-2' }, () => true, remote)))
    const clock = fakeClock(T0)
    const observed: LockObservations = new Map()
    expectErrCode(await acquireLock(deps(me, () => true, clock, observed)), 'persist.locked')
    clock.advance(LOCK_STALE_MS)
    remote.advance(LOCK_HEARTBEAT_MS)
    expectOk(await held.refresh()) // a heartbeat restarts the observation
    expectErrCode(await acquireLock(deps(me, () => true, clock, observed)), 'persist.locked')
    clock.advance(LOCK_STALE_MS)
    expectErrCode(await acquireLock(deps(me, () => true, clock, observed)), 'persist.locked')
    clock.advance(1)
    expectOk(await acquireLock(deps(me, () => true, clock, observed)))
    expect((await readLock()).instanceId).toBe('inst-a')
  })

  it('two instances taking over the same stale lock at once: exactly one wins', async () => {
    await mkdir(join(tmp.dir, 'p'))
    for (let round = 0; round < 20; round++) {
      await writeFile(
        lockPath(),
        JSON.stringify({
          instanceId: 'dead',
          pid: 1,
          host: 'host-1',
          startedAt: '2026-11-17T09:00:00.000Z',
          heartbeatAt: '2026-11-17T09:00:00.000Z',
        }),
      )
      const owners = ['x', 'y', 'z'].map((id, i) => ({
        instanceId: id,
        pid: 300 + i,
        host: 'host-1',
      }))
      const results = await Promise.all(owners.map((o) => acquireLock(deps(o))))
      const winners = results.filter((r) => r.isOk())
      expect(winners.length, `round ${round}`).toBe(1)
      for (const r of results) if (r.isErr()) expect(r.unwrapErr().code).toBe('persist.locked')
      expect((await readLock()).instanceId).toBe(winners[0]?.unwrap().owner.instanceId)
    }
  })

  it('a refresh racing a takeover leaves exactly one holder', async () => {
    await mkdir(join(tmp.dir, 'p'))
    for (let round = 0; round < 20; round++) {
      // The holder was suspended past the stale limit and refreshes just as `me` takes over.
      const clock = fakeClock(T0)
      const holder = expectOk(await acquireLock(deps(other, () => true, clock)))
      clock.advance(LOCK_STALE_MS + 1)
      const [refreshed, taken] = await Promise.all([
        holder.refresh(),
        acquireLock(deps(me, () => true, clock)),
      ])
      expect(refreshed.isOk() && taken.isOk(), `round ${round}`).toBe(false)
      const file = await readLock()
      if (taken.isOk()) expect(file.instanceId).toBe('inst-a')
      if (refreshed.isOk()) expect(file.instanceId).toBe('inst-b')
      if (taken.isOk()) expectOk(await taken.unwrap().release())
      else expectOk(await holder.release())
      expect((await inspectLock(deps(me))).unwrap()).toEqual({ state: 'none' })
    }
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
    expect((await readdir(join(tmp.dir, 'p'))).sort()).toEqual(['lock.json'])
  })

  it('a failed create returns persist.io and leaves no lock', async () => {
    await mkdir(join(tmp.dir, 'p'))
    const fs = faultFs((op) => (op === 'writeFile' ? 'fail' : undefined))
    expectErrCode(await acquireLock({ ...deps(me), fs }), 'persist.io')
    expect((await inspectLock(deps(me))).unwrap()).toEqual({ state: 'none' })
  })
})
