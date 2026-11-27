/**
 * The interrupted run found at launch (hardening DF129, slice RC6): the run journal left by the
 * last run (a `running` one reads as `appCrashed`: the app or the computer died while it streamed)
 * becomes the last run's record again, `lastRun.interruption` with `launch`, so the recovery panel
 * shows it as after a lost connection: what happened, where the job was, the suggestion (from the
 * kept copy of the original program, checked against the journal's hash), and the project or file
 * to reopen and the connection to come back to (never opened by itself, Q158). Pure and headless:
 * main reads the files and checks what is still there.
 * Doc: docs/modes/run-recovery.md#implementation-rc6
 */
import type { RunJournal } from './journal'
import {
  interruptionOf,
  originalLine,
  type Interruption,
  type LaunchFileState,
  type ResumedOrigin,
} from './interruption'
import type { LastRun, RunProgram } from './service'

export interface LaunchInput {
  /** The journal as read (`loadRunJournal`: a `running` one already reads as `appCrashed`). */
  readonly journal: RunJournal
  /** The kept copy of the run's original program, only when it hashes as the journal says. */
  readonly program?: readonly string[] | undefined
  /** A plan run with a saved project: its file is no longer at its path. */
  readonly projectMissing?: boolean | undefined
  /** A file run: the file at its path, hashed as the journal's program. */
  readonly file?: LaunchFileState | undefined
}

export interface LaunchRecord {
  /** The last run's record, with `interruption.launch`. */
  readonly lastRun: LastRun
  /** The original program for the gCode panel (the kept copy); absent without it. */
  readonly program?: RunProgram | undefined
}

/**
 * The SHA-256 the original program of the journal's run must have: the program's own, or for a
 * run that started at a line the program it started in (`resumed.programHash`).
 */
export function originalProgramHash(j: RunJournal): string | undefined {
  return j.job.resumed === undefined ? j.job.programHash : j.job.resumed.programHash
}

/**
 * The record of the journal's run as the recovery panel needs it, or undefined when it needs
 * none (a run that ended `done`, `stopped` or `failed`: nothing to recover).
 */
export function launchRecord(input: LaunchInput): LaunchRecord | undefined {
  const j = input.journal
  if (j.state !== 'interrupted' || j.reason === undefined) return undefined
  const lines = input.program
  const r = j.job.resumed
  const plan = j.job.plan
  const hash = originalProgramHash(j)
  // a run started at a line maps its lines back even without the copy (no points then)
  const resumed: ResumedOrigin | undefined =
    r === undefined
      ? undefined
      : {
          fromLine: r.fromLine,
          leadIn: r.leadIn,
          lines: lines ?? [],
          ...(r.operationStarts === undefined ? {} : { operationStarts: r.operationStarts }),
        }
  const base = interruptionOf(j, j.reason, {
    program: lines ?? [],
    operationStarts: plan?.operations.map((o) => o.fromLine),
    origin: {
      ...(hash === undefined ? {} : { programHash: hash }),
      ...(resumed === undefined ? {} : { resumed }),
    },
  })
  const project = j.job.project
  const m = j.machine
  const interruption: Interruption = {
    ...base,
    // without the copy the line count is the journal's (unknown for a run started at a line)
    ...(lines === undefined ? { lines: r === undefined ? j.job.lines : 0 } : {}),
    launch: {
      machine: {
        target: m.target,
        ...(m.port === undefined ? {} : { port: { ...m.port } }),
        ...(m.usb === undefined ? {} : { usb: { ...m.usb } }),
      },
      ...(project === undefined
        ? {}
        : {
            project: {
              id: project.id,
              ...(project.path === undefined ? {} : { path: project.path }),
              missing: project.path !== undefined && input.projectMissing === true,
            },
          }),
      ...(plan === undefined
        ? {}
        : {
            plan: {
              planName: plan.planName,
              setupName: plan.setupName,
              setup: plan.setup,
              setups: plan.setups,
            },
          }),
      ...(j.job.file === undefined ? {} : { file: input.file ?? 'missing' }),
      program: lines !== undefined,
    },
  }
  const lastRun: LastRun = {
    jobId: j.job.jobId,
    ...(plan === undefined
      ? {}
      : {
          planId: plan.planId,
          setupId: plan.setupId,
          ...(plan.planHash === undefined ? {} : { planHash: plan.planHash }),
          operations: plan.operations.map((o) => o.planOperationId),
        }),
    ...(j.job.file === undefined ? {} : { file: { ...j.job.file } }),
    outcome: 'failed',
    interruption,
  }
  if (lines === undefined) return { lastRun }
  // the original program's sections and operations: a run started at a line has them shifted
  // past its lead-in (the lead-in's own section dropped)
  const back = (l: number) => originalLine(l, resumed)
  const sections = j.job.sections
    .filter((s) => r === undefined || !(s.label === 'Lead-in' && s.fromLine === 1))
    .map((s) => ({ fromLine: back(s.fromLine), label: s.label }))
  const operations = (plan?.operations ?? []).map((o) => ({
    planOperationId: o.planOperationId,
    fromLine: back(o.fromLine),
  }))
  return { lastRun, program: { jobId: j.job.jobId, lines, sections, operations } }
}
