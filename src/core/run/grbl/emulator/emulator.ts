/**
 * GRBL 1.1h virtual machine: a deterministic state machine fed bytes and time, producing bytes.
 * Doc: docs/architecture/grbl.md#virtual-machine-task-38
 *
 * Time is explicit: `advanceTo(ms)` runs every event up to that time; `nextEventAt()` says
 * when the next one is due (VirtualGrblTransport schedules it on a Clock). Bytes arrive one
 * at a time as over a serial line, and a complete line is processed as soon as it arrives.
 */
import { Ok, type AppResult } from '../../../../shared/result'
import {
  initialParserState,
  parseBlock,
  STATUS,
  type Action,
  type ParserState,
  type SpindleDir,
  type StatusCode,
} from './gcode'
import { Planner, type Vec3 } from './planner'
import { holdProfile, sampleProfile, trapezoid, type Profile } from './profile'
import { Settings, type SettingValues } from './settings'
import {
  emptyTrace,
  type MutableTrace,
  type Trace,
  type TraceLine,
  type ViolationKind,
} from './trace'

/** RX_BUFFER_SIZE; the ring buffer holds one byte less. */
export const RX_BUFFER_SIZE = 128
/** LINE_BUFFER_SIZE. */
export const LINE_BUFFER_SIZE = 80
export const BANNER = "Grbl 1.1h ['$' for help]"
const VERSION = '[VER:1.1h.20190830:]'
const OPTIONS = '[OPT:VZ,15,128]'
const HELP = '[HLP:$$ $# $G $I $N $x=val $Nx=line $J=line $SLP $C $X $H ~ ! ? ctrl-x]'
/** SAFETY_DOOR_SPINDLE_DELAY, ms. */
const DOOR_SPINDLE_DELAY = 4000
const MM_PER_INCH = 25.4

export type MachineState = 'Idle' | 'Run' | 'Hold' | 'Jog' | 'Home' | 'Alarm' | 'Check' | 'Door'

export interface EmulatorOptions {
  /** `$22`: start in Alarm and require `$H` (default true); false starts Idle at MPos 0,0,0. */
  readonly homing?: boolean
  /** Setting overrides, e.g. `machineSettings(machine)` or `{ 120: 500 }`. */
  readonly settings?: SettingValues
  /** Record the trace (default true). */
  readonly trace?: boolean
}

export interface EmulatorStatus {
  /** As reported, e.g. `Hold:0`. */
  readonly state: string
  readonly mpos: Vec3
  readonly wco: Vec3
  /** mm/min. */
  readonly rate: number
  /** rpm actually running (after override and `$30/$31` clamping). */
  readonly spindleSpeed: number
  readonly plannerFree: number
  readonly rxFree: number
}

type Stop = 'hold' | 'jogCancel' | 'softLimit' | 'door'
type Step = Action | { readonly kind: 'jog'; readonly target: Vec3; readonly feed: number }

interface Current {
  readonly steps: Step[]
  readonly line: number
}

interface Exec {
  readonly startedAt: number
  readonly profile: Profile
}

const zero: Vec3 = [0, 0, 0]
const add = (a: Vec3, u: Vec3, s: number): Vec3 => [
  a[0] + u[0] * s,
  a[1] + u[1] * s,
  a[2] + u[2] * s,
]

/** GRBL printFloat(): fixed decimals, never `-0.000`. */
function fixed(v: number, decimals: number): string {
  const s = v.toFixed(decimals)
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s
}

export class GrblEmulator {
  private now = 0
  private state: MachineState
  private readonly planner: Planner
  private parser: ParserState
  /** Actual G54 offset (the parser's copy changes at parse time, this one after G10 syncs). */
  private wco: Vec3 = zero
  private mpos: Vec3 = zero

  private readonly rx: number[] = []
  private rxMidLine = false
  private lineChars = ''
  private lineRaw = ''
  private lineRawLength = 0
  private lineComment = false
  private lineSemicolon = false
  private lineOverflow = false

  private current: Current | undefined
  private exec: Exec | undefined
  private stopping: Stop | undefined
  /** Hold or door: motion has stopped (Hold:0, Door:0/1). */
  private holdComplete = false
  /** Waiting for a reset after a critical alarm (GRBL prints nothing, not even status). */
  private critical = false
  private dwellEndsAt: number | undefined
  private dwellRemaining: number | undefined
  private homingEndsAt: number | undefined
  private restoreEndsAt: number | undefined
  private doorAjar = false

  private spindle: { dir: SpindleDir; rpm: number } = { dir: 'off', rpm: 0 }
  private spindleSuspended = false
  private spindleStopOverride = false
  private ov = { feed: 100, rapid: 100, spindle: 100 }
  private reportWco = 0
  private reportOv = 0

  private output: string[] = []
  private readonly rec: MutableTrace = emptyTrace()
  private lastState = ''

  private constructor(
    private readonly settings: Settings,
    private readonly tracing: boolean,
  ) {
    const s = settings
    this.planner = new Planner({
      get maxRate(): Vec3 {
        return [s.get(110), s.get(111), s.get(112)]
      },
      get accel(): Vec3 {
        return [s.get(120), s.get(121), s.get(122)]
      },
      get junctionDeviation() {
        return s.get(11)
      },
    })
    this.parser = initialParserState(zero, zero)
    this.state = s.get(22) ? 'Alarm' : 'Idle'
    this.banner()
    this.noteState()
  }

  static create(options: EmulatorOptions = {}): AppResult<GrblEmulator> {
    return Settings.create(options.settings ?? {}, options.homing ?? true).andThen((s) =>
      Ok(new GrblEmulator(s, options.trace ?? true)),
    )
  }

  // ── Public API ──────────────────────────────────────────────────────────────────────────

  /** Current emulator time, ms. */
  get time(): number {
    return this.now
  }

  get trace(): Trace {
    return this.rec
  }

  /** Bytes from the sender, at the current time. */
  receive(bytes: Uint8Array): void {
    for (const b of bytes) {
      this.receiveByte(b)
      this.noteState()
    }
  }

  /** Output produced since the last call (ASCII text with `\r\n` line ends). */
  readOutput(): string {
    const s = this.output.join('')
    this.output = []
    return s
  }

  /** Time of the next internal event (block end, dwell, homing, door restore), if any. */
  nextEventAt(): number | undefined {
    let t: number | undefined
    const take = (v: number | undefined) => {
      if (v !== undefined && (t === undefined || v < t)) t = v
    }
    if (this.exec) take(this.exec.startedAt + this.exec.profile.duration * 1000)
    take(this.dwellEndsAt)
    take(this.homingEndsAt)
    take(this.restoreEndsAt)
    return t
  }

  /** Runs every event due up to `t` (ms) and moves the clock there; earlier times are ignored. */
  advanceTo(t: number): void {
    for (let e = this.nextEventAt(); e !== undefined && e <= t; e = this.nextEventAt()) {
      this.now = Math.max(this.now, e)
      this.handleEvent()
      this.noteState()
    }
    this.now = Math.max(this.now, t)
  }

  advance(ms: number): void {
    this.advanceTo(this.now + ms)
  }

  status(): EmulatorStatus {
    return {
      state: this.stateString(),
      mpos: this.position(),
      wco: this.wco,
      rate: this.speed() * 60,
      spindleSpeed: this.spindleRpm(),
      plannerFree: this.planner.free,
      rxFree: RX_BUFFER_SIZE - this.rx.length,
    }
  }

  /** Test hook: close the safety door opened by `0x84`; `~` then resumes. */
  closeDoor(): void {
    this.doorAjar = false
    this.noteState()
  }

  // ── Bytes and lines ─────────────────────────────────────────────────────────────────────

  private receiveByte(b: number): void {
    switch (b) {
      case 0x3f:
        return this.statusReport()
      case 0x21:
        return this.feedHold()
      case 0x7e:
        return this.cycleStart()
      case 0x18:
        return this.reset()
    }
    if (b >= 0x80) {
      if (this.rxMidLine) this.violation('nonAscii', `0x${b.toString(16)}`)
      return this.extended(b)
    }
    if (this.rx.length >= RX_BUFFER_SIZE - 1) {
      return this.violation('rxOverflow', `0x${b.toString(16)}`)
    }
    this.rx.push(b)
    const eol = b === 0x0a || b === 0x0d
    this.rxMidLine = !eol
    if (eol) this.run()
  }

  /** Main loop: executes the current line's steps, then reads and executes further lines. */
  private run(): void {
    for (;;) {
      if (this.blocked()) return
      if (this.current) {
        if (!this.step(this.current)) return
      } else if (!this.readLine()) return
      this.noteState()
    }
  }

  private blocked(): boolean {
    return (
      this.critical ||
      this.stopping !== undefined ||
      this.state === 'Hold' ||
      this.state === 'Door' ||
      this.state === 'Home' ||
      this.dwellEndsAt !== undefined
    )
  }

  /** GRBL protocol_main_loop() line assembly. Returns false when no complete line is buffered. */
  private readLine(): boolean {
    for (let c = this.rx.shift(); c !== undefined; c = this.rx.shift()) {
      if (c === 0x0a || c === 0x0d) {
        this.executeLine()
        return true
      }
      this.lineRawLength++
      if (this.lineRaw.length < 256) this.lineRaw += String.fromCharCode(c)
      const ch = String.fromCharCode(c)
      if (this.lineComment || this.lineSemicolon || this.lineOverflow) {
        if (ch === ')') this.lineComment = false
      } else if (c <= 0x20 || ch === '/') {
        // Whitespace, control characters and block delete are dropped.
      } else if (ch === '(') this.lineComment = true
      else if (ch === ';') this.lineSemicolon = true
      else if (this.lineChars.length >= LINE_BUFFER_SIZE - 1) this.lineOverflow = true
      else this.lineChars += ch.toUpperCase()
    }
    return false
  }

  private executeLine(): void {
    const text = this.lineChars
    const overflow = this.lineOverflow
    const index = this.rec.lines.length
    const entry: TraceLine = { text: this.lineRaw, receivedAt: this.now }
    if (this.lineRawLength > LINE_BUFFER_SIZE) this.violation('lineTooLong', this.lineRaw)
    this.lineChars = ''
    this.lineRaw = ''
    this.lineRawLength = 0
    this.lineComment = this.lineSemicolon = this.lineOverflow = false
    this.rec.lines.push(entry) // always: indices identify lines for motion timing
    if (overflow) return this.respond(index, STATUS.overflow)
    if (text === '') return this.respond(index, 0)
    if (text.startsWith('$')) return this.system(index, text)
    if (this.state === 'Alarm' || this.state === 'Jog')
      return this.respond(index, STATUS.systemGcLock)
    const parsed = parseBlock(text, this.parser, { arcTolerance: this.settings.get(12) })
    if (parsed.isErr()) return this.respond(index, parsed.unwrapErr())
    const block = parsed.unwrap()
    this.parser = block.state
    this.current = { steps: [...block.actions], line: index }
  }

  private respond(line: number, status: StatusCode | 0): void {
    const text = status === 0 ? 'ok' : `error:${status}`
    const entry = this.rec.lines[line]
    if (entry) {
      entry.response = text
      entry.ackedAt = this.now
    }
    this.emit(text)
  }

  /** Executes the next step of the current line; false when it has to wait. */
  private step(cur: Current): boolean {
    const s = cur.steps[0]
    if (s === undefined) {
      this.current = undefined
      this.respond(cur.line, 0)
      return true
    }
    if (s.kind === 'move' || s.kind === 'jog') {
      if (s.kind === 'move' && this.outsideSoftLimits(s.target)) {
        this.softLimit()
        return false
      }
      if (this.state === 'Check') {
        cur.steps.shift()
        return true
      }
      if (this.planner.free === 0) return false
      const last = this.planner.blocks[this.planner.blocks.length - 1]
      const start = last ? last.target : this.position()
      const lastOfLine = !cur.steps.slice(1).some((x) => x.kind === 'move' || x.kind === 'jog')
      const added = this.planner.add(start, {
        target: s.target,
        rapid: s.kind === 'move' && s.rapid,
        feed: s.feed,
        jog: s.kind === 'jog',
        line: cur.line,
        lastOfLine,
      })
      cur.steps.shift()
      if (added) {
        if (this.exec) this.replan()
        else this.startMotion()
      }
      return true
    }
    // Every other step synchronizes with the planner first (protocol_buffer_synchronize).
    if (this.planner.blocks.length > 0) return false
    cur.steps.shift()
    const check = this.state === 'Check'
    switch (s.kind) {
      case 'spindle':
        if (!check) this.spindle = { dir: s.dir, rpm: s.rpm }
        return true
      case 'dwell': {
        if (check || s.seconds <= 0) return true
        const entry = this.rec.lines[cur.line]
        if (entry) entry.startedAt = this.now
        this.dwellEndsAt = this.now + s.seconds * 1000
        return false
      }
      case 'setWco':
        this.wco = s.wco
        this.reportWco = 0
        return true
      case 'pause':
        if (!check) {
          this.state = 'Hold'
          this.holdComplete = true
        }
        return true
      case 'programEnd':
        if (!check) this.spindle = { dir: 'off', rpm: this.spindle.rpm }
        this.emit('[MSG:Pgm End]')
        return true
    }
  }

  // ── Motion ──────────────────────────────────────────────────────────────────────────────

  private position(): Vec3 {
    const b = this.planner.blocks[0]
    if (!this.exec || !b) return this.mpos
    const { s } = sampleProfile(this.exec.profile, (this.now - this.exec.startedAt) / 1000)
    return add(b.start, b.unit, s)
  }

  /** mm/s. */
  private speed(): number {
    if (!this.exec) return 0
    return sampleProfile(this.exec.profile, (this.now - this.exec.startedAt) / 1000).v
  }

  private startMotion(): void {
    const b = this.planner.blocks[0]
    if (!b || this.state === 'Hold' || this.state === 'Door') return
    if (this.state === 'Idle') this.state = b.jog ? 'Jog' : 'Run'
    this.startBlock(0)
  }

  /** Starts (or re-plans) the executing block from speed `v0` at the current time. */
  private startBlock(v0: number): void {
    const b = this.planner.blocks[0]
    if (!b) return
    b.entrySq = v0 * v0
    this.planner.recalculate()
    const profile = this.stopping
      ? holdProfile(b.length, v0, b.accel)
      : trapezoid(b.length, v0, b.nominal, this.planner.exitSpeed(), b.accel)
    this.exec = { startedAt: this.now, profile }
    const entry = this.rec.lines[b.line]
    if (entry && entry.startedAt === undefined) entry.startedAt = this.now
    this.sample()
  }

  /** Cuts the executing block at the current position and re-plans it (new block, override). */
  private replan(): void {
    const b = this.planner.blocks[0]
    if (!this.exec || !b) return
    const { s, v } = sampleProfile(this.exec.profile, (this.now - this.exec.startedAt) / 1000)
    b.start = add(b.start, b.unit, s)
    b.length = Math.max(0, b.length - s)
    this.startBlock(v)
  }

  private onBlockEnd(): void {
    const exec = this.exec
    const b = this.planner.blocks[0]
    if (!exec || !b) return
    const p = exec.profile
    this.exec = undefined
    if (p.length < b.length - 1e-9) {
      // A hold stopped inside the block; the rest stays planned.
      b.start = add(b.start, b.unit, p.length)
      b.length -= p.length
      this.mpos = b.start
      return this.stopped()
    }
    this.planner.blocks.shift()
    this.mpos = b.target
    const entry = this.rec.lines[b.line]
    if (b.lastOfLine && entry) entry.endedAt = this.now
    if (this.planner.blocks.length > 0 && !(this.stopping && p.exitSpeed <= 1e-9)) {
      this.startBlock(p.exitSpeed)
      return this.run()
    }
    this.sample()
    if (this.stopping) return this.stopped()
    if (this.state === 'Jog') this.parser = { ...this.parser, position: this.mpos }
    if (this.state === 'Run' || this.state === 'Jog') this.state = 'Idle'
    this.run()
  }

  /** Begins a controlled stop (feed hold, jog cancel, soft limit, door). */
  private beginStop(reason: Stop): void {
    this.stopping = reason
    this.holdComplete = false
    const b = this.planner.blocks[0]
    if (!this.exec || !b) return this.stopped()
    const { s, v } = sampleProfile(this.exec.profile, (this.now - this.exec.startedAt) / 1000)
    b.start = add(b.start, b.unit, s)
    b.length = Math.max(0, b.length - s)
    if (v <= 1e-9) {
      this.exec = undefined
      this.mpos = b.start
      return this.stopped()
    }
    this.exec = { startedAt: this.now, profile: holdProfile(b.length, v, b.accel) }
  }

  private stopped(): void {
    const reason = this.stopping
    this.stopping = undefined
    this.holdComplete = true
    const jog = this.planner.blocks[0]?.jog === true
    if (reason === 'jogCancel' || (reason === 'door' && jog)) {
      this.planner.clear()
      this.parser = { ...this.parser, position: this.mpos }
    }
    if (reason === 'jogCancel') this.state = 'Idle'
    if (reason === 'door') this.spindleSuspended = true
    this.sample()
    if (reason === 'softLimit') return this.criticalAlarm(2)
    this.run()
  }

  private outsideSoftLimits(t: Vec3): boolean {
    if (!this.settings.get(20)) return false
    const travel = [this.settings.get(130), this.settings.get(131), this.settings.get(132)]
    return t.some((v, i) => v > 1e-6 || v < -(travel[i] ?? 0) - 1e-6)
  }

  private softLimit(): void {
    this.current = undefined
    if (this.exec) {
      this.state = 'Hold'
      this.beginStop('softLimit')
    } else this.criticalAlarm(2)
  }

  /** mc_reset() + a critical alarm: everything stops, only a reset continues. */
  private criticalAlarm(code: number): void {
    this.mpos = this.position()
    this.exec = undefined
    this.planner.clear()
    this.current = undefined
    this.spindle = { dir: 'off', rpm: this.spindle.rpm }
    this.state = 'Alarm'
    this.critical = true
    this.emit(`ALARM:${code}`)
    this.emit('[MSG:Reset to continue]')
  }

  // ── Events ──────────────────────────────────────────────────────────────────────────────

  private handleEvent(): void {
    const t = this.now
    if (this.exec && this.exec.startedAt + this.exec.profile.duration * 1000 <= t) {
      return this.onBlockEnd()
    }
    if (this.dwellEndsAt !== undefined && this.dwellEndsAt <= t) {
      this.dwellEndsAt = undefined
      const entry = this.current && this.rec.lines[this.current.line]
      if (entry) entry.endedAt = t
      return this.run()
    }
    if (this.homingEndsAt !== undefined && this.homingEndsAt <= t) {
      this.homingEndsAt = undefined
      this.mpos = zero
      this.parser = { ...this.parser, position: zero }
      this.state = 'Idle'
      this.sample()
      return this.run()
    }
    if (this.restoreEndsAt !== undefined && this.restoreEndsAt <= t) {
      this.restoreEndsAt = undefined
      this.resume()
    }
  }

  // ── Realtime commands ───────────────────────────────────────────────────────────────────

  private feedHold(): void {
    if (this.critical || this.stopping) return
    if (this.state === 'Run') {
      this.state = 'Hold'
      this.beginStop('hold')
    } else if (this.state === 'Jog') this.beginStop('jogCancel')
    else if (this.state === 'Idle') {
      this.pauseDwell()
      this.state = 'Hold'
      this.holdComplete = true
    }
  }

  private pauseDwell(): void {
    if (this.dwellEndsAt === undefined) return
    this.dwellRemaining = this.dwellEndsAt - this.now
    this.dwellEndsAt = undefined
  }

  private cycleStart(): void {
    if (this.critical || this.stopping) return
    if (this.state === 'Hold' && this.holdComplete) {
      if (this.spindleStopOverride) this.restoreSpindle()
      this.resume()
    } else if (
      this.state === 'Door' &&
      this.holdComplete &&
      !this.doorAjar &&
      this.restoreEndsAt === undefined
    ) {
      this.spindleSuspended = false
      if (this.spindle.dir !== 'off') this.restoreEndsAt = this.now + DOOR_SPINDLE_DELAY
      else this.resume()
    }
  }

  private resume(): void {
    this.holdComplete = false
    this.spindleSuspended = false
    if (this.dwellRemaining !== undefined) {
      this.dwellEndsAt = this.now + this.dwellRemaining
      this.dwellRemaining = undefined
    }
    const b = this.planner.blocks[0]
    if (b) {
      this.state = b.jog ? 'Jog' : 'Run'
      this.startBlock(0)
    } else this.state = 'Idle'
    this.run()
  }

  private restoreSpindle(): void {
    this.spindleStopOverride = false
    if (this.spindle.dir !== 'off') this.emit('[MSG:Restoring spindle]')
  }

  private door(): void {
    if (this.critical || this.stopping === 'softLimit') return
    if (['Alarm', 'Check', 'Home'].includes(this.state)) return
    this.emit('[MSG:Check Door]')
    this.doorAjar = true
    if (this.restoreEndsAt !== undefined) {
      this.restoreEndsAt = undefined
      this.spindleSuspended = true
      return
    }
    if (this.state === 'Door') return
    const moving = this.exec !== undefined
    this.state = 'Door'
    if (moving) {
      this.beginStop('door')
    } else {
      this.pauseDwell()
      this.stopping = 'door'
      this.stopped()
    }
  }

  private extended(b: number): void {
    const clamp = (v: number) => Math.min(200, Math.max(10, v))
    const before = { ...this.ov }
    switch (b) {
      case 0x84:
        return this.door()
      case 0x85:
        if (this.state === 'Jog' && !this.stopping) this.beginStop('jogCancel')
        return
      case 0x90:
        this.ov.feed = 100
        break
      case 0x91:
        this.ov.feed = clamp(this.ov.feed + 10)
        break
      case 0x92:
        this.ov.feed = clamp(this.ov.feed - 10)
        break
      case 0x93:
        this.ov.feed = clamp(this.ov.feed + 1)
        break
      case 0x94:
        this.ov.feed = clamp(this.ov.feed - 1)
        break
      case 0x95:
        this.ov.rapid = 100
        break
      case 0x96:
        this.ov.rapid = 50
        break
      case 0x97:
        this.ov.rapid = 25
        break
      case 0x99:
        this.ov.spindle = 100
        break
      case 0x9a:
        this.ov.spindle = clamp(this.ov.spindle + 10)
        break
      case 0x9b:
        this.ov.spindle = clamp(this.ov.spindle - 10)
        break
      case 0x9c:
        this.ov.spindle = clamp(this.ov.spindle + 1)
        break
      case 0x9d:
        this.ov.spindle = clamp(this.ov.spindle - 1)
        break
      case 0x9e:
        if (this.state === 'Hold' && this.holdComplete) {
          if (this.spindleStopOverride) this.restoreSpindle()
          else if (this.spindle.dir !== 'off') this.spindleStopOverride = true
        }
        return
      default:
        return // unknown extended byte: dropped, like GRBL
    }
    if (before.feed !== this.ov.feed || before.rapid !== this.ov.rapid) {
      this.planner.overrides = { feed: this.ov.feed, rapid: this.ov.rapid }
      if (this.exec && !this.stopping) this.replan()
      else this.planner.recalculate()
    }
    if (
      before.feed !== this.ov.feed ||
      before.rapid !== this.ov.rapid ||
      before.spindle !== this.ov.spindle
    ) {
      this.reportOv = 0
    }
  }

  /** Soft reset (ctrl-x): ALARM:3 if moving (ALARM:6 while homing), then the banner. */
  private reset(): void {
    const moving = this.exec !== undefined || this.state === 'Home'
    if (this.critical) this.critical = false
    else if (moving) {
      this.emit(`ALARM:${this.state === 'Home' ? 6 : 3}`)
      this.state = 'Alarm'
    }
    this.mpos = this.position()
    this.exec = undefined
    this.planner.clear()
    this.stopping = undefined
    this.holdComplete = false
    this.current = undefined
    this.rx.length = 0
    this.rxMidLine = false
    this.lineChars = this.lineRaw = ''
    this.lineRawLength = 0
    this.lineComment = this.lineSemicolon = this.lineOverflow = false
    this.dwellEndsAt = this.dwellRemaining = this.homingEndsAt = this.restoreEndsAt = undefined
    this.doorAjar = false
    this.spindle = { dir: 'off', rpm: 0 }
    this.spindleSuspended = this.spindleStopOverride = false
    this.ov = { feed: 100, rapid: 100, spindle: 100 }
    this.planner.overrides = { feed: 100, rapid: 100 }
    this.reportWco = this.reportOv = 0
    this.parser = initialParserState(this.mpos, this.wco)
    if (this.state !== 'Alarm') this.state = 'Idle'
    this.banner()
    this.sample()
  }

  private banner(): void {
    this.output.push('\r\n')
    this.emit(BANNER)
    if (this.state === 'Alarm') this.emit("[MSG:'$H'|'$X' to unlock]")
  }

  // ── `$` commands ────────────────────────────────────────────────────────────────────────

  private system(line: number, text: string): void {
    const respond = (status: StatusCode | 0) => this.respond(line, status)
    const idleOrAlarm = this.state === 'Idle' || this.state === 'Alarm'
    if (text === '$') {
      this.emit(HELP)
      return respond(0)
    }
    const c = text[1]
    if (c === 'J') {
      if (this.state !== 'Idle' && this.state !== 'Jog') return respond(STATUS.idleError)
      if (text[2] !== '=') return respond(STATUS.invalidStatement)
      return this.jog(line, text.slice(3))
    }
    if (c === '$' || c === 'G' || c === 'C' || c === 'X') {
      if (text.length !== 2) return respond(STATUS.invalidStatement)
      if (c === '$') {
        if (this.state === 'Run' || this.state === 'Hold') return respond(STATUS.idleError)
        for (const l of this.settings.report()) this.emit(l)
      } else if (c === 'G') this.emit(this.modesReport())
      else if (c === 'C') {
        if (this.state === 'Check') {
          this.emit('[MSG:Disabled]')
          respond(0)
          return this.reset()
        }
        if (this.state !== 'Idle') return respond(STATUS.idleError)
        this.state = 'Check'
        this.emit('[MSG:Enabled]')
      } else if (this.state === 'Alarm') {
        this.emit('[MSG:Caution: Unlocked]')
        this.state = 'Idle'
      }
      return respond(0)
    }
    if (!idleOrAlarm) return respond(STATUS.idleError)
    if (c === '#') {
      if (text.length !== 2) return respond(STATUS.invalidStatement)
      for (const l of this.parametersReport()) this.emit(l)
      return respond(0)
    }
    if (c === 'H') {
      if (!this.settings.get(22)) return respond(STATUS.settingDisabled)
      if (text.length !== 2) return respond(STATUS.invalidStatement)
      return this.home(line)
    }
    if (c === 'I') {
      if (text.length !== 2) return respond(STATUS.invalidStatement)
      this.emit(VERSION)
      this.emit(OPTIONS)
      return respond(0)
    }
    if (c === 'S' || c === 'R' || c === 'N') return respond(STATUS.invalidStatement) // not emulated
    const m = /^\$([+-]?(?:\d+\.?\d*|\.\d+))(.*)$/.exec(text)
    if (!m) return respond(STATUS.badNumberFormat)
    const rest = m[2] ?? ''
    if (!rest.startsWith('=')) return respond(STATUS.invalidStatement)
    const v = /^=([+-]?(?:\d+\.?\d*|\.\d+))(.*)$/.exec(rest)
    if (!v) return respond(STATUS.badNumberFormat)
    const id = Number(m[1])
    if ((v[2] ?? '') !== '' || id > 255) return respond(STATUS.invalidStatement)
    const status = this.settings.store(Math.trunc(id), Number(v[1]))
    if (status === 0 && Math.trunc(id) === 10) this.reportWco = 0
    return respond(status)
  }

  private jog(line: number, text: string): void {
    const parsed = parseBlock(text, this.parser, {
      arcTolerance: this.settings.get(12),
      jog: true,
    })
    if (parsed.isErr()) return this.respond(line, parsed.unwrapErr())
    const { jog } = parsed.unwrap()
    if (!jog) return this.respond(line, STATUS.invalidJogCommand)
    if (this.settings.get(20) && this.outsideSoftLimits(jog.target)) {
      return this.respond(line, STATUS.travelExceeded)
    }
    this.parser = { ...this.parser, position: jog.target }
    this.current = { steps: [{ kind: 'jog', target: jog.target, feed: jog.feed }], line }
  }

  /** `$H`: Z cycle, then XY, each seeking at `$25` plus locate and pull-off at `$24`/`$27`. */
  private home(line: number): void {
    const p = this.position()
    const seek = this.settings.get(25)
    const locate = (2 * this.settings.get(27)) / Math.max(this.settings.get(24), 1e-6)
    const minutes =
      Math.abs(p[2]) / seek + locate + Math.max(Math.abs(p[0]), Math.abs(p[1])) / seek + locate
    this.state = 'Home'
    this.homingEndsAt = this.now + minutes * 60_000
    this.current = { steps: [], line }
  }

  // ── Reports ─────────────────────────────────────────────────────────────────────────────

  private stateString(): string {
    switch (this.state) {
      case 'Hold':
        return `Hold:${this.holdComplete ? 0 : 1}`
      case 'Door':
        if (this.restoreEndsAt !== undefined) return 'Door:3'
        if (!this.holdComplete) return 'Door:2'
        return this.doorAjar ? 'Door:1' : 'Door:0'
      default:
        return this.state
    }
  }

  private inches(): boolean {
    return this.settings.get(13) !== 0
  }

  private coords(v: Vec3): string {
    return v.map((x) => (this.inches() ? fixed(x / MM_PER_INCH, 4) : fixed(x, 3))).join(',')
  }

  private rateText(mmPerMin: number): string {
    return this.inches() ? fixed(mmPerMin / MM_PER_INCH, 1) : fixed(mmPerMin, 0)
  }

  private spindleOn(): boolean {
    return this.spindle.dir !== 'off' && !this.spindleSuspended && !this.spindleStopOverride
  }

  /** sys.spindle_speed: programmed rpm × override, clamped to `$31…$30`; 0 when off. */
  private spindleRpm(): number {
    if (!this.spindleOn()) return 0
    const rpm = (this.spindle.rpm * this.ov.spindle) / 100
    const max = this.settings.get(30)
    const min = this.settings.get(31)
    if (min >= max || rpm >= max) return max
    if (rpm <= min) return rpm === 0 ? 0 : min
    return rpm
  }

  private statusReport(): void {
    if (this.critical) return
    const mask = this.settings.get(10)
    const pos = this.position()
    const busy = ['Home', 'Run', 'Hold', 'Jog', 'Door'].includes(this.state)
    const parts = [this.stateString()]
    if (mask & 1) parts.push(`MPos:${this.coords(pos)}`)
    else {
      const w = this.wco
      parts.push(`WPos:${this.coords([pos[0] - w[0], pos[1] - w[1], pos[2] - w[2]])}`)
    }
    if (mask & 2) parts.push(`Bf:${this.planner.free},${RX_BUFFER_SIZE - this.rx.length}`)
    parts.push(`FS:${this.rateText(this.speed() * 60)},${fixed(this.spindleRpm(), 0)}`)
    if (this.reportWco > 0) this.reportWco--
    else {
      this.reportWco = busy ? 29 : 9
      if (this.reportOv === 0) this.reportOv = 1
      parts.push(`WCO:${this.coords(this.wco)}`)
    }
    if (this.reportOv > 0) this.reportOv--
    else {
      this.reportOv = busy ? 19 : 9
      parts.push(`Ov:${this.ov.feed},${this.ov.rapid},${this.ov.spindle}`)
      if (this.spindleOn()) parts.push(`A:${this.spindle.dir === 'cw' ? 'S' : 'C'}`)
    }
    this.emit(`<${parts.join('|')}>`)
  }

  private modesReport(): string {
    const p = this.parser
    const m = p.spindle === 'cw' ? 3 : p.spindle === 'ccw' ? 4 : 5
    return (
      `[GC:G${p.motion} G54 G17 G${p.metric ? 21 : 20} G${p.absolute ? 90 : 91} G94 M${m} M9` +
      ` T${p.tool} F${this.rateText(p.feed)} S${fixed(p.spindleSpeed, 0)}]`
    )
  }

  private parametersReport(): string[] {
    const z = this.coords(zero)
    const lines = [`[G54:${this.coords(this.wco)}]`]
    for (const g of ['G55', 'G56', 'G57', 'G58', 'G59', 'G28', 'G30', 'G92'])
      lines.push(`[${g}:${z}]`)
    lines.push(`[TLO:${this.inches() ? '0.0000' : '0.000'}]`, `[PRB:${z}:0]`)
    return lines
  }

  // ── Output and trace ────────────────────────────────────────────────────────────────────

  private emit(text: string): void {
    this.output.push(`${text}\r\n`)
    if (this.tracing) this.rec.responses.push({ t: this.now, text })
  }

  private violation(kind: ViolationKind, detail: string): void {
    this.rec.violations.push({ t: this.now, kind, detail })
  }

  private sample(): void {
    if (!this.tracing) return
    this.rec.samples.push({
      t: this.now,
      mpos: this.position(),
      state: this.stateString(),
      rate: this.speed() * 60,
    })
  }

  private noteState(): void {
    const s = this.stateString()
    if (s === this.lastState) return
    if (this.tracing && this.lastState !== '') {
      this.rec.transitions.push({ t: this.now, from: this.lastState, to: s })
    }
    this.lastState = s
  }
}
