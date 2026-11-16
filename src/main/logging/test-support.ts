// Shared setup for the main-logging tests (temp folder, logger, JSON lines).
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { createMainLogging, type MainLogging } from './logger'

export const ID = '0f8e2a4c-1b2d-4e6f-8a9b-0c1d2e3f4a5b'
export const NAME = `2026-11-16T10-20-30Z-${ID}`

/** Creates a fresh temp folder per test; read `.dir` inside tests. */
export function useTempDir(): { dir: string } {
  const state = { dir: '' }
  beforeEach(async () => {
    state.dir = await mkdtemp(join(tmpdir(), 'dfyom-log-'))
  })
  afterEach(async () => {
    await rm(state.dir, { recursive: true, force: true })
  })
  return state
}

export const lines = async (file: string): Promise<Record<string, unknown>[]> =>
  (await readFile(file, 'utf8'))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)

export const openLogging = (
  dir: string,
  extra: { rotateBytes?: number } = {},
): Promise<MainLogging> =>
  createMainLogging({
    dir,
    level: 'info',
    instance: ID,
    app: '0.0.0',
    proc: 'main',
    startedAt: new Date('2026-11-16T10:20:30.123Z'),
    ...extra,
  })
