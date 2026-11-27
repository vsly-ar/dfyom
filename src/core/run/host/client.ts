/**
 * Main's side of the machine host: spawns it on connect, sends requests and matches replies by
 * `requestId`, mirrors the latest status, forwards job progress and phases, and fails what is
 * pending when the host exits. Implements the `MachineService` port.
 * Doc: docs/modes/run-v0.1.md#machine-host-and-protocol
 */
import { AppError } from '../../../shared/errors/app-error'
import { noopLogger, type Logger, type LogLevel } from '../../../shared/logging'
import { parseWith } from '../../../shared/parse'
import {
  Err,
  fail,
  fromWire,
  Ok,
  type AppResult,
  type AsyncAppResult,
} from '../../../shared/result'
import { systemTimerHost, type TimerHost, type TimeScale } from '../clock'
import type { Vec3 } from '../../toolpath/model'
import type { RunSummary, SenderProgram } from '../grbl/sender'
import {
  closedStatus,
  type FileJobAbout,
  type JobAbout,
  type JobListener,
  type LastRun,
  type MachineService,
  type RunningJob,
  type RunPlan,
  type RunFile,
  type RunProgram,
  type RunStatus,
} from '../service'
import type { MachineValuesDTO } from '../../library/machine.dto'
import type { SerialPortInfo } from '../serial'
import { programmedRates, type ProgrammedRates } from '../override'
import {
  DEFAULT_ARC_TOLERANCE,
  estimateExecuting,
  ProgramTracer,
  type Executing,
} from '../executing'
import { PLANNER_BLOCKS } from '../grbl/emulator/planner'
import { reconcileStep, type AlignmentStep } from '../alignment'
import { RunRecorder, type RunJournal, type RunJournalPort, type UsbIdentity } from '../journal'
import { interruptionOf, type InterruptionReason } from '../interruption'
import type { LaunchRecord } from '../launch'
import { Reconnector, type ReconnectProgress } from './reconnect'
import {
  ControllerInfoSchema,
  HostMessage,
  PortListSchema,
  PROTOCOL_VERSION,
  RunSummarySchema,
  type ConnectedInfo,
  type ConnectTarget,
  type HostStatus,
  type JobControlAction,
  type MachineAction,
  type SimulatedInput,
  type MainMessage,
  type TargetKind,
} from './protocol'

/** A running host process or thread, as main sees it. */
export interface MachineHostHandle {
  post(message: unknown): void
  /** Ends the host; `exit` follows. */
  terminate(): void
}

export interface MachineHostEvents {
  message(message: unknown): void
  /** The host is gone (crash, kill or after `disconnect`); `code` as the platform reports it. */
  exit(code: number | null): void
}

/** Spawns a host: Electron utility process, `worker_threads` worker or in-process (tests). */
export type MachineHostFactory = (events: MachineHostEvents) => MachineHostHandle

export interface MachineClientOptions {
  readonly factory: MachineHostFactory
  readonly logLevel: LogLevel
  readonly log?: Logger
  /** Receives the host's log batches (`createForwardReceiver`, origin `utility`). */
  readonly onLog?: (batch: readonly unknown[]) => void
  /** Epoch ms for `job.startedAt` (default `Date.now`). */
  readonly now?: () => number
  /**
   * DF129: writes the run journal of jobs on a real connection (atomic, latest wins); absent =
   * none (headless tests, the virtual machine keeps only the in-memory record).
   * Doc: docs/modes/run-recovery.md#what-dfyom-keeps
   */
  readonly journal?: RunJournalPort
  /** DF129: SHA-256 (hex) of a program's text for the journal; absent = not hashed. */
  readonly hashProgram?: (text: string) => string
  /**
   * DF129: keeps the computer awake while a job streams on a real connection (`true` at the
   * start, `false` at the end; Electron `powerSaveBlocker` in the app).
   */
  readonly keepAwake?: (on: boolean) => void
  /**
   * DF129 RC4: auto-reconnect after a connection lost during a run
   * (docs/modes/run-recovery.md#implementation-rc4). `enabled`: the app's setting "Reconnect
   * automatically after a lost connection" (default: on); `timers`: the backoff's (default: the
   * system's).
   */
  readonly reconnect?: {
    readonly enabled?: () => boolean
    readonly timers?: TimerHost
  }
}

type ConnectProfile = {
  readonly spindleMinSpeed?: number | undefined
  readonly machine?: MachineValuesDTO | undefined
}

/** The connection to open again after a loss (DF129 RC4): as last opened, with its profile. */
interface Reopen {
  readonly target: ConnectTarget
  readonly profile: ConnectProfile | undefined
  /** Serial: the port's USB identity at connect, when the OS reported one. */
  readonly usb?: UsbIdentity | undefined
}

/**
 * DF129, Q173: the simulated cable of the virtual machine stays out this long, so the practice run
 * shows a failed attempt or two before it reconnects (docs/modes/run-recovery.md#implementation-rc4).
 */
export const SIMULATED_UNPLUG_MS = 2500

interface Host {
  readonly handle: MachineHostHandle
  readonly ready: Promise<AppResult<void>>
  readonly resolveReady: (r: AppResult<void>) => void
  /** Exit expected (after `disconnect` or `close`): not logged as a crash. */
  expectExit: boolean
}

interface Job {
  readonly jobId: string
  readonly listener: JobListener
  readonly startedAt: string
  readonly end: (r: AppResult<RunSummary>) => void
  readonly about: JobAbout | FileJobAbout | undefined
  /** Lines acknowledged (last progress). */
  done: number
  /** Waiting at a tool change (last phase). */
  atToolChange: boolean
  /** The program's modal F (mm/min) and S (rpm, 0 = off) after each line (DF85). */
  readonly rates: ReturnType<typeof programmedRates>
  /** DF84: the program's planner blocks, traced in slices after the start. */
  readonly tracer: ProgramTracer
  /** DF84: the last executing-line estimate (its block is the next one's floor). */
  executing?: Executing
  /** DF84: the work position of the last status, for the direction of motion. */
  position?: Vec3
}

/** Lines traced per slice (DF84): ~25 ms of main's time each. */
const TRACE_SLICE = 5000

/** Phases that say where a run is (the end phases keep the last of these). */
const WAIT_OR_STREAM: readonly string[] = ['streaming', 'held', 'programPause', 'toolChange']

/**
 * Motion lines GRBL may hold besides the one moving: its planner plans up to 15 blocks ahead
 * (docs/modes/run.md#6-lost-connection-disconnect-and-reconnect); one more for margin.
 */
export const PLANNER_LINES = 16

/** The plan operation holding 1-based `line`; the first one for a line before it. */
export function operationAt(about: JobAbout, line: number): string | undefined {
  let id = about.operations[0]?.planOperationId
  for (const o of about.operations) {
    if (o.fromLine > line) break
    id = o.planOperationId
  }
  return id
}

/**
 * Where a run that ended stopped (docs/modes/run-machine.md#section-resume-m5): the operation of
 * the tool change it waited at, else the earliest one GRBL may still have been executing.
 */
export function stoppedOperation(
  about: JobAbout,
  done: number,
  atToolChange: boolean,
): string | undefined {
  return operationAt(about, atToolChange ? done + 1 : Math.max(1, done - PLANNER_LINES))
}

/**
 * The programmed F and S of the last acknowledged line (DF85): what the override scales next.
 * Absent before the first line.
 */
function programmedAt(job: Job, line: number): { programmed?: ProgrammedRates } {
  const i = Math.min(line - 1, job.rates.feed.length) - 1
  if (i < 0) return {}
  return { programmed: { feed: job.rates.feed[i] ?? 0, spindle: job.rates.spindle[i] ?? 0 } }
}

/** The host's job status without the estimate's inputs (`ackedAtReport` DF84, `reportedLine` DF129). */
function statusJob(
  j: NonNullable<HostStatus['job']>,
): Omit<typeof j, 'ackedAtReport' | 'reportedLine'> {
  const { ackedAtReport: _input, reportedLine: _ln, ...rest } = j
  return rest
}

const WHERE = 'MachineClient'

const hostExited = (code: number | null): AppError =>
  new AppError('machine.connection', 'the machine host exited', {
    where: WHERE,
    data: { exitCode: code },
  })

export class MachineClient implements MachineService {
  private host: Host | undefined
  private readonly pending = new Map<string, (r: AppResult<unknown>) => void>()
  private seq = 0
  private conn:
    | {
        state: 'connecting' | 'open'
        machineKey: string
        spindleMinSpeed?: number | undefined
        machine?: MachineValuesDTO | undefined
        target?: TargetKind | undefined
        port?: { path: string; baud: number } | undefined
        usb?: UsbIdentity | undefined
        settings?: Readonly<Record<string, number>> | undefined
      }
    | undefined
  /** DF129 RC4: the last connection opened, to open again after a loss during a run. */
  private reopen: Reopen | undefined
  /** DF129 RC4: the current reconnecting episode and where it is (kept after it ends, see status). */
  private reconnecting:
    | { readonly r: Reconnector; progress: ReconnectProgress; nextAt?: number | undefined }
    | undefined
  /** DF129 RC4: the last position and G54 seen before a loss (the virtual machine's power-up). */
  private lastSeen: { mpos: Vec3; workZero: Vec3 } | undefined
  /** DF129, Q173: the simulated cable is back at this time (`reconnectTimers`' clock). */
  private simulatedUntil: number | undefined
  /**
   * The last open connection ended without DFYOM closing it (host reported it lost, or the host
   * exited): shown until the next connect (docs/modes/run-machine.md#lost-connection-m2).
   */
  private lost: { target: TargetKind; port?: { path: string; baud: number } } | undefined
  /** Job that checks and exports before it streams: machine actions wait (run.busy). */
  private reserved: string | undefined
  private hostStatus: HostStatus | undefined
  private job: Job | undefined
  /** The run that ended last (M5): kept until the next run starts, across connections. */
  private lastRun: LastRun | undefined
  /**
   * DF129: the record of the current or last job (docs/modes/run-recovery.md#what-dfyom-keeps);
   * `journaled`: written to the run journal (a real connection).
   */
  private record: { recorder: RunRecorder; jobId: string; journaled: boolean } | undefined
  /** DF129 RC5: what the last job was started with (its plan or file and the original program). */
  private lastAbout: JobAbout | FileJobAbout | undefined
  /** DF84: the last run's program, kept until the next run starts (renderer only). */
  private lastProgram: RunProgram | undefined
  /** DF84: planner blocks when empty: the largest `Bf` free count seen on this connection. */
  private plannerCapacity: number = PLANNER_BLOCKS
  /** DF78: the alignment step (docs/modes/alignment.md#state); dropped with the connection. */
  private step: AlignmentStep | undefined
  private timeScale: TimeScale = 1
  private readonly listeners = new Set<(s: RunStatus) => void>()
  private readonly log: Logger
  private readonly now: () => number

  private readonly reconnectTimers: TimerHost

  constructor(private readonly opts: MachineClientOptions) {
    this.log = (opts.log ?? noopLogger).child({ scope: 'run.client' })
    this.now = opts.now ?? (() => Date.now())
    this.reconnectTimers = opts.reconnect?.timers ?? systemTimerHost
  }

  /** As the host reported it on connect; undefined while connecting or closed. */
  get target(): TargetKind | undefined {
    return this.conn?.state === 'open' ? this.conn.target : undefined
  }

  get controllerSettings(): Readonly<Record<string, number>> | undefined {
    return this.conn?.state === 'open' ? this.conn.settings : undefined
  }

  get machineKey(): string | undefined {
    return this.conn?.machineKey
  }

  get spindleMinSpeed(): number | undefined {
    return this.conn?.state === 'open' ? this.conn.spindleMinSpeed : undefined
  }

  get connectedMachine(): MachineValuesDTO | undefined {
    return this.conn?.state === 'open' ? this.conn.machine : undefined
  }

  status(): RunStatus {
    const conn = this.conn
    const h = this.hostStatus
    const last = this.lastRun === undefined ? {} : { lastRun: { ...this.lastRun } }
    const reconnect = this.reconnectStatus()
    if (conn === undefined || h === undefined) {
      const s: RunStatus = { ...closedStatus(this.timeScale), ...last }
      // DF129 RC4: also while auto-reconnect's attempt connects
      if (this.lost !== undefined)
        s.connection.lost = {
          target: this.lost.target,
          ...(this.lost.port === undefined ? {} : { port: { ...this.lost.port } }),
        }
      if (reconnect !== undefined) s.connection.reconnect = reconnect
      return conn === undefined
        ? s
        : {
            ...s,
            state: 'Connecting',
            connection: { ...s.connection, state: conn.state },
          }
    }
    const { job: hostJob, timeScale, ...rest } = h
    // `ackedAtReport` is the estimate's input, not part of the status (DF84)
    const job = hostJob === undefined ? undefined : statusJob(hostJob)
    const executing = this.job?.executing?.line
    return {
      ...rest,
      connection: {
        state: conn.state,
        ...(conn.target === undefined ? {} : { target: conn.target }),
        ...(conn.port === undefined ? {} : { port: { ...conn.port } }),
        timeScale,
        ...(reconnect === undefined ? {} : { reconnect }),
      },
      ...(job === undefined || this.job?.jobId !== job.jobId
        ? {}
        : {
            job: {
              ...job,
              startedAt: this.job.startedAt,
              ...this.aboutJob(this.job, job.line),
              ...programmedAt(this.job, job.line),
              ...(executing === undefined ? {} : { executing }),
            },
          }),
      ...last,
      ...(this.step === undefined ? {} : { alignment: structuredClone(this.step) }),
    }
  }

  /** DF129 RC4: auto-reconnect's state for the status, while trying and after it ended. */
  private reconnectStatus(): RunStatus['connection']['reconnect'] {
    const r = this.reconnecting
    if (r === undefined) return undefined
    return {
      phase: r.progress.phase,
      attempt: r.progress.attempt,
      ...(r.progress.phase === 'waiting' && r.nextAt !== undefined ? { nextAt: r.nextAt } : {}),
    }
  }

  /**
   * DF129 RC4: after a connection lost during a run, open it again by itself: the same port path or
   * USB serial number, backoff for 2 minutes; only a plain connect (handshake and reads), never a
   * move, homing, unlock or resume (docs/modes/run-recovery.md#auto-reconnect).
   */
  private startReconnect(asked = false): void {
    const reopen = this.reopen
    if (reopen === undefined || (!asked && this.opts.reconnect?.enabled?.() === false)) return
    this.reconnecting?.r.cancel()
    const target = reopen.target
    const r: Reconnector = new Reconnector({
      timers: this.reconnectTimers,
      attempt: (path) => this.reconnectAttempt(r, reopen, path),
      ...(target.kind === 'serial'
        ? {
            serial: {
              lost: { path: target.path, ...reopen.usb },
              list: () => this.listPorts(),
            },
          }
        : {}),
      onChange: (progress) => {
        if (this.reconnecting?.r !== r) return
        this.reconnecting.progress = progress
        this.reconnecting.nextAt =
          progress.nextInMs === undefined ? undefined : this.now() + progress.nextInMs
        this.log.info({ ...progress }, 'reconnect')
        this.notify()
      },
    })
    this.reconnecting = { r, progress: r.progress }
    this.log.info({ target: target.kind }, 'reconnecting after a lost connection')
    r.start()
    this.notify()
  }

  /** One reconnect attempt: the connection as last opened, at `path` (serial). */
  private async reconnectAttempt(
    r: Reconnector,
    reopen: Reopen,
    path: string | undefined,
  ): AsyncAppResult<unknown> {
    const where = `${WHERE}.reconnect`
    if (this.conn !== undefined) return fail('run.busy', 'a connection is open', { where })
    const t = reopen.target
    let target: ConnectTarget
    if (t.kind === 'serial') target = { ...t, path: path ?? t.path }
    else {
      if (this.simulatedUntil !== undefined && this.reconnectTimers.now() < this.simulatedUntil)
        return fail('machine.connection', 'the simulated cable is unplugged', { where })
      // powers up where it stopped, G54 kept (EEPROM), never prepared (prepare homes)
      const { prepare: _prepare, ...rest } = t
      const seen = this.lastSeen
      target = {
        ...rest,
        // the time scale the connection had when lost
        timeScale: this.timeScale,
        ...(seen === undefined ? {} : { position: seen.mpos, workZero: seen.workZero }),
      }
    }
    // `lost` stays while trying: the safety warning is not announced again per attempt
    const opened = await this.open(target, reopen.profile, true)
    if (opened.isErr()) return opened
    // "Stop trying" while this attempt connected: let go again (reads only happened)
    if (this.reconnecting?.r !== r) {
      await this.disconnect()
      return fail('op.aborted', 'reconnecting was stopped', { where })
    }
    // the next loss reopens this port (a re-enumerated device keeps its new path)
    this.reopen = { target, profile: reopen.profile, usb: this.connUsb() ?? reopen.usb }
    return opened
  }

  /** DF129 RC4: the user's "Stop trying": ends auto-reconnect (the lost warning stays). */
  cancelReconnect(): void {
    const r = this.reconnecting
    if (r === undefined) return
    r.r.cancel()
    this.reconnecting = undefined
    this.notify()
  }

  /**
   * DF129, Q173: "Simulate a lost connection" on the virtual machine during a run: its cable is
   * pulled (the connection is lost as a real one is) and comes back after `SIMULATED_UNPLUG_MS`,
   * so auto-reconnect and the recovery can be practised. Renderer only (no command, no agent tool).
   */
  async simulateConnectionLoss(): AsyncAppResult<void> {
    const where = `${WHERE}.simulateConnectionLoss`
    if (this.conn?.state !== 'open') return this.notConnected()
    if (this.conn.target !== 'virtual')
      return fail('run.state', 'only the virtual machine can simulate a lost connection', { where })
    if (this.job === undefined)
      return fail('run.state', 'a lost connection is simulated during a run', { where })
    this.simulatedUntil = this.reconnectTimers.now() + SIMULATED_UNPLUG_MS
    const r = await this.request({
      type: 'machine',
      requestId: '',
      action: { kind: 'simulateLostConnection' },
    })
    // the host may be gone before its reply is read: lost is what was asked for
    return r.isErr() && r.unwrapErr().code === 'machine.connection'
      ? Ok(undefined)
      : r.map(() => undefined)
  }

  /**
   * DF134: a limit switch (`x`/`y`/`z`) or the safety door of the virtual machine pressed or
   * released, for practising the alarm flow. Renderer only (no command, no agent tool).
   * Doc: docs/modes/run-machine.md#after-a-hard-limit-df134
   */
  async simulateInput(input: SimulatedInput, pressed: boolean): AsyncAppResult<void> {
    if (this.conn?.state !== 'open') return this.notConnected()
    if (this.conn.target !== 'virtual')
      return fail('run.state', 'only the virtual machine can simulate an input', {
        where: `${WHERE}.simulateInput`,
      })
    const r = await this.request({
      type: 'machine',
      requestId: '',
      action: { kind: 'simulateInput', input, pressed },
    })
    return r.map(() => undefined)
  }

  alignmentStep(): AlignmentStep | undefined {
    return this.step === undefined ? undefined : structuredClone(this.step)
  }

  setAlignmentStep(step: AlignmentStep | undefined): void {
    this.step = step === undefined ? undefined : structuredClone(step)
    this.notify()
  }

  /** The plan, setup and current operation of a job (M7). */
  private aboutJob(
    job: Job,
    line: number,
  ): { plan?: RunPlan; planOperationId?: string; file?: RunFile } {
    const about = job.about
    if (about === undefined) return {}
    if ('file' in about) return { file: { ...about.file } }
    const op = operationAt(about, Math.max(1, line))
    return { plan: { ...about.plan }, ...(op === undefined ? {} : { planOperationId: op }) }
  }

  /** Records how a job ended (M5); an interrupted run with its interruption (DF129 RC5). */
  private ended(job: Job, r: AppResult<RunSummary>): void {
    const about = job.about
    const rec = this.recorder(job.jobId)?.snapshot()
    const interruption =
      rec?.state === 'interrupted' && rec.reason !== undefined
        ? this.interruptionOf(rec, rec.reason, job.atToolChange)
        : undefined
    if (about === undefined) return
    // a file run keeps a record only when interrupted (DF93's runs end with the file loaded)
    if ('file' in about) {
      if (interruption !== undefined)
        this.lastRun = {
          jobId: job.jobId,
          file: { ...about.file },
          outcome: 'failed',
          interruption,
        }
      return
    }
    const op = r.isOk() ? undefined : stoppedOperation(about, job.done, job.atToolChange)
    this.lastRun = {
      jobId: job.jobId,
      planId: about.plan.planId,
      setupId: about.plan.setupId,
      outcome: r.isOk() ? 'done' : r.unwrapErr().code === 'op.aborted' ? 'stopped' : 'failed',
      ...(op === undefined ? {} : { planOperationId: op }),
      ...(about.planHash === undefined ? {} : { planHash: about.planHash }),
      ...(about.order === undefined ? {} : { operations: [...about.order] }),
      ...(interruption === undefined ? {} : { interruption }),
    }
  }

  /** DF129 RC5: the interruption of the last job's record, its lines in the original program. */
  private interruptionOf(rec: RunJournal, reason: InterruptionReason, waiting: boolean) {
    const about = this.lastAbout
    return interruptionOf(rec, reason, {
      program: this.lastProgram?.lines ?? [],
      operationStarts:
        about !== undefined && 'operations' in about
          ? about.operations.map((o) => o.fromLine)
          : undefined,
      origin: about?.origin,
      waiting,
    })
  }

  /**
   * DF129 RC5 (Q171): "The machine lost power" after a run ended (stopped, failed, interrupted):
   * the record becomes `interrupted` / `machinePowerLost` with the operation start suggested, and
   * the open connection forgets that it is homed (GRBL on USB power cannot know). Renderer only.
   * Doc: docs/modes/run-recovery.md#implementation-rc5
   */
  async markMachinePowerLost(): AsyncAppResult<void> {
    const where = `${WHERE}.markMachinePowerLost`
    const rec = this.record
    if (this.job !== undefined)
      return fail('run.state', 'not while a run is going', { where, data: { state: 'run' } })
    // the DRO menu while idle (no ended run to recover): only the position is lost
    if (rec === undefined || !rec.recorder.markPowerLost(this.now())) {
      if (this.conn?.state !== 'open') return this.notConnected()
      await this.forgetHoming()
      this.notify()
      return Ok(undefined)
    }
    if (rec.journaled) this.opts.journal?.save(rec.recorder.snapshot())
    const interruption = this.interruptionOf(rec.recorder.snapshot(), 'machinePowerLost', false)
    const about = this.lastAbout
    const last = this.lastRun?.jobId === rec.jobId ? this.lastRun : undefined
    if (last !== undefined) this.lastRun = { ...last, interruption }
    else if (about !== undefined && 'file' in about)
      this.lastRun = { jobId: rec.jobId, file: { ...about.file }, outcome: 'stopped', interruption }
    if (this.conn?.state === 'open') await this.forgetHoming()
    this.notify()
    return Ok(undefined)
  }

  /** Q171: the host forgets that the machine is homed (the position is lost). */
  private async forgetHoming(): Promise<void> {
    const r = await this.request({
      type: 'machine',
      requestId: '',
      action: { kind: 'forgetHoming' },
    })
    if (r.isErr()) this.log.warn({ code: r.unwrapErr().code }, 'could not mark the position lost')
  }

  /**
   * DF129 RC6: the interrupted run found in the run journal at launch becomes the last run's record
   * (`lastRun.interruption` with `launch`) and its kept program the last program (the gCode panel),
   * unless a run already started or ended since. Doc: docs/modes/run-recovery.md#implementation-rc6
   */
  restoreLaunch(record: LaunchRecord): void {
    if (this.job !== undefined || this.lastRun !== undefined || this.record !== undefined) return
    this.lastRun = record.lastRun
    if (record.program !== undefined) this.lastProgram = record.program
    this.notify()
  }

  /**
   * DF129 RC5: "Dismiss" in the recovery panel: the interruption is forgotten (the record of a
   * file run with it) and the run journal removed. Renderer only.
   */
  dismissInterruption(): void {
    const last = this.lastRun
    if (last?.interruption === undefined) return
    if (last.file !== undefined) this.lastRun = undefined
    else {
      const { interruption: _gone, ...rest } = last
      this.lastRun = rest
    }
    this.opts.journal?.discard?.()
    this.notify()
  }

  /**
   * DF129 RC5: "Reconnect now" while auto-reconnect waits (the next attempt at once), and "Try
   * again" after it gave up, was stopped or is off: a new episode on the connection last opened.
   */
  reconnectNow(): AppResult<void> {
    if (this.conn !== undefined) return Ok(undefined)
    const r = this.reconnecting?.r
    if (r?.active === true) {
      r.now()
      return Ok(undefined)
    }
    if (this.reopen === undefined)
      return fail('run.state', 'no connection to reopen', { where: `${WHERE}.reconnectNow` })
    this.startReconnect(true)
    return Ok(undefined)
  }

  /**
   * DF84: the program of run job `jobId` as streamed, while kept (the current run, or the last
   * one until the next starts); `undefined` otherwise. Renderer only
   * (docs/modes/run.md#gcode-panel-df84).
   */
  program(jobId: string): RunProgram | undefined {
    return this.lastProgram?.jobId === jobId ? this.lastProgram : undefined
  }

  /**
   * DF129: the record of the current job, or of the last one until the next starts (a copy);
   * RC5's recovery panel reads it. Doc: docs/modes/run-recovery.md#what-dfyom-keeps
   */
  runRecord(): RunJournal | undefined {
    return this.record?.recorder.snapshot()
  }

  /** DF129: writes the record to the journal when `due` and the job is journaled. */
  private journal(due: boolean): void {
    const r = this.record
    if (due && r?.journaled === true) this.opts.journal?.save(r.recorder.snapshot())
  }

  /** DF129: the record's update for the current job `jobId`, if it is the recorded one. */
  private recorder(jobId: string | undefined): RunRecorder | undefined {
    return jobId !== undefined && this.record?.jobId === jobId ? this.record.recorder : undefined
  }

  /** DF84: traces the job's program in slices, a macrotask each, while it is the current job. */
  private traceSlices(job: Job): void {
    if (this.job !== job || job.tracer.step(TRACE_SLICE)) return
    setTimeout(() => this.traceSlices(job), 0)
  }

  /** DF84: the executing line from a host status of the job (docs/modes/run.md#gcode-panel-df84). */
  private estimate(job: Job, h: HostStatus): void {
    const j = h.job
    if (j?.jobId !== job.jobId || j.sent === undefined || j.ackedAtReport === undefined) return
    const e = estimateExecuting(job.tracer.trace, {
      acknowledged: j.ackedAtReport,
      sent: j.sent,
      blocksFree: h.buffer?.blocks,
      capacity: this.plannerCapacity,
      position: h.wpos,
      previous: job.position,
      floor: job.executing?.block,
    })
    job.position = h.wpos
    if (e === undefined) return
    const before = job.executing
    job.executing = {
      line: Math.max(e.line, before?.line ?? 0),
      block: Math.max(e.block, before?.block ?? -1),
    }
  }

  /** DF129: how job `jobId` ended, into its record; the journal's last write; awake no longer. */
  private recordEnd(jobId: string, r: AppResult<RunSummary>): void {
    const rec = this.recorder(jobId)
    if (rec === undefined) return
    const due = rec.end(
      r.isOk() ? { ok: true } : { ok: false, code: r.unwrapErr().code },
      this.now(),
    )
    if (this.record?.journaled === true) {
      this.journal(due)
      this.opts.keepAwake?.(false)
    }
  }

  onStatus(listener: (s: RunStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async connect(target: ConnectTarget, profile?: ConnectProfile): AsyncAppResult<ConnectedInfo> {
    if (this.conn !== undefined)
      return fail('run.busy', 'a machine connection is already open', { where: `${WHERE}.connect` })
    // the user's own connect ends auto-reconnect and its state (DF129 RC4)
    this.cancelReconnect()
    const r = await this.open(target, profile)
    if (r.isOk()) this.reopen = { target, profile, usb: this.connUsb() }
    return r
  }

  /** Opens `target` (a connect, the user's or auto-reconnect's). */
  private async open(
    target: ConnectTarget,
    profile: ConnectProfile | undefined,
    auto = false,
  ): AsyncAppResult<ConnectedInfo> {
    const machineKey = target.machineKey
    if (this.conn !== undefined)
      return fail('run.busy', 'a machine connection is already open', { where: `${WHERE}.connect` })
    // the kind is known from the start, so a connection lost while opening is reported too
    this.conn = { state: 'connecting', machineKey, target: target.kind }
    if (!auto) this.lost = undefined
    this.plannerCapacity = PLANNER_BLOCKS
    // a real controller always runs at 1× (docs/modes/run-machine.md#amendments-to-run-v01md)
    this.timeScale = target.kind === 'virtual' ? target.timeScale : 1
    this.notify()
    const host = this.spawn()
    const ready = await host.ready
    if (ready.isErr()) return this.connectFailed(ready.unwrapErr())
    const r = await this.request({ type: 'connect', requestId: '', target })
    const info = r.andThen((v) => parseWith(ControllerInfoSchema, v, `${WHERE}.connect`))
    if (info.isErr()) return this.connectFailed(info.unwrapErr())
    const connected = info.unwrap()
    const usb =
      connected.target === 'serial' ? await this.usbIdentity(connected.port?.path) : undefined
    this.conn = {
      state: 'open',
      machineKey,
      target: connected.target,
      ...(connected.port === undefined ? {} : { port: connected.port }),
      ...(usb === undefined ? {} : { usb }),
      settings: connected.settings,
      ...(profile?.spindleMinSpeed === undefined
        ? {}
        : { spindleMinSpeed: profile.spindleMinSpeed }),
      ...(profile?.machine === undefined ? {} : { machine: profile.machine }),
    }
    // auto-reconnect kept the lost warning while trying (the user's connect cleared it at once)
    if (auto) this.lost = undefined
    this.log.info({ target: connected.target, version: connected.version }, 'connected')
    this.notify()
    return info
  }

  /** DF129 RC4: the open connection's USB identity (a method: narrowing does not see `open`). */
  private connUsb(): UsbIdentity | undefined {
    return this.conn?.usb
  }

  /** DF129 RC4: the USB identity the OS reports for `path` (undefined: none or no list). */
  private async usbIdentity(path: string | undefined): Promise<UsbIdentity | undefined> {
    if (path === undefined) return undefined
    const listed = await this.request({ type: 'listPorts', requestId: '' })
    const ports = listed.andThen((v) => parseWith(PortListSchema, v, `${WHERE}.connect`))
    const p = ports.isOk() ? ports.unwrap().find((x) => x.path === path) : undefined
    if (p === undefined || (p.serialNumber ?? p.vendorId ?? p.productId) === undefined)
      return undefined
    return {
      ...(p.serialNumber === undefined ? {} : { serialNumber: p.serialNumber }),
      ...(p.vendorId === undefined ? {} : { vendorId: p.vendorId }),
      ...(p.productId === undefined ? {} : { productId: p.productId }),
    }
  }

  async listPorts(): AsyncAppResult<SerialPortInfo[]> {
    const host = this.spawn()
    const ready = await host.ready
    if (ready.isErr()) return Err(ready.unwrapErr().withContext(`${WHERE}.listPorts`))
    const r = await this.request({ type: 'listPorts', requestId: '' })
    return r.andThen((v) => parseWith(PortListSchema, v, `${WHERE}.listPorts`))
  }

  async disconnect(): AsyncAppResult<void> {
    // the user's own disconnect ends auto-reconnect and its state (DF129 RC4)
    this.cancelReconnect()
    const host = this.host
    if (host === undefined || this.conn === undefined) return Ok(undefined)
    if (this.job !== undefined)
      return fail('run.busy', `job ${this.job.jobId} is running`, { where: `${WHERE}.disconnect` })
    host.expectExit = true
    const sent = await this.request({ type: 'disconnect', requestId: '' })
    // the host may exit before its reply is read: gone is disconnected too
    const r = sent.isErr() && sent.unwrapErr().code === 'machine.connection' ? Ok(undefined) : sent
    this.conn = undefined
    this.hostStatus = undefined
    this.step = undefined
    host.handle.terminate()
    this.log.info('disconnected')
    this.notify()
    return r.map(() => undefined)
  }

  async machine(action: MachineAction): AsyncAppResult<unknown> {
    if (this.conn?.state !== 'open') return this.notConnected()
    // the emergency paths and overrides (real-time bytes) always pass; anything else waits while
    // a job checks its program
    const passes =
      action.kind === 'reset' ||
      action.kind === 'jogCancel' ||
      action.kind === 'override' ||
      action.kind === 'overrideTo' ||
      action.kind === 'feedHold' ||
      action.kind === 'cycleStart'
    if (this.reserved !== undefined && !passes)
      return fail('run.busy', `job ${this.reserved} is starting`, {
        where: `${WHERE}.machine`,
        data: { jobId: this.reserved },
      })
    return this.request({ type: 'machine', requestId: '', action })
  }

  reserve(jobId: string): AppResult<void> {
    if (this.conn?.state !== 'open') return this.notConnected()
    const holder = this.job?.jobId ?? this.reserved
    if (holder !== undefined && holder !== jobId)
      return fail('run.busy', `job ${holder} is running`, { where: `${WHERE}.reserve` })
    this.reserved = jobId
    return Ok(undefined)
  }

  release(jobId: string): void {
    if (this.reserved === jobId) this.reserved = undefined
  }

  async startJob(
    jobId: string,
    program: SenderProgram,
    listener: JobListener,
    expect: { readonly workZero: Vec3; readonly machineKey: string },
    about?: JobAbout | FileJobAbout,
  ): AsyncAppResult<RunningJob> {
    if (this.conn?.state !== 'open' || this.conn.target === undefined) return this.notConnected()
    if (this.job !== undefined || (this.reserved !== undefined && this.reserved !== jobId))
      return fail('run.busy', `job ${this.job?.jobId ?? this.reserved} is running`, {
        where: `${WHERE}.startJob`,
      })
    let resolveEnd: (r: AppResult<RunSummary>) => void = () => {}
    const ended = new Promise<AppResult<RunSummary>>((resolve) => (resolveEnd = resolve))
    const job: Job = {
      jobId,
      listener,
      startedAt: new Date(this.now()).toISOString(),
      end: (r) => {
        // the record's final state first: an interrupted run's lastRun carries it (RC5)
        this.recordEnd(jobId, r)
        this.ended(job, r)
        resolveEnd(r)
      },
      about,
      done: 0,
      atToolChange: false,
      rates: programmedRates(program.lines),
      tracer: new ProgramTracer(program.lines, {
        arcTolerance: this.conn.settings?.['12'] ?? DEFAULT_ARC_TOLERANCE,
        ...(this.hostStatus === undefined ? {} : { start: this.hostStatus.wpos }),
      }),
    }
    this.job = job
    // a new run: "Reconnected" has done its job (DF129 RC4)
    if (this.reconnecting?.r.active === false) this.reconnecting = undefined
    // a new run replaces the record of the last one (back if the host refuses the start)
    const before = { lastRun: this.lastRun, lastAbout: this.lastAbout }
    if (about !== undefined) this.lastRun = undefined
    this.lastAbout = about
    this.lastProgram = {
      jobId,
      lines: program.lines,
      sections: program.sections,
      operations: about !== undefined && 'operations' in about ? about.operations : [],
    }
    this.traceSlices(job)
    const previous = this.record
    const serial = this.conn.target === 'serial'
    this.record = {
      jobId,
      journaled: false,
      recorder: new RunRecorder({
        jobId,
        program,
        about,
        machine: {
          target: this.conn.target,
          port: this.conn.port,
          usb: this.conn.usb,
          machineKey: this.conn.machineKey,
          envelope: this.hostStatus?.envelope,
        },
        workZero: expect.workZero,
        programHash: this.opts.hashProgram?.(program.lines.join('\n')),
        origin: about?.origin,
        arcTolerance: this.conn.settings?.['12'],
        now: this.now(),
      }),
    }
    const r = await this.request({
      type: 'jobStart',
      requestId: '',
      jobId,
      program: { lines: [...program.lines], sections: program.sections.map((s) => ({ ...s })) },
      expect: {
        workZero: [...expect.workZero] as unknown as Vec3,
        machineKey: expect.machineKey,
        target: this.conn.target,
      },
    })
    this.release(jobId)
    if (r.isErr()) {
      if (this.job === job) this.job = undefined
      // a refused start ran nothing: the last run's record stays
      if (this.record?.jobId === jobId) {
        this.record = previous
        this.lastRun = before.lastRun
        this.lastAbout = before.lastAbout
      }
      return Err(r.unwrapErr())
    }
    // DF129: a real run is journaled from its start (replacing the last journal) and keeps the
    // computer awake until it ends (docs/modes/run-recovery.md#what-dfyom-keeps)
    if (serial && this.record?.jobId === jobId && this.record.recorder.state === 'running') {
      this.record.journaled = true
      this.opts.keepAwake?.(true)
      // RC6: the original program first, so the start's journal finds it after a crash
      this.opts.journal?.saveProgram?.(about?.origin?.resumed?.lines ?? program.lines)
      this.journal(true)
    }
    return Ok({ ended })
  }

  async controlJob(
    jobId: string,
    action: JobControlAction,
    expect?: { readonly toolChange?: number; readonly pause?: number },
  ): AsyncAppResult<void> {
    if (this.conn?.state !== 'open') return this.notConnected()
    const r = await this.request({
      type: 'jobControl',
      requestId: '',
      jobId,
      action,
      ...(expect === undefined ? {} : { expect: { ...expect } }),
    })
    return r.map(() => undefined)
  }

  async setTimeScale(scale: TimeScale): AsyncAppResult<void> {
    if (this.conn?.state !== 'open') return this.notConnected()
    const r = await this.request({ type: 'timeScale', requestId: '', scale })
    if (r.isOk()) this.timeScale = scale
    return r.map(() => undefined)
  }

  /**
   * App quit or headless exit: a controlled end first (the host stops a running job with hold and
   * reset, then closes the controller), bounded by `timeoutMs`; then the host is ended.
   */
  async shutdown(timeoutMs = 3000): Promise<void> {
    this.reconnecting?.r.cancel()
    const host = this.host
    if (host === undefined) return
    host.expectExit = true
    if (this.conn?.state === 'open') {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        this.request({ type: 'disconnect', requestId: '' }),
        new Promise((r) => (timer = setTimeout(r, timeoutMs))),
      ])
      clearTimeout(timer)
    }
    if (this.host === host) host.handle.terminate()
  }

  /** Ends the host at once, without a controlled stop (tests; a host that does not answer). */
  close(): void {
    this.reconnecting?.r.cancel()
    const host = this.host
    if (host === undefined) return
    host.expectExit = true
    host.handle.terminate()
  }

  // ── host lifecycle ────────────────────────────────────────────────────────────────────────

  private spawn(): Host {
    const current = this.host
    if (current !== undefined && !current.expectExit) return current
    // A host told to end whose exit is still on its way (a worker's or utility process's comes
    // late under load) is not reused: it would take the next connect and then exit under it.
    if (current !== undefined) this.drop(current, hostExited(null))
    let resolveReady: (r: AppResult<void>) => void = () => {}
    const ready = new Promise<AppResult<void>>((r) => (resolveReady = r))
    const events = {
      message: (m: unknown) => this.onMessage(host, m),
      exit: (code: number | null) => this.onExit(host, code),
    }
    const host: Host = {
      handle: this.opts.factory(events),
      ready,
      resolveReady,
      expectExit: false,
    }
    this.host = host
    host.handle.post({ type: 'init', protocol: PROTOCOL_VERSION, logLevel: this.opts.logLevel })
    return host
  }

  private onMessage(host: Host, raw: unknown): void {
    if (host !== this.host) return
    const parsed = parseWith(HostMessage, raw, `${WHERE}.message`)
    if (parsed.isErr()) {
      this.log.warn({ err: parsed.unwrapErr().toJSON() }, 'malformed message from the machine host')
      return
    }
    const m = parsed.unwrap()
    switch (m.type) {
      case 'ready':
        if (m.protocol !== PROTOCOL_VERSION)
          host.resolveReady(
            fail(
              'internal.unexpected',
              `machine host protocol ${m.protocol}, expected ${PROTOCOL_VERSION}`,
              {
                where: WHERE,
              },
            ),
          )
        else host.resolveReady(Ok(undefined))
        return
      case 'reply': {
        const resolve = this.pending.get(m.requestId)
        this.pending.delete(m.requestId)
        resolve?.(fromWire(m.result))
        return
      }
      case 'status':
        this.hostStatus = m.status
        if (m.status.buffer !== undefined)
          this.plannerCapacity = Math.max(this.plannerCapacity, m.status.buffer.blocks)
        if (this.job !== undefined) {
          this.estimate(this.job, m.status)
          const rec = this.recorder(this.job.jobId)
          if (rec !== undefined && m.status.job?.jobId === this.job.jobId)
            this.journal(rec.status(m.status, this.job.executing?.line, this.now()))
        }
        this.step = reconcileStep(this.step, this.status())
        this.notify()
        return
      case 'progress':
        if (this.job?.jobId === m.jobId) {
          this.job.done = m.done
          this.journal(this.recorder(m.jobId)?.progress(m.done, this.now()) === true)
          this.job.listener.progress({ done: m.done, total: m.total, label: m.label })
        }
        return
      case 'phase':
        if (this.job?.jobId === m.jobId && WAIT_OR_STREAM.includes(m.phase))
          this.job.atToolChange = m.phase === 'toolChange'
        if (this.job?.jobId === m.jobId)
          this.journal(this.recorder(m.jobId)?.phase(m.phase, this.now()) === true)
        if (this.job?.jobId === m.jobId)
          this.job.listener.phase({
            phase: m.phase,
            ...(m.heldBy === undefined ? {} : { heldBy: m.heldBy }),
            ...(m.toolChange === undefined ? {} : { toolChange: m.toolChange }),
            ...(m.message === undefined ? {} : { message: m.message }),
          })
        return
      case 'jobEnd': {
        const job = this.job
        if (job?.jobId !== m.jobId) return
        this.job = undefined
        const r = fromWire(m.result).andThen((v) =>
          parseWith(RunSummarySchema, v, `${WHERE}.jobEnd`),
        )
        job.end(r)
        this.notify()
        return
      }
      case 'event':
        if (m.kind === 'connectionLost') {
          // the host has dropped the connection: closed here too, and a fresh host next time
          this.log.warn({ ...m.data }, 'machine connection lost')
          this.recorder(this.job?.jobId)?.flag('connectionLost')
          this.markLost()
          const duringRun = this.job !== undefined
          host.expectExit = true
          this.conn = undefined
          this.hostStatus = undefined
          this.step = undefined
          this.reserved = undefined
          host.handle.terminate()
          // DF129 RC4: lost during a run: reconnect by itself (never otherwise)
          if (duringRun) this.startReconnect()
          this.notify()
          return
        }
        // DF129: a restart DFYOM did not cause while a job streams ends it as interrupted
        if (m.kind === 'reset' && m.data['expected'] === false)
          this.recorder(this.job?.jobId)?.flag('controllerReset')
        if (m.kind === 'alarm') this.log.warn({ kind: m.kind, ...m.data }, 'machine event')
        else this.log.debug({ kind: m.kind, ...m.data }, 'machine event')
        return
      case 'log':
        this.opts.onLog?.(m.batch)
        return
    }
  }

  private onExit(host: Host, code: number | null): void {
    if (host !== this.host) return
    const e = hostExited(code)
    const lostRun = !host.expectExit && this.conn !== undefined && this.job !== undefined
    if (!host.expectExit && this.conn !== undefined) {
      this.log.error({ err: e.toJSON() }, 'machine host exited unexpectedly')
      this.markLost()
      this.recorder(this.job?.jobId)?.flag('hostExit')
    }
    this.drop(host, e)
    this.conn = undefined
    this.hostStatus = undefined
    this.step = undefined
    this.reserved = undefined
    // DF129 RC4: the host died during a run: reconnect by itself
    if (lostRun) this.startReconnect()
    this.notify()
  }

  /** Forgets the current `host`: its waiters and its job get `e`; the next spawn starts afresh. */
  private drop(host: Host, e: AppError): void {
    this.host = undefined
    host.resolveReady(Err(e))
    for (const resolve of this.pending.values()) resolve(Err(e))
    this.pending.clear()
    const job = this.job
    this.job = undefined
    job?.end(Err(e))
  }

  private markLost(): void {
    const c = this.conn
    const h = this.hostStatus
    if (h !== undefined) this.lastSeen = { mpos: h.mpos, workZero: h.workZero }
    if (c?.target === undefined) return
    this.lost = { target: c.target, ...(c.port === undefined ? {} : { port: { ...c.port } }) }
  }

  private request(m: MainMessage & { requestId: string }): AsyncAppResult<unknown> {
    const host = this.host
    if (host === undefined) return Promise.resolve(this.notConnected())
    const requestId = `r${++this.seq}`
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve)
      host.handle.post({ ...m, requestId })
    })
  }

  private connectFailed(e: AppError): AppResult<never> {
    const host = this.host
    this.conn = undefined
    this.hostStatus = undefined
    this.step = undefined
    if (host !== undefined) {
      host.expectExit = true
      host.handle.terminate()
    }
    this.notify()
    return Err(e.withContext(`${WHERE}.connect`))
  }

  private notConnected(): AppResult<never> {
    return fail('run.notConnected', 'no machine connection', { where: WHERE })
  }

  private notify(): void {
    if (this.listeners.size === 0) return
    const s = this.status()
    for (const l of [...this.listeners]) l(s)
  }
}
