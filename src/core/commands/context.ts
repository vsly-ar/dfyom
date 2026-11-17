/**
 * What a handler may use besides its args: source, ids, clock and injected service ports.
 * Doc: docs/architecture/commands.md#command-definition
 *
 * Ports keep src/core headless: each process injects its own implementations.
 */
import type { EntryPoint } from '../../shared/boundary'
import type { Library } from '../library/library'
import type { ProjectSession } from '../project/storage'
import type { WorkerPort } from './jobs'

/**
 * A per-session identity: one window, MCP session, CLI invocation or script run.
 * Doc: docs/architecture/commands.md#stale-writes
 */
export interface Source {
  readonly kind: EntryPoint['kind']
  readonly id: string
}

/** Stable map key of a source. */
export function sourceKey(s: Source): string {
  return `${s.kind}:${s.id}`
}

export function sameSource(a: Source, b: Source): boolean {
  return a.kind === b.kind && a.id === b.id
}

/** Generates ids for new records; deterministic in tests (`fakeIds` in testing.ts). */
export interface IdGenerator {
  next(prefix: string): string
}

/** Wall clock in epoch milliseconds; fake in tests. */
export interface Clock {
  now(): number
}

/**
 * Injected service ports. The machine port arrives with run mode (task 3.9).
 */
export interface Services {
  readonly workers: WorkerPort
  /** The shared library (docs/architecture/library.md#storage); absent = library commands fail. */
  readonly library?: Library
  /** Persistence of the open project (docs/architecture/persistence.md); absent in tests. */
  readonly project?: ProjectSession
}

export interface CommandContext {
  readonly source: Source
  readonly ids: IdGenerator
  readonly clock: Clock
  readonly services: Services
}

/** Progress of a job; `total` unknown for indeterminate work. */
export interface JobProgress {
  readonly done: number
  readonly total?: number
  readonly label?: string
}

export interface JobContext extends CommandContext {
  readonly signal: AbortSignal
  readonly progress: (p: JobProgress) => void
  /** Resolves when the job is not paused; rejects with an `AbortError` once aborted. */
  readonly checkpoint: () => Promise<void>
}

export interface QueryContext {
  readonly source: Source
  readonly services: Services
}

export const systemIds: IdGenerator = { next: (prefix) => `${prefix}-${crypto.randomUUID()}` }
export const systemClock: Clock = { now: () => Date.now() }
