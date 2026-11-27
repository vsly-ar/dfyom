// The run journal file `<appData>/run-journal.json` (hardening DF129, RC1): main's writer behind
// the core's `RunJournalPort`. Saves are atomic (temp, fsync, rename: a crash leaves the previous
// complete journal) and serialized, the latest journal winning when saves queue up; a failed write
// is logged once per run and never blocks it. Reading discards an unreadable journal; a `running`
// one reads as `interrupted` / `appCrashed` (the app or the computer died during the run).
// Doc: docs/modes/run-recovery.md#what-dfyom-keeps · contract: src/core/run/journal.ts
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Logger } from '../../shared/logging'
import { parseWith } from '../../shared/parse'
import { tryCatch } from '../../shared/result'
import { RunJournalSchema, type RunJournal, type RunJournalPort } from '../../core/run/journal'
import { errnoCode, nodeFs, writeFileAtomic, type PersistFs } from './fs'

export const RUN_JOURNAL_FILE = 'run-journal.json'

export interface RunJournalStore extends RunJournalPort {
  /** Resolves when every queued save has finished (tests, quit). */
  flush(): Promise<void>
}

/** SHA-256 (hex) of a program's text, for the journal's `programHash`. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function createRunJournalStore(o: {
  readonly appData: string
  readonly log: Logger
  readonly fs?: PersistFs
}): RunJournalStore {
  const fs = o.fs ?? nodeFs
  const file = join(o.appData, RUN_JOURNAL_FILE)
  let tail: Promise<void> = Promise.resolve()
  /** The journal to write next; saves while a write runs replace it (latest wins). */
  let next: RunJournal | undefined
  /** The job whose failed write was logged (once per run). */
  let warned: string | undefined
  return {
    save(journal) {
      const queued = next !== undefined
      next = journal
      if (queued) return
      tail = tail.then(async () => {
        const j = next
        next = undefined
        if (j === undefined) return
        const r = await writeFileAtomic(fs, file, `${JSON.stringify(j)}\n`)
        if (r.isErr() && warned !== j.job.jobId) {
          warned = j.job.jobId
          o.log.warn({ file, err: r.unwrapErr().toJSON() }, 'run journal not saved')
        }
      })
    },
    // after any queued save: "Dismiss" in the recovery panel (DF129 RC5)
    discard() {
      next = undefined
      tail = tail.then(() => discardRunJournal(o.appData, o.log, fs))
    },
    flush: () => tail,
  }
}

/**
 * The journal left by the last run, if any. Unreadable or another format: removed and logged at
 * warn (pre-alpha, no migration). A `running` journal means the app or computer died while a run
 * streamed: it reads as `interrupted` with reason `appCrashed`.
 */
export async function loadRunJournal(
  appData: string,
  log: Logger,
  fs: PersistFs = nodeFs,
): Promise<RunJournal | undefined> {
  const file = join(appData, RUN_JOURNAL_FILE)
  let text: string
  try {
    text = new TextDecoder().decode(await fs.readFile(file))
  } catch (e) {
    if (errnoCode(e) !== 'ENOENT') log.warn({ file, err: String(e) }, 'run journal unreadable')
    return undefined
  }
  const parsed = tryCatch(() => JSON.parse(text) as unknown, 'input.malformed', 'not JSON').andThen(
    (raw) => parseWith(RunJournalSchema, raw, 'loadRunJournal'),
  )
  if (parsed.isErr()) {
    log.warn({ file, err: parsed.unwrapErr().toJSON() }, 'run journal invalid; discarded')
    await discardRunJournal(appData, log, fs)
    return undefined
  }
  const j = parsed.unwrap()
  return j.state === 'running' ? { ...j, state: 'interrupted', reason: 'appCrashed' } : j
}

/** Removes the journal ("Dismiss" in the recovery panel, RC5; an unreadable one). */
export async function discardRunJournal(
  appData: string,
  log: Logger,
  fs: PersistFs = nodeFs,
): Promise<void> {
  const file = join(appData, RUN_JOURNAL_FILE)
  try {
    await fs.unlink(file)
  } catch (e) {
    log.warn({ file, err: String(e) }, 'run journal not removed')
  }
}
