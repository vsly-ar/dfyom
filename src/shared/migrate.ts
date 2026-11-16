// Generic step-by-step schema migration runner. Doc: docs/conventions/error-handling/migrations.md
import type { IssuePath } from './errors/app-error'
import { Err, fail, Ok, tryCatch, type AppResult } from './result'

/** Recorded when a migration had to change user data (shown to the user on open, logged). */
export interface MigrationNote {
  readonly from: number
  readonly path: IssuePath
  readonly message: string
}

export interface Migrated<T> {
  readonly value: T
  readonly notes: readonly MigrationNote[]
}

/** One step vN → vN+1. Pure DTO → DTO; never constructs models. */
export interface Migration {
  readonly from: number
  readonly describe: string
  readonly up: (doc: unknown, notes: MigrationNote[]) => AppResult<unknown>
}

export interface MigrationPlan {
  /** Document kind, used in error frames, e.g. 'project'. */
  readonly document: string
  readonly current: number
  readonly migrations: readonly Migration[]
}

function readVersion(raw: unknown): AppResult<number> {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'schemaVersion' in raw &&
    Number.isInteger(raw.schemaVersion)
  ) {
    return Ok(raw.schemaVersion as number)
  }
  return fail('input.malformed', 'document has no integer schemaVersion')
}

/**
 * Upgrades `raw` to `plan.current`, step by step. The result is still `unknown`:
 * shape-check it with `parseWith(CurrentDocSchema, …)` before building models.
 */
export function migrate(raw: unknown, plan: MigrationPlan): AppResult<Migrated<unknown>> {
  const where = `migrate:${plan.document}`
  const v = readVersion(raw)
  if (v.isErr()) return Err(v.unwrapErr().withContext(where))
  let version = v.unwrap()
  if (version > plan.current) {
    return fail(
      'persist.migration',
      `${plan.document} schema ${version} is newer than this app (${plan.current})`,
      { where, data: { version, current: plan.current } },
    )
  }
  const notes: MigrationNote[] = []
  let doc: unknown = raw
  while (version < plan.current) {
    const step = plan.migrations.find((m) => m.from === version)
    if (step === undefined) {
      return fail('persist.migration', `no ${plan.document} migration from schema ${version}`, {
        where,
        data: { version },
      })
    }
    // A migration that throws is a bug; classify it instead of crashing the load.
    const out = tryCatch(
      () => step.up(doc, notes),
      'persist.migration',
      `migration from v${version} threw`,
    ).andThen((r) => r)
    if (out.isErr()) {
      return Err(out.unwrapErr().withContext(where, { from: version, step: step.describe }))
    }
    doc = out.unwrap()
    version += 1
  }
  return Ok({ value: doc, notes })
}
