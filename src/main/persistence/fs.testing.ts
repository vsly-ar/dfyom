// Test helpers: temp dirs and a fault-injecting file system. Doc: docs/architecture/persistence.md#files
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { nodeFs, type PersistFs } from './fs'

/** A fresh temp folder per test; read `.dir` inside tests. */
export function useTempDir(): { dir: string } {
  const state = { dir: '' }
  beforeEach(async () => {
    state.dir = await mkdtemp(join(tmpdir(), 'dfyom-persist-'))
  })
  afterEach(async () => {
    await rm(state.dir, { recursive: true, force: true })
  })
  return state
}

export type FsOp = keyof PersistFs

/**
 * `fail`: this call throws (EIO), later calls work – an I/O error.
 * `crash`: this and every later call throw – the process was killed here; nothing after it,
 * not even cleanup, reaches the disk.
 */
export type Fault = 'fail' | 'crash' | undefined

export interface FaultFs extends PersistFs {
  /** Calls made so far, as `op path`. */
  readonly calls: readonly string[]
  readonly crashed: boolean
}

export function faultFs(
  inject: (op: FsOp, path: string, n: number) => Fault,
  base: PersistFs = nodeFs,
): FaultFs {
  const calls: string[] = []
  let crashed = false
  const wrap =
    <K extends FsOp>(op: K) =>
    async (...args: Parameters<PersistFs[K]>): Promise<Awaited<ReturnType<PersistFs[K]>>> => {
      const path = String(args[0])
      calls.push(`${op} ${path}`)
      if (crashed) throw Object.assign(new Error('process killed'), { code: 'EKILLED' })
      const fault = inject(op, path, calls.length)
      if (fault === 'crash') {
        crashed = true
        throw Object.assign(new Error('process killed'), { code: 'EKILLED' })
      }
      if (fault === 'fail')
        throw Object.assign(new Error(`injected ${op} failure`), { code: 'EIO' })
      const fn = base[op] as (...a: Parameters<PersistFs[K]>) => ReturnType<PersistFs[K]>
      return (await fn(...args)) as Awaited<ReturnType<PersistFs[K]>>
    }
  const ops: FsOp[] = [
    'readFile',
    'writeFile',
    'fsync',
    'fsyncDir',
    'rename',
    'rm',
    'mkdir',
    'readdir',
    'stat',
    'lstat',
    'unlink',
    'copyFile',
    'link',
    'realpath',
  ]
  const fs = Object.fromEntries(ops.map((op) => [op, wrap(op)])) as unknown as PersistFs
  return Object.defineProperties(fs, {
    calls: { get: () => calls },
    crashed: { get: () => crashed },
  }) as FaultFs
}

/** Waits 0–`maxMs` ms (random) before every call: interleaves concurrent races in tests. */
export function jitterFs(maxMs = 3, base: PersistFs = nodeFs): PersistFs {
  const wait = () => new Promise((r) => setTimeout(r, Math.random() * maxMs))
  return Object.fromEntries(
    Object.entries(base).map(([op, fn]) => [
      op,
      async (...args: unknown[]) => {
        await wait()
        return (fn as (...a: unknown[]) => unknown)(...args)
      },
    ]),
  ) as unknown as PersistFs
}
