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
import {
  firstChange,
  POINT_TIP,
  probeClosed,
  type ProbeScene,
  type ProbeTarget,
  type ProbeTip,
} from './probe-scene'
import { holdProfile, sampleProfile, trapezoid, type Profile } from './profile'
import { homedPosition, homesNegative, switchAt, travelViolation } from '../envelope'
import { Settings, type SettingValues } from './settings'
import { emptyTrace, type MutableTrace, type Trace, type ViolationKind } from './trace'

/** RX_BUFFER_SIZE: all of it usable (GRBL's ring has RX_BUFFER_SIZE + 1 slots). */
export const RX_BUFFER_SIZE = 128
/** LINE_BUFFER_SIZE. */
export const LINE_BUFFER_SIZE = 80
export const BANNER = "Grbl 1.1h ['$' for help]"
const VERSION = '[VER:1.1h.20190830:]'
const OPTIONS = '[OPT:V,15,128]'
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
  /**
   * MPos at power-up (default 0,0,0): the virtual machine's physical position in the homed frame
   * (docs/architecture/grbl.md#homing-and-machine-coordinates). The app passes the travel centre.
   */
  readonly position?: Vec3
  /**
   * G54 at power-up (default 0,0,0), as GRBL's EEPROM keeps it over a power cycle (DF129: the
   * virtual machine reconnected after a simulated lost connection,
   * docs/modes/run-recovery.md#implementation-rc4).
   */
  readonly workOffset?: Vec3
  /**
   * GRBL-exact homing (default false): no status report while `$H` runs; the `?`s received meanwhile
   * are answered once when the cycle ends. The default reports during homing (DFYOM's deviation,
   * docs/architecture/grbl.md#homing-and-machine-coordinates). `'drop'`: as a GRBL fork that drops
   * the `?`s received during the cycle (never answered, DF87).
   */
  readonly silentHoming?: boolean | 'drop'
  /**
   * As a GRBL fork that prints its banner when `$H` ends, right after the `ok` (DF87 follow-up,
   * docs/architecture/grbl.md#banner): `true` stays Idle with the homed position; `'alarm'` goes to
   * Alarm with it (a controller that really restarted and lost its position).
   */
  readonly bannerAfterHoming?: boolean | 'alarm'
  /**
   * Simulated touch plate: its top in MPos Z (the probe input is closed while the tool tip is at
   * or below it); absent = no plate, a probe finds nothing (docs/architecture/grbl.md#probing).
   */
  readonly probePlate?: number
  /**
   * v0.5 RV3: the probe scene (stock boxes, a corner plate, a hole, a height field); `probePlate`
   * adds its plane to it (docs/architecture/grbl.md#probe-scene-rv3).
   */
  readonly probeScene?: ProbeScene
  /** v0.5 RV3: the probe's tip (default a point: a cylinder of radius 0). */
  readonly probeTip?: ProbeTip
  /**
   * v0.5 RV8: how far each homing may stop from the true switch point, per axis (mm, the full width:
   * each `$H` draws an offset in ±width/2), as a worn switch does; the physical position then
   * differs from the reported one by that offset until the next homing. Absent: exact homing
   * (docs/architecture/grbl.md#homing-scatter-and-lost-steps-rv8).
   */
  readonly homingScatter?: { readonly x?: number; readonly y?: number; readonly z?: number }
  /** v0.5 RV8: the seed of `homingScatter`'s draws (default 1): the same seed, the same offsets. */
  readonly homingSeed?: number
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
  /**
   * The trace index of the line whose block executes (the planner's oldest), while tracing and
   * moving; the truth the executing-line estimate is tested against (DF84).
   */
  readonly executing?: number
}

type Stop = 'hold' | 'jogCancel' | 'softLimit' | 'door' | 'probe'
type Step = Action | { readonly kind: 'jog'; readonly target: Vec3; readonly feed: number }

interface Current {
  readonly steps: readonly Step[]
  /** Next step to execute. */
  next: number
  /** Index of the last motion step (for the line's end time). */
  readonly lastMove: number
  readonly line: number
}

interface Exec {
  readonly startedAt: number
  readonly profile: Profile
}

const zero: Vec3 = [0, 0, 0]

/** A probe cycle in progress (G38.x). */
interface Probing {
  readonly away: boolean
  readonly noError: boolean
  /** Where on the move the input changes (RV3: found in the scene when the probe starts). */
  readonly change: Vec3 | undefined
  /** MPos latched when the input changed (GRBL's sys_probe_position). */
  contact?: Vec3
}

/** Time (s) at which `p` has covered `s` mm (bisection; profiles are monotonic in distance). */
function timeAtDistance(p: Profile, s: number): number {
  if (s <= 0) return 0
  let lo = 0
  let hi = p.duration
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (sampleProfile(p, mid).s < s) lo = mid
    else hi = mid
  }
  return hi
}

/** One move of the homing cycle: each axis from → to at its own duration (ms), together. */
interface HomingMove {
  readonly from: Vec3
  readonly to: Vec3
  /** Per axis, ms (0 for an axis that does not move). */
  readonly ms: Vec3
  readonly startsAt: number
  readonly endsAt: number
}

function current(steps: readonly Step[], line: number): Current {
  let lastMove = -1
  steps.forEach((s, i) => {
    if (s.kind === 'move' || s.kind === 'jog') lastMove = i
  })
  return { steps, next: 0, lastMove, line }
}
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
  /** `silentHoming`: a `?` came during the cycle; answered when it ends. */
  private reportAfterHoming = false
  /** The homing cycle's moves while homing (`$H`), for the position in `Home` reports. */
  private homingPath: readonly HomingMove[] | undefined
  private restoreEndsAt: number | undefined
  /** Door pin open (test hook); `0x84` alone has no pin, so the door counts as closed. */
  private doorAjar = false
  private doorAfterJog = false
  /** Limit pins held closed (DF134 test hook), in `Pn:` order. */
  private readonly limitPins = new Set<'X' | 'Y' | 'Z'>()
  /** RV3: the probe scene (the touch plate is its `plane` target). */
  private scene: ProbeScene
  private tip: ProbeTip
  /** RV3 fault hook: the probe input reads closed whatever touches (a shorted clip or wire). */
  private probeShorted = false
  private probing: Probing | undefined
  /** The last probe, for `$#` (`[PRB:x,y,z:flag]`). */
  private prb: { readonly pos: Vec3; readonly ok: boolean } = { pos: zero, ok: false }
  /** Fault hook: a hung controller answers nothing. */
  private silent = false
  /**
   * v0.5 RV8: physical − reported position (mm): the homing scatter drawn at the last `$H` plus
   * the steps lost since. The probe scene is physical, so probes see it; the reports do not.
   */
  private slip: Vec3 = zero
  private scatter: Vec3 = zero
  private seed = 1

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
    position: Vec3,
    private readonly silentHoming: boolean | 'drop' = false,
    scene: ProbeScene = { targets: [] },
    private readonly bannerAfterHoming: boolean | 'alarm' = false,
    workOffset: Vec3 = zero,
    tip: ProbeTip = POINT_TIP,
  ) {
    this.scene = scene
    this.tip = tip
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
    this.mpos = position
    this.wco = workOffset
    this.parser = initialParserState(position, workOffset)
    this.state = s.get(22) ? 'Alarm' : 'Idle'
    this.banner()
    this.noteState()
  }

  static create(options: EmulatorOptions = {}): AppResult<GrblEmulator> {
    return Settings.create(options.settings ?? {}, options.homing ?? true).andThen((s) =>
      Ok(
        new GrblEmulator(
          s,
          options.trace ?? true,
          options.position ?? zero,
          options.silentHoming ?? false,
          options.probePlate === undefined
            ? (options.probeScene ?? { targets: [] })
            : withPlane(options.probeScene ?? { targets: [] }, options.probePlate),
          options.bannerAfterHoming ?? false,
          options.workOffset ?? zero,
          options.probeTip ?? POINT_TIP,
        ),
      ).map((e) => {
        const w = options.homingScatter
        e.scatter = [w?.x ?? 0, w?.y ?? 0, w?.z ?? 0]
        e.seed = (options.homingSeed ?? 1) >>> 0 || 1
        return e
      }),
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
    if (this.silent) return
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
    take(this.probeContactAt())
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
      ...(this.planner.blocks[0] === undefined || this.planner.blocks[0].line < 0
        ? {}
        : { executing: this.planner.blocks[0].line }),
    }
  }

  /**
   * Test hook for a door switch (GRBL's safety-door pin): opening triggers the door like
   * `0x84` and keeps it in Door:1 once stopped; closing allows `~` to resume (Door:0).
   */
  setDoorPin(open: boolean): void {
    this.doorAjar = open
    if (open) this.door()
    this.noteState()
  }

  /**
   * Test hook for GRBL's feed-hold and cycle-start pins (a machine's hardware buttons, DF82): the
   * same as the real-time `!` / `~` bytes, but from the controller side, so the sender never sent
   * them (docs/architecture/grbl.md#fault-injection).
   */
  pressButton(button: 'feedHold' | 'cycleStart'): void {
    if (this.silent) return
    if (button === 'feedHold') this.feedHold()
    else this.cycleStart()
    this.noteState()
  }

  /**
   * Test hook: lays the touch plate with its top at MPos Z `z`, or removes it (`undefined`: a probe
   * then finds nothing). Takes effect for the next probe cycle (docs/architecture/grbl.md#probing).
   */
  setProbePlate(z: number | undefined): void {
    this.scene = withPlane(this.scene, z)
  }

  /**
   * RV3 test hook: replaces the probe scene (the plate's plane with it), or empties it; takes
   * effect for the next probe cycle (docs/architecture/grbl.md#probe-scene-rv3).
   */
  setProbeScene(scene: ProbeScene | undefined): void {
    this.scene = scene ?? { targets: [] }
  }

  /**
   * v0.5 RV8 fault hook: the `axis` motor loses `mm` of steps (a stall, a loose pulley): the
   * machine is physically that far off from what it reports, until the next homing finds the
   * switch again.
   */
  loseSteps(axis: 'x' | 'y' | 'z', mm: number): void {
    const i = axis === 'x' ? 0 : axis === 'y' ? 1 : 2
    const s: [number, number, number] = [...this.slip]
    s[i] += mm
    this.slip = s
  }

  /** v0.5 RV8 test hook: physical − reported position now (mm): the scatter and lost steps. */
  get physicalOffset(): Vec3 {
    return this.slip
  }

  /** RV3 test hook: the probe's tip (the bit as a cylinder, a 3D probe's ball). */
  setProbeTip(tip: ProbeTip): void {
    this.tip = tip
  }

  /**
   * RV3 fault hook: the probe input reads closed whatever the scene says (the clip lying on the
   * plate, a shorted wire): `Pn:P`, a toward probe is `ALARM:4`, an away probe never opens.
   */
  setProbeShorted(shorted: boolean): void {
    this.probeShorted = shorted
  }

  /**
   * RV3 test hook: whether the probe touches now (the contact readout of a touch-off by hand,
   * which a real operator feels), as `Pn:P` reports it.
   */
  probeTouching(): boolean {
    return this.probeClosed(this.position())
  }

  /**
   * Fault hook: a limit switch closes (GRBL's limit pin interrupt): motion stops at once,
   * `ALARM:1`, critical until a reset; the position counts as lost
   * (docs/architecture/grbl.md#fault-injection).
   */
  triggerHardLimit(): void {
    if (this.critical || this.silent) return
    this.stopping = undefined
    this.holdComplete = false
    this.probing = undefined
    this.dwellEndsAt = this.dwellRemaining = this.homingEndsAt = this.restoreEndsAt = undefined
    if (this.homingPath !== undefined) this.mpos = this.position()
    this.homingPath = undefined
    this.criticalAlarm(1)
    this.sample()
    this.noteState()
  }

  /**
   * Fault hook (DF134): a limit switch is pressed (`true`) or released. GRBL's limit pins raise an
   * interrupt on every change: with hard limits on (`$21=1`) a change outside Alarm (and outside a
   * homing cycle, which uses the switches) is a hard limit as `triggerHardLimit()`; in Alarm GRBL
   * ignores it, so a switch released after the alarm (or before the reset) raises nothing. A
   * pressed pin shows in status reports as `Pn:X`/`Y`/`Z`
   * (docs/architecture/grbl.md#fault-injection).
   */
  setLimitPin(axis: 'x' | 'y' | 'z', pressed: boolean): void {
    const pin = axis.toUpperCase() as 'X' | 'Y' | 'Z'
    if (this.limitPins.has(pin) === pressed) return
    if (pressed) this.limitPins.add(pin)
    else this.limitPins.delete(pin)
    if (this.settings.get(21) && this.state !== 'Alarm' && this.state !== 'Home')
      this.triggerHardLimit()
  }

  /**
   * Fault hook (DF129): the controller restarts as from power-up (a board reset by DTR when its
   * port opens, or powered again): motion, spindle, coolant, overrides and the parser's modal
   * state are gone, no `ALARM:3`; the banner, and with `$22=1` the start-up lock. G54 stays (GRBL's
   * EEPROM). The position stays where the machine physically is (the emulator's MPos is its
   * physical position; DFYOM never trusts it before homing). Doc: docs/architecture/grbl.md#fault-injection
   */
  powerCycle(): void {
    this.silent = false
    this.reset(true)
    this.noteState()
  }

  /** Fault hook: a hung controller (true): bytes are dropped and nothing is answered. */
  setSilent(silent: boolean): void {
    this.silent = silent
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
    if (this.rx.length >= RX_BUFFER_SIZE) {
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
      (this.stopping !== undefined && this.stopping !== 'hold') ||
      (this.state === 'Hold' && this.holdComplete) ||
      this.state === 'Door' ||
      this.state === 'Home' ||
      this.dwellEndsAt !== undefined ||
      this.probing !== undefined
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
    const index = this.tracing ? this.rec.lines.length : -1
    if (this.lineRawLength > LINE_BUFFER_SIZE) this.violation('lineTooLong', this.lineRaw)
    if (this.tracing) this.rec.lines.push({ text: this.lineRaw, receivedAt: this.now })
    this.lineChars = ''
    this.lineRaw = ''
    this.lineRawLength = 0
    this.lineComment = this.lineSemicolon = this.lineOverflow = false
    if (overflow) return this.respond(index, STATUS.overflow)
    if (text === '') return this.respond(index, 0)
    if (text.startsWith('$')) return this.system(index, text)
    if (this.state === 'Alarm' || this.state === 'Jog')
      return this.respond(index, STATUS.systemGcLock)
    const parsed = parseBlock(text, this.parser, { arcTolerance: this.settings.get(12) })
    if (parsed.isErr()) return this.respond(index, parsed.unwrapErr())
    const block = parsed.unwrap()
    this.parser = block.state
    this.current = current(block.actions, index)
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
    const s = cur.steps[cur.next]
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
        cur.next++
        return true
      }
      if (this.planner.free === 0) return false
      const last = this.planner.blocks[this.planner.blocks.length - 1]
      const start = last ? last.target : this.position()
      const lastOfLine = cur.next === cur.lastMove
      const added = this.planner.add(start, {
        target: s.target,
        rapid: s.kind === 'move' && s.rapid,
        feed: s.feed,
        jog: s.kind === 'jog',
        line: cur.line,
        lastOfLine,
      })
      cur.next++
      if (added) {
        if (this.exec) this.replan()
        else this.startMotion()
      }
      return true
    }
    // Every other step synchronizes with the planner first (protocol_buffer_synchronize).
    if (this.planner.blocks.length > 0) return false
    cur.next++
    const check = this.state === 'Check'
    switch (s.kind) {
      case 'spindle':
        if (!check) {
          // GRBL's spindle_set_state(): reported at once (`Ov` and `A:`, report_ovr_counter = 0)
          this.reportOv = 0
          this.spindle = { dir: s.dir, rpm: s.rpm }
        }
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
      case 'probe':
        return check ? true : this.startProbe(s, cur.line)
      case 'programEnd':
        if (!check) {
          this.spindle = { dir: 'off', rpm: this.spindle.rpm }
          this.restoreOverrides()
        }
        this.emit('[MSG:Pgm End]')
        return true
    }
  }

  // ── Motion ──────────────────────────────────────────────────────────────────────────────

  /** RV8: one homing's offsets, uniform in ±scatter/2 per axis (mulberry32, seeded). */
  private drawScatter(): Vec3 {
    const next = () => {
      this.seed = (this.seed + 0x6d2b79f5) >>> 0
      let t = this.seed
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const d = (w: number) => (w > 0 ? (next() - 0.5) * w : 0)
    return [d(this.scatter[0]), d(this.scatter[1]), d(this.scatter[2])]
  }

  private position(): Vec3 {
    if (this.homingPath !== undefined) return this.homingPosition(this.homingPath)
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
    if (this.probing !== undefined) {
      // the probe move ended without the input changing
      this.state = 'Idle'
      return this.finishProbe(false)
    }
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
    if (reason === 'jogCancel') {
      this.state = this.doorAfterJog ? 'Door' : 'Idle'
      if (this.doorAfterJog) this.spindleSuspended = true
      this.doorAfterJog = false
    }
    if (reason === 'door') this.spindleSuspended = true
    this.sample()
    if (reason === 'softLimit') return this.criticalAlarm(2)
    if (reason === 'probe') {
      this.planner.clear()
      this.holdComplete = false
      this.state = 'Idle'
      return this.finishProbe(true)
    }
    this.run()
  }

  // ── Probing ─────────────────────────────────────────────────────────────────────────────

  /** Probe input: the probe touches a target of the scene (or the input is shorted). */
  private probeClosed(at: Vec3): boolean {
    return this.probeShorted || probeClosed(this.scene, this.tip, shift(at, this.slip, 1))
  }

  /**
   * mc_probe_cycle(): the planner is empty here. The input must start open (toward) or closed
   * (away), else `ALARM:4`; then one move at the feed, watched for the input to change.
   * Returns false while the cycle runs (the line's `ok` comes after it).
   */
  private startProbe(s: Extract<Action, { kind: 'probe' }>, line: number): boolean {
    if (this.probeClosed(this.mpos) !== s.away) {
      this.alarm(4)
      return true
    }
    if (this.outsideSoftLimits(s.target)) {
      this.softLimit()
      return false
    }
    // the scene is fixed during the cycle: where the input changes is known from the start
    const change = this.probeShorted
      ? undefined
      : physicalChange(this.scene, this.tip, this.mpos, s.target, !s.away, this.slip)
    this.probing = { away: s.away, noError: s.noError, change }
    const added = this.planner.add(this.mpos, {
      target: s.target,
      rapid: false,
      feed: s.feed,
      jog: false,
      line,
      lastOfLine: true,
    })
    if (!added) {
      this.finishProbe(false)
      return true
    }
    this.startMotion()
    return false
  }

  /** When the probe input changes on the executing move, if it does (ms). */
  private probeContactAt(): number | undefined {
    const p = this.probing
    const b = this.planner.blocks[0]
    const e = this.exec
    if (p === undefined || p.contact !== undefined || p.change === undefined || !b || !e)
      return undefined
    // the distance to the change along the executing (possibly re-planned) block
    const c = p.change
    const s =
      (c[0] - b.start[0]) * b.unit[0] +
      (c[1] - b.start[1]) * b.unit[1] +
      (c[2] - b.start[2]) * b.unit[2]
    if (s > e.profile.length + 1e-12) return undefined
    return e.startedAt + timeAtDistance(e.profile, Math.max(0, s)) * 1000
  }

  /** The input changed: latch the position and stop like a motion cancel (decelerate). */
  private probeContact(): void {
    const p = this.probing
    if (p === undefined) return
    p.contact = p.change ?? this.position()
    this.beginStop('probe')
  }

  /** End of a probe cycle: sync the parser, `ALARM:5` on a miss (G38.2/G38.4), `[PRB]`, then the `ok`. */
  private finishProbe(found: boolean): void {
    const p = this.probing
    this.probing = undefined
    if (p === undefined) return
    this.parser = { ...this.parser, position: this.mpos }
    const pos = found && p.contact !== undefined ? p.contact : this.mpos
    if (!found && !p.noError) this.alarm(5)
    this.prb = { pos, ok: found }
    this.emit(`[PRB:${this.coords(pos)}:${found ? 1 : 0}]`)
    this.run()
  }

  /** A non-critical alarm (probe fail): Alarm state, `$X`/`$H` clear it. */
  private alarm(code: number): void {
    this.state = 'Alarm'
    this.emit(`ALARM:${code}`)
  }

  private outsideSoftLimits(t: Vec3): boolean {
    if (!this.settings.get(20)) return false
    return travelViolation(this.travel(), t) !== undefined
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
    const contact = this.probeContactAt()
    if (contact !== undefined && contact <= t) return this.probeContact()
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
      this.homingPath = undefined
      this.mpos = homedPosition({
        travel: this.travel(),
        homingMask: this.settings.get(23),
        pullOff: this.settings.get(27),
      })
      // RV8: homing finds the switch again (lost steps gone), within the switch's scatter
      this.slip = this.drawScatter()
      this.parser = { ...this.parser, position: this.mpos }
      this.state = 'Idle'
      this.sample()
      if (this.reportAfterHoming) {
        this.reportAfterHoming = false
        this.statusReport()
      }
      this.run()
      if (this.bannerAfterHoming !== false) {
        if (this.bannerAfterHoming === 'alarm') this.state = 'Alarm'
        this.banner()
        this.noteState()
      }
      return
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

  private restoreOverrides(): void {
    this.ov = { feed: 100, rapid: 100, spindle: 100 }
    this.planner.overrides = { feed: 100, rapid: 100 }
    this.planner.recalculate()
    this.reportOv = 0
  }

  private restoreSpindle(): void {
    this.spindleStopOverride = false
    if (this.spindle.dir !== 'off') this.emit('[MSG:Restoring spindle]')
  }

  private door(): void {
    if (this.critical || this.stopping === 'softLimit') return
    if (['Alarm', 'Check', 'Home'].includes(this.state)) return
    this.emit('[MSG:Check Door]')
    if (this.state === 'Jog') {
      // GRBL blocks the door until the jog cancel completes, then enters Door.
      this.doorAfterJog = true
      if (!this.stopping) this.beginStop('jogCancel')
      return
    }
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

  /**
   * Soft reset (ctrl-x): ALARM:3 if moving (ALARM:6 while homing), then the banner. `powerUp`
   * (`powerCycle`): no alarm message, the state as at power-up (`$22`).
   */
  private reset(powerUp = false): void {
    const moving = this.exec !== undefined || this.state === 'Home'
    if (powerUp) {
      this.critical = false
      this.state = this.settings.get(22) ? 'Alarm' : 'Idle'
    } else if (this.critical) this.critical = false
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
    this.homingPath = undefined
    this.reportAfterHoming = false
    this.doorAfterJog = false
    this.probing = undefined
    this.spindle = { dir: 'off', rpm: 0 }
    this.spindleSuspended = this.spindleStopOverride = false
    this.restoreOverrides()
    this.reportWco = this.reportOv = 0
    this.parser = initialParserState(this.mpos, this.wco)
    if (this.state !== 'Alarm') this.state = 'Idle'
    this.banner()
    this.sample()
  }

  private banner(): void {
    // GRBL 1.1 protocol_main_loop() with CHECK_LIMITS_AT_INIT (default): a limit pin still
    // pressed with hard limits on locks the controller (DF134)
    const checkLimits = this.settings.get(21) !== 0 && this.limitPins.size > 0
    if (checkLimits) this.state = 'Alarm'
    if (this.silent) return
    this.output.push('\r\n')
    this.emit(BANNER)
    if (checkLimits) this.emit('[MSG:Check Limits]')
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
        // GRBL refuses to unlock while the safety door is open (STATUS_CHECK_DOOR)
        if (this.doorAjar) return respond(STATUS.checkDoor)
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
      if (this.doorAjar) return respond(STATUS.checkDoor)
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
    this.current = current([{ kind: 'jog', target: jog.target, feed: jog.feed }], line)
  }

  /**
   * `$H` as GRBL limits_go_home(): a Z cycle, then X and Y together; each approaches its switch at
   * `$25`, pulls off `$27` at `$25`, locates at `$24` and pulls off again at `$25`
   * (docs/architecture/grbl.md#homing-and-machine-coordinates).
   */
  private home(line: number): void {
    const e = { travel: this.travel(), homingMask: this.settings.get(23) }
    const pull = this.settings.get(27)
    const seek = Math.max(this.settings.get(25), 1e-6)
    const feed = Math.max(this.settings.get(24), 1e-6)
    const moves: HomingMove[] = []
    let at = this.position()
    let t = this.now
    const move = (axes: readonly number[], target: (i: number) => number, rate: number) => {
      const to = [...at] as [number, number, number]
      const ms: [number, number, number] = [0, 0, 0]
      for (const i of axes) {
        to[i] = target(i)
        ms[i] = (Math.abs(to[i] - at[i]!) / rate) * 60_000
      }
      const d = Math.max(...ms)
      moves.push({ from: at, to, ms, startsAt: t, endsAt: t + d })
      at = to
      t += d
    }
    const off = (i: number) => switchAt(e, i) + (homesNegative(e.homingMask, i) ? pull : -pull)
    for (const axes of [[2], [0, 1]]) {
      move(axes, (i) => switchAt(e, i), seek)
      move(axes, off, seek)
      move(axes, (i) => switchAt(e, i), feed)
      move(axes, off, seek)
    }
    this.state = 'Home'
    this.homingPath = moves
    this.homingEndsAt = t
    this.current = current([], line)
  }

  private homingPosition(path: readonly HomingMove[]): Vec3 {
    const m = path.find((x) => this.now < x.endsAt) ?? path[path.length - 1]
    if (m === undefined) return this.mpos
    const dt = Math.max(0, this.now - m.startsAt)
    const axis = (i: number) => {
      const ms = m.ms[i]!
      const f = ms <= 0 ? 1 : Math.min(1, dt / ms)
      return m.from[i]! + (m.to[i]! - m.from[i]!) * f
    }
    return [axis(0), axis(1), axis(2)]
  }

  private travel(): Vec3 {
    return [this.settings.get(130), this.settings.get(131), this.settings.get(132)]
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
    if (this.silentHoming !== false && this.state === 'Home') {
      if (this.silentHoming === true) this.reportAfterHoming = true
      return
    }
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
    // GRBL 1.1 report_realtime_status(): `Pn:` after `FS` (probe, limits, then the control pins)
    const probe = this.probeClosed(pos) ? 'P' : ''
    const pins = `${probe}${[...this.limitPins].sort().join('')}${this.doorAjar ? 'D' : ''}`
    if (pins !== '') parts.push(`Pn:${pins}`)
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
    lines.push(
      `[TLO:${this.inches() ? '0.0000' : '0.000'}]`,
      `[PRB:${this.coords(this.prb.pos)}:${this.prb.ok ? 1 : 0}]`,
    )
    return lines
  }

  // ── Output and trace ────────────────────────────────────────────────────────────────────

  private emit(text: string): void {
    if (this.silent) return
    this.output.push(`${text}\r\n`)
    if (this.tracing) this.rec.responses.push({ t: this.now, text })
  }

  private violation(kind: ViolationKind, detail: string): void {
    if (!this.tracing) return
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

/** The scene with its `plane` target (the M4 touch plate) at `z`, or without one. */
function withPlane(scene: ProbeScene, z: number | undefined): ProbeScene {
  const rest: ProbeTarget[] = scene.targets.filter((t) => t.kind !== 'plane')
  return { targets: z === undefined ? rest : [{ kind: 'plane', z }, ...rest] }
}

/** `v` + sign × `d` per axis. */
function shift(v: Vec3, d: Vec3, sign: 1 | -1): Vec3 {
  return [v[0] + sign * d[0], v[1] + sign * d[1], v[2] + sign * d[2]]
}

/**
 * RV8: where the probe input changes on a move from `from` to `to` (reported MPos), with the scene
 * physical and the machine `slip` off from what it reports; in reported MPos.
 */
function physicalChange(
  scene: ProbeScene,
  tip: ProbeTip,
  from: Vec3,
  to: Vec3,
  closing: boolean,
  slip: Vec3,
): Vec3 | undefined {
  const c = firstChange(scene, tip, shift(from, slip, 1), shift(to, slip, 1), closing)
  return c === undefined ? undefined : shift(c, slip, -1)
}
