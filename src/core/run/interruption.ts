/**
 * The interruption record of the last run (hardening DF129, slice RC5): what the recovery panel and
 * agents read in `run.status.get` → `lastRun.interruption` – why the run ended without DFYOM
 * wanting it to, where the machine was (the last report, the tool, the operation, the spindle),
 * the range of lines that may have been running, and the suggested resume point (Q160). Every
 * line is a line of the **original** program: a run that itself started at a line (a lead-in plus
 * the program from the line on) is mapped back, so a resume always refers to the program as
 * exported or read. Pure and headless; `MachineClient` builds it from the run record (journal.ts).
 * Doc: docs/modes/run-recovery.md#agent-api, #implementation-rc5
 */
import { z } from 'zod'
import { Vec3Schema } from './host/protocol'
import type { RunJournal } from './journal'
import { resumePoints, scanProgram, suggestResume, type ResumePoint } from './recovery'

/** Why a run ended without DFYOM wanting it to (docs/modes/run-recovery.md#what-dfyom-keeps). */
export const INTERRUPTION_REASONS = [
  'connectionLost',
  'controllerReset',
  'hostExit',
  'machinePowerLost',
  'appCrashed',
] as const
export type InterruptionReason = (typeof INTERRUPTION_REASONS)[number]

/**
 * Where the executing line comes from: `reported` – GRBL's `Ln:` (a controller built with line
 * numbers, a program with `N` words); `estimate` – DF84's estimate from `Bf` and the position;
 * `planner` – the acknowledged lines minus a full planner (no estimate yet).
 */
export const EXECUTING_SOURCES = ['reported', 'estimate', 'planner'] as const

const PointSchema = z.object({
  line: z.number().int(),
  kind: z.enum(['operation', 'pass']),
  label: z.string().exactOptional(),
})

/** `lastRun.interruption` (docs/modes/run-recovery.md#agent-api). Lines: the original program's. */
export const InterruptionSchema = z.object({
  reason: z.enum(INTERRUPTION_REASONS),
  /** ISO time the run ended (main's clock); `startedAt` when it started. */
  at: z.string(),
  startedAt: z.string(),
  /** Lines of the original program. */
  lines: z.number().int(),
  /** Written to the controller: the upper bound of where it stopped. */
  sent: z.number().int(),
  /** Acknowledged (in the planner). */
  acknowledged: z.number().int(),
  /** Moving at the last report (0: none yet): the lower bound. */
  executing: z.number().int(),
  executingFrom: z.enum(EXECUTING_SOURCES),
  /** The last status report of the run (mm, machine and work). */
  lastReport: z
    .object({
      at: z.string(),
      state: z.string(),
      mpos: Vec3Schema,
      wpos: Vec3Schema,
      feed: z.number(),
      spindle: z.number(),
    })
    .exactOptional(),
  /** G54 (machine, mm) at the run's start and as last reported. */
  workZero: z.object({ start: Vec3Schema, last: Vec3Schema }),
  tool: z.object({ n: z.number().int(), name: z.string() }).exactOptional(),
  /** The plan operation and the section label (operation or tool run) at the executing line. */
  operation: z
    .object({ planOperationId: z.string().exactOptional(), label: z.string().exactOptional() })
    .exactOptional(),
  /** The programmed spindle at the executing line (rpm; `off` when stopped). */
  spindle: z.object({ dir: z.enum(['off', 'cw', 'ccw']), rpm: z.number() }),
  /** SHA-256 of the original program: pass it with `fromLine` to `run.job.start`. */
  programHash: z.string().exactOptional(),
  /** The suggested resume point (Q160) and the operation start it belongs to ("safest"). */
  suggestion: PointSchema.exactOptional(),
  safest: PointSchema.exactOptional(),
})
export type Interruption = z.output<typeof InterruptionSchema>

/**
 * A run that started at a line (DF129 RC2): the original program's lines and resume points, and
 * how the streamed program maps to it (`leadIn` lines, then the original from `fromLine` on).
 */
export interface ResumedOrigin {
  readonly fromLine: number
  readonly leadIn: number
  readonly lines: readonly string[]
  /** A plan's operation lines in the original program (`resumePoints`' operation starts). */
  readonly operationStarts?: readonly number[] | undefined
}

/** What the run's lines refer to: the original program's hash, and its lead-in when resumed. */
export interface RunOrigin {
  readonly programHash?: string | undefined
  readonly resumed?: ResumedOrigin | undefined
}

/**
 * Line `line` (1-based) of the streamed program as a line of the original program: a lead-in line
 * is the resume line itself (nothing of the program ran yet), a later one shifted back; 0 stays 0.
 */
export function originalLine(line: number, resumed: ResumedOrigin | undefined): number {
  if (resumed === undefined || line <= 0) return line
  if (line <= resumed.leadIn) return resumed.fromLine
  return line - resumed.leadIn + resumed.fromLine - 1
}

const pointOf = (p: ResumePoint): z.output<typeof PointSchema> => ({
  line: p.line,
  kind: p.kind,
  ...(p.label === undefined ? {} : { label: p.label }),
})

/**
 * The interruption of a run from its final record (`state: interrupted`, or a Stop the operator
 * then marked `machinePowerLost`): lines mapped to the original program, and the suggestion –
 * the latest resume point at or before the lower bound (Q160); for `machinePowerLost` the
 * operation start, since the progress after the power went is fiction (Q171). `program`: the
 * streamed program's lines; `operationStarts`: a plan's operation lines in it (not resumed).
 */
export function interruptionOf(
  record: RunJournal,
  reason: InterruptionReason,
  input: {
    readonly program: readonly string[]
    readonly operationStarts?: readonly number[] | undefined
    readonly origin?: RunOrigin | undefined
    /** The run was waiting at a tool change or pause when it ended. */
    readonly waiting?: boolean | undefined
  },
): Interruption {
  const resumed = input.origin?.resumed
  const map = (l: number) => originalLine(l, resumed)
  const p = record.progress
  const lines = resumed?.lines ?? input.program
  const scan = scanProgram(lines)
  const points = resumePoints(
    scan,
    resumed !== undefined
      ? resumed.operationStarts === undefined
        ? {}
        : { operationStarts: resumed.operationStarts }
      : input.operationStarts === undefined || input.operationStarts.length === 0
        ? {}
        : { operationStarts: input.operationStarts },
  )
  // a resumed run's own start line is a point to come back to (an interruption in its lead-in
  // suggests the same start again, docs/modes/run-recovery.md#edge-cases)
  if (resumed !== undefined && !points.some((x) => x.line === resumed.fromLine)) {
    const i = points.findIndex((x) => x.line > resumed.fromLine)
    points.splice(i < 0 ? points.length : i, 0, { line: resumed.fromLine, kind: 'pass' })
  }
  const executing = map(p.executing)
  const acknowledged = map(p.acknowledged)
  const s = suggestResume(points, {
    executing,
    acknowledged,
    ...(input.waiting === true ? { waitingAt: acknowledged } : {}),
  })
  const suggestion = reason === 'machinePowerLost' ? s?.safest : s?.suggestion
  const section =
    record.position.section === 'Lead-in'
      ? record.job.sections.find((x) => x.label !== 'Lead-in')?.label
      : record.position.section
  const r = record.lastReport
  const op = record.position.planOperationId
  const hash =
    input.origin?.programHash ?? (resumed === undefined ? record.job.programHash : undefined)
  return {
    reason,
    at: record.updatedAt,
    startedAt: record.startedAt,
    lines: lines.length,
    sent: map(p.sent),
    acknowledged,
    executing,
    executingFrom: p.executingFrom,
    ...(r === undefined
      ? {}
      : {
          lastReport: {
            at: r.at,
            state: r.state,
            mpos: r.mpos,
            wpos: r.wpos,
            feed: r.feed,
            spindle: r.spindle,
          },
        }),
    workZero: { start: record.workZero.start, last: record.workZero.last },
    ...(record.position.tool === undefined ? {} : { tool: { ...record.position.tool } }),
    ...(op === undefined && section === undefined
      ? {}
      : {
          operation: {
            ...(op === undefined ? {} : { planOperationId: op }),
            ...(section === undefined ? {} : { label: section }),
          },
        }),
    spindle: { dir: record.position.modal.spindle, rpm: record.position.modal.spindleSpeed },
    ...(hash === undefined ? {} : { programHash: hash }),
    ...(suggestion === undefined ? {} : { suggestion: pointOf(suggestion) }),
    ...(s === undefined ? {} : { safest: pointOf(s.safest) }),
  }
}
