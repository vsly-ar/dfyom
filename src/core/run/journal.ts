/**
 * The run record and journal (hardening DF129, slice RC1): what DFYOM keeps about a streaming job
 * so that a run that ends without DFYOM wanting it to can be recovered: the sent, acknowledged and
 * executing lines, the last status report, the work zero, the tool, the operation and the modal
 * state at the executing line. `RunRecorder` builds it in main (`MachineClient`) from the host's
 * status, progress and phases; main writes it through `RunJournalPort` (a real connection only),
 * throttled by `JournalThrottle`. Headless: the file IO is main's (src/main/persistence/run-journal.ts).
 * Doc: docs/modes/run-recovery.md#what-dfyom-keeps, #implementation-rc1
 */
import { z } from 'zod'
import type { SenderProgram } from './grbl/sender'
import type { ParserState } from './grbl/emulator/gcode'
import { PLANNER_BLOCKS, type Vec3 } from './grbl/emulator/planner'
import { DEFAULT_ARC_TOLERANCE } from './executing'
import { initialModal, stepModal, type ModalState } from './recovery'
import {
  PortSchema,
  TARGET_KINDS,
  Vec3Schema,
  type HostStatus,
  type TargetKind,
} from './host/protocol'
import { RunFileSchema, RunPlanSchema, type FileJobAbout, type JobAbout } from './service'

/** The journal's own format; another one at launch is discarded (pre-alpha, no migration). */
export const JOURNAL_FORMAT = 1

/** At most one periodic write per this many ms (Q159); events write at once. */
export const JOURNAL_INTERVAL_MS = 1000

/** Why a run ended without DFYOM wanting it to (docs/modes/run-recovery.md#what-dfyom-keeps). */
export const INTERRUPTION_REASONS = [
  'connectionLost',
  'controllerReset',
  'hostExit',
  'machinePowerLost',
  'appCrashed',
] as const
export type InterruptionReason = (typeof INTERRUPTION_REASONS)[number]

export const JOURNAL_STATES = ['running', 'interrupted', 'stopped', 'failed', 'done'] as const
export type JournalState = (typeof JOURNAL_STATES)[number]

/**
 * Where the executing line comes from: `reported` – GRBL's `Ln:` (a controller built with line
 * numbers, a program with `N` words); `estimate` – DF84's estimate from `Bf` and the position;
 * `planner` – the acknowledged lines minus a full planner (no estimate yet).
 */
export const EXECUTING_SOURCES = ['reported', 'estimate', 'planner'] as const

/**
 * Motion lines GRBL may hold besides the one moving: its planner plans up to 15 blocks ahead; one
 * more for margin (as `PLANNER_LINES` of host/client.ts, M5).
 */
const PLANNER_MARGIN_LINES = PLANNER_BLOCKS + 1

const Num = z.number().refine(Number.isFinite, 'must be finite')
const Line = z.number().int().min(0)
const Time = z.string().max(40)

export const RunJournalSchema = z.object({
  format: z.literal(JOURNAL_FORMAT),
  state: z.enum(JOURNAL_STATES),
  /** With `interrupted`. */
  reason: z.enum(INTERRUPTION_REASONS).exactOptional(),
  startedAt: Time,
  updatedAt: Time,
  job: z.object({
    jobId: z.string().max(200),
    /** `program`: a job started without a plan or a file (agents, tests). */
    kind: z.enum(['plan', 'file', 'program']),
    plan: RunPlanSchema.extend({
      planHash: z.string().max(200).exactOptional(),
      operations: z
        .array(z.object({ planOperationId: z.string().max(200), fromLine: Line }))
        .readonly(),
    }).exactOptional(),
    file: RunFileSchema.exactOptional(),
    /** SHA-256 (hex) of the program's lines joined with `\n`; absent where main cannot hash. */
    programHash: z.string().max(100).exactOptional(),
    lines: Line,
    sections: z.array(z.object({ fromLine: Line, label: z.string().max(500) })).readonly(),
    toolChanges: z
      .array(z.object({ line: Line, n: z.number().int(), name: z.string().max(500) }))
      .readonly(),
  }),
  machine: z.object({
    target: z.enum(TARGET_KINDS),
    port: PortSchema.exactOptional(),
    machineKey: z.string().max(200),
    /** From the controller's `$$`: the travel and the homing corner (docs/modes/run.md DF33). */
    envelope: z
      .object({ travel: Vec3Schema, homingMask: z.number().int(), pullOff: Num })
      .exactOptional(),
  }),
  /** G54 in machine coordinates (mm): at the start and as last reported. */
  workZero: z.object({ start: Vec3Schema, last: Vec3Schema }),
  progress: z.object({
    /** Lines written to the controller: the upper bound of where it stopped. */
    sent: Line,
    /** Lines the controller acknowledged (took into its planner). */
    acknowledged: Line,
    /** The 1-based line moving at the last report (0: none yet): the lower bound. */
    executing: Line,
    executingFrom: z.enum(EXECUTING_SOURCES),
    sentAt: Time,
    acknowledgedAt: Time,
    executingAt: Time,
  }),
  /** The last status report while the job ran (positions in mm). */
  lastReport: z
    .object({
      at: Time,
      state: z.string().max(50),
      mpos: Vec3Schema,
      wpos: Vec3Schema,
      wco: Vec3Schema,
      feed: Num,
      spindle: Num,
      overrides: z.object({ feed: Num, rapid: Num, spindle: Num }).exactOptional(),
      buffer: z.object({ blocks: Num, rx: Num }).exactOptional(),
    })
    .exactOptional(),
  /** At the executing line: the tool, the operation or section, and the modal state it starts in. */
  position: z.object({
    tool: z.object({ n: z.number().int(), name: z.string().max(500) }).exactOptional(),
    planOperationId: z.string().max(200).exactOptional(),
    section: z.string().max(500).exactOptional(),
    modal: z.object({
      motion: Num,
      units: z.enum(['mm', 'inch']),
      distance: z.enum(['absolute', 'incremental']),
      /** mm/min; 0 = none programmed yet. */
      feed: Num,
      spindle: z.enum(['off', 'cw', 'ccw']),
      spindleSpeed: Num,
      /** The last `T` word (0 = none). */
      toolWord: z.number().int(),
      /** `G17` (RC2). */
      plane: z.union([z.literal(17), z.literal(18), z.literal(19)]),
      /** `M7` mist and `M8` flood (RC2). */
      coolant: z.object({ mist: z.boolean(), flood: z.boolean() }),
    }),
  }),
})
export type RunJournal = z.output<typeof RunJournalSchema>

/**
 * Main's writer of the run journal (`<appData>/run-journal.json`): saves atomically, the latest
 * journal wins when writes queue up; never throws and never blocks the run (a failed write is
 * logged). Implemented in src/main/persistence/run-journal.ts.
 */
export interface RunJournalPort {
  save(journal: RunJournal): void
}

/** At most one periodic write per `intervalMs` (Q159); an event write always goes and restarts it. */
export class JournalThrottle {
  private last = -Infinity

  constructor(private readonly intervalMs = JOURNAL_INTERVAL_MS) {}

  /** Whether to write at `now` (ms): always for an `event`, else once `intervalMs` has passed. */
  take(now: number, event = false): boolean {
    if (!event && now - this.last < this.intervalMs) return false
    this.last = now
    return true
  }
}

/** DFYOM's tool-change marker as a whole line (grbl.md#output-dialect; the sender's `MARKER`). */
const MARKER = /^\(DFYOM TOOL CHANGE (\d+): ([^()]*)\)$/
/** A line number word at the start of a line (`N120 G1 X5`). */
const N_WORD = /^\s*N(\d+)/i

/** The tool changes of a program: the marker's 1-based line, the tool number and name. */
export function toolChanges(lines: readonly string[]): { line: number; n: number; name: string }[] {
  const out: { line: number; n: number; name: string }[] = []
  lines.forEach((l, i) => {
    const m = MARKER.exec(l)
    if (m !== null) out.push({ line: i + 1, n: Number(m[1]), name: m[2] ?? '' })
  })
  return out
}

/**
 * The 1-based line of each `N` number, when the program numbers its lines uniquely and ascending
 * (GRBL's `Ln:` reports the `N` word, not the line); `undefined` otherwise, and `Ln:` is not used.
 */
export function lineNumberIndex(lines: readonly string[]): Map<number, number> | undefined {
  const index = new Map<number, number>()
  let last = -1
  lines.forEach((l, i) => {
    const m = N_WORD.exec(l)
    if (m === null || last === -2) return
    const n = Number(m[1])
    if (n <= last) last = -2
    else {
      last = n
      index.set(n, i + 1)
    }
  })
  return last === -2 || index.size === 0 ? undefined : index
}

/**
 * The executing line by source (docs/modes/run-recovery.md#what-dfyom-can-know-about-where-the-job-stopped):
 * GRBL's `Ln:` mapped to a line, else DF84's estimate, else the acknowledged lines minus a full
 * planner (erring early). Never after the acknowledged lines.
 */
export function executingLine(input: {
  readonly acknowledged: number
  readonly estimate?: number | undefined
  readonly reported?: number | undefined
  readonly index?: ReadonlyMap<number, number> | undefined
}): { line: number; from: (typeof EXECUTING_SOURCES)[number] } {
  const { acknowledged } = input
  const reported = input.reported === undefined ? undefined : input.index?.get(input.reported)
  if (reported !== undefined) return { line: Math.min(reported, acknowledged), from: 'reported' }
  if (input.estimate !== undefined)
    return { line: Math.min(input.estimate, acknowledged), from: 'estimate' }
  return { line: Math.max(0, acknowledged - PLANNER_MARGIN_LINES), from: 'planner' }
}

/**
 * The modal state at the start of each line, parsed forward with the virtual machine's parser
 * (the subset the controller runs; plus the plane and coolant, RC2's `stepModal`) as the
 * executing line advances: each line is parsed once.
 */
export class ModalTracker {
  private state: ModalState = initialModal()
  /** Lines parsed (0-based index of the next one). */
  private next = 0

  constructor(
    private readonly lines: readonly string[],
    private readonly arcTolerance = DEFAULT_ARC_TOLERANCE,
  ) {}

  /** The parser state line `line` (1-based) starts in. */
  at(line: number): ParserState {
    return this.modalAt(line).parser
  }

  /** The state line `line` (1-based) starts in; lines before the last asked for are not re-parsed. */
  modalAt(line: number): ModalState {
    const until = Math.min(Math.max(0, line - 1), this.lines.length)
    while (this.next < until) {
      this.state = stepModal(this.state, this.lines[this.next] ?? '', this.arcTolerance).state
      this.next++
    }
    return this.state
  }
}

export interface RecorderStart {
  readonly jobId: string
  readonly program: SenderProgram
  readonly about: JobAbout | FileJobAbout | undefined
  readonly machine: {
    readonly target: TargetKind
    readonly port?: { readonly path: string; readonly baud: number } | undefined
    readonly machineKey: string
    readonly envelope?: HostStatus['envelope']
  }
  readonly workZero: Vec3
  readonly programHash?: string | undefined
  readonly arcTolerance?: number | undefined
  /** Epoch ms. */
  readonly now: number
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** The section label holding 1-based `line` (the last section starting at or before it). */
function sectionAt(sections: SenderProgram['sections'], line: number): string | undefined {
  let label: string | undefined
  for (const s of sections) {
    if (s.fromLine > Math.max(1, line)) break
    label = s.label
  }
  return label
}

/**
 * Builds the run record of one job and says when to write it: `start` and every event (a section
 * start, a tool change, a pause or hold, the end) write at once, status reports at most once per
 * `JournalThrottle` interval. Pure bookkeeping: the caller saves `snapshot()` when a method
 * answers `true`.
 */
export class RunRecorder {
  private journal: RunJournal
  private readonly modal: ModalTracker
  private readonly index: Map<number, number> | undefined
  private readonly changes: readonly { line: number; n: number; name: string }[]
  private readonly operations: readonly { planOperationId: string; fromLine: number }[]
  /** Reason flagged by an event before the job's end arrives (a lost link, an own restart). */
  private flagged: InterruptionReason | undefined
  private section: string | undefined

  constructor(
    private readonly start: RecorderStart,
    private readonly throttle = new JournalThrottle(),
  ) {
    const { program, about, now } = start
    this.modal = new ModalTracker(program.lines, start.arcTolerance)
    this.index = lineNumberIndex(program.lines)
    this.changes = toolChanges(program.lines)
    this.operations = about !== undefined && 'operations' in about ? about.operations : []
    const t = iso(now)
    this.journal = {
      format: JOURNAL_FORMAT,
      state: 'running',
      startedAt: t,
      updatedAt: t,
      job: {
        jobId: start.jobId,
        kind: about === undefined ? 'program' : 'file' in about ? 'file' : 'plan',
        ...(about !== undefined && 'plan' in about
          ? {
              plan: {
                ...about.plan,
                ...(about.planHash === undefined ? {} : { planHash: about.planHash }),
                operations: about.operations.map((o) => ({ ...o })),
              },
            }
          : {}),
        ...(about !== undefined && 'file' in about ? { file: { ...about.file } } : {}),
        ...(start.programHash === undefined ? {} : { programHash: start.programHash }),
        lines: program.lines.length,
        sections: program.sections.map((s) => ({ ...s })),
        toolChanges: this.changes.map((c) => ({ ...c })),
      },
      machine: {
        target: start.machine.target,
        ...(start.machine.port === undefined ? {} : { port: { ...start.machine.port } }),
        machineKey: start.machine.machineKey,
        ...(start.machine.envelope === undefined
          ? {}
          : {
              envelope: {
                travel: start.machine.envelope.travel,
                homingMask: start.machine.envelope.homingMask,
                pullOff: start.machine.envelope.pullOff,
              },
            }),
      },
      workZero: { start: start.workZero, last: start.workZero },
      progress: {
        sent: 0,
        acknowledged: 0,
        executing: 0,
        executingFrom: 'planner',
        sentAt: t,
        acknowledgedAt: t,
        executingAt: t,
      },
      position: { modal: this.modalAt(0) },
    }
    this.section = sectionAt(program.sections, 1)
    this.throttle.take(now, true)
  }

  /** The record as it is now (a copy). */
  snapshot(): RunJournal {
    return structuredClone(this.journal)
  }

  get state(): JournalState {
    return this.journal.state
  }

  /**
   * A host status of the job. `estimate`: DF84's executing line, if estimated. Answers whether
   * to write now (a section starts, or the throttle interval has passed).
   */
  status(h: HostStatus, estimate: number | undefined, now: number): boolean {
    if (this.journal.state !== 'running') return false
    const j = h.job
    const t = iso(now)
    const p = this.journal.progress
    const acknowledged = Math.max(p.acknowledged, j?.ackedAtReport ?? 0, (j?.line ?? 1) - 1)
    const sent = Math.max(p.sent, j?.sent ?? 0)
    const exec = executingLine({
      acknowledged,
      estimate,
      reported: j?.reportedLine,
      index: this.index,
    })
    const executing = Math.max(p.executing, exec.line)
    this.journal = {
      ...this.journal,
      updatedAt: t,
      workZero: { ...this.journal.workZero, last: h.workZero },
      progress: {
        sent,
        acknowledged,
        executing,
        executingFrom: exec.line >= p.executing ? exec.from : p.executingFrom,
        sentAt: sent === p.sent ? p.sentAt : t,
        acknowledgedAt: acknowledged === p.acknowledged ? p.acknowledgedAt : t,
        // the time of the report that placed it: a lower bound that held then
        executingAt: t,
      },
      lastReport: {
        at: t,
        state: h.state,
        mpos: h.mpos,
        wpos: h.wpos,
        wco: [h.mpos[0] - h.wpos[0], h.mpos[1] - h.wpos[1], h.mpos[2] - h.wpos[2]],
        feed: h.feed,
        spindle: h.spindle,
        ...(h.overrides === undefined ? {} : { overrides: { ...h.overrides } }),
        ...(h.buffer === undefined ? {} : { buffer: { ...h.buffer } }),
      },
      position: this.positionAt(executing),
    }
    return this.throttle.take(now, this.sectionChanged(executing))
  }

  /** Lines acknowledged (the host's progress, newer than the last status). */
  progress(acknowledged: number, now: number): boolean {
    if (this.journal.state !== 'running') return false
    const p = this.journal.progress
    if (acknowledged <= p.acknowledged) return false
    this.journal = {
      ...this.journal,
      updatedAt: iso(now),
      progress: { ...p, acknowledged, acknowledgedAt: iso(now) },
    }
    return this.throttle.take(now)
  }

  /** A phase of the job: a tool change, a program pause or a hold writes at once. */
  phase(phase: string, now: number): boolean {
    if (this.journal.state !== 'running') return false
    if (phase !== 'toolChange' && phase !== 'programPause' && phase !== 'held') return false
    this.journal = { ...this.journal, updatedAt: iso(now) }
    return this.throttle.take(now, true)
  }

  /** An event says why the job is about to end (the end itself follows). */
  flag(reason: InterruptionReason): void {
    if (this.journal.state === 'running') this.flagged ??= reason
  }

  /**
   * The job ended: `ok`, or the error code it failed with. A flagged reason, a lost link
   * (`machine.connection`) or an own restart (`machine.reset`) make it `interrupted`; a Stop
   * (`op.aborted`) `stopped`; any other failure `failed`. Always writes.
   */
  end(
    result: { readonly ok: true } | { readonly ok: false; readonly code: string },
    now: number,
  ): boolean {
    if (this.journal.state !== 'running') return false
    const reason: InterruptionReason | undefined =
      result.ok || result.code === 'op.aborted'
        ? undefined
        : (this.flagged ??
          (result.code === 'machine.connection'
            ? 'connectionLost'
            : result.code === 'machine.reset'
              ? 'controllerReset'
              : undefined))
    const state: JournalState = result.ok
      ? 'done'
      : reason !== undefined
        ? 'interrupted'
        : result.code === 'op.aborted'
          ? 'stopped'
          : 'failed'
    this.journal = {
      ...this.journal,
      state,
      ...(reason === undefined ? {} : { reason }),
      updatedAt: iso(now),
    }
    this.throttle.take(now, true)
    return true
  }

  private sectionChanged(executing: number): boolean {
    const s = sectionAt(this.start.program.sections, executing)
    if (s === this.section) return false
    this.section = s
    return true
  }

  private modalAt(line: number): RunJournal['position']['modal'] {
    const m = this.modal.modalAt(line)
    const s = m.parser
    return {
      motion: s.motion,
      units: s.metric ? 'mm' : 'inch',
      distance: s.absolute ? 'absolute' : 'incremental',
      feed: s.feed,
      spindle: s.spindle,
      spindleSpeed: s.spindleSpeed,
      toolWord: s.tool,
      plane: m.plane,
      coolant: { ...m.coolant },
    }
  }

  private positionAt(line: number): RunJournal['position'] {
    let tool: { n: number; name: string } | undefined
    for (const c of this.changes) {
      if (c.line > Math.max(1, line)) break
      tool = { n: c.n, name: c.name }
    }
    let op: string | undefined = this.operations[0]?.planOperationId
    for (const o of this.operations) {
      if (o.fromLine > Math.max(1, line)) break
      op = o.planOperationId
    }
    const section = sectionAt(this.start.program.sections, line)
    return {
      ...(tool === undefined ? {} : { tool }),
      ...(op === undefined ? {} : { planOperationId: op }),
      ...(section === undefined ? {} : { section }),
      modal: this.modalAt(line),
    }
  }
}
