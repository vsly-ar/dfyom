// Test helpers: temp dirs and a fault-injecting file system. Doc: docs/architecture/persistence.md#files
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { nodeFs, type PersistFs } from './fs'

/**
 * The real file system without the flushes: `fsync`/`fsyncDir` resolve at once. Tests of what
 * persistence does (open, save, recover, lock races) use it; under a busy disk a single flush took
 * up to 80 ms and flushes were 75–85 % of an open's time even idle, which made these tests time out
 * on a loaded machine (docs/conventions/testing.md#load-stable-tests). That the flushes happen, in
 * order, is checked through `faultFs(…).calls` (still recorded); that a real flush works, by
 * fs.test.ts on `nodeFs`.
 */
export const testFs: PersistFs = {
  ...nodeFs,
  fsync: async () => undefined,
  fsyncDir: async () => undefined,
}

/** A fresh temp folder per test; read `.dir` inside tests. */
export function useTempDir(): { dir: string } {
  const state = { dir: '' }
  beforeEach(async () => {
    state.dir = await mkdtemp(join(tmpdir(), 'dfyom-persist-'))
  })
  afterEach(async () => {
    // retries: a store's write may still land while the directory is removed (ENOTEMPTY, X3)
    await rm(state.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
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
  base: PersistFs = testFs,
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
    'readRange',
    'appendFile',
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
export function jitterFs(maxMs = 3, base: PersistFs = testFs): PersistFs {
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
