// The run journal file `<appData>/run-journal.json` (hardening DF129, RC1): main's writer behind
// the core's `RunJournalPort`. Saves are atomic (temp, fsync, rename: a crash leaves the previous
// complete journal) and serialized, the latest journal winning when saves queue up; a failed write
// is logged once per run and never blocks it. Reading discards an unreadable journal; a `running`
// one reads as `interrupted` / `appCrashed` (the app or the computer died during the run).
// RC6: the run's original program is kept next to it (`run-program.nc`, written once at the
// start), and `readLaunchRecord` turns what the last run left into the recovery panel's record.
// Doc: docs/modes/run-recovery.md#what-dfyom-keeps, #implementation-rc6 · contract: src/core/run/journal.ts
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Logger } from '../../shared/logging'
import { parseWith } from '../../shared/parse'
import { tryCatch } from '../../shared/result'
import { prepareGcodeFile } from '../../core/run/gcode-file'
import type { LaunchFileState } from '../../core/run/interruption'
import { RunJournalSchema, type RunJournal, type RunJournalPort } from '../../core/run/journal'
import { launchRecord, originalProgramHash, type LaunchRecord } from '../../core/run/launch'
import { errnoCode, nodeFs, writeFileAtomic, type PersistFs } from './fs'
import { readGcodeFile } from './gcode-file'

export const RUN_JOURNAL_FILE = 'run-journal.json'
/** DF129 RC6: the run's original program, as streamed lines joined with LF. */
export const RUN_PROGRAM_FILE = 'run-program.nc'

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
  const programFile = join(o.appData, RUN_PROGRAM_FILE)
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
    // RC6: queued before the start's journal (a crash between them leaves a copy whose hash
    // does not match the journal: no suggestion, nothing wrong)
    saveProgram(lines) {
      const text = lines.join('\n')
      tail = tail.then(async () => {
        const r = await writeFileAtomic(fs, programFile, text)
        if (r.isErr())
          o.log.warn({ file: programFile, err: r.unwrapErr().toJSON() }, 'run program not kept')
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
  for (const name of [RUN_JOURNAL_FILE, RUN_PROGRAM_FILE]) {
    const file = join(appData, name)
    try {
      await fs.unlink(file)
    } catch (e) {
      // the program copy may never have been written (a virtual run, an older journal)
      if (name === RUN_JOURNAL_FILE || errnoCode(e) !== 'ENOENT')
        log.warn({ file, err: String(e) }, 'run journal not removed')
    }
  }
}

/** The text of a file, or undefined when it cannot be read. */
async function readText(fs: PersistFs, file: string): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await fs.readFile(file))
  } catch {
    return undefined
  }
}

/**
 * DF129 RC6: the interrupted run the last session left, as the recovery panel's record, or
 * undefined (no journal, or a run that ended without an interruption). The kept program counts
 * only when it hashes as the journal says; a plan run's project file and a file run's file are
 * looked up (the file hashed as read for a run, Q170).
 * Doc: docs/modes/run-recovery.md#implementation-rc6
 */
export async function readLaunchRecord(
  appData: string,
  log: Logger,
  fs: PersistFs = nodeFs,
): Promise<LaunchRecord | undefined> {
  const journal = await loadRunJournal(appData, log, fs)
  if (journal === undefined || journal.state !== 'interrupted') return undefined
  const expected = originalProgramHash(journal)
  const kept = await readText(fs, join(appData, RUN_PROGRAM_FILE))
  const program =
    kept !== undefined && expected !== undefined && sha256(kept) === expected
      ? kept.split('\n')
      : undefined
  if (kept !== undefined && program === undefined)
    log.warn({ jobId: journal.job.jobId }, 'kept run program does not match the journal')
  const projectPath = journal.job.project?.path
  const projectMissing =
    projectPath === undefined
      ? undefined
      : (await fs.stat(projectPath).catch(() => undefined)) === undefined
  let file: LaunchFileState | undefined
  if (journal.job.file !== undefined) {
    const text = await readGcodeFile(fs, journal.job.file.path)
    file = text.isErr()
      ? 'missing'
      : expected !== undefined &&
          sha256(prepareGcodeFile(text.unwrap()).lines.join('\n')) === expected
        ? 'same'
        : 'changed'
  }
  return launchRecord({ journal, program, projectMissing, file })
}
