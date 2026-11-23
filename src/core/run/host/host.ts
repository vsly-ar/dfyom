/**
 * The machine host, environment-neutral: owns the virtual machine, its transport, the sender,
 * the run clock and all run state; talks to main over an `Endpoint`.
 * Doc: docs/modes/run-v0.1.md#machine-host-and-protocol
 *
 * Hosts adapt their channel to an `Endpoint` (utility process: src/main/machine/utility.ts;
 * `worker_threads`: src/main/machine/node-worker.ts; tests: in-process) and call
 * `runMachineHost` once.
 */
import {
  createEntryLogger,
  createLogForwarder,
  noopLogger,
  type Logger,
  type LogForwarder,
} from '../../../shared/logging'
import { parseWith } from '../../../shared/parse'
import { Err, fail, Ok, toWire, tryAsync, type AppResult } from '../../../shared/result'
import type { Vec3 } from '../../toolpath/model'
import type { Endpoint } from '../../workers/protocol'
import { ScaledClock, type TimerHost, type TimeScale } from '../clock'
import { GrblEmulator } from '../grbl/emulator/emulator'
import {
  GrblSender,
  preflight,
  REALTIME,
  type PhaseChange,
  type RunPhase,
  type SenderEvent,
  type ToolChangeInfo,
} from '../grbl/sender'
import { envelopeOf, travelViolation, type Envelope, type TravelViolation } from '../grbl/envelope'
import { POSITION_ALARMS } from '../grbl/status'
import { VirtualGrblTransport } from '../grbl/virtual-transport'
import { sortPorts, type SerialPorts } from '../serial'
import type { ControllerTransport } from '../transport'
import {
  AXES,
  MainMessage,
  PROTOCOL_VERSION,
  type ConnectedInfo,
  type HostMessage,
  type HostStatus,
  type MachineAction,
  type ConnectTarget,
  type MainRequest,
  type SerialTarget,
  type TargetKind,
  type VirtualTarget,
} from './protocol'

/**
 * Banner wait on a serial port: opening it resets most Arduino-based boards, whose bootloader
 * needs 1–2 s before GRBL prints its banner (docs/modes/run-machine.md#connect).
 */
export const SERIAL_BANNER_MS = 3000

export interface MachineHostOptions {
  readonly timers: TimerHost
  /** Root logger binding: `utility` in the app, `worker` headless. */
  readonly proc: 'utility' | 'worker'
  /** Min wall interval between `status` and between `progress` messages (default 100 ms). */
  readonly throttleMs?: number
  /** Called after `disconnect` was answered: the process may exit. */
  readonly onDisconnected?: () => void
  /** Serial ports (Node `serialport` in the host entries, a loopback in tests); absent = none. */
  readonly serial?: SerialPorts
}

export interface MachineHost {
  /** The host's logger (uncaught errors of the process). */
  log(): Logger
  /** Headless exit: stops a running job (controlled stop) and disconnects. */
  shutdown(): Promise<void>
}

interface Job {
  readonly jobId: string
  phase: RunPhase
  toolChange?: ToolChangeInfo | undefined
  readonly startedAt: number
  /** The start's checks passed and the sender streams: a stop goes to the sender. */
  streaming: boolean
  /**
   * A stop (`stop`, disconnect) came while the start's checks ran: the start refuses with
   * `op.aborted` instead of streaming (docs/modes/run-v0.1.md#review-of-39).
   */
  stopRequested: boolean
  /** Settles when the start has streamed or refused. */
  readonly checked: Promise<void>
}

interface Connection {
  readonly target: TargetKind
  readonly port?: { readonly path: string; readonly baud: number } | undefined
  readonly machineKey: string
  readonly clock: ScaledClock
  readonly sender: GrblSender
  homed: boolean
  workZero: Vec3
  alarm?: { readonly code: number; readonly text: string } | undefined
  lastMessage?: string | undefined
  job?: Job | undefined
  /** From the controller's `$$` at connect; undefined when it reports no travel. */
  readonly envelope: Envelope | undefined
  /**
   * End (MPos) of the last jog GRBL accepted; the base of the next relative jog's travel check
   * while jogs queue. Cleared by anything else that moves or questions the position.
   */
  jogEnd?: Vec3 | undefined
}

const fmt = (v: number) => {
  const s = v.toFixed(3).replace(/\.?0+$/, '')
  return s === '-0' ? '0' : s
}

export function runMachineHost(endpoint: Endpoint, opts: MachineHostOptions): MachineHost {
  const timers = opts.timers
  const throttleMs = opts.throttleMs ?? 100
  const post = (m: HostMessage) => endpoint.post(m)
  let log: Logger = noopLogger
  let forwarder: LogForwarder | undefined
  let conn: Connection | undefined
  let connecting = false

  // ── throttled pushes (wall time) ──────────────────────────────────────────────────────────

  function throttled(send: () => void): { now(): void; soon(): void; cancel(): void } {
    let last = Number.NEGATIVE_INFINITY
    let cancel: (() => void) | undefined
    const fire = () => {
      cancel?.()
      cancel = undefined
      last = timers.now()
      send()
    }
    return {
      now: fire,
      soon() {
        if (cancel !== undefined) return
        const wait = last + throttleMs - timers.now()
        if (wait <= 0) fire()
        else cancel = timers.setTimeout(fire, wait)
      },
      cancel() {
        cancel?.()
        cancel = undefined
      },
    }
  }

  let lastState = ''
  const status = throttled(() => {
    const s = hostStatus()
    if (s !== undefined) post({ type: 'status', status: s })
  })
  let lastProgress: { jobId: string; done: number; total: number; label: string } | undefined
  const progress = throttled(() => {
    if (lastProgress !== undefined) post({ type: 'progress', ...lastProgress })
  })

  function hostStatus(): HostStatus | undefined {
    if (conn === undefined) return undefined
    const s = conn.sender.status
    const job = conn.job
    const wait = conn.sender.wait
    return {
      state: s?.state ?? 'Unknown',
      homed: conn.homed,
      mpos: s?.mpos ?? [0, 0, 0],
      wpos: s?.wpos ?? [0, 0, 0],
      workZero: conn.workZero,
      feed: s?.feed ?? 0,
      spindle: s?.spindle ?? 0,
      ...(s?.buffer === undefined ? {} : { buffer: s.buffer }),
      ...(conn.alarm === undefined ? {} : { alarm: conn.alarm }),
      ...(conn.lastMessage === undefined ? {} : { lastMessage: conn.lastMessage }),
      ...(conn.envelope === undefined
        ? {}
        : {
            envelope: {
              travel: conn.envelope.travel,
              homingMask: conn.envelope.homingMask,
              pullOff: conn.envelope.pullOff,
              softLimits: conn.envelope.softLimits,
            },
          }),
      timeScale: conn.clock.scale,
      ...(job === undefined
        ? {}
        : {
            job: {
              jobId: job.jobId,
              phase: job.phase,
              line: conn.sender.line ?? 0,
              ...(job.toolChange === undefined ? {} : { toolChange: job.toolChange }),
              ...(job.phase === 'programPause' && wait !== undefined && 'pause' in wait
                ? { pause: wait.pause }
                : {}),
              elapsedSeconds: (conn.clock.now() - job.startedAt) / 1000,
            },
          }),
    }
  }

  // ── requests ──────────────────────────────────────────────────────────────────────────────

  const reply = (requestId: string, result: AppResult<unknown>) =>
    post({ type: 'reply', requestId, result: toWire(result) })

  function stateError(message: string, state: string): AppResult<never> {
    return fail('run.state', message, { where: 'machineHost', data: { state } })
  }

  function notConnected(): AppResult<never> {
    return fail('run.notConnected', 'no machine connection', { where: 'machineHost' })
  }

  async function connect(target: ConnectTarget): Promise<AppResult<ConnectedInfo>> {
    if (conn !== undefined || connecting)
      return fail('run.busy', 'already connected', { where: 'machineHost.connect' })
    return target.kind === 'serial' ? connectSerial(target) : connectVirtual(target)
  }

  /** A real controller on a serial port (docs/modes/run-machine.md#connect). */
  async function connectSerial(target: SerialTarget): Promise<AppResult<ConnectedInfo>> {
    const where = 'machineHost.connect'
    if (opts.serial === undefined)
      return fail('machine.connection', 'serial ports are not available here', { where })
    connecting = true
    const opened = await opts.serial.open(target.path, target.baud)
    if (opened.isErr()) {
      connecting = false
      return Err(opened.unwrapErr().withContext(where, { path: target.path }))
    }
    const transport = opened.unwrap()
    // a real controller runs in real time (decision 3 is virtual-only)
    const clock = new ScaledClock(timers, { scale: 1 })
    const sender = new GrblSender(transport, clock, {
      timers,
      log,
      bannerTimeoutMs: SERIAL_BANNER_MS,
    })
    clock.setBusy(() => sender.needsStatus)
    const port = { path: target.path, baud: target.baud }
    // never assumed homed: GRBL with $22=1 starts locked, and the position is unknown
    return finishConnect(target, clock, sender, transport, false, port)
  }

  async function connectVirtual(target: VirtualTarget): Promise<AppResult<ConnectedInfo>> {
    const settings: Record<number, number> = {}
    for (const [k, v] of Object.entries(target.settings)) settings[Number(k)] = v
    const created = GrblEmulator.create({
      settings,
      homing: target.homing,
      trace: false,
      ...(target.position === undefined ? {} : { position: target.position }),
    })
    if (created.isErr()) return Err(created.unwrapErr().withContext('machineHost.connect'))
    const emu = created.unwrap()
    connecting = true
    const clock = new ScaledClock(timers, { scale: target.timeScale })
    const transport = new VirtualGrblTransport(emu, clock)
    const sender = new GrblSender(transport, clock, { timers, log })
    clock.setBusy(() => emu.nextEventAt() !== undefined || sender.needsStatus)
    const c = await finishConnect(target, clock, sender, transport, !target.homing, undefined)
    if (c.isErr() || target.prepare === undefined || conn === undefined) return c
    const prepared = await prepare(conn, target.prepare.workZero)
    if (prepared.isErr()) return Err(prepared.unwrapErr())
    status.now()
    return Ok({ ...c.unwrap(), workZero: conn.workZero, homed: conn.homed })
  }

  /** The handshake and the connection's bookkeeping, for every target. */
  async function finishConnect(
    target: ConnectTarget,
    clock: ScaledClock,
    sender: GrblSender,
    transport: ControllerTransport,
    homed: boolean,
    port: { path: string; baud: number } | undefined,
  ): Promise<AppResult<ConnectedInfo>> {
    const info = await sender.connect()
    connecting = false
    if (info.isErr()) {
      clock.dispose()
      if (target.kind === 'serial') await transport.close()
      return Err(info.unwrapErr())
    }
    const c: Connection = {
      target: target.kind,
      ...(port === undefined ? {} : { port }),
      machineKey: target.machineKey,
      clock,
      sender,
      homed,
      workZero: info.unwrap().workZero,
      envelope: envelopeOf(info.unwrap().settings),
    }
    conn = c
    sender.onStatus((s) => {
      if (s.state !== lastState) {
        lastState = s.state
        status.now()
      } else status.soon()
    })
    sender.onEvent((e) => onSenderEvent(c, e))
    log.info(
      {
        target: target.kind,
        version: info.unwrap().version,
        timeScale: clock.scale,
        ...(port === undefined ? {} : { path: port.path, baud: port.baud }),
      },
      'connected',
    )
    status.now()
    return Ok({
      ...info.unwrap(),
      target: target.kind,
      ...(port === undefined ? {} : { port }),
      workZero: c.workZero,
      homed: c.homed,
    })
  }

  /** Decision 7: home at `max` speed, then G54 at the given MPos. */
  async function prepare(c: Connection, workZero: Vec3): Promise<AppResult<void>> {
    if (!c.homed) {
      const scale = c.clock.scale
      c.clock.setScale('max')
      const homed = await home(c)
      c.clock.setScale(scale)
      if (homed.isErr()) return homed
    }
    const set = await c.sender.command(
      `G21 G10 L2 P1 X${fmt(workZero[0])} Y${fmt(workZero[1])} Z${fmt(workZero[2])}`,
    )
    if (set.isErr()) return Err(set.unwrapErr())
    return (await readWorkZero(c)).map(() => undefined)
  }

  async function readWorkZero(c: Connection): Promise<AppResult<Vec3>> {
    const r = await c.sender.readWorkZero()
    if (r.isOk()) {
      c.workZero = r.unwrap()
      log.debug({ workZero: c.workZero }, 'work zero')
      // the reply should find main's mirror current
      await c.sender.freshStatus()
      status.now()
    }
    return r
  }

  async function home(c: Connection): Promise<AppResult<void>> {
    c.jogEnd = undefined
    const r = await c.sender.command('$H')
    if (r.isErr()) return Err(r.unwrapErr())
    c.homed = true
    c.alarm = undefined
    log.info('homing done')
    return (await readWorkZero(c)).map(() => undefined)
  }

  const machineState = (c: Connection) => c.sender.status?.state ?? 'Unknown'

  async function machine(action: MachineAction): Promise<AppResult<unknown>> {
    const c = conn
    if (c === undefined) return notConnected()
    const state = machineState(c)
    const phase = c.job?.phase
    const jobBusy = c.job !== undefined && phase !== 'toolChange'
    switch (action.kind) {
      case 'home':
        if (c.job !== undefined) return stateError('cannot home during a run', state)
        if (state !== 'Idle' && state !== 'Alarm')
          return stateError(`cannot home in state ${state}`, state)
        return home(c)
      case 'unlock': {
        if (c.job !== undefined) return stateError('cannot unlock during a run', state)
        const r = await c.sender.command('$X')
        if (r.isOk()) c.alarm = undefined
        return r.map(() => undefined)
      }
      case 'jog': {
        if (jobBusy || (state !== 'Idle' && !state.startsWith('Jog')))
          return stateError(`cannot jog in state ${state}${phase ? ` (${phase})` : ''}`, state)
        if ((action.to === undefined) === (action.by === undefined))
          return fail('input.malformed', 'jog needs exactly one of to or by', {
            where: 'machineHost.jog',
            issues: [{ path: ['to'], rule: 'oneOf', message: 'give to or by' }],
          })
        if (action.continuous === true) return jogToEdge(c, action.by ?? [0, 0, 0], action.feed)
        const v = action.to ?? action.by ?? [0, 0, 0]
        const mode = action.to !== undefined ? 'G53 G90' : 'G91'
        const line = `$J=G21 ${mode} X${fmt(v[0])} Y${fmt(v[1])} Z${fmt(v[2])} F${fmt(action.feed)}`
        // the jog's end in MPos: relative jogs from the end of the queued ones, else the report
        const base = c.jogEnd ?? c.sender.status?.mpos
        const end: Vec3 | undefined =
          action.to ??
          (base === undefined ? undefined : [base[0] + v[0], base[1] + v[1], base[2] + v[2]])
        const env = c.envelope
        const outside =
          env?.softLimits === true && end !== undefined
            ? travelViolation(env.travel, end)
            : undefined
        if (outside !== undefined) return travelError(outside)
        const r = await c.sender.command(line)
        if (r.isErr()) {
          const e = r.unwrapErr()
          // GRBL's own check (error:15) when the estimate lagged: the same refusal in words
          if (e.code === 'machine.error' && e.frames[0]?.data?.['code'] === 15)
            return travelError(
              env !== undefined && end !== undefined ? travelViolation(env.travel, end) : undefined,
            )
          return Err(e)
        }
        c.jogEnd = end
        return Ok(undefined)
      }
      case 'jogCancel':
        c.jogEnd = undefined
        return c.sender.realtime(REALTIME.jogCancel)
      case 'setWorkZero': {
        if (jobBusy || state !== 'Idle')
          return stateError(`cannot set the work zero in state ${state}`, state)
        const words = action.axes.map((a) => {
          const v = action.values?.[AXES.indexOf(a)] ?? 0
          return `${a.toUpperCase()}${fmt(v)}`
        })
        const set = await c.sender.command(`G21 G10 L20 P1 ${words.join(' ')}`)
        if (set.isErr()) return Err(set.unwrapErr())
        return readWorkZero(c)
      }
      case 'reset':
        c.jogEnd = undefined
        return c.sender.realtime(REALTIME.reset)
    }
  }

  /**
   * Continuous jog (hold to jog, docs/modes/run-machine.md#machine-readiness-m3): an absolute
   * machine move to the travel edge in the direction of `by` (one axis), ended by a jog cancel.
   * The exact edge (`0` or `−travel`) never trips GRBL's soft-limit check on rounding.
   */
  async function jogToEdge(c: Connection, by: Vec3, feed: number): Promise<AppResult<unknown>> {
    const where = 'machineHost.jog'
    const axes = [0, 1, 2].filter((i) => by[i] !== 0)
    if (axes.length !== 1)
      return fail('input.malformed', 'a continuous jog moves exactly one axis', {
        where,
        issues: [{ path: ['by'], rule: 'oneAxis', message: 'give one non-zero axis' }],
      })
    const i = axes[0]!
    const env = c.envelope
    if (env === undefined) return stateError('the machine travel is not known yet', machineState(c))
    const edge = by[i]! > 0 ? 0 : -env.travel[i]!
    const base = c.jogEnd ?? c.sender.status?.mpos
    const axis = AXES[i]!
    if (base !== undefined && (by[i]! > 0 ? base[i]! >= edge - 1e-3 : base[i]! <= edge + 1e-3))
      return fail('run.travel', `${axis.toUpperCase()} is at the end of its travel`, {
        where,
        data: { axis, target: base[i]!, min: -env.travel[i]!, max: 0, atEdge: true },
      })
    const r = await c.sender.command(
      `$J=G21 G53 G90 ${axis.toUpperCase()}${fmt(edge)} F${fmt(feed)}`,
    )
    if (r.isErr()) {
      const e = r.unwrapErr()
      if (e.code === 'machine.error' && e.frames[0]?.data?.['code'] === 15)
        return travelError(undefined)
      return Err(e)
    }
    const at = (k: number) => (k === i ? edge : (base?.[k] ?? 0))
    c.jogEnd = base === undefined ? undefined : [at(0), at(1), at(2)]
    return Ok(undefined)
  }

  /** `run.travel`: a jog outside `[−travel, 0]`, in words (docs/modes/run.md DF33). */
  function travelError(v: TravelViolation | undefined): AppResult<never> {
    const where = 'machineHost.jog'
    if (v === undefined)
      return fail('run.travel', 'the jog would leave the machine travel (GRBL error 15)', { where })
    const A = v.axis.toUpperCase()
    const limit = v.target > v.max ? `max ${fmt(v.max)} mm` : `min ${fmt(v.min)} mm`
    return fail(
      'run.travel',
      `${A} would leave the travel: ${limit}, the jog would end at ${fmt(v.target)} mm`,
      { where, data: { axis: v.axis, target: v.target, min: v.min, max: v.max } },
    )
  }

  /**
   * Starts streaming after re-checking what main checked the program against: the target, the
   * machine copy and the G54 (read again with `$#`), on a status report taken now. The job is
   * registered first, so no jog or work-zero change slips in between; a stop or disconnect during
   * the checks makes the start refuse with `op.aborted` (the sender never streams).
   */
  async function jobStart(
    jobId: string,
    program: { lines: string[]; sections: { fromLine: number; label: string }[] },
    expect: { workZero: Vec3; machineKey: string; target: TargetKind },
  ): Promise<AppResult<void>> {
    const where = 'machineHost.jobStart'
    const c = conn
    if (c === undefined) return notConnected()
    if (c.job !== undefined) return fail('run.busy', `job ${c.job.jobId} is running`, { where })
    const pf = preflight(program.lines, where)
    if (pf.isErr()) return pf
    let checked: () => void = () => {}
    const job: Job = {
      jobId,
      phase: 'streaming',
      startedAt: c.clock.now(),
      streaming: false,
      stopRequested: false,
      checked: new Promise<void>((r) => (checked = r)),
    }
    c.job = job
    c.jogEnd = undefined
    try {
      return await checkAndStream(c, job, program, expect)
    } finally {
      checked()
    }
  }

  async function checkAndStream(
    c: Connection,
    job: Job,
    program: { lines: string[]; sections: { fromLine: number; label: string }[] },
    expect: { workZero: Vec3; machineKey: string; target: TargetKind },
  ): Promise<AppResult<void>> {
    const where = 'machineHost.jobStart'
    const jobId = job.jobId
    const refuse = (r: AppResult<never>): AppResult<void> => {
      if (c.job === job) c.job = undefined
      status.now()
      // stopped while checking: the stop wins over whatever the checks ran into (a closed sender)
      return job.stopRequested
        ? fail('op.aborted', 'the run was stopped before it started', { where })
        : r
    }
    const mismatch = (rule: string, message: string, data: Record<string, unknown>) =>
      fail('run.state', message, {
        where,
        data: { state: machineState(c), ...data },
        issues: [{ path: ['expect'], rule, message }],
      })
    if (expect.target !== c.target)
      return refuse(mismatch('targetMismatch', 'the job was checked for another target', {}))
    if (expect.machineKey !== c.machineKey)
      return refuse(
        mismatch('machineMismatch', 'the job was exported for another machine copy', {}),
      )
    const fresh = await c.sender.freshStatus()
    if (fresh === undefined)
      return refuse(fail('machine.connection', 'no status report before the start', { where }))
    if (fresh.state !== 'Idle')
      return refuse(stateError(`the machine is ${fresh.state}, not Idle`, fresh.state))
    if (!c.homed) return refuse(stateError('the machine is not homed', fresh.state))
    const wz = await readWorkZero(c)
    if (wz.isErr()) return refuse(Err(wz.unwrapErr()))
    if (wz.unwrap().some((v, i) => Math.abs(v - (expect.workZero[i] ?? Number.NaN)) > 5e-4))
      return refuse(
        mismatch('workZeroChanged', 'the work zero changed after the program was checked', {
          expected: [...expect.workZero],
          actual: [...wz.unwrap()],
        }),
      )
    if (c.job !== job || conn !== c)
      return refuse(fail('run.busy', 'the start was overtaken', { where }))
    if (job.stopRequested) return refuse(fail('op.aborted', 'stopped while starting', { where }))
    job.streaming = true
    log.info({ jobId, lines: program.lines.length }, 'job started')
    void c.sender
      .run(program, {
        progress: (p) => {
          lastProgress = { jobId, ...p }
          progress.soon()
        },
        phase: (p: PhaseChange) => {
          job.phase = p.phase
          job.toolChange = p.toolChange
          if (p.phase === 'toolChange') log.debug({ tool: p.toolChange?.n }, 'tool change')
          post({
            type: 'phase',
            jobId,
            phase: p.phase,
            ...(p.toolChange === undefined ? {} : { toolChange: p.toolChange }),
            ...(p.message === undefined ? {} : { message: p.message }),
          })
          status.now()
        },
      })
      .then((result) => {
        if (lastProgress?.jobId === jobId) progress.now()
        progress.cancel()
        lastProgress = undefined
        c.job = undefined
        log.info(
          {
            jobId,
            ...(result.isOk()
              ? { lines: result.unwrap().lines, s: result.unwrap().seconds }
              : { code: result.unwrapErr().code }),
          },
          'job ended',
        )
        post({ type: 'jobEnd', jobId, result: toWire(result) })
        status.now()
      })
    return Ok(undefined)
  }

  async function jobControl(
    jobId: string,
    action: 'hold' | 'resume' | 'continue' | 'stop',
    expect: { toolChange?: number; pause?: number } | undefined,
  ): Promise<AppResult<void>> {
    const c = conn
    if (c === undefined) return notConnected()
    if (c.job?.jobId !== jobId)
      return fail('run.state', `job ${jobId} is not running`, {
        where: 'machineHost.jobControl',
        data: { state: machineState(c) },
      })
    switch (action) {
      case 'hold':
        return c.sender.hold()
      case 'resume':
        return c.sender.resume()
      case 'continue': {
        const wait = c.sender.wait
        const named =
          wait === undefined
            ? undefined
            : 'toolChange' in wait
              ? expect?.toolChange === wait.toolChange
              : expect?.pause === wait.pause
        if (named !== true)
          return fail(
            'run.state',
            wait === undefined
              ? 'the run does not wait at a tool change or pause'
              : `the run waits at ${'toolChange' in wait ? `tool change ${wait.toolChange}` : `pause ${wait.pause}`}, not the one given`,
            {
              where: 'machineHost.continue',
              data: { state: machineState(c), ...(c.job.phase ? { phase: c.job.phase } : {}) },
            },
          )
        // decide on a report taken now: a jog or G10 just acknowledged may still be moving
        await c.sender.freshStatus()
        return c.sender.continueProgram()
      }
      case 'stop':
        // during the start's checks the sender has no run yet: the start refuses instead
        if (!c.job.streaming) c.job.stopRequested = true
        else void c.sender.stop()
        return Ok(undefined)
    }
  }

  async function disconnect(): Promise<AppResult<void>> {
    const c = conn
    if (c === undefined) return Ok(undefined)
    const job = c.job
    if (job?.streaming === true) await c.sender.stop()
    else if (job !== undefined) {
      // a start still checking: let it refuse (op.aborted) before the sender closes under it
      job.stopRequested = true
      await job.checked
    }
    conn = undefined
    status.cancel()
    progress.cancel()
    // disconnect = reset on a real machine: no queued jog or line runs on after we let go
    // (docs/modes/run.md#6-lost-connection-disconnect-and-reconnect)
    const closed = await c.sender.close({ reset: c.target === 'serial' })
    c.clock.dispose()
    log.info('disconnected')
    return closed
  }

  function onSenderEvent(c: Connection, e: SenderEvent): void {
    switch (e.kind) {
      case 'alarm':
        c.jogEnd = undefined
        c.alarm = { code: e.code, text: e.text }
        if (POSITION_ALARMS.has(e.code)) c.homed = false
        post({ type: 'event', kind: 'alarm', data: { code: e.code, text: e.text } })
        break
      case 'error':
        post({
          type: 'event',
          kind: 'error',
          data: { code: e.code, text: e.text, ...(e.line === undefined ? {} : { line: e.line }) },
        })
        break
      case 'message':
        c.lastMessage = e.text
        post({ type: 'event', kind: 'message', data: { text: e.text } })
        break
      case 'reset':
        c.jogEnd = undefined
        // a controller that restarted on its own (power glitch, USB reset) lost its position:
        // home again before a run (docs/modes/run-machine.md#real-machine-run-rules)
        if (!e.expected) c.homed = false
        post({ type: 'event', kind: 'reset', data: { expected: e.expected } })
        // GRBL keeps G54 over a reset; read it again anyway (docs/modes/run-v0.1.md#work-zero-and-the-soft-limit-check)
        if (c.job === undefined || c.job.phase === 'stopping')
          void timers.setTimeout(() => {
            if (conn === c && c.job === undefined) void readWorkZero(c)
          }, 0)
        break
      case 'connectionLost':
        log.warn({ reason: e.reason }, 'connection lost')
        post({ type: 'event', kind: 'connectionLost', data: { reason: e.reason } })
        // the connection is gone: main closes it and starts a fresh host on the next open
        if (conn === c) {
          conn = undefined
          status.cancel()
          c.clock.dispose()
          void c.sender.close()
        }
        return
    }
    status.now()
  }

  async function handle(m: MainRequest): Promise<AppResult<unknown>> {
    switch (m.type) {
      case 'connect':
        return connect(m.target)
      case 'disconnect': {
        const r = await disconnect()
        return r
      }
      case 'machine':
        return machine(m.action)
      case 'jobStart':
        return jobStart(m.jobId, m.program, m.expect)
      case 'jobControl':
        return jobControl(m.jobId, m.action, m.expect)
      case 'listPorts': {
        if (opts.serial === undefined)
          return fail('machine.connection', 'serial ports are not available here', {
            where: 'machineHost.listPorts',
          })
        return (await opts.serial.list()).map(sortPorts)
      }
      case 'timeScale': {
        const c = conn
        if (c === undefined) return notConnected()
        if (c.target !== 'virtual')
          return fail('run.state', 'the time scale is for the virtual machine only', {
            where: 'machineHost.timeScale',
            data: { state: machineState(c) },
            issues: [
              { path: ['scale'], rule: 'virtualOnly', message: 'a real machine runs at 1×' },
            ],
          })
        c.clock.setScale(m.scale as TimeScale)
        log.debug({ timeScale: m.scale }, 'time scale')
        status.now()
        return Ok(undefined)
      }
    }
  }

  endpoint.onMessage((raw) => {
    const parsed = parseWith(MainMessage, raw, 'machineHost.message')
    if (parsed.isErr()) {
      const id = (raw as { requestId?: unknown } | null)?.requestId
      log.warn({ err: parsed.unwrapErr().toJSON() }, 'malformed message from main')
      if (typeof id === 'string' && id.length > 0 && id.length <= 200)
        reply(id, Err(parsed.unwrapErr()))
      return
    }
    const m = parsed.unwrap()
    if (m.type === 'init') {
      forwarder = createLogForwarder({ send: (batch) => post({ type: 'log', batch: [...batch] }) })
      const fw = forwarder
      log = createEntryLogger({
        level: m.logLevel,
        bindings: { proc: opts.proc, scope: 'run.host' },
        write: (r) => fw.push(r),
      })
      log.info({ protocol: PROTOCOL_VERSION }, 'machine host started')
      post({ type: 'ready', protocol: PROTOCOL_VERSION })
      fw.flush()
      return
    }
    void tryAsync(() => handle(m), 'internal.unexpected', `machine host: ${m.type} threw`).then(
      (r) => {
        const result = r.isOk() ? r.unwrap() : Err(r.unwrapErr())
        reply(m.requestId, result)
        if (m.type === 'disconnect') opts.onDisconnected?.()
      },
    )
  })

  return {
    log: () => log,
    async shutdown() {
      await disconnect()
      forwarder?.flush()
    },
  }
}
