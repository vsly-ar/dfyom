/**
 * gCode block parser for the virtual machine: GRBL 1.1 gc_execute_line() steps 1–3 for the
 * emulated subset, producing the actions step 4 would execute.
 * Doc: docs/architecture/grbl.md#protocol-subset
 *
 * Failures are GRBL status codes sent as `error:N` (protocol outcomes, not AppErrors).
 */
import { Err, Ok, type Result } from '../../../../shared/result'
import type { Vec3 } from './planner'

/** GRBL 1.1 status codes produced by the emulator (gnea/grbl error_codes_en_US.csv). */
export const STATUS = {
  expectedCommandLetter: 1,
  badNumberFormat: 2,
  invalidStatement: 3,
  negativeValue: 4,
  settingDisabled: 5,
  idleError: 8,
  systemGcLock: 9,
  softLimitError: 10,
  overflow: 11,
  travelExceeded: 15,
  invalidJogCommand: 16,
  unsupportedCommand: 20,
  modalGroupViolation: 21,
  undefinedFeedRate: 22,
  commandValueNotInteger: 23,
  axisCommandConflict: 24,
  wordRepeated: 25,
  noAxisWords: 26,
  axisWordsExist: 31,
  valueWordMissing: 28,
  g53InvalidMotionMode: 30,
  noAxisWordsInPlane: 32,
  invalidTarget: 33,
  arcRadiusError: 34,
  noOffsetsInPlane: 35,
  unusedWords: 36,
  maxValueExceeded: 38,
} as const

export type StatusCode = (typeof STATUS)[keyof typeof STATUS]

export type SpindleDir = 'off' | 'cw' | 'ccw'

/**
 * Motion modes: G0–G3, the probe cycles G38.2–G38.5 (docs/architecture/grbl.md#probing) and G80
 * (motion off: axis words are then an error, DF93).
 */
export type MotionMode = 0 | 1 | 2 | 3 | 38.2 | 38.3 | 38.4 | 38.5 | 80
const PROBE_MODES: ReadonlySet<number> = new Set([38.2, 38.3, 38.4, 38.5])

/** Modal parser state (gc_state) for the emulated subset. Lengths in mm, machine coordinates. */
export interface ParserState {
  readonly motion: MotionMode
  readonly metric: boolean
  readonly absolute: boolean
  /** mm/min; 0 = undefined (GRBL has no default feed). */
  readonly feed: number
  readonly spindle: SpindleDir
  /** Programmed rpm. */
  readonly spindleSpeed: number
  readonly tool: number
  /** End of the last planned motion. */
  readonly position: Vec3
  /** G54 work coordinate offset. */
  readonly wco: Vec3
}

/** gc_init(): modal defaults after power-up or reset; the G54 offset is stored data and survives. */
export function initialParserState(position: Vec3, wco: Vec3): ParserState {
  return {
    motion: 0,
    metric: true,
    absolute: true,
    feed: 0,
    spindle: 'off',
    spindleSpeed: 0,
    tool: 0,
    position,
    wco,
  }
}

export interface Move {
  readonly kind: 'move'
  readonly target: Vec3
  readonly rapid: boolean
  /** mm/min. */
  readonly feed: number
}

/** Step-4 actions, in GRBL's execution order. All but `move` wait for the planner to empty. */
export type Action =
  | Move
  | { readonly kind: 'spindle'; readonly dir: SpindleDir; readonly rpm: number }
  | { readonly kind: 'dwell'; readonly seconds: number }
  | { readonly kind: 'setWco'; readonly wco: Vec3 }
  | { readonly kind: 'pause' }
  | { readonly kind: 'programEnd' }
  /** G38.x: probe toward (or `away` from) the workpiece; `noError` for G38.3/G38.5. */
  | {
      readonly kind: 'probe'
      readonly target: Vec3
      /** mm/min. */
      readonly feed: number
      readonly away: boolean
      readonly noError: boolean
    }

export interface ParsedBlock {
  readonly state: ParserState
  readonly actions: readonly Action[]
}

export interface JogBlock {
  readonly target: Vec3
  /** mm/min. */
  readonly feed: number
}

const MM_PER_INCH = 25.4
const MAX_TOOL_NUMBER = 255
const AXES = ['X', 'Y', 'Z'] as const
const VALUE_LETTERS = new Set('FIJKLNPRSTXYZ')

type Group =
  | 'nonModal'
  | 'motion'
  | 'plane'
  | 'distance'
  | 'feedMode'
  | 'units'
  | 'coord'
  | 'cutter'
  | 'toolLength'
  | 'pathControl'
type MGroup = 'flow' | 'spindle' | 'coolant'

const G_GROUPS: ReadonlyMap<number, Group> = new Map([
  [4, 'nonModal'],
  [10, 'nonModal'],
  [53, 'nonModal'],
  [0, 'motion'],
  [1, 'motion'],
  [2, 'motion'],
  [3, 'motion'],
  // DF93: GRBL's modal no-ops that other CAM posts emit (G80 motion off, G40 cutter compensation
  // off, G49 tool length offset off, G61 exact path)
  [80, 'motion'],
  [17, 'plane'],
  [40, 'cutter'],
  [49, 'toolLength'],
  [61, 'pathControl'],
  [90, 'distance'],
  [91, 'distance'],
  [94, 'feedMode'],
  [20, 'units'],
  [21, 'units'],
  [54, 'coord'],
])

const M_GROUPS: ReadonlyMap<number, MGroup> = new Map([
  [0, 'flow'],
  // M1: GRBL 1.1 accepts the optional stop and ignores it (DF93)
  [1, 'flow'],
  [2, 'flow'],
  [30, 'flow'],
  [3, 'spindle'],
  [4, 'spindle'],
  [5, 'spindle'],
  // M7/M8/M9: coolant (GRBL switches its pins; nothing to emulate, DF93)
  [7, 'coolant'],
  [8, 'coolant'],
  [9, 'coolant'],
])

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)/

interface Words {
  readonly g: Map<Group, number>
  readonly m: Map<MGroup, number>
  readonly values: Map<string, number>
  /** G0–G3 or G10 present (GRBL axis_command). */
  readonly axisCommand: 'motion' | 'nonModal' | undefined
}

/** Step 1: split the stripped, upper-case line into words. */
function readWords(line: string): Result<Words, StatusCode> {
  const g = new Map<Group, number>()
  const m = new Map<MGroup, number>()
  const values = new Map<string, number>()
  let axisCommand: Words['axisCommand']
  let i = 0
  while (i < line.length) {
    const letter = line[i] ?? ''
    if (letter < 'A' || letter > 'Z') return Err(STATUS.expectedCommandLetter)
    const num = NUMBER.exec(line.slice(i + 1))
    if (num === null) return Err(STATUS.badNumberFormat)
    i += 1 + num[0].length
    const value = Number(num[0])
    const int = Math.trunc(value)
    const mantissa = Math.round(100 * (value - int))
    if (letter === 'G' && int === 38) {
      // G38.2–G38.5 (GRBL: any other mantissa is unsupported)
      if (![20, 30, 40, 50].includes(mantissa)) return Err(STATUS.unsupportedCommand)
      if (axisCommand !== undefined) return Err(STATUS.axisCommandConflict)
      axisCommand = 'motion'
      if (g.has('motion')) return Err(STATUS.modalGroupViolation)
      g.set('motion', 38 + mantissa / 100)
    } else if (letter === 'G') {
      const group = G_GROUPS.get(int)
      if (group === undefined) return Err(STATUS.unsupportedCommand)
      // GRBL order: the axis-command conflict is checked in the case, the mantissa after it.
      if ((group === 'motion' && int !== 80) || int === 10) {
        if (axisCommand !== undefined) return Err(STATUS.axisCommandConflict)
        axisCommand = group === 'motion' ? 'motion' : 'nonModal'
      }
      // G91.1 (incremental arc centres) is GRBL's only arc mode: accepted, nothing to do (DF93);
      // G90.1 is unsupported
      if (group === 'distance' && mantissa !== 0) {
        if (int !== 91 || mantissa !== 10) return Err(STATUS.unsupportedCommand)
        continue
      }
      if (mantissa !== 0) return Err(STATUS.commandValueNotInteger)
      if (g.has(group)) return Err(STATUS.modalGroupViolation)
      g.set(group, int)
    } else if (letter === 'M') {
      if (mantissa !== 0) return Err(STATUS.commandValueNotInteger)
      const group = M_GROUPS.get(int)
      if (group === undefined) return Err(STATUS.unsupportedCommand)
      if (m.has(group)) return Err(STATUS.modalGroupViolation)
      m.set(group, int)
    } else {
      if (!VALUE_LETTERS.has(letter)) return Err(STATUS.unsupportedCommand)
      if (values.has(letter)) return Err(STATUS.wordRepeated)
      if ('FNPST'.includes(letter) && value < 0) return Err(STATUS.negativeValue)
      if (letter === 'T' && value > MAX_TOOL_NUMBER) return Err(STATUS.maxValueExceeded)
      values.set(letter, value)
    }
  }
  return Ok({ g, m, values, axisCommand })
}

/**
 * Parses one gCode block against `state`. `jog` parses the part after `$J=` with GRBL's jog
 * rules (G1 with a required F; only G20/G21, G90/G91, G53 allowed). On success the jog result
 * carries the target instead of actions; the caller commits only its position.
 */
export function parseBlock(
  line: string,
  state: ParserState,
  opts: { readonly arcTolerance: number; readonly jog?: boolean },
): Result<ParsedBlock & { readonly jog?: JogBlock }, StatusCode> {
  const read = readWords(line)
  if (read.isErr()) return Err(read.unwrapErr())
  const w = read.unwrap()
  const jog = opts.jog === true
  const used = new Set<string>(['N'])
  const val = (k: string) => w.values.get(k)
  const has = (k: string) => w.values.has(k)

  const metric = w.g.has('units') ? w.g.get('units') === 21 : state.metric
  const absolute = w.g.has('distance') ? w.g.get('distance') === 90 : state.absolute
  const toMm = (v: number) => (metric ? v : v * MM_PER_INCH)
  const nonModal = w.g.get('nonModal')
  let motion: MotionMode = jog ? 1 : state.motion
  const gm = w.g.get('motion')
  if (gm !== undefined) motion = gm as MotionMode

  const axisWords = AXES.filter((a) => has(a))
  let axisCommand = w.axisCommand
  if (axisWords.length > 0 && axisCommand === undefined) axisCommand = 'motion'

  // Feed rate (G94 only). Jogs require their own F and never change the modal feed.
  let feed = state.feed
  used.add('F')
  if (jog) {
    const f = val('F')
    if (f === undefined) return Err(STATUS.undefinedFeedRate)
    feed = toMm(f)
  } else if (has('F')) feed = toMm(val('F') ?? 0)

  if (!jog) used.add('S').add('T')
  const spindleSpeed = val('S') ?? state.spindleSpeed
  const tool = val('T') !== undefined ? Math.trunc(val('T') ?? 0) : state.tool

  // G4 dwell.
  if (nonModal === 4) {
    if (!has('P')) return Err(STATUS.valueWordMissing)
    used.add('P')
  }

  // G10 L2/L20 P1: set the G54 offset.
  let wco = state.wco
  if (nonModal === 10) {
    if (axisWords.length === 0) return Err(STATUS.noAxisWords)
    // GRBL needs P or L; a missing one is 0 (P0 = the active system, G54 here).
    if (!has('P') && !has('L')) return Err(STATUS.valueWordMissing)
    const l = Math.trunc(val('L') ?? 0)
    const p = Math.trunc(val('P') ?? 0)
    if (l !== 2 && l !== 20) return Err(STATUS.unsupportedCommand)
    if (l === 2 && has('R')) return Err(STATUS.unsupportedCommand) // G10 L2 R: rotation
    if (p !== 0 && p !== 1) return Err(STATUS.unsupportedCommand) // G55–G59 not emulated
    used.add('P').add('L')
    const next: [number, number, number] = [wco[0], wco[1], wco[2]]
    AXES.forEach((a, i) => {
      const v = val(a)
      if (v === undefined) return
      next[i] = l === 2 ? toMm(v) : (state.position[i] ?? 0) - toMm(v)
    })
    wco = next
  }

  // G53: machine coordinates, only with G0/G1.
  if (nonModal === 53 && motion !== 0 && motion !== 1) return Err(STATUS.g53InvalidMotionMode)

  // Target of the motion (or G10's axis words, already consumed above).
  const target: [number, number, number] = [state.position[0], state.position[1], state.position[2]]
  if (axisCommand === 'motion') {
    AXES.forEach((a, i) => {
      const v = val(a)
      if (v === undefined) return
      const mm = toMm(v)
      if (nonModal === 53) target[i] = mm
      else target[i] = absolute ? mm + (wco[i] ?? 0) : (state.position[i] ?? 0) + mm
    })
  }
  if (axisCommand !== undefined) used.add('X').add('Y').add('Z')

  const actions: Action[] = []
  let moves: Move[] = []
  let probe: Extract<Action, { kind: 'probe' }> | undefined
  // [G80 errors]: axis words while motion is off
  if (axisCommand === 'motion' && motion === 80) return Err(STATUS.axisWordsExist)
  if (axisCommand === 'motion' && PROBE_MODES.has(motion)) {
    // [G38 errors]: feed undefined, no axis words, target equals the current position
    if (feed === 0) return Err(STATUS.undefinedFeedRate)
    if (axisWords.length === 0) return Err(STATUS.noAxisWords)
    if (target.every((v, i) => v === state.position[i])) return Err(STATUS.invalidTarget)
    probe = {
      kind: 'probe',
      target,
      feed,
      away: motion === 38.4 || motion === 38.5,
      noError: motion === 38.3 || motion === 38.5,
    }
  } else if (axisCommand === 'motion') {
    if (motion === 0) {
      if (axisWords.length > 0) moves = [{ kind: 'move', target, rapid: true, feed }]
    } else {
      if (feed === 0) return Err(STATUS.undefinedFeedRate)
      if (motion === 1) {
        if (axisWords.length > 0) moves = [{ kind: 'move', target, rapid: false, feed }]
      } else {
        const arc = arcMoves(state.position, target, motion === 2, w, toMm, feed, opts.arcTolerance)
        if (arc.isErr()) return Err(arc.unwrapErr())
        moves = arc.unwrap()
        // Radius mode consumes only R; offset mode consumes I, J and K.
        if (has('R')) used.add('R')
        else used.add('I').add('J').add('K')
      }
    }
  }

  for (const k of w.values.keys()) if (!used.has(k)) return Err(STATUS.unusedWords)

  if (jog) {
    const allowed = [...w.g.keys()].every(
      (g) => g === 'distance' || g === 'units' || g === 'nonModal',
    )
    if (!allowed || w.m.size > 0 || (nonModal !== undefined && nonModal !== 53)) {
      return Err(STATUS.invalidJogCommand)
    }
    return Ok({ state: { ...state, position: target }, actions: [], jog: { target, feed } })
  }

  // Step 4 order: S, M3/M4/M5, G4, …, G10, motion, M0/M2/M30.
  let spindle = state.spindle
  if (spindleSpeed !== state.spindleSpeed && state.spindle !== 'off') {
    actions.push({ kind: 'spindle', dir: state.spindle, rpm: spindleSpeed })
  }
  const ms = w.m.get('spindle')
  if (ms !== undefined) {
    const dir: SpindleDir = ms === 3 ? 'cw' : ms === 4 ? 'ccw' : 'off'
    if (dir !== state.spindle) actions.push({ kind: 'spindle', dir, rpm: spindleSpeed })
    spindle = dir
  }
  if (nonModal === 4) actions.push({ kind: 'dwell', seconds: val('P') ?? 0 })
  if (nonModal === 10) actions.push({ kind: 'setWco', wco })
  actions.push(...moves)
  if (probe !== undefined) actions.push(probe)
  // a probe's end is known only after it ran: the emulator syncs the position then
  const position = moves.length > 0 || probe !== undefined ? target : state.position

  let next: ParserState = {
    motion,
    metric,
    absolute,
    feed,
    spindle,
    spindleSpeed,
    tool,
    position,
    wco,
  }
  const flow = w.m.get('flow')
  if (flow === 0) actions.push({ kind: 'pause' })
  else if (flow === 2 || flow === 30) {
    // Program end resets modal groups 1, 2, 3, 5, 7, 12 (LinuxCNC rules, as GRBL).
    actions.push({ kind: 'programEnd' })
    next = { ...next, motion: 1, absolute: true, spindle: 'off' }
  }
  return Ok({ state: next, actions })
}

/** G2/G3 in the XY plane (IJ offsets or R), split into chords within `$12` like GRBL mc_arc(). */
function arcMoves(
  position: Vec3,
  target: Vec3,
  clockwise: boolean,
  w: Words,
  toMm: (v: number) => number,
  feed: number,
  tolerance: number,
): Result<Move[], StatusCode> {
  if (!w.values.has('X') && !w.values.has('Y')) return Err(STATUS.noAxisWordsInPlane)
  const x = target[0] - position[0]
  const y = target[1] - position[1]
  let i: number
  let j: number
  let radius: number
  const r = w.values.get('R')
  if (r !== undefined) {
    if (x === 0 && y === 0 && target[2] === position[2]) return Err(STATUS.invalidTarget)
    let rr = toMm(r)
    let h = 4 * rr * rr - x * x - y * y
    if (h < 0) return Err(STATUS.arcRadiusError)
    h = -Math.sqrt(h) / Math.hypot(x, y)
    if (!clockwise) h = -h
    if (rr < 0) {
      h = -h
      rr = -rr
    }
    i = 0.5 * (x - y * h)
    j = 0.5 * (y + x * h)
    radius = rr
  } else {
    if (!w.values.has('I') && !w.values.has('J')) return Err(STATUS.noOffsetsInPlane)
    i = toMm(w.values.get('I') ?? 0)
    j = toMm(w.values.get('J') ?? 0)
    radius = Math.hypot(i, j)
    const targetR = Math.hypot(x - i, y - j)
    const delta = Math.abs(targetR - radius)
    if (delta > 0.005 && (delta > 0.5 || delta > 0.001 * radius)) return Err(STATUS.invalidTarget)
  }
  const cx = position[0] + i
  const cy = position[1] + j
  const r0x = -i
  const r0y = -j
  const rtx = target[0] - cx
  const rty = target[1] - cy
  let travel = Math.atan2(r0x * rty - r0y * rtx, r0x * rtx + r0y * rty)
  const EPS = 5e-7 // ARC_ANGULAR_TRAVEL_EPSILON
  if (clockwise) {
    if (travel >= -EPS) travel -= 2 * Math.PI
  } else if (travel <= EPS) travel += 2 * Math.PI
  const segments =
    2 * radius > tolerance
      ? Math.floor(
          Math.abs(0.5 * travel * radius) / Math.sqrt(tolerance * (2 * radius - tolerance)),
        )
      : 0
  const moves: Move[] = []
  for (let k = 1; k < segments; k++) {
    const a = (travel * k) / segments
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    moves.push({
      kind: 'move',
      target: [
        cx + r0x * cos - r0y * sin,
        cy + r0x * sin + r0y * cos,
        position[2] + ((target[2] - position[2]) * k) / segments,
      ],
      rapid: false,
      feed,
    })
  }
  moves.push({ kind: 'move', target, rapid: false, feed })
  return Ok(moves)
}
