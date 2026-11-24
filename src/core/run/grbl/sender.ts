/**
 * GRBL 1.1 streaming sender over a `ControllerTransport` and a run `Clock`: handshake, line
 * framing, character counting, status polling, real-time commands, the DFYOM tool-change rule,
 * program pauses, controlled stop, errors and alarms.
 * Docs: docs/modes/run-v0.1.md#sender, docs/architecture/grbl.md#transport-and-sender
 *
 * The protocol logic is synchronous and callback-driven (a line is booked before it is written,
 * responses are handled as they arrive), so it runs unchanged on a `VirtualClock` in tests and on
 * a `ScaledClock` in the machine host. Only the public API returns promises.
 */
import { AppError } from '../../../shared/errors/app-error'
import { noopLogger, type Logger } from '../../../shared/logging'
import { Err, fail, Ok, type AppResult, type AsyncAppResult } from '../../../shared/result'
import type { Vec3 } from '../../toolpath/model'
import type { Clock, TimerHost } from '../clock'
import type { ControllerTransport } from '../transport'
import {
  alarmText,
  errorText,
  parseLine,
  parseModes,
  parseParameters,
  parseSettings,
  parseVersion,
  positions,
  stateText,
  type GrblLine,
  type StatusReport,
} from './status'

/** GRBL's serial RX buffer (`RX_BUFFER_SIZE`); character counting fills it at most. */
export const RX_BUFFER_BYTES = 128
/** GRBL's line buffer (`LINE_BUFFER_SIZE`): a line as sent, with its `\n`, must fit. */
export const MAX_LINE_BYTES = 80

/** Real-time command bytes the sender uses (sent at once, never queued behind lines). */
export const REALTIME = {
  status: 0x3f,
  hold: 0x21,
  resume: 0x7e,
  reset: 0x18,
  jogCancel: 0x85,
} as const

/**
 * GRBL 1.1 override bytes (docs/modes/run-machine.md#overrides-m6): feed and spindle in 10 % and
 * 1 % steps or back to 100 %, rapids at 100/50/25 %.
 */
export const OVERRIDE = {
  feedReset: 0x90,
  feedPlus10: 0x91,
  feedMinus10: 0x92,
  feedPlus1: 0x93,
  feedMinus1: 0x94,
  rapid100: 0x95,
  rapid50: 0x96,
  rapid25: 0x97,
  spindleReset: 0x99,
  spindlePlus10: 0x9a,
  spindleMinus10: 0x9b,
  spindlePlus1: 0x9c,
  spindleMinus1: 0x9d,
} as const
export type RealtimeCommand =
  (typeof REALTIME)[keyof typeof REALTIME] | (typeof OVERRIDE)[keyof typeof OVERRIDE]

/** Feed, rapid and spindle overrides in % (status report `Ov`). */
export interface Overrides {
  readonly feed: number
  readonly rapid: number
  readonly spindle: number
}
const NO_OVERRIDES: Overrides = { feed: 100, rapid: 100, spindle: 100 }

/** DFYOM tool-change marker, matched against a whole line (grbl.md#output-dialect). */
const MARKER = /^\(DFYOM TOOL CHANGE (\d+): ([^()]*)\)$/
/** The line after a marker: `M0`, or `M0 ;message` since DF63 (grbl.md#output-dialect). */
const MARKER_PAUSE = /^M0( ;.*)?$/
/** DF69: the Z reference lines before a marker (docs/modes/z-reference.md#exported-gcode). */
const ZREF_LINE = /^\(Z0 for tool \d+: ([^()]*)\)$/
const SPOT_LINE = /^\(Touch off Z here, (X\S+ Y\S+): [^()]*\)$/
/** The level on the Z reference line (program units) and the spot's coordinates. */
const ZREF_LEVEL = /, (\d+(?:\.\d+)?) below the stock top$/
const SPOT_XY = /^X(-?\d+(?:\.\d+)?) Y(-?\d+(?:\.\d+)?)$/
/** A units word in a line's code (comments stripped). */
const UNITS_WORD = /G2([01])(?![0-9.])/i
/** Lines before a marker searched for them (the manual spindle's stop comment sits between). */
const ZREF_LOOKBACK = 4
/** A line whose code (comments stripped) contains `M0`/`M00`: GRBL pauses there. */
const PROGRAM_PAUSE = /M0*0(?![0-9.])/i

export interface SenderProgram {
  /** gCode lines without line ends. */
  readonly lines: readonly string[]
  /** Labels for progress, by 1-based first line (ascending). */
  readonly sections: readonly { readonly fromLine: number; readonly label: string }[]
}

export type RunPhase =
  'streaming' | 'held' | 'programPause' | 'toolChange' | 'stopping' | 'done' | 'failed' | 'stopped'

export interface ToolChangeInfo {
  readonly n: number
  readonly name: string
  /** DF69: the Z reference surface and its level, when not the top face. */
  readonly surface?: string
  /** DF69: where to touch off (`X120 Y45`, program units), with `surface`. */
  readonly spot?: string
  /** DF69: the surface's level below the stock top (mm, setup frame, < 0), with `surface`. */
  readonly level?: number
  /** DF69: the spot in work coordinates (mm), with `spot`. */
  readonly at?: readonly [number, number]
}

/** mm per program unit at line `i`: the last `G20`/`G21` before it (none = mm). */
function programPerUnit(lines: readonly string[], i: number): number {
  for (let k = i - 1; k >= 0; k--) {
    const code = (lines[k] ?? '').replace(/\([^)]*\)/g, '').replace(/;.*$/, '')
    const u = UNITS_WORD.exec(code)
    if (u !== null) return u[1] === '0' ? 25.4 : 1
  }
  return 1
}

/** The tool change at the marker line `i`, with the Z reference lines before it (DF69). */
function toolChangeAt(lines: readonly string[], i: number, m: RegExpExecArray): ToolChangeInfo {
  let surface: string | undefined
  let spot: string | undefined
  for (let k = Math.max(0, i - ZREF_LOOKBACK); k < i; k++) {
    const line = lines[k] ?? ''
    surface = ZREF_LINE.exec(line)?.[1] ?? surface
    spot = SPOT_LINE.exec(line)?.[1] ?? spot
  }
  const k = surface === undefined ? 1 : programPerUnit(lines, i)
  const level = surface === undefined ? undefined : ZREF_LEVEL.exec(surface)
  const xy = surface === undefined || spot === undefined ? null : SPOT_XY.exec(spot)
  return {
    n: Number(m[1]),
    name: m[2] ?? '',
    ...(surface === undefined ? {} : { surface }),
    ...(surface === undefined || spot === undefined ? {} : { spot }),
    ...(level == null ? {} : { level: -Number(level[1]) * k || 0 }),
    ...(xy === null ? {} : { at: [Number(xy[1]) * k, Number(xy[2]) * k] as const }),
  }
}

export interface PhaseChange {
  readonly phase: RunPhase
  readonly toolChange?: ToolChangeInfo
  /** The `M0`'s message (its preceding comment) in `programPause`. */
  readonly message?: string
}

export interface RunProgress {
  /** Lines acknowledged (a tool change's skipped `M0` counts). */
  readonly done: number
  readonly total: number
  /** Current section, or the tool change / pause text while waiting. */
  readonly label: string
}

export interface RunEvents {
  readonly progress?: (p: RunProgress) => void
  readonly phase?: (p: PhaseChange) => void
}

export interface RunSummary {
  readonly lines: number
  /** Clock seconds without waits for the user (tool changes, `M0` pauses, holds). */
  readonly seconds: number
  /** Clock seconds from start to end, waits included. */
  readonly elapsedSeconds: number
  readonly toolChanges: number
  readonly pauses: number
}

export interface ControllerInfo {
  /** `$I` version, e.g. `1.1h.20190830`. */
  readonly version: string
  /** `$$` values by setting number. */
  readonly settings: Readonly<Record<string, number>>
  /** G54 in machine coordinates (mm). */
  readonly workZero: Vec3
  /** `$G` words. */
  readonly modes: readonly string[]
}

/** The latest status report, positions in mm. */
export interface SenderStatus {
  /** As reported, e.g. `Hold:0`. */
  readonly state: string
  readonly mpos: Vec3
  readonly wpos: Vec3
  readonly wco: Vec3
  /** mm/min. */
  readonly feed: number
  readonly spindle: number
  readonly buffer?: { readonly blocks: number; readonly rx: number }
  /** The last `Ov` (GRBL sends it every 10–20 reports); absent until the first. */
  readonly overrides?: Overrides
}

export type SenderEvent =
  | { readonly kind: 'alarm'; readonly code: number; readonly text: string }
  | {
      readonly kind: 'error'
      readonly code: number
      readonly text: string
      readonly line?: number
    }
  | { readonly kind: 'message'; readonly text: string }
  /** The controller restarted (banner): after our reset or by itself. */
  | { readonly kind: 'reset'; readonly expected: boolean }
  | { readonly kind: 'connectionLost'; readonly reason: string }

export interface SenderOptions {
  /** Character counting (default) or one line in flight (debugging). */
  readonly mode?: 'charCount' | 'sendResponse'
  /** Status poll interval in clock time (default 200 ms). */
  readonly pollMs?: number
  /** Wall time for the handshake and the status-reply watchdog. */
  readonly timers: TimerHost
  /** Wall time to wait for the banner (default 2 s) and for a status reply (default 2 s). */
  readonly bannerTimeoutMs?: number
  readonly statusTimeoutMs?: number
  /** Clock time a controlled stop waits for `Hold:0` before the reset (default 5 s). */
  readonly holdTimeoutMs?: number
  /** Clock time a command may wait for its reply (default 10 s; `$H` 10 min) → `machine.connection`. */
  readonly commandTimeoutMs?: number
  /**
   * Clock time the machine may report `Idle` while a line waits for its `ok` (default 5 s, plus
   * the dwells in flight) before the `ok` counts as lost → `machine.connection`.
   */
  readonly ackTimeoutMs?: number
  readonly log?: Logger
}

interface PendingCommand {
  readonly line: string
  readonly replies: GrblLine[]
  readonly resolve: (r: AppResult<readonly GrblLine[]>) => void
  /** Answered (or failed by an alarm, a timeout, a reset): later replies only free its bytes. */
  settled: boolean
  cancelTimeout?: (() => void) | undefined
}

type Sent =
  | { readonly bytes: number; readonly kind: 'program'; readonly index: number }
  | { readonly bytes: number; readonly kind: 'command'; readonly cmd: PendingCommand }

interface ActiveRun {
  readonly program: SenderProgram
  readonly events: RunEvents
  readonly resolve: (r: AppResult<RunSummary>) => void
  /** Called after `resolve` (stop() waiters). */
  readonly onEnd: (() => void)[]
  readonly startedAt: number
  phase: RunPhase
  /** Index of the next line to send. */
  next: number
  /** Lines acknowledged (plus skipped tool-change `M0`s). */
  done: number
  /** Marker detected at `next`; waiting for every `ok` and `Idle`. */
  pendingToolChange?: ToolChangeInfo | undefined
  toolChange?: ToolChangeInfo | undefined
  message?: string | undefined
  /** Start of the current wait for the user (clock ms). */
  waitingSince?: number | undefined
  waited: number
  toolChanges: number
  pauses: number
  /** The error the run ends with once the stop sequence is through (`undefined`: stopped). */
  failure?: AppError
  label: string
  /** `continueProgram()` at a tool change: send the marker (and skip its `M0`) when it fits. */
  sendMarker?: boolean
  /** `hold()` while waiting at a tool change or pause: `continueProgram()` waits for `resume()`. */
  holdAfterWait?: boolean
}

/** Which wait `continueProgram()` would end: tool change `n`, or the `n`-th program pause. */
export type RunWait = { readonly toolChange: number } | { readonly pause: number }

const DWELL = /G0*4(?![0-9.])[^P]*P\s*([0-9.]+)/i
const dwellMs = (line: string | undefined): number => {
  const m = line === undefined ? null : DWELL.exec(line.replace(/\([^)]*\)/g, ''))
  return m ? Number(m[1]) * 1000 || 0 : 0
}

type Waiter = (ok: boolean) => void

const encode = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

/** Every line ≤ 80 bytes as sent and printable ASCII without `?`, `!`, `~`. */
export function preflight(
  lines: readonly string[],
  where = 'GrblSender.preflight',
): AppResult<void> {
  const issues = []
  for (let i = 0; i < lines.length && issues.length < 50; i++) {
    const line = lines[i] ?? ''
    const path = ['lines', i]
    if (line.length + 1 > MAX_LINE_BYTES)
      issues.push({
        path,
        rule: 'lineLength',
        message: `line ${i + 1} is ${line.length + 1} bytes with its line end; GRBL takes ${MAX_LINE_BYTES}`,
        params: { line: i + 1, bytes: line.length + 1 },
      })
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k)
      if (c < 0x20 || c > 0x7e || c === 0x3f || c === 0x21 || c === 0x7e) {
        issues.push({
          path,
          rule: 'character',
          message: `line ${i + 1} contains ${c < 0x20 || c > 0x7e ? `byte 0x${c.toString(16)}` : `'${line[k]}'`}, which GRBL reads as a real-time command or rejects`,
          params: { line: i + 1, column: k + 1 },
        })
        break
      }
    }
  }
  if (issues.length === 0) return Ok(undefined)
  return fail('run.program', `${issues.length} line(s) cannot be sent to GRBL`, { issues, where })
}

/** The text of a whole-line comment `(text)`, else undefined. */
function commentText(line: string | undefined): string | undefined {
  const m = line === undefined ? null : /^\((.*)\)$/.exec(line.trim())
  return m ? (m[1] ?? '').trim() : undefined
}

/** The `;` message on a pause line (`M0 ;Set spindle to 18000 rpm`, DF63). */
function pauseText(line: string | undefined): string | undefined {
  const m = line === undefined ? null : /;(.*)$/.exec(line)
  const text = m?.[1]?.trim()
  return text === undefined || text === '' ? undefined : text
}

function isProgramPause(line: string | undefined): boolean {
  if (line === undefined) return false
  const code = line.replace(/\([^)]*\)/g, '').replace(/;.*$/, '')
  return PROGRAM_PAUSE.test(code)
}

const ZERO: Vec3 = [0, 0, 0]

export class GrblSender {
  private readonly mode: 'charCount' | 'sendResponse'
  private readonly pollMs: number
  private readonly log: Logger
  private readonly timers: TimerHost
  private connected = false
  private unsubscribe: (() => void) | undefined
  private unsubscribeClose: (() => void) | undefined
  private rxText = ''
  private inches = false

  private readonly commands: PendingCommand[] = []
  private readonly inflight: Sent[] = []
  private used = 0
  private run_: ActiveRun | undefined

  private latest: SenderStatus | undefined
  /** Status reports that said Hold (a command's reply timeout waits on through a hold, DF82). */
  private holdReports = 0
  private wco: Vec3 = ZERO
  private pollsWritten = 0
  private reportsSeen = 0
  private pollOutstandingSince: number | undefined
  private cancelPoll: (() => void) | undefined
  private cancelWatchdog: (() => void) | undefined
  /** After ALARM:1/2 GRBL sends nothing (not even status) until a reset. */
  private critical = false
  /** Reports requested after this ordinal follow our last `~` (earlier ones may say Hold). */
  private resumeMark: number | undefined
  /** The last command acknowledgement: the state is known only from reports requested after it. */
  private motionMark = 0
  /** Reports requested after this ordinal follow the last line booked or acknowledged. */
  private ackMark = 0
  private idleWithLineSince: number | undefined
  /** G54 changed: positions wait for a report with `WCO` (WCO = G54 + G92 + TLO). */
  private wcoPending = true
  private lastG54: Vec3 | undefined
  private overrides: Overrides | undefined

  /** Stop sequence: waiting for `Hold:0` after `!` (report ordinal must exceed the mark). */
  private holdMark: number | undefined
  private cancelHoldTimeout: (() => void) | undefined
  /** We sent `0x18` and expect the banner. */
  private expectingReset = false
  /** Fresh status needed after this report ordinal (tool change, end of program). */
  private freshMark: number | undefined
  private bannerWaiter: Waiter | undefined

  private readonly statusListeners = new Set<(s: SenderStatus) => void>()
  private readonly eventListeners = new Set<(e: SenderEvent) => void>()

  constructor(
    private readonly transport: ControllerTransport,
    private readonly clock: Clock,
    private readonly opts: SenderOptions,
  ) {
    this.mode = opts.mode ?? 'charCount'
    this.pollMs = opts.pollMs ?? 200
    this.timers = opts.timers
    this.log = (opts.log ?? noopLogger).child({ scope: 'run.sender' })
  }

  // ── Public API ──────────────────────────────────────────────────────────────────────────

  get isConnected(): boolean {
    return this.connected
  }

  /** The latest status report, if any. */
  get status(): SenderStatus | undefined {
    return this.latest
  }

  /** The current run's phase, if a program runs. */
  get phase(): RunPhase | undefined {
    return this.run_?.phase
  }

  /** The current run's 1-based line (last acknowledged + 1). */
  get line(): number | undefined {
    return this.run_ === undefined
      ? undefined
      : Math.min(this.run_.done + 1, this.run_.program.lines.length)
  }

  /** What `continueProgram()` would end, if the run waits. */
  get wait(): RunWait | undefined {
    const run = this.run_
    if (run?.phase === 'toolChange' && run.toolChange !== undefined)
      return { toolChange: run.toolChange.n }
    if (run?.phase === 'programPause') return { pause: run.pauses + 1 }
    return undefined
  }

  /**
   * The next decision waits for a status report (tool change ahead, end of program, stop): a
   * `max` clock should not idle at real time meanwhile.
   */
  get needsStatus(): boolean {
    const phase = this.run_?.phase
    return (
      (phase === 'streaming' && this.freshMark !== undefined) ||
      (phase === 'stopping' && this.holdMark !== undefined)
    )
  }

  onStatus(listener: (s: SenderStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  onEvent(listener: (e: SenderEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  /**
   * Handshake: banner (≤ 2 s wall, else one `0x18` and again), `$I` (version 1.1), `$$`, `$#`,
   * `$G`; then status polling starts.
   */
  async connect(): AsyncAppResult<ControllerInfo> {
    const where = 'GrblSender.connect'
    if (this.connected || this.unsubscribe !== undefined)
      return fail('run.busy', 'the sender is already connected', { where })
    this.unsubscribe = this.transport.onData((b) => this.onData(b))
    // a serial port that closes by itself (cable pulled) fails the connection at once
    this.unsubscribeClose = this.transport.onClose?.((reason) => {
      if (this.connected) this.connectionLost(`port closed: ${reason}`)
      else this.bannerWaiter?.(false)
    })
    let banner = await this.waitForBanner()
    if (!banner) {
      this.log.warn('no banner; sending a soft reset')
      this.writeBytes(Uint8Array.of(REALTIME.reset))
      banner = await this.waitForBanner()
    }
    if (!banner) {
      this.disposeIo()
      return fail('machine.connection', 'no GRBL banner from the controller', { where })
    }
    this.connected = true
    const ver = await this.request('$I')
    if (ver.isErr()) return this.connectFailed(ver.unwrapErr(), where)
    const version = parseVersion(ver.unwrap()) ?? ''
    if (!version.startsWith('1.1'))
      return this.connectFailed(
        new AppError('machine.connection', `unsupported controller ${version || '(no version)'}`, {
          where,
          data: { version },
        }),
        where,
      )
    const set = await this.request('$$')
    if (set.isErr()) return this.connectFailed(set.unwrapErr(), where)
    const settings = parseSettings(set.unwrap())
    this.inches = (settings.get(13) ?? 0) !== 0
    const g54 = await this.readWorkZero()
    if (g54.isErr()) return this.connectFailed(g54.unwrapErr(), where)
    const modes = await this.request('$G')
    if (modes.isErr()) return this.connectFailed(modes.unwrapErr(), where)
    this.startPolling()
    if ((await this.freshStatus()) === undefined)
      return this.connectFailed(
        new AppError('machine.connection', 'no status report from the controller', { where }),
        where,
      )
    const info: ControllerInfo = {
      version,
      settings: Object.fromEntries([...settings].map(([k, v]) => [String(k), v])),
      workZero: g54.unwrap(),
      modes: parseModes(modes.unwrap()),
    }
    return Ok(info)
  }

  /**
   * One line when no program streams (or while a tool change waits): `$H`, `$J=`, `G10`, …
   * `timeoutMs`: clock time to wait for its reply instead of the default (a probe cycle).
   */
  async command(
    line: string,
    opts: { readonly timeoutMs?: number } = {},
  ): AsyncAppResult<readonly string[]> {
    const r = await this.request(line, opts.timeoutMs)
    return r.map((replies) => replies.map(lineText))
  }

  /** G54 in machine coordinates, read with `$#`. */
  async readWorkZero(): AsyncAppResult<Vec3> {
    const r = await this.request('$#')
    if (r.isErr()) return Err(r.unwrapErr())
    const g54 = parseParameters(r.unwrap(), this.inches).get('G54')
    if (g54 === undefined)
      return fail('machine.connection', 'no G54 in the $# report', {
        where: 'GrblSender.readWorkZero',
      })
    // WCO is G54 + G92 + TLO: take it from the next report with `WCO`, which GRBL sends after a change
    if (this.lastG54 === undefined || g54.some((v, i) => v !== this.lastG54?.[i]))
      this.wcoPending = true
    this.lastG54 = g54
    return Ok(g54)
  }

  /**
   * A status report requested after this call (e.g. after `$H`, so the state is not stale);
   * undefined if none comes within the status timeout (wall).
   */
  freshStatus(): Promise<SenderStatus | undefined> {
    const mark = this.pollsWritten
    this.requestStatus()
    return new Promise((resolve) => {
      const cancel = this.timers.setTimeout(() => {
        off()
        resolve(undefined)
      }, this.opts.statusTimeoutMs ?? 2000)
      const off = this.onStatus((s) => {
        if (this.reportsSeen <= mark || this.wcoPending) return
        off()
        cancel()
        resolve(s)
      })
    })
  }

  /** Writes a real-time byte at once. */
  realtime(byte: RealtimeCommand): AppResult<void> {
    if (!this.connected)
      return fail('machine.connection', 'not connected', { where: 'GrblSender.realtime' })
    if (byte === REALTIME.reset) this.expectingReset = true
    this.writeBytes(Uint8Array.of(byte))
    return Ok(undefined)
  }

  /**
   * Streams `program` (pre-flighted first). Resolves once the program ends: `Ok` when every line
   * is acknowledged and the machine is `Idle`; `machine.error`/`machine.alarm`/
   * `machine.connection`; `op.aborted` after `stop()`.
   */
  run(program: SenderProgram, events: RunEvents = {}): AsyncAppResult<RunSummary> {
    const where = 'GrblSender.run'
    if (!this.connected)
      return Promise.resolve(fail('machine.connection', 'not connected', { where }))
    if (this.run_ !== undefined)
      return Promise.resolve(fail('run.busy', 'a program is running', { where }))
    const pf = preflight(program.lines, where)
    if (pf.isErr()) return Promise.resolve(Err(pf.unwrapErr()))
    return new Promise((resolve) => {
      const run: ActiveRun = {
        program,
        events,
        resolve,
        onEnd: [],
        startedAt: this.clock.now(),
        phase: 'streaming',
        next: 0,
        done: 0,
        waited: 0,
        toolChanges: 0,
        pauses: 0,
        label: '',
      }
      this.run_ = run
      this.log.info({ lines: program.lines.length }, 'run started')
      this.emitPhase(run)
      this.emitProgress(run)
      if (program.lines.length === 0) this.awaitFresh()
      this.fill()
    })
  }

  /**
   * Feed hold (`!`) while streaming. While a tool change or pause waits, nothing moves: the hold
   * is kept, and `continueProgram()` is refused until `resume()`.
   */
  hold(): AppResult<void> {
    const run = this.run_
    if (run !== undefined && (run.phase === 'toolChange' || run.phase === 'programPause')) {
      run.holdAfterWait = true
      return Ok(undefined)
    }
    if (run?.phase !== 'streaming') return this.phaseError('hold')
    this.writeBytes(Uint8Array.of(REALTIME.hold))
    this.setPhase(run, 'held')
    return Ok(undefined)
  }

  /** Cycle start (`~`) after `hold()`. */
  resume(): AppResult<void> {
    const run = this.run_
    if (run?.holdAfterWait === true && run.phase !== 'held') {
      run.holdAfterWait = false
      return Ok(undefined)
    }
    if (run?.phase !== 'held') return this.phaseError('resume')
    this.cycleStart()
    this.setPhase(run, 'streaming')
    this.fill()
    return Ok(undefined)
  }

  /** Leaves `toolChange` (sends the marker, skips its `M0`) or `programPause` (`~`). */
  continueProgram(): AppResult<void> {
    const run = this.run_
    if (run?.holdAfterWait === true && (run.phase === 'toolChange' || run.phase === 'programPause'))
      return fail('run.state', 'the run is paused: resume it first', {
        where: 'GrblSender.continue',
        data: { phase: run.phase, paused: true },
      })
    if (run?.phase === 'toolChange') {
      // the user may have jogged or zeroed: continue only once all of it is done and acknowledged
      if (!this.idleNow() || this.inflight.length > 0 || this.commands.length > 0)
        return fail('run.state', 'wait until the machine is Idle and every command is done', {
          where: 'GrblSender.continue',
          data: { state: this.latest?.state ?? 'Unknown', phase: run.phase },
        })
      run.toolChanges++
      run.toolChange = undefined
      run.sendMarker = true
      this.setPhase(run, 'streaming')
      this.fill()
      return Ok(undefined)
    }
    if (run?.phase === 'programPause') {
      run.pauses++
      run.message = undefined
      this.cycleStart()
      this.setPhase(run, 'streaming')
      return Ok(undefined)
    }
    return this.phaseError('continue')
  }

  /** `~`; reports requested before it may still say Hold. */
  private cycleStart(): void {
    this.writeBytes(Uint8Array.of(REALTIME.resume))
    this.resumeMark = this.pollsWritten
  }

  /** The last report says Idle and was requested after the last command's acknowledgement. */
  private idleNow(): boolean {
    return this.latest?.state === 'Idle' && this.reportsSeen > this.motionMark
  }

  /**
   * Controlled stop: `!`, wait for `Hold:0` (≤ 5 s clock time), then `0x18` (in `toolChange`,
   * already Idle, only the reset). Resolves when the controller has restarted; the run resolves
   * `op.aborted`.
   */
  stop(): AsyncAppResult<void> {
    const run = this.run_
    if (run === undefined) return Promise.resolve(Ok(undefined))
    return new Promise((resolve) => {
      run.onEnd.push(() => resolve(Ok(undefined)))
      // a stop already under way: wait for it to reach the reset and end
      if (run.phase !== 'stopping') this.stopSequence(run, undefined)
    })
  }

  /**
   * Stops polling, fails what is pending and closes the transport. During a run the controller is
   * reset first (`0x18`: motion and spindle stop, GRBL's buffers are flushed), and so is it with
   * `reset` (a real machine: disconnect = reset, docs/modes/run.md#6-lost-connection-disconnect-and-reconnect).
   */
  async close(opts: { readonly reset?: boolean } = {}): AsyncAppResult<void> {
    const run = this.run_
    if ((run !== undefined || opts.reset === true) && this.connected) {
      this.expectingReset = true
      const reset = await this.transport.write(Uint8Array.of(REALTIME.reset))
      if (reset.isErr())
        this.log.warn({ err: reset.unwrapErr().toJSON() }, 'reset before close failed')
    }
    if (run !== undefined)
      this.finish(
        run,
        Err(new AppError('machine.connection', 'connection closed', { where: 'GrblSender.close' })),
      )
    this.failCommands(
      new AppError('machine.connection', 'connection closed', { where: 'GrblSender.close' }),
    )
    this.connected = false
    this.disposeIo()
    return this.transport.close()
  }

  // ── Streaming ───────────────────────────────────────────────────────────────────────────

  private request(line: string, timeoutMs?: number): AsyncAppResult<readonly GrblLine[]> {
    const where = 'GrblSender.command'
    if (!this.connected)
      return Promise.resolve(fail('machine.connection', 'not connected', { where }))
    const run = this.run_
    if (run !== undefined && run.phase !== 'toolChange')
      return Promise.resolve(
        fail('run.state', `no commands while a program is ${run.phase}`, {
          where,
          data: { phase: run.phase },
        }),
      )
    // after a sent reset, commands wait for the banner
    if (this.critical && !this.expectingReset)
      return Promise.resolve(
        fail('run.state', 'the controller is in a critical alarm: reset it first', {
          where,
          data: { state: 'Alarm' },
        }),
      )
    const pf = preflight([line], where)
    if (pf.isErr()) return Promise.resolve(Err(pf.unwrapErr()))
    return new Promise((resolve) => {
      const cmd: PendingCommand = { line, replies: [], resolve, settled: false }
      const ms = timeoutMs ?? (line === '$H' ? 600_000 : (this.opts.commandTimeoutMs ?? 10_000))
      const arm = (): (() => void) => {
        const holds = this.holdReports
        return this.clock.schedule(this.clock.now() + ms, () => {
          cmd.cancelTimeout = undefined
          if (cmd.settled) return
          // a feed hold (a paused Probe Z, DF82) keeps the reply back on purpose: wait on, a
          // whole timeout again after the last report of a hold
          if (this.holdReports > holds) {
            cmd.cancelTimeout = arm()
            return
          }
          this.log.warn({ command: line, ms }, 'no reply to a command')
          this.connectionLost(`no reply to ${line}`)
        })
      }
      cmd.cancelTimeout = arm()
      this.commands.push(cmd)
      this.fill()
    })
  }

  private settle(cmd: PendingCommand, r: AppResult<readonly GrblLine[]>): void {
    if (cmd.settled) return
    cmd.settled = true
    // the poll outstanding through a silent homing cycle gets a fresh limit (homingInFlight)
    if (cmd.line === '$H' && this.pollOutstandingSince !== undefined)
      this.pollOutstandingSince = this.timers.now()
    cmd.cancelTimeout?.()
    cmd.cancelTimeout = undefined
    cmd.resolve(r)
  }

  private fits(bytes: number): boolean {
    return this.mode === 'charCount'
      ? this.used + bytes <= RX_BUFFER_BYTES
      : this.inflight.length === 0
  }

  /** Sends what fits: queued commands first, then program lines. */
  private fill(): void {
    if (!this.connected || this.expectingReset) return
    for (;;) {
      const cmd = this.commands[0]
      if (cmd !== undefined) {
        const n = cmd.line.length + 1
        if (!this.fits(n)) return
        this.commands.shift()
        this.book({ bytes: n, kind: 'command', cmd }, cmd.line)
        continue
      }
      const run = this.run_
      if (run?.phase !== 'streaming' || run.pendingToolChange !== undefined) return
      const lines = run.program.lines
      if (run.sendMarker === true) {
        const marker = lines[run.next] ?? ''
        if (!this.fits(marker.length + 1)) return
        this.book({ bytes: marker.length + 1, kind: 'program', index: run.next }, marker)
        run.sendMarker = false
        run.next += 2
        run.done++ // the skipped M0
        continue
      }
      const line = lines[run.next]
      if (line === undefined) return
      const m = MARKER.exec(line)
      if (m && MARKER_PAUSE.test(lines[run.next + 1] ?? '')) {
        run.pendingToolChange = toolChangeAt(lines, run.next, m)
        this.log.debug({ tool: run.pendingToolChange.n, line: run.next + 1 }, 'tool change ahead')
        this.awaitFresh()
        return
      }
      const n = line.length + 1
      if (!this.fits(n)) return
      this.book({ bytes: n, kind: 'program', index: run.next }, line)
      run.next++
    }
  }

  /** Books the line against the RX buffer, then writes it (an answer can only follow). */
  private book(sent: Sent, line: string): void {
    this.ackMark = this.pollsWritten
    this.idleWithLineSince = undefined
    this.inflight.push(sent)
    this.used += sent.bytes
    if (sent.kind === 'program' && this.log.isLevelEnabled('trace'))
      this.log.trace({ line: sent.index + 1 }, 'line sent')
    this.writeBytes(encode(`${line}\n`))
  }

  private writeBytes(bytes: Uint8Array): void {
    void this.transport.write(bytes).then((r) => {
      if (r.isErr()) this.connectionLost(`write failed: ${r.unwrapErr().message}`)
    })
  }

  // ── Receiving ───────────────────────────────────────────────────────────────────────────

  private onData(bytes: Uint8Array): void {
    let text = this.rxText
    for (const b of bytes) text += String.fromCharCode(b)
    const parts = text.split('\r\n')
    this.rxText = parts.pop() ?? ''
    for (const raw of parts) if (raw !== '') this.onLine(parseLine(raw))
  }

  private onLine(l: GrblLine): void {
    switch (l.kind) {
      case 'ok':
      case 'error':
        return this.onAck(l)
      case 'status':
        return this.onStatusReport(l.report)
      case 'alarm':
        return this.onAlarm(l.code)
      case 'banner':
        return this.onBanner()
      case 'message':
        if (l.text === 'Reset to continue') this.critical = true
        this.emit({ kind: 'message', text: l.text })
        this.collect(l)
        return
      default:
        this.collect(l)
    }
  }

  /** Replies before a command's `ok` (`$#`, `$$`, `[MSG:…]` of `$X`) belong to that command. */
  private collect(l: GrblLine): void {
    const oldest = this.inflight[0]
    if (oldest?.kind === 'command') oldest.cmd.replies.push(l)
  }

  private onAck(l: Extract<GrblLine, { kind: 'ok' | 'error' }>): void {
    const sent = this.inflight.shift()
    if (sent === undefined) {
      this.log.warn({ reply: lineText(l) }, 'acknowledgement without a line in flight')
      return
    }
    this.used -= sent.bytes
    this.ackMark = this.pollsWritten
    this.idleWithLineSince = undefined
    if (sent.kind === 'command') {
      this.motionMark = this.pollsWritten
      if (l.kind === 'ok') this.settle(sent.cmd, Ok(sent.cmd.replies))
      else
        this.settle(
          sent.cmd,
          fail('machine.error', `error:${l.code} ${errorText(l.code)}`, {
            where: 'GrblSender.command',
            data: { code: l.code, text: errorText(l.code), command: sent.cmd.line },
          }),
        )
      this.fill()
      return
    }
    const run = this.run_
    if (run === undefined) return // a stale line of a finished run (e.g. error:9 after an alarm)
    run.done++
    if (this.log.isLevelEnabled('trace'))
      this.log.trace({ line: sent.index + 1 }, 'line acknowledged')
    if (l.kind === 'error') {
      if (run.phase === 'stopping') return
      const text = errorText(l.code)
      this.emit({ kind: 'error', code: l.code, text, line: sent.index + 1 })
      this.stopSequence(
        run,
        new AppError('machine.error', `line ${sent.index + 1}: error:${l.code} ${text}`, {
          where: 'GrblSender.run',
          data: { code: l.code, line: sent.index + 1, text },
        }),
      )
      return
    }
    this.emitProgress(run)
    if (run.done >= run.program.lines.length || run.pendingToolChange !== undefined)
      if (this.programInflight() === 0) this.awaitFresh()
    this.fill()
  }

  private onStatusReport(report: StatusReport): void {
    this.reportsSeen++
    if (report.state === 'Hold') this.holdReports++
    this.pollOutstandingSince = undefined
    const p = positions(report, this.wco, this.inches)
    if (report.wco !== undefined && p !== undefined) {
      this.wco = p.wco
      this.wcoPending = false
    }
    const prev = this.latest
    if (report.overrides !== undefined) this.overrides = report.overrides
    const k = this.inches ? 25.4 : 1
    this.latest = {
      state: stateText(report),
      mpos: p?.mpos ?? prev?.mpos ?? ZERO,
      wpos: p?.wpos ?? prev?.wpos ?? ZERO,
      wco: this.wco,
      feed: report.feed === undefined ? (prev?.feed ?? 0) : report.feed * k,
      spindle: report.spindle ?? prev?.spindle ?? 0,
      ...(report.buffer === undefined ? {} : { buffer: report.buffer }),
      ...(this.overrides === undefined ? {} : { overrides: this.overrides }),
    }
    for (const l of [...this.statusListeners]) l(this.latest)
    if (this.lostAcknowledgement(report)) return
    this.afterStatus(report)
  }

  /**
   * Idle (in reports requested after the last line went out or was acknowledged) while a line
   * waits for its `ok`: GRBL has executed it, so the `ok` was lost. Dwells in flight extend the
   * allowance (GRBL reports Idle while it dwells).
   */
  private lostAcknowledgement(report: StatusReport): boolean {
    const waiting = this.inflight.some((x) => x.kind === 'program' || !x.cmd.settled)
    if (report.state !== 'Idle' || !waiting || this.reportsSeen <= this.ackMark) {
      this.idleWithLineSince = undefined
      return false
    }
    const now = this.clock.now()
    this.idleWithLineSince ??= now
    let allowance = this.opts.ackTimeoutMs ?? 5000
    const lines = this.run_?.program.lines
    for (const x of this.inflight)
      allowance += dwellMs(x.kind === 'program' ? lines?.[x.index] : x.cmd.line)
    if (now - this.idleWithLineSince <= allowance) return false
    this.log.warn({ ms: now - this.idleWithLineSince }, 'acknowledgement missing')
    this.connectionLost('acknowledgement missing')
    return true
  }

  private afterStatus(report: StatusReport): void {
    const run = this.run_
    if (run === undefined) return
    const state = stateText(report)
    // Never re-poll from here: on a virtual clock a reply comes at the same instant (livelock);
    // the next regular poll brings the next report.
    if (run.phase === 'stopping') {
      // motion has stopped after our `!` (a report requested after it)
      const commandsDone = !this.inflight.some((x) => x.kind === 'command' && !x.cmd.settled)
      if (this.holdMark !== undefined && this.reportsSeen > this.holdMark && commandsDone)
        if (state === 'Hold:0' || state === 'Idle' || report.state === 'Alarm') this.sendReset()
      return
    }
    if (run.phase === 'streaming' && state === 'Hold:0') {
      // a report requested before our `~` still shows the hold we just left
      if (this.resumeMark !== undefined && this.reportsSeen <= this.resumeMark) return
      const oldest = this.inflight[0]
      if (oldest?.kind === 'program' && isProgramPause(run.program.lines[oldest.index])) {
        run.message =
          pauseText(run.program.lines[oldest.index]) ??
          commentText(run.program.lines[oldest.index - 1]) ??
          'Program paused (M0)'
        this.setPhase(run, 'programPause')
      } else this.setPhase(run, 'held') // a hold we did not send (door, button)
      return
    }
    if (this.freshMark === undefined || this.reportsSeen <= this.freshMark) return
    if (run.phase !== 'streaming' || state !== 'Idle' || this.programInflight() > 0) return
    this.freshMark = undefined
    if (run.pendingToolChange !== undefined) {
      run.toolChange = run.pendingToolChange
      run.pendingToolChange = undefined
      this.log.debug({ tool: run.toolChange.n }, 'tool change')
      this.setPhase(run, 'toolChange')
      return
    }
    if (run.done >= run.program.lines.length) this.finishOk(run)
  }

  private onAlarm(code: number): void {
    const text = alarmText(code)
    // GRBL 1.1: hard and soft limits are critical (`[MSG:Reset to continue]`, nothing until a reset)
    if (code === 1 || code === 2) this.critical = true
    this.emit({ kind: 'alarm', code, text })
    const e = new AppError('machine.alarm', `ALARM:${code} ${text}`, {
      where: 'GrblSender.command',
      data: { code, text },
    })
    // commands not sent yet never run; in a critical alarm GRBL answers none in flight either
    for (const c of this.commands.splice(0)) this.settle(c, Err(e))
    if (this.critical)
      for (const x of this.inflight) if (x.kind === 'command') this.settle(x.cmd, Err(e))
    const run = this.run_
    if (run === undefined) return
    if (run.phase === 'stopping') {
      run.failure ??= alarmError(code, run)
      return
    }
    // a probe at a tool change missed (ALARM:4/5): none of the program is in GRBL's buffers there,
    // so the run keeps waiting for unlock, another probe and continue (run-machine.md#probing-and-re-zero-m4)
    if (run.phase === 'toolChange' && (code === 4 || code === 5)) {
      this.log.debug({ code }, 'probe alarm at a tool change')
      return
    }
    this.log.debug({ code }, 'alarm during a run')
    this.finish(run, Err(alarmError(code, run)))
  }

  private onBanner(): void {
    const expected = this.expectingReset
    this.expectingReset = false
    this.critical = false
    // GRBL restores the overrides on a reset
    if (this.overrides !== undefined) this.overrides = NO_OVERRIDES
    this.holdMark = undefined
    this.freshMark = undefined
    this.cancelHoldTimeout?.()
    this.cancelHoldTimeout = undefined
    // GRBL flushed its buffers: nothing in flight is acknowledged any more
    this.failCommands(
      expected
        ? new AppError('op.aborted', 'the controller was reset', { where: 'GrblSender' })
        : new AppError('machine.connection', 'the controller reset itself', {
            where: 'GrblSender',
          }),
      true,
    )
    this.inflight.length = 0
    this.used = 0
    this.pollOutstandingSince = undefined
    this.reportsSeen = this.pollsWritten
    this.resumeMark = undefined
    this.idleWithLineSince = undefined
    const waiter = this.bannerWaiter
    this.bannerWaiter = undefined
    if (waiter !== undefined) {
      waiter(true)
      return
    }
    if (!this.connected) return
    this.emit({ kind: 'reset', expected })
    const run = this.run_
    if (run === undefined) {
      this.fill()
      return
    }
    const failure =
      run.phase === 'stopping'
        ? (run.failure ??
          new AppError('op.aborted', 'the run was stopped', { where: 'GrblSender.stop' }))
        : expected
          ? new AppError('op.aborted', 'the controller was reset during the run', {
              where: 'GrblSender.run',
            })
          : new AppError('machine.connection', 'the controller reset during the run', {
              where: 'GrblSender.run',
              data: { line: run.done + 1 },
            })
    this.finish(run, Err(failure))
    this.fill()
  }

  // ── Run state ───────────────────────────────────────────────────────────────────────────

  private programInflight(): number {
    let n = 0
    for (const s of this.inflight) if (s.kind === 'program') n++
    return n
  }

  /** Asks for a status report the next decision needs (one after this moment). */
  private awaitFresh(): void {
    this.freshMark = this.pollsWritten
    this.requestStatus()
  }

  private stopSequence(run: ActiveRun, failure: AppError | undefined): void {
    if (failure !== undefined) run.failure = failure
    run.pendingToolChange = undefined
    const wasToolChange = run.phase === 'toolChange'
    this.setPhase(run, 'stopping')
    this.freshMark = undefined
    if (this.critical) {
      this.sendReset()
      return
    }
    // a reset during motion loses the position (ALARM:3): at a tool change the user may be
    // jogging, so cancel the jog; otherwise feed-hold. Reset once a later report shows it stopped.
    this.writeBytes(Uint8Array.of(wasToolChange ? REALTIME.jogCancel : REALTIME.hold))
    this.holdMark = this.pollsWritten
    this.requestStatus()
    this.cancelHoldTimeout = this.clock.schedule(
      this.clock.now() + (this.opts.holdTimeoutMs ?? 5000),
      () => {
        this.cancelHoldTimeout = undefined
        if (this.holdMark === undefined) return
        this.log.warn('motion did not stop in time; resetting anyway')
        this.sendReset()
      },
    )
  }

  private sendReset(): void {
    this.holdMark = undefined
    this.cancelHoldTimeout?.()
    this.cancelHoldTimeout = undefined
    this.expectingReset = true
    this.writeBytes(Uint8Array.of(REALTIME.reset))
  }

  private finishOk(run: ActiveRun): void {
    const now = this.clock.now()
    this.finish(
      run,
      Ok({
        lines: run.program.lines.length,
        seconds: (now - run.startedAt - run.waited) / 1000,
        elapsedSeconds: (now - run.startedAt) / 1000,
        toolChanges: run.toolChanges,
        pauses: run.pauses,
      }),
    )
  }

  private finish(run: ActiveRun, result: AppResult<RunSummary>): void {
    if (this.run_ !== run) return
    this.run_ = undefined
    this.freshMark = undefined
    this.holdMark = undefined
    this.cancelHoldTimeout?.()
    this.cancelHoldTimeout = undefined
    this.endWait(run)
    run.phase = result.isOk()
      ? 'done'
      : result.unwrapErr().code === 'op.aborted'
        ? 'stopped'
        : 'failed'
    this.emitProgress(run)
    run.events.phase?.({ phase: run.phase })
    this.log.info(
      {
        phase: run.phase,
        lines: run.done,
        s: (this.clock.now() - run.startedAt) / 1000,
        ...(result.isErr() ? { code: result.unwrapErr().code } : {}),
      },
      'run ended',
    )
    run.resolve(result)
    for (const f of run.onEnd) f()
  }

  private setPhase(run: ActiveRun, phase: RunPhase): void {
    if (run.phase === phase) return
    const waiting = (p: RunPhase) => p === 'held' || p === 'programPause' || p === 'toolChange'
    if (waiting(run.phase) && !waiting(phase)) this.endWait(run)
    if (!waiting(run.phase) && waiting(phase)) run.waitingSince = this.clock.now()
    run.phase = phase
    this.log.debug({ phase }, 'run phase')
    this.emitPhase(run)
    this.emitProgress(run)
  }

  private endWait(run: ActiveRun): void {
    if (run.waitingSince === undefined) return
    run.waited += this.clock.now() - run.waitingSince
    run.waitingSince = undefined
  }

  private emitPhase(run: ActiveRun): void {
    run.events.phase?.({
      phase: run.phase,
      ...(run.phase === 'toolChange' && run.toolChange !== undefined
        ? { toolChange: run.toolChange }
        : {}),
      ...(run.phase === 'programPause' && run.message !== undefined
        ? { message: run.message }
        : {}),
    })
  }

  private emitProgress(run: ActiveRun): void {
    run.label =
      run.phase === 'toolChange' && run.toolChange !== undefined
        ? `Tool change ${run.toolChange.n}: ${run.toolChange.name}`
        : run.phase === 'programPause' && run.message !== undefined
          ? run.message
          : sectionLabel(run.program, run.done + 1)
    run.events.progress?.({ done: run.done, total: run.program.lines.length, label: run.label })
  }

  private phaseError(action: string): AppResult<never> {
    const phase = this.run_?.phase ?? 'none'
    return fail('run.state', `cannot ${action} while the run is ${phase}`, {
      where: `GrblSender.${action}`,
      data: { phase },
    })
  }

  private emit(e: SenderEvent): void {
    for (const l of [...this.eventListeners]) l(e)
  }

  // ── Polling, watchdog and connection ────────────────────────────────────────────────────

  private requestStatus(): void {
    if (!this.connected || this.pollOutstandingSince !== undefined || this.critical) return
    this.pollOutstandingSince = this.timers.now()
    this.pollsWritten++
    this.writeBytes(Uint8Array.of(REALTIME.status))
  }

  private startPolling(): void {
    const tick = () => {
      this.requestStatus()
      this.cancelPoll = this.clock.schedule(this.clock.now() + this.pollMs, tick)
    }
    tick()
    const limit = this.opts.statusTimeoutMs ?? 2000
    const watch = () => {
      const since = this.pollOutstandingSince
      if (
        since !== undefined &&
        !this.critical &&
        !this.homingInFlight() &&
        this.timers.now() - since > limit
      ) {
        this.log.warn({ ms: this.timers.now() - since }, 'status reply missing')
        this.connectionLost('no status reply')
        return
      }
      this.cancelWatchdog = this.timers.setTimeout(watch, limit / 4)
    }
    this.cancelWatchdog = this.timers.setTimeout(watch, limit / 4)
  }

  /**
   * Real GRBL runs no realtime protocol inside the homing cycle, so no `?` is answered until `$H`
   * ends: the status watchdog waits while `$H` is in flight; the `$H` command timeout still applies
   * (docs/modes/run.md#5-watchdogs).
   */
  private homingInFlight(): boolean {
    return this.inflight.some((s) => s.kind === 'command' && s.cmd.line === '$H' && !s.cmd.settled)
  }

  private waitForBanner(): Promise<boolean> {
    return new Promise((resolve) => {
      const cancel = this.timers.setTimeout(() => {
        this.bannerWaiter = undefined
        resolve(false)
      }, this.opts.bannerTimeoutMs ?? 2000)
      this.bannerWaiter = (ok) => {
        cancel()
        resolve(ok)
      }
    })
  }

  private connectFailed(e: AppError, where: string): AppResult<never> {
    this.connected = false
    this.disposeIo()
    return Err(e.withContext(where))
  }

  private connectionLost(reason: string): void {
    if (!this.connected) return
    this.connected = false
    this.disposeIo()
    const e = new AppError('machine.connection', `connection lost: ${reason}`, {
      where: 'GrblSender',
      data: { reason },
    })
    this.emit({ kind: 'connectionLost', reason })
    this.failCommands(e)
    const run = this.run_
    if (run !== undefined) this.finish(run, Err(e))
  }

  /** Fails the commands in flight and, unless `inflightOnly`, the queued ones. */
  private failCommands(e: AppError, inflightOnly = false): void {
    const pending = inflightOnly ? [] : this.commands.splice(0)
    for (const s of this.inflight)
      if (s.kind === 'command') {
        this.used -= s.bytes
        pending.push(s.cmd)
      }
    const rest = this.inflight.filter((s) => s.kind !== 'command')
    this.inflight.splice(0, this.inflight.length, ...rest)
    for (const c of pending) this.settle(c, Err(e))
  }

  private disposeIo(): void {
    this.cancelPoll?.()
    this.cancelWatchdog?.()
    this.cancelHoldTimeout?.()
    this.cancelPoll = this.cancelWatchdog = this.cancelHoldTimeout = undefined
    this.unsubscribe?.()
    this.unsubscribeClose?.()
    this.unsubscribe = this.unsubscribeClose = undefined
  }
}

function lineText(l: GrblLine): string {
  switch (l.kind) {
    case 'ok':
      return 'ok'
    case 'error':
      return `error:${l.code}`
    case 'alarm':
      return `ALARM:${l.code}`
    case 'message':
      return `[MSG:${l.text}]`
    case 'feedback':
      return `[${l.tag}:${l.text}]`
    case 'setting':
      return `$${l.n}=${l.value}`
    case 'banner':
      return `Grbl ${l.version}`
    case 'status':
      return `<${stateText(l.report)}>`
    case 'other':
      return l.text
  }
}

function alarmError(code: number, run: ActiveRun): AppError {
  return new AppError('machine.alarm', `ALARM:${code} ${alarmText(code)}`, {
    where: 'GrblSender.run',
    data: { code, line: run.done + 1, text: alarmText(code) },
  })
}

function sectionLabel(program: SenderProgram, line: number): string {
  let label = ''
  for (const s of program.sections) {
    if (s.fromLine > line) break
    label = s.label
  }
  return label
}
