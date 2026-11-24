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
import type { TimeScale } from '../clock'
import type { Vec3 } from '../../toolpath/model'
import type { RunSummary, SenderProgram } from '../grbl/sender'
import {
  closedStatus,
  type JobAbout,
  type JobListener,
  type LastRun,
  type MachineService,
  type RunningJob,
  type RunPlan,
  type RunStatus,
} from '../service'
import type { SerialPortInfo } from '../serial'
import { programmedRates, type ProgrammedRates } from '../override'
import { reconcileStep, type AlignmentStep } from '../alignment'
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
}

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
  readonly about: JobAbout | undefined
  /** Lines acknowledged (last progress). */
  done: number
  /** Waiting at a tool change (last phase). */
  atToolChange: boolean
  /** The program's modal F (mm/min) and S (rpm, 0 = off) after each line (DF85). */
  readonly rates: ReturnType<typeof programmedRates>
}

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

const WHERE = 'MachineClient'

export class MachineClient implements MachineService {
  private host: Host | undefined
  private readonly pending = new Map<string, (r: AppResult<unknown>) => void>()
  private seq = 0
  private conn:
    | {
        state: 'connecting' | 'open'
        machineKey: string
        target?: TargetKind | undefined
        port?: { path: string; baud: number } | undefined
        settings?: Readonly<Record<string, number>> | undefined
      }
    | undefined
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
  /** DF78: the alignment step (docs/modes/alignment.md#state); dropped with the connection. */
  private step: AlignmentStep | undefined
  private timeScale: TimeScale = 1
  private readonly listeners = new Set<(s: RunStatus) => void>()
  private readonly log: Logger
  private readonly now: () => number

  constructor(private readonly opts: MachineClientOptions) {
    this.log = (opts.log ?? noopLogger).child({ scope: 'run.client' })
    this.now = opts.now ?? (() => Date.now())
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

  status(): RunStatus {
    const conn = this.conn
    const h = this.hostStatus
    const last = this.lastRun === undefined ? {} : { lastRun: { ...this.lastRun } }
    if (conn === undefined || h === undefined) {
      const s: RunStatus = { ...closedStatus(this.timeScale), ...last }
      if (conn === undefined && this.lost !== undefined)
        s.connection.lost = {
          target: this.lost.target,
          ...(this.lost.port === undefined ? {} : { port: { ...this.lost.port } }),
        }
      return conn === undefined
        ? s
        : {
            ...s,
            state: 'Connecting',
            connection: { ...s.connection, state: conn.state },
          }
    }
    const { job, timeScale, ...rest } = h
    return {
      ...rest,
      connection: {
        state: conn.state,
        ...(conn.target === undefined ? {} : { target: conn.target }),
        ...(conn.port === undefined ? {} : { port: { ...conn.port } }),
        timeScale,
      },
      ...(job === undefined || this.job?.jobId !== job.jobId
        ? {}
        : {
            job: {
              ...job,
              startedAt: this.job.startedAt,
              ...this.aboutJob(this.job, job.line),
              ...programmedAt(this.job, job.line),
            },
          }),
      ...last,
      ...(this.step === undefined ? {} : { alignment: structuredClone(this.step) }),
    }
  }

  alignmentStep(): AlignmentStep | undefined {
    return this.step === undefined ? undefined : structuredClone(this.step)
  }

  setAlignmentStep(step: AlignmentStep | undefined): void {
    this.step = step === undefined ? undefined : structuredClone(step)
    this.notify()
  }

  /** The plan, setup and current operation of a job (M7). */
  private aboutJob(job: Job, line: number): { plan?: RunPlan; planOperationId?: string } {
    const about = job.about
    if (about === undefined) return {}
    const op = operationAt(about, Math.max(1, line))
    return { plan: { ...about.plan }, ...(op === undefined ? {} : { planOperationId: op }) }
  }

  /** Records how a job ended (M5). */
  private ended(job: Job, r: AppResult<RunSummary>): void {
    const about = job.about
    if (about === undefined) return
    const op = r.isOk() ? undefined : stoppedOperation(about, job.done, job.atToolChange)
    this.lastRun = {
      jobId: job.jobId,
      planId: about.plan.planId,
      setupId: about.plan.setupId,
      outcome: r.isOk() ? 'done' : r.unwrapErr().code === 'op.aborted' ? 'stopped' : 'failed',
      ...(op === undefined ? {} : { planOperationId: op }),
      ...(about.planHash === undefined ? {} : { planHash: about.planHash }),
      ...(about.order === undefined ? {} : { operations: [...about.order] }),
    }
  }

  onStatus(listener: (s: RunStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async connect(target: ConnectTarget): AsyncAppResult<ConnectedInfo> {
    const machineKey = target.machineKey
    if (this.conn !== undefined)
      return fail('run.busy', 'a machine connection is already open', { where: `${WHERE}.connect` })
    // the kind is known from the start, so a connection lost while opening is reported too
    this.conn = { state: 'connecting', machineKey, target: target.kind }
    this.lost = undefined
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
    this.conn = {
      state: 'open',
      machineKey,
      target: connected.target,
      ...(connected.port === undefined ? {} : { port: connected.port }),
      settings: connected.settings,
    }
    this.log.info({ target: connected.target, version: connected.version }, 'connected')
    this.notify()
    return info
  }

  async listPorts(): AsyncAppResult<SerialPortInfo[]> {
    const host = this.spawn()
    const ready = await host.ready
    if (ready.isErr()) return Err(ready.unwrapErr().withContext(`${WHERE}.listPorts`))
    const r = await this.request({ type: 'listPorts', requestId: '' })
    return r.andThen((v) => parseWith(PortListSchema, v, `${WHERE}.listPorts`))
  }

  async disconnect(): AsyncAppResult<void> {
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
    about?: JobAbout,
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
        this.ended(job, r)
        resolveEnd(r)
      },
      about,
      done: 0,
      atToolChange: false,
      rates: programmedRates(program.lines),
    }
    this.job = job
    // a new run replaces the record of the last one
    if (about !== undefined) this.lastRun = undefined
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
      return Err(r.unwrapErr())
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
    const host = this.host
    if (host === undefined) return
    host.expectExit = true
    host.handle.terminate()
  }

  // ── host lifecycle ────────────────────────────────────────────────────────────────────────

  private spawn(): Host {
    if (this.host !== undefined) return this.host
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
        this.step = reconcileStep(this.step, this.status())
        this.notify()
        return
      case 'progress':
        if (this.job?.jobId === m.jobId) {
          this.job.done = m.done
          this.job.listener.progress({ done: m.done, total: m.total, label: m.label })
        }
        return
      case 'phase':
        if (this.job?.jobId === m.jobId && WAIT_OR_STREAM.includes(m.phase))
          this.job.atToolChange = m.phase === 'toolChange'
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
          this.markLost()
          host.expectExit = true
          this.conn = undefined
          this.hostStatus = undefined
          this.step = undefined
          this.reserved = undefined
          host.handle.terminate()
          this.notify()
          return
        }
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
    this.host = undefined
    const e = new AppError('machine.connection', 'the machine host exited', {
      where: WHERE,
      data: { exitCode: code },
    })
    if (!host.expectExit && this.conn !== undefined) {
      this.log.error({ err: e.toJSON() }, 'machine host exited unexpectedly')
      this.markLost()
    }
    host.resolveReady(Err(e))
    for (const resolve of this.pending.values()) resolve(Err(e))
    this.pending.clear()
    const job = this.job
    this.job = undefined
    job?.end(Err(e))
    this.conn = undefined
    this.hostStatus = undefined
    this.step = undefined
    this.reserved = undefined
    this.notify()
  }

  private markLost(): void {
    const c = this.conn
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
