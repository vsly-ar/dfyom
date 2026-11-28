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
  OVERRIDE,
  preflight,
  REALTIME,
  type RealtimeCommand,
  type PhaseChange,
  type RunPhase,
  STILL_STATES,
  type SenderEvent,
  type ToolChangeInfo,
} from '../grbl/sender'
import { envelopeOf, travelViolation, type Envelope, type TravelViolation } from '../grbl/envelope'
import { limitSwitches, POSITION_ALARMS } from '../grbl/status'
import { overrideLimits, overrideSteps } from '../override'
import { runProbeCycle, type ProbePort } from '../probe-cycle'
import { runProbeRoutine } from '../probe-routines'
import type { ProbeTarget } from '../grbl/emulator/probe-scene'
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
  type OverrideStep,
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
  /** DF69: the level (mm, < 0) of the tool run's Z reference surface, from its tool change; 0 = top. */
  level: number
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
  /** `reset` events with the position lost so far (a homing they overlap does not hold). */
  positionResets?: number
  workZero: Vec3
  /**
   * DF69: the level (mm, setup frame, ≤ 0) of the surface G54 Z was last set on: the run's
   * reference surface when set during a run, else the stock top (0)
   * (docs/modes/z-reference.md#dfyom-run).
   */
  zeroLevel: number
  alarm?: { readonly code: number; readonly text: string; readonly reset?: true } | undefined
  lastMessage?: string | undefined
  job?: Job | undefined
  /** From the controller's `$$` at connect; undefined when it reports no travel. */
  readonly envelope: Envelope | undefined
  /** `$32=1` at connect (DF85). */
  readonly laserMode: boolean
  /**
   * End (MPos) of the last jog GRBL accepted; the base of the next relative jog's travel check
   * while jogs queue. Cleared by anything else that moves or questions the position.
   */
  jogEnd?: Vec3 | undefined
  /** DF84: the run's lines acknowledged when the last status report arrived. */
  ackedAtReport?: number | undefined
  /** The virtual machine's emulator (its touch plate is laid before each probe, M4). */
  readonly emulator?: GrblEmulator | undefined
  /** `$13=1`: GRBL reports in inch. */
  readonly inches: boolean
  /** DF129: the virtual machine's cable pulled ("Simulate a lost connection"); virtual only. */
  readonly unplug?: (() => void) | undefined
  /** DF134: a hook applied to the virtual machine's emulator at the current time; virtual only. */
  readonly controllerSide?: ((act: (e: GrblEmulator) => void) => void) | undefined
  /** gCode that restores the modal state a failed probe left (sent after `$X`/`$H`, M4). */
  restoreModes?: readonly string[] | undefined
  /**
   * RV1: the `S` (rpm) the last spindle action turned the spindle on at; cleared by `M5`, a
   * reset, an alarm and a run start (docs/modes/run-machine.md#spindle-while-jogging-rv1).
   */
  manualSpindle?: { readonly rpm: number } | undefined
  /** RV1: a spindle off is cancelling a jog: new jogs are refused until it is done. */
  spindleStopping?: boolean
  /** v0.5 RV5: the virtual machine's stock (MPos) and whether it closes the probe input now. */
  virtualStock?: { readonly stock?: VirtualStock; readonly touch: boolean } | undefined
}

type VirtualStock = NonNullable<Extract<MachineAction, { kind: 'virtualStock' }>['stock']>
type ProbeRoutineAction = Extract<MachineAction, { kind: 'probeRoutine' }>

type ProbeZ = Extract<MachineAction, { kind: 'probeZ' }>
type SpindleAction = Extract<MachineAction, { kind: 'spindle' }>
type OverrideAction = Extract<MachineAction, { kind: 'override' }>
type OverrideToAction = Extract<MachineAction, { kind: 'overrideTo' }>

/**
 * Between two override bytes (DF85): GRBL keeps one flag per byte kind until its main loop
 * applies it, so two equal bytes in a row could count once; a gap lets each apply on its own.
 * The read-back corrects the rest.
 */
export const OVERRIDE_BYTE_GAP_MS = 25
/** Rounds of steps and read-back for one override target. */
const OVERRIDE_ROUNDS = 3

/** Feed and spindle steps → their real-time bytes; rapids by percent. */
const OVERRIDE_BYTES: Readonly<
  Record<'feed' | 'spindle', Readonly<Record<OverrideStep, RealtimeCommand>>>
> = {
  feed: {
    reset: OVERRIDE.feedReset,
    '+10': OVERRIDE.feedPlus10,
    '-10': OVERRIDE.feedMinus10,
    '+1': OVERRIDE.feedPlus1,
    '-1': OVERRIDE.feedMinus1,
  },
  spindle: {
    reset: OVERRIDE.spindleReset,
    '+10': OVERRIDE.spindlePlus10,
    '-10': OVERRIDE.spindleMinus10,
    '+1': OVERRIDE.spindlePlus1,
    '-1': OVERRIDE.spindleMinus1,
  },
}
const RAPID_BYTES: Readonly<Record<string, RealtimeCommand>> = {
  '100': OVERRIDE.rapid100,
  '50': OVERRIDE.rapid50,
  '25': OVERRIDE.rapid25,
}

/** Machine time a manual feed hold may take to report `Hold:0` (as the sender's stop, 5 s). */
const FEED_HOLD_MS = 5000

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
  /** DF85: override targets run one after another. */
  let overrideChain: Promise<void> = Promise.resolve()

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
  /** The last `status` posted, serialized: an unchanged report is not posted again (P7, idle cost). */
  let lastPosted: string | undefined
  const status = throttled(() => {
    const s = hostStatus()
    if (s === undefined) return
    // Polled at 5 Hz while connected (run-v0.1.md#behaviour), but an idle machine reports the
    // same thing every time: main and the windows only hear about changes (docs/research/2026-11-23-idle-cost.md).
    const key = JSON.stringify(s)
    if (key === lastPosted) return
    lastPosted = key
    post({ type: 'status', status: s })
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
    const holdBy = conn.sender.holdBy
    return {
      state: s?.state ?? 'Unknown',
      ...(holdBy === undefined ? {} : { holdBy }),
      homed: conn.homed,
      mpos: s?.mpos ?? [0, 0, 0],
      wpos: s?.wpos ?? [0, 0, 0],
      workZero: conn.workZero,
      feed: s?.feed ?? 0,
      spindle: s?.spindle ?? 0,
      ...(s?.spindleDirection === undefined ? {} : { spindleDirection: s.spindleDirection }),
      ...(conn.manualSpindle === undefined ? {} : { manualSpindle: conn.manualSpindle }),
      ...(s?.buffer === undefined ? {} : { buffer: s.buffer }),
      ...(s?.overrides === undefined ? {} : { overrides: s.overrides }),
      ...(conn.alarm === undefined ? {} : { alarm: conn.alarm }),
      ...(s?.pins === undefined ? {} : { pins: s.pins }),
      ...(conn.laserMode ? { laserMode: true as const } : {}),
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
      ...(conn.zeroLevel === 0 ? {} : { zeroLevel: conn.zeroLevel }),
      ...(job === undefined
        ? {}
        : {
            job: {
              jobId: job.jobId,
              phase: job.phase,
              line: conn.sender.line ?? 0,
              ...(conn.sender.sent === undefined ? {} : { sent: conn.sender.sent }),
              ...(conn.ackedAtReport === undefined ? {} : { ackedAtReport: conn.ackedAtReport }),
              ...(s?.line === undefined ? {} : { reportedLine: s.line }),
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
    // DF134: hard limits on ($21=1) as on a router's controller, so a simulated limit switch alarms
    const settings: Record<number, number> = { 21: 1 }
    for (const [k, v] of Object.entries(target.settings)) settings[Number(k)] = v
    const created = GrblEmulator.create({
      settings,
      homing: target.homing,
      trace: false,
      ...(target.position === undefined ? {} : { position: target.position }),
      ...(target.workZero === undefined ? {} : { workOffset: target.workZero }),
    })
    if (created.isErr()) return Err(created.unwrapErr().withContext('machineHost.connect'))
    const emu = created.unwrap()
    connecting = true
    const clock = new ScaledClock(timers, { scale: target.timeScale })
    const transport = new VirtualGrblTransport(emu, clock)
    const sender = new GrblSender(transport, clock, { timers, log })
    clock.setBusy(() => emu.nextEventAt() !== undefined || sender.needsStatus)
    const c = await finishConnect(
      target,
      clock,
      sender,
      transport,
      !target.homing,
      undefined,
      emu,
      () => transport.unplug('simulated'),
      (act) => transport.controllerSide(act),
    )
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
    emulator?: GrblEmulator,
    unplug?: () => void,
    controllerSide?: (act: (e: GrblEmulator) => void) => void,
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
      zeroLevel: 0,
      envelope: envelopeOf(info.unwrap().settings),
      laserMode: info.unwrap().settings['32'] === 1,
      emulator,
      inches: info.unwrap().settings['13'] === 1,
      unplug,
      controllerSide,
    }
    conn = c
    lastPosted = undefined
    sender.onStatus((s) => {
      // DF84: the report's `Bf` and position belong to the lines acknowledged so far
      c.ackedAtReport = sender.acknowledged
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
    c.zeroLevel = 0
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

  /**
   * `$H`; homed on its `ok`, posted at once (DF87). Reading G54 afterwards is bookkeeping: a
   * failure there is logged and does not undo the homing, unless the controller restarted or the
   * connection ended meanwhile (then homed is false or the connection gone, and the error says so).
   * A banner right after `$H` (a GRBL fork that prints it at the end of the cycle) drops the
   * bookkeeping command in flight: once the sender has checked the state, it is sent again while
   * still homed (DF87 follow-up, docs/modes/run-machine.md#homing-on-a-real-controller).
   */
  async function home(c: Connection): Promise<AppResult<void>> {
    c.jogEnd = undefined
    const resets = c.positionResets ?? 0
    const r = await c.sender.command('$H')
    if (r.isErr()) {
      log.warn({ err: r.unwrapErr().toJSON() }, 'homing failed')
      return Err(r.unwrapErr())
    }
    // a banner at the end of `$H` already checked and found Alarm: the homing did not hold
    if ((c.positionResets ?? 0) !== resets) return lostAfterHoming()
    c.homed = true
    c.alarm = undefined
    log.info('homing done')
    status.now()
    const restored = await againAfterBanner(c, () => restoreModes(c))
    if (restored.isErr()) return restored
    const read = await againAfterBanner(c, () => readWorkZero(c))
    if (read.isErr()) {
      log.warn({ err: read.unwrapErr().toJSON() }, 'work zero not read after homing')
      if (!c.homed || conn !== c) return Err(read.unwrapErr())
    }
    // a banner meanwhile followed by Alarm: the homing did not hold
    await c.sender.bannerChecked()
    if (!c.homed && conn === c) return lostAfterHoming()
    return Ok(undefined)
  }

  function lostAfterHoming(): AppResult<never> {
    log.warn('the controller restarted after homing: position lost')
    return fail('machine.reset', 'the controller restarted by itself after homing', {
      where: 'machineHost.home',
    })
  }

  /** `f` again once if it failed on a banner we did not cause and the position was kept. */
  async function againAfterBanner<T>(
    c: Connection,
    f: () => Promise<AppResult<T>>,
  ): Promise<AppResult<T>> {
    const r = await f()
    if (r.isOk() || r.unwrapErr().code !== 'machine.reset' || conn !== c) return r
    await c.sender.bannerChecked()
    if (!c.homed || conn !== c) return r
    log.info('command sent again after a banner (position kept)')
    return f()
  }

  const machineState = (c: Connection) => c.sender.status?.state ?? 'Unknown'

  /** ALARM:1/2 not yet followed by a reset: GRBL answers nothing (docs/modes/run-v0.1.md). */
  const inCriticalAlarm = (c: Connection) =>
    c.alarm !== undefined && (c.alarm.code === 1 || c.alarm.code === 2) && c.alarm.reset !== true

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
        // RV1: GRBL would home with the spindle turning
        if ((c.sender.status?.spindle ?? 0) > 0)
          return fail('run.state', 'the spindle is on: stop it before homing', {
            where: 'machineHost.machine',
            data: { state, spindle: c.sender.status?.spindle ?? 0 },
            issues: [{ path: ['spindle'], rule: 'spindleOn', message: 'turn the spindle off' }],
          })
        {
          // DF134: homing on a pressed limit switch takes it for home (or, wired in parallel with
          // the axis's other end, the wrong end): release it first, or unlock and jog off it
          const pressed = limitSwitches(c.sender.status?.pins)
          if (pressed.length > 0)
            return fail(
              'run.state',
              `the ${pressed.join(', ')} limit switch${pressed.length > 1 ? 'es are' : ' is'} still pressed: release it first, or unlock and jog the axis off it`,
              {
                where: 'machineHost.machine',
                data: { state, pins: c.sender.status?.pins ?? '' },
                issues: [{ path: [], rule: 'limitPressed', message: 'release the limit switch' }],
              },
            )
        }
        return home(c)
      case 'unlock': {
        // at a tool-change wait only a probe alarm can be pending (run-machine.md#probing-and-re-zero-m4)
        if (jobBusy) return stateError('cannot unlock during a run', state)
        const r = await c.sender.command('$X')
        if (r.isErr()) return Err(r.unwrapErr())
        c.alarm = undefined
        const restored = await restoreModes(c)
        if (restored.isErr()) return restored
        // the next action sees Idle, not the Alarm of the last report
        await c.sender.freshStatus()
        status.now()
        return Ok(undefined)
      }
      case 'jog': {
        if (jobBusy || (state !== 'Idle' && !state.startsWith('Jog')))
          return stateError(`cannot jog in state ${state}${phase ? ` (${phase})` : ''}`, state)
        if (c.spindleStopping === true)
          return fail('run.state', 'the spindle is stopping: jog again once it is off', {
            where: 'machineHost.jog',
            data: { state },
            issues: [{ path: [], rule: 'spindleStopping', message: 'the spindle is stopping' }],
          })
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
        if (action.axes.includes('z')) c.zeroLevel = c.job?.level ?? 0
        return readWorkZero(c)
      }
      case 'simulateLostConnection':
        if (c.unplug === undefined)
          return fail('run.state', 'only the virtual machine can simulate a lost connection', {
            where: 'machineHost.machine',
            data: { state },
          })
        // the sender reports the closed port: `connectionLost` follows, as for a real cable
        c.unplug()
        return Ok(undefined)
      case 'simulateInput': {
        if (c.controllerSide === undefined)
          return fail('run.state', 'only the virtual machine can simulate an input', {
            where: 'machineHost.machine',
            data: { state },
          })
        const { input, pressed } = action
        c.controllerSide((e) =>
          input === 'door' ? e.setDoorPin(pressed) : e.setLimitPin(input, pressed),
        )
        status.now()
        return Ok(undefined)
      }
      case 'forgetHoming':
        if (jobBusy) return stateError('not while a run is going', state)
        c.homed = false
        return Ok(undefined)
      case 'reset':
        c.jogEnd = undefined
        return c.sender.realtime(REALTIME.reset)
      case 'probeZ':
        return probeZ(c, action)
      case 'probeRoutine':
        return probeRoutine(c, action)
      case 'virtualStock': {
        if (c.emulator === undefined)
          return fail('run.state', 'only the virtual machine has a simulated stock', {
            where: 'machineHost.machine',
            data: { state },
          })
        // without `stock` the stock laid before stays (the touch step switches its readout)
        const stock = action.stock ?? c.virtualStock?.stock
        c.virtualStock = { ...(stock === undefined ? {} : { stock }), touch: action.touch }
        c.emulator.setProbeScene(touchScene(c))
        c.emulator.setProbeTip({
          shape: 'cylinder',
          radius: action.touch ? (action.toolDiameter ?? 0) / 2 : 0,
        })
        status.now()
        return Ok(undefined)
      }
      case 'spindle':
        return action.on ? spindleOn(c, action) : spindleOff(c)
      case 'feedHold':
      case 'cycleStart':
        // a run's own hold goes through jobControl; a probe at a tool change is a manual cycle
        if (jobBusy) return stateError('a run holds and resumes with job.pause/job.resume', state)
        if (action.kind === 'feedHold') return feedHold(c)
        return cycleStart(c)
      case 'override':
        return override(c, action)
      case 'overrideTo': {
        // one target at a time: each steps from the `Ov` the last one read back
        const next = overrideChain.then(() => overrideTo(c, action))
        overrideChain = next.then(
          () => undefined,
          () => undefined,
        )
        return next
      }
    }
  }

  /**
   * Feed hold of a manual cycle (Probe Z, hardening DF82): `!`, then Ok once a report taken after
   * it says `Hold:0` (motion has stopped). GRBL ignores a hold while homing: refused. A cycle
   * that ends instead (Idle, Alarm) fails `run.state`. Doc: docs/modes/run.md#1-emergency-stop-stop-and-reset
   */
  async function feedHold(c: Connection): Promise<AppResult<void>> {
    const state = machineState(c)
    if (state.startsWith('Home') || state === 'Alarm')
      return stateError(`cannot hold in state ${state}`, state)
    const sent = c.sender.realtime(REALTIME.hold)
    if (sent.isErr()) return sent
    // machine time, as the sender's controlled stop waits for Hold:0
    const deadline = c.clock.now() + FEED_HOLD_MS
    while (c.clock.now() < deadline) {
      const s = await c.sender.freshStatus()
      status.now()
      if (s !== undefined && STILL_STATES.has(s.state)) return Ok(undefined)
      if (s !== undefined && !/^(Hold|Run|Door)/.test(s.state))
        return stateError(`the controller did not hold (state ${s.state})`, s.state)
      await new Promise<void>((resolve) => c.clock.schedule(c.clock.now() + 50, resolve))
    }
    return stateError('the controller did not report the hold', machineState(c))
  }

  /**
   * Cycle start (`~`) of a held manual cycle (Probe Z), on a report taken now. A safety door must be
   * closed first (GRBL ignores `~` while it is ajar, `Door:1`; DF82). Doc: docs/modes/run.md#external-holds-df82
   */
  async function cycleStart(c: Connection): Promise<AppResult<void>> {
    await c.sender.freshStatus()
    const state = machineState(c)
    const door = doorOpen(state)
    if (door !== undefined) return door
    if (state !== 'Hold:0' && state !== 'Door:0')
      return stateError(`nothing is held (state ${state})`, state)
    return c.sender.realtime(REALTIME.resume)
  }

  /** `run.state` (rule `doorOpen`) while a safety door is open or still stopping. */
  function doorOpen(state: string): AppResult<never> | undefined {
    if (state !== 'Door:1' && state !== 'Door:2') return undefined
    const message = 'the safety door is open: close it, then resume'
    return fail('run.state', message, {
      where: 'machineHost',
      data: { state },
      issues: [{ path: [], rule: 'doorOpen', message }],
    })
  }

  /**
   * After a run's feed hold (`job.pause`, hardening DF82): Ok once a report taken after the `!`
   * says motion has stopped (`Hold:0`; a door's `Door:0`/`Door:1`). `Hold:1` is still decelerating.
   * A hold at a tool change or `M0` wait is Ok at once (nothing moves; kept until resume). A run that
   * stops or ends meanwhile, or no `Hold:0` within `FEED_HOLD_MS` machine time, fails `run.state`
   * (the job stays running). Doc: docs/modes/run.md#1-emergency-stop-stop-and-reset
   */
  async function awaitRunHeld(c: Connection, jobId: string): Promise<AppResult<void>> {
    const deadline = c.clock.now() + FEED_HOLD_MS
    for (;;) {
      const phase = c.sender.phase
      if (phase === 'toolChange' || phase === 'programPause') return Ok(undefined)
      if (conn !== c || c.job?.jobId !== jobId || phase !== 'held')
        return stateError(`the run did not hold (${phase ?? 'ended'})`, machineState(c))
      if (c.clock.now() >= deadline)
        return stateError('the controller did not report the hold', machineState(c))
      const s = await c.sender.freshStatus()
      status.now()
      if (s !== undefined && STILL_STATES.has(s.state) && c.sender.phase === 'held')
        return Ok(undefined)
      await new Promise<void>((resolve) => c.clock.schedule(c.clock.now() + 50, resolve))
    }
  }

  /** After a probe alarm: the modal state the probe changed, once GRBL takes gCode again. */
  async function restoreModes(c: Connection): Promise<AppResult<void>> {
    const lines = c.restoreModes
    for (const l of lines ?? []) {
      const r = await c.sender.command(l)
      if (r.isErr()) return Err(r.unwrapErr())
    }
    // kept until all were sent (modal lines: sending them again is harmless)
    if (c.restoreModes === lines) c.restoreModes = undefined
    return Ok(undefined)
  }

  /** RV3: the connection as the probe-cycle runner's port (docs/modes/run-probing.md). */
  function probePort(c: Connection): ProbePort {
    return {
      status: async () => {
        const s = (await c.sender.freshStatus()) ?? c.sender.status
        return s === undefined ? stateError('no status report yet', machineState(c)) : Ok(s)
      },
      command: (line, opts) => c.sender.command(line, opts),
      onAlarm: (listener) =>
        c.sender.onEvent((e) => {
          if (e.kind === 'alarm') listener(e.code)
        }),
      unlock: async () => {
        const r = await c.sender.command('$X')
        if (r.isErr()) return Err(r.unwrapErr())
        c.alarm = undefined
        return Ok(undefined)
      },
    }
  }

  /**
   * Z touch plate (docs/modes/run-machine.md#probing-and-re-zero-m4): one `G38.2` down from here
   * through the probe-cycle runner (RV3), retract, the modal state back, then G54 Z so the contact
   * is at Z = plate thickness. An alarm stays for the operator (the modal state after `$X`).
   */
  async function probeZ(c: Connection, a: ProbeZ): Promise<AppResult<unknown>> {
    const where = 'machineHost.probeZ'
    const state = machineState(c)
    if (c.job !== undefined && c.job.phase !== 'toolChange')
      return stateError('cannot probe during a run', state)
    if (state !== 'Idle') return stateError(`cannot probe in state ${state}`, state)
    const s = c.sender.status
    if (s === undefined) return stateError('no status report yet', state)
    if (c.emulator !== undefined) {
      // the virtual plate lies on the surface to zero on (the run's Z reference, DF69; else the
      // stock top) below the work zero's stock top, else just below the tool
      const top = c.workZero[2] - c.zeroLevel + (c.job?.level ?? 0) + a.plateThickness
      c.emulator.setProbePlate(top < s.mpos[2] - 1e-3 ? top : s.mpos[2] - 10)
    }
    c.jogEnd = undefined
    const env = c.envelope
    log.info({ distance: a.maxTravel, feed: a.feed }, 'probing Z')
    const probed = await runProbeCycle(
      probePort(c),
      {
        axis: 'z',
        direction: -1,
        maxDistance: a.maxTravel,
        fastFeed: a.feed,
        retract: a.retract,
        ...(env?.softLimits === true
          ? { travel: { min: [-env.travel[0], -env.travel[1], -env.travel[2]], max: [0, 0, 0] } }
          : {}),
        inches: c.inches,
        onAlarm: 'stay',
      },
      {
        // GRBL refuses gCode in Alarm: the modal state goes back after the unlock
        restorePending: (lines) => (c.restoreModes = lines),
      },
    )
    // the operator takes the virtual plate away (no `Pn:P` while cutting below it)
    c.emulator?.setProbePlate(undefined)
    if (probed.isErr()) return Err(probed.unwrapErr().withContext(where))
    const contact = probed.unwrap().contact
    const g10 = await c.sender.command(`G21 G10 L2 P1 Z${fmt(contact[2] - a.plateThickness)}`)
    if (g10.isErr()) return Err(g10.unwrapErr().withContext(where))
    c.zeroLevel = c.job?.level ?? 0
    const wz = await readWorkZero(c)
    if (wz.isErr()) return Err(wz.unwrapErr())
    log.info({ contact, workZero: wz.unwrap() }, 'probed Z')
    return Ok({ workZero: wz.unwrap(), contact })
  }

  /** v0.5 RV5: the virtual scene outside a cycle: the stock while the touch-off is open. */
  function touchScene(c: Connection): { targets: ProbeTarget[] } {
    const v = c.virtualStock
    return v?.touch === true && v.stock !== undefined
      ? { targets: [{ kind: 'box', ...v.stock }] }
      : { targets: [] }
  }

  /**
   * v0.5 RV4: the virtual operator's set-up for a routine: the bit (a cylinder) or the 3D probe's
   * ball, and the stock (the bit or a 3D probe touches it) or the corner plate on the probed
   * corner (an edge: beside the tool), which is taken away afterwards
   * (docs/modes/run-probing.md#implementation-rv4).
   */
  function routineScene(c: Connection, a: ProbeRoutineAction, at: Vec3): ProbeTarget[] {
    const stock = c.virtualStock?.stock
    if (stock === undefined) return []
    if (a.probe.kind !== 'xyzPlate') return [{ kind: 'box', ...stock }]
    const size = a.plateSize ?? 50
    const r = a.routine
    const [sx, sy]: readonly [-1 | 1, -1 | 1] =
      r.cycle === 'corner'
        ? r.corner
        : r.cycle === 'edge' && r.axis === 'x'
          ? [r.side, -1]
          : [-1, -1]
    const wall = a.probe.wallOffset ?? [0, 0]
    const edge = (i: 0 | 1, side: -1 | 1) => (side < 0 ? stock.min[i] : stock.max[i])
    // an edge: the plate's other wall half a plate beyond the tool, so only this edge is touched
    const along = (i: 0 | 1, side: -1 | 1) => at[i] + side * (size / 2 - wall[i])
    const corner: Vec3 =
      r.cycle === 'edge'
        ? r.axis === 'x'
          ? [edge(0, sx), along(1, sy), stock.max[2]]
          : [along(0, sx), edge(1, r.side), stock.max[2]]
        : [edge(0, sx), edge(1, sy), stock.max[2]]
    const facing: readonly [-1 | 1, -1 | 1] =
      r.cycle === 'edge' && r.axis === 'y' ? [sx, r.side] : [sx, sy]
    return [
      {
        kind: 'cornerPlate',
        corner,
        thickness: a.probe.plateThickness ?? 0,
        size,
        wallOffset: wall,
        facing,
      },
    ]
  }

  /**
   * v0.5 RV4: an edge, corner or centre routine from here (docs/modes/run-probing.md#xy-probing-rv4)
   * through the probe-cycle runner; writes nothing. Idle without a run only.
   */
  async function probeRoutine(c: Connection, a: ProbeRoutineAction): Promise<AppResult<unknown>> {
    const where = 'machineHost.probeRoutine'
    const state = machineState(c)
    if (c.job !== undefined) return stateError('cannot probe during a run', state)
    if (state !== 'Idle') return stateError(`cannot probe in state ${state}`, state)
    const s = c.sender.status
    if (s === undefined) return stateError('no status report yet', state)
    const emu = c.emulator
    if (emu !== undefined) {
      emu.setProbeScene({ targets: routineScene(c, a, s.mpos) })
      emu.setProbeTip({
        shape: a.probe.kind === '3d' ? 'ball' : 'cylinder',
        radius: a.probe.tipDiameter / 2,
      })
    }
    c.jogEnd = undefined
    const env = c.envelope
    const { kind: _kind, plateSize: _size, ...spec } = a
    log.info({ routine: a.routine, probe: a.probe.kind }, 'probing')
    const r = await runProbeRoutine(probePort(c), {
      ...spec,
      ...(env?.softLimits === true
        ? { travel: { min: [-env.travel[0], -env.travel[1], -env.travel[2]], max: [0, 0, 0] } }
        : {}),
      inches: c.inches,
    })
    if (emu !== undefined) {
      // the operator takes the plate away and the clip off
      emu.setProbeScene(touchScene(c))
      emu.setProbeTip({ shape: 'cylinder', radius: 0 })
    }
    // the next action sees the Idle the routine ended in, not a report from its moves
    await c.sender.freshStatus()
    status.now()
    if (r.isErr()) return Err(r.unwrapErr().withContext(where))
    log.info({ result: r.unwrap() }, 'probed')
    return Ok(r.unwrap())
  }

  /** RV1: `run.state` with a rule (docs/modes/run-machine.md#spindle-while-jogging-rv1). */
  function spindleRefused(message: string, state: string, rule: string): AppResult<never> {
    return fail('run.state', message, {
      where: 'machineHost.spindle',
      data: { state },
      issues: [{ path: ['on'], rule, message }],
    })
  }

  /**
   * RV1, spindle on (docs/modes/run-machine.md#spindle-while-jogging-rv1): in Idle without a run
   * the spindle override back to 100 %, `M3 S<rpm>` and from off the spin-up dwell; in a jog with
   * the spindle on from Run a speed change through the spindle override; refused otherwise.
   */
  async function spindleOn(c: Connection, a: SpindleAction): Promise<AppResult<unknown>> {
    const state = machineState(c)
    const rpm = a.rpm
    if (rpm === undefined)
      return fail('input.malformed', 'spindle on needs rpm', {
        where: 'machineHost.spindle',
        issues: [{ path: ['rpm'], rule: 'required', message: 'give rpm' }],
      })
    if (c.job !== undefined)
      return spindleRefused('the run controls the spindle', state, 'runSpindle')
    if (c.spindleStopping === true)
      return spindleRefused('the spindle is stopping', state, 'spindleStopping')
    if (state.startsWith('Jog')) {
      const base = c.manualSpindle?.rpm
      if (base === undefined || (c.sender.status?.spindle ?? 0) <= 0)
        return spindleRefused(
          'the spindle turns on only while the machine is idle: stop the jog first',
          state,
          'spindleNotIdle',
        )
      // GRBL takes no S in a jog: the speed changes through the spindle override (DF85 steps)
      const percent = Math.round((rpm / base) * 100)
      const { min, max } = overrideLimits('grbl').spindle
      if (percent < min || percent > max)
        return fail('input.malformed', `${rpm} rpm is ${percent} % of S ${base}`, {
          where: 'machineHost.spindle',
          issues: [
            {
              path: ['rpm'],
              rule: 'overrideRange',
              message: `during a jog the override takes ${min}–${max} % of S ${base} rpm`,
            },
          ],
        })
      const next = overrideChain.then(() =>
        overrideTo(c, { kind: 'overrideTo', which: 'spindle', percent }),
      )
      overrideChain = next.then(
        () => undefined,
        () => undefined,
      )
      const r = await next
      if (r.isErr()) return r
      return Ok({ spindle: c.sender.status?.spindle ?? 0 })
    }
    if (state !== 'Idle') return stateError(`cannot turn the spindle on in state ${state}`, state)
    const wasOn = (c.sender.status?.spindle ?? 0) > 0
    // the asked speed is what turns: an override left from a run or a jog goes back to 100 %
    const ov = c.sender.status?.overrides?.spindle
    if (ov !== undefined && ov !== 100) {
      const reset = c.sender.realtime(OVERRIDE.spindleReset)
      if (reset.isErr()) return reset
    }
    const dwell = wasOn ? 0 : (a.dwellSeconds ?? 0)
    log.info({ rpm, dwell }, 'spindle on')
    const on = await c.sender.command(`M3 S${fmt(rpm)}`)
    if (on.isErr()) return Err(on.unwrapErr().withContext('machineHost.spindle'))
    c.manualSpindle = { rpm }
    if (dwell > 0) {
      const d = await c.sender.command(`G4 P${fmt(dwell)}`, { timeoutMs: dwell * 1000 + 10_000 })
      if (d.isErr()) return Err(d.unwrapErr().withContext('machineHost.spindle'))
    }
    const fresh = await c.sender.freshStatus()
    status.now()
    return Ok({ spindle: fresh?.spindle ?? c.sender.status?.spindle ?? 0 })
  }

  /**
   * RV1, spindle off, always (docs/modes/run-machine.md#spindle-while-jogging-rv1): `M5` in Idle
   * (or at a tool-change wait); in a jog the jog cancel first, a report saying Idle, then `M5`
   * (never `M5` in Jog: `error:9`); a jog that does not end in time, or a spindle turning in any
   * other state, is stopped by a reset. Refused while a run streams (Stop stops it).
   */
  async function spindleOff(c: Connection): Promise<AppResult<unknown>> {
    const where = 'machineHost.spindle'
    const turning = () => (c.sender.status?.spindle ?? 0) > 0
    const off = async (): Promise<AppResult<unknown>> => {
      const r = await c.sender.command('M5')
      if (r.isErr()) return Err(r.unwrapErr().withContext(where))
      c.manualSpindle = undefined
      const fresh = await c.sender.freshStatus()
      status.now()
      return Ok({ spindle: fresh?.spindle ?? 0 })
    }
    const resetToStop = (): AppResult<unknown> => {
      log.warn({ state: machineState(c) }, 'spindle off by a reset')
      c.jogEnd = undefined
      const r = c.sender.realtime(REALTIME.reset)
      if (r.isErr()) return r
      c.manualSpindle = undefined
      return fail('machine.reset', 'the controller was reset to stop the spindle: home again', {
        where,
        data: { state: machineState(c) },
        issues: [{ path: ['on'], rule: 'spindleReset', message: 'the spindle stopped by a reset' }],
      })
    }
    if (c.job !== undefined && c.job.phase !== 'toolChange')
      return spindleRefused(
        'the run controls the spindle: Stop stops the run and the spindle',
        machineState(c),
        'runSpindle',
      )
    const state = machineState(c)
    if (state === 'Idle') return off()
    if (state.startsWith('Jog')) {
      c.spindleStopping = true
      try {
        c.jogEnd = undefined
        const cancel = c.sender.realtime(REALTIME.jogCancel)
        if (cancel.isErr()) return resetToStop()
        // machine time, as a feed hold's wait for Hold:0
        const deadline = c.clock.now() + FEED_HOLD_MS
        while (c.clock.now() < deadline) {
          const s = await c.sender.freshStatus()
          status.now()
          if (conn !== c) return notConnected()
          if (s?.state === 'Idle') return await off()
          if (s !== undefined && !s.state.startsWith('Jog')) break
          await new Promise<void>((resolve) => c.clock.schedule(c.clock.now() + 50, resolve))
        }
        return machineState(c) === 'Idle' ? await off() : resetToStop()
      } finally {
        c.spindleStopping = false
      }
    }
    // Alarm and the door stop the spindle themselves; anything else turning: a reset
    if (!turning()) {
      c.manualSpindle = undefined
      return Ok({ spindle: 0 })
    }
    return resetToStop()
  }

  /** One override byte (docs/modes/run-machine.md#overrides-m6); answers the overrides reported. */
  async function override(c: Connection, a: OverrideAction): Promise<AppResult<unknown>> {
    const where = 'machineHost.override'
    const byte =
      a.which === 'rapid'
        ? RAPID_BYTES[a.action]
        : (OVERRIDE_BYTES[a.which] as Partial<Record<string, RealtimeCommand>>)[a.action]
    if (byte === undefined)
      return fail('input.malformed', `${a.action} is not a ${a.which} override`, {
        where,
        issues: [
          {
            path: ['action'],
            rule: 'overrideStep',
            message: a.which === 'rapid' ? 'give 100, 50 or 25' : 'give reset, +10, -10, +1 or -1',
          },
        ],
      })
    if (inCriticalAlarm(c))
      return stateError('the controller is in a critical alarm: reset it first', machineState(c))
    const sent = c.sender.realtime(byte)
    if (sent.isErr()) return sent
    // GRBL reports `Ov` on the next status after a change
    const fresh = await c.sender.freshStatus()
    status.now()
    return Ok({ overrides: fresh?.overrides ?? c.sender.status?.overrides })
  }

  /**
   * Feed or spindle override to a target percent (DF85, docs/modes/run-machine.md#overrides-m6):
   * the shortest coarse/fine steps from the last reported `Ov` (a reset first when none is
   * known), a gap between bytes, then a fresh report; a value off target is stepped again from
   * what was reported (another round), at most `OVERRIDE_ROUNDS` times.
   */
  async function overrideTo(c: Connection, a: OverrideToAction): Promise<AppResult<unknown>> {
    const where = 'machineHost.override'
    const limits = overrideLimits('grbl')
    const range = limits[a.which]
    if (a.percent < range.min || a.percent > range.max)
      return fail('input.malformed', `${a.which} override ${a.percent} % is out of range`, {
        where,
        issues: [
          {
            path: [a.which],
            rule: 'overrideRange',
            message: `the controller takes ${range.min}–${range.max} %`,
          },
        ],
      })
    if (inCriticalAlarm(c))
      return stateError('the controller is in a critical alarm: reset it first', machineState(c))
    for (let round = 0; round < OVERRIDE_ROUNDS; round++) {
      const steps = overrideSteps(c.sender.status?.overrides?.[a.which], a.percent, range, limits)
      if (steps.length === 0) break
      for (const [i, step] of steps.entries()) {
        if (i > 0) await new Promise<void>((r) => void timers.setTimeout(r, OVERRIDE_BYTE_GAP_MS))
        const sent = c.sender.realtime(OVERRIDE_BYTES[a.which][step])
        if (sent.isErr()) return sent
      }
      // GRBL reports `Ov` on the next status after a change; without one, no second round
      const fresh = await c.sender.freshStatus()
      if (fresh?.overrides === undefined || fresh.overrides[a.which] === a.percent) break
    }
    status.now()
    return Ok({ overrides: c.sender.status?.overrides })
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
      level: 0,
      startedAt: c.clock.now(),
      streaming: false,
      stopRequested: false,
      checked: new Promise<void>((r) => (checked = r)),
    }
    c.job = job
    c.jogEnd = undefined
    // RV1: the program sends its own M3
    c.manualSpindle = undefined
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
          // DF138 F10: the throttled progress goes out first (it names the wait)
          if (lastProgress?.jobId === jobId) progress.now()
          job.phase = p.phase
          job.toolChange = p.toolChange
          // DF69: the tool run from this tool change on is in its surface's Z
          if (p.phase === 'toolChange') job.level = p.toolChange?.level ?? 0
          if (p.phase === 'toolChange') log.debug({ tool: p.toolChange?.n }, 'tool change')
          post({
            type: 'phase',
            jobId,
            phase: p.phase,
            ...(p.heldBy === undefined ? {} : { heldBy: p.heldBy }),
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
      case 'hold': {
        // already held (a hold we did not send, or an earlier one not yet confirmed): wait on it
        if (c.sender.phase !== 'held') {
          const sent = c.sender.hold()
          if (sent.isErr()) return sent
        }
        return awaitRunHeld(c, jobId)
      }
      case 'resume': {
        // a safety door must be closed first (Door:0); GRBL ignores `~` while it is open (DF82)
        if (c.sender.phase === 'held') {
          await c.sender.freshStatus()
          const door = doorOpen(machineState(c))
          if (door !== undefined) return door
          // the controller's cycle-start button was quicker: nothing left to resume
          if ((c.sender.phase as RunPhase | undefined) === 'streaming') return Ok(undefined)
        }
        return c.sender.resume()
      }
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
        // GRBL's alarm stops the spindle (mc_reset)
        c.manualSpindle = undefined
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
        // a reset stops the spindle
        c.manualSpindle = undefined
        // DF134: a reset ends a critical alarm (GRBL then waits locked for `$H` or `$X`); the
        // alarm stays shown until one of them, with the reset noted
        if (c.alarm !== undefined && c.alarm.reset !== true) c.alarm = { ...c.alarm, reset: true }
        // a controller that restarted on its own into Alarm (power glitch, USB reset) lost its
        // position: home again before a run; a banner followed by Idle kept it (DF87 follow-up,
        // docs/modes/run-machine.md#real-machine-run-rules)
        if (e.positionLost) {
          c.homed = false
          c.positionResets = (c.positionResets ?? 0) + 1
        }
        post({
          type: 'event',
          kind: 'reset',
          data: { expected: e.expected, positionLost: e.positionLost },
        })
        // GRBL keeps G54 over a reset; read it again anyway (docs/modes/run-v0.1.md#work-zero-and-the-soft-limit-check)
        if (c.job === undefined || c.job.phase === 'stopping')
          void timers.setTimeout(() => {
            if (conn === c && c.job === undefined) void readWorkZero(c)
          }, 0)
        break
      case 'connectionLost': {
        log.warn({ reason: e.reason }, 'connection lost')
        // DF129: the lines written since the last (throttled) status, before the connection goes:
        // the run record's upper bound (docs/modes/run-recovery.md#implementation-rc1)
        const last = conn === c ? hostStatus() : undefined
        if (last !== undefined) post({ type: 'status', status: last })
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
