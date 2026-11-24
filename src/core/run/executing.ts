/**
 * The line a GRBL machine executes, estimated from the status report (hardening DF84): GRBL
 * acknowledges a line once its motion is in the planner, so the line moving lags the acknowledged
 * one by what the planner holds. `programTrace` counts each line's planner blocks once (arcs split
 * as GRBL's mc_arc does); `estimateExecuting` walks back from the acknowledged lines by the
 * blocks in the planner (`Bf`), or matches the reported position without `Bf`.
 * Doc: docs/modes/run.md#gcode-panel-df84
 */
import { initialParserState, parseBlock, type ParserState } from './grbl/emulator/gcode'
import { PLANNER_BLOCKS, type Vec3 } from './grbl/emulator/planner'

/** GRBL's default arc tolerance (`$12`, mm). */
export const DEFAULT_ARC_TOLERANCE = 0.002

/** Planner blocks per line of a program and where each block ends (work coordinates, mm). */
export interface ProgramTrace {
  /** Lines in the program. */
  readonly lines: number
  /** Lines traced so far (`ProgramTracer` works in slices); `first`/`settled` hold up to it. */
  readonly traced: number
  /** `first[i]`: index of line i's (0-based) first block; `first[lines]` = block count. */
  readonly first: Uint32Array
  /**
   * `settled[i]`: the first block that can still be in the planner once lines 1..i are
   * processed: GRBL empties the planner before a spindle change, a dwell, a probe, `M0`/`M2`/`M30`
   * or a G10 (protocol_buffer_synchronize), so the blocks before such a line have run.
   */
  readonly settled: Uint32Array
  /** End point of each block (x, y, z), mm in work coordinates (`first[traced]` blocks). */
  readonly ends: Float64Array
  /** Where the first block starts (the position at the start of the run). */
  readonly start: Vec3
}

/** A gCode line as GRBL's protocol loop reads it: no comments, spaces or lower case. */
function normalize(raw: string): string {
  let out = ''
  let comment = false
  for (const ch of raw) {
    if (comment) {
      if (ch === ')') comment = false
    } else if (ch === '(') comment = true
    else if (ch === ';') break
    else if (ch > ' ' && ch !== '/') out += ch.toUpperCase()
  }
  return out
}

/**
 * Traces a program's planner blocks in slices (`step`), so a long program never holds the
 * caller's thread for long (100 k lines take ~0.5 s in all): a linear move is one block, an arc
 * its `$12` segments, a zero-length move or a line without motion none. Parsed with the
 * emulator's gCode parser from `start` (work coordinates; G54 taken as the origin, so blocks are
 * in work coordinates). A line the parser refuses adds no block and leaves the modal state as it
 * was, as GRBL does after an error.
 */
export class ProgramTracer {
  private readonly arcTolerance: number
  private readonly start: Vec3
  private readonly first: Uint32Array
  private readonly settled: Uint32Array
  private ends: Float64Array
  private count = 0
  private sync = 0
  private done = 0
  private state: ParserState
  private at: Vec3

  constructor(
    private readonly lines: readonly string[],
    opts: { readonly arcTolerance?: number; readonly start?: Vec3 } = {},
  ) {
    this.arcTolerance = opts.arcTolerance ?? DEFAULT_ARC_TOLERANCE
    this.start = opts.start ?? [0, 0, 0]
    this.first = new Uint32Array(lines.length + 1)
    this.settled = new Uint32Array(lines.length + 1)
    this.ends = new Float64Array(Math.max(48, lines.length * 3))
    this.state = initialParserState(this.start, [0, 0, 0])
    this.at = this.start
  }

  /** Whether every line is traced. */
  get finished(): boolean {
    return this.done >= this.lines.length
  }

  /** Traces up to `n` more lines; returns `finished`. */
  step(n: number): boolean {
    const end = Math.min(this.lines.length, this.done + n)
    for (let i = this.done; i < end; i++) this.line(i)
    this.done = end
    this.first[end] = this.count
    this.settled[end] = this.sync
    return this.finished
  }

  /** The trace so far (no copy: valid until the next `step`). */
  get trace(): ProgramTrace {
    return {
      lines: this.lines.length,
      traced: this.done,
      first: this.first,
      settled: this.settled,
      ends: this.ends,
      start: this.start,
    }
  }

  private line(i: number): void {
    this.first[i] = this.count
    this.settled[i] = this.sync
    const text = normalize(this.lines[i] ?? '')
    if (text === '' || text.startsWith('$')) return
    const parsed = parseBlock(text, this.state, { arcTolerance: this.arcTolerance })
    if (parsed.isErr()) return
    const block = parsed.unwrap()
    this.state = block.state
    for (const a of block.actions) {
      // every step but a move waits for the planner to empty first (as the emulator, GRBL)
      if (a.kind !== 'move') this.sync = this.count
      if (a.kind === 'move' || a.kind === 'probe') this.push(a.target)
    }
    // a probe ends where it touched: unknown here, the next block starts from its target
    this.at = this.state.position
  }

  private push(p: Vec3): void {
    const at = this.at
    // GRBL drops a block without steps (PLAN_EMPTY_BLOCK); the emulator below 1e-6 mm
    if (Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]) < 1e-6) return
    if ((this.count + 1) * 3 > this.ends.length) {
      const grown = new Float64Array(this.ends.length * 2)
      grown.set(this.ends)
      this.ends = grown
    }
    this.ends[this.count * 3] = p[0]
    this.ends[this.count * 3 + 1] = p[1]
    this.ends[this.count * 3 + 2] = p[2]
    this.count++
    this.at = p
  }
}

/** The whole program's trace at once (tests, short programs). */
export function programTrace(
  lines: readonly string[],
  opts: { readonly arcTolerance?: number; readonly start?: Vec3 } = {},
): ProgramTrace {
  const t = new ProgramTracer(lines, opts)
  t.step(lines.length)
  return t.trace
}

/** The 1-based line that owns block `b` (`first[i] <= b < first[i + 1]`). */
export function lineOfBlock(trace: ProgramTrace, b: number): number {
  let lo = 0
  let hi = trace.traced - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (trace.first[mid]! <= b) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/**
 * How well `p` fits block `b`'s segment (from the previous block's end, or the start): the
 * distance (mm), plus a penalty when the machine moved (`moved`) against the block's direction,
 * so a retraced segment (a plunge and its retract) is told from its twin.
 */
function misfit(trace: ProgramTrace, b: number, p: Vec3, moved: Vec3 | undefined): number {
  const e = trace.ends
  const ax = b > 0 ? e[(b - 1) * 3]! : trace.start[0]
  const ay = b > 0 ? e[(b - 1) * 3 + 1]! : trace.start[1]
  const az = b > 0 ? e[(b - 1) * 3 + 2]! : trace.start[2]
  const dx = e[b * 3]! - ax
  const dy = e[b * 3 + 1]! - ay
  const dz = e[b * 3 + 2]! - az
  const len2 = dx * dx + dy * dy + dz * dz
  let t = len2 === 0 ? 0 : ((p[0] - ax) * dx + (p[1] - ay) * dy + (p[2] - az) * dz) / len2
  t = Math.max(0, Math.min(1, t))
  const d = Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1], az + t * dz - p[2])
  const against = moved !== undefined && moved[0] * dx + moved[1] * dy + moved[2] * dz < 0
  return against ? d + AGAINST_MM : d
}

/** Penalty (mm) for a block the machine moved against (`misfit`). */
const AGAINST_MM = 0.5

export interface ExecutingInput {
  /** Lines acknowledged when the status report arrived. */
  readonly acknowledged: number
  /** Lines written to the controller (≥ acknowledged). */
  readonly sent: number
  /** `Bf`'s free planner blocks, when the report has it. */
  readonly blocksFree?: number | undefined
  /** Planner blocks when empty (the largest free count seen; GRBL Uno: 15). */
  readonly capacity?: number | undefined
  /** The reported work position (mm). */
  readonly position?: Vec3 | undefined
  /** The work position of the report before (mm): which way the machine moves. */
  readonly previous?: Vec3 | undefined
  /** The last estimate's block (never go back during one run). */
  readonly floor?: number | undefined
}

/**
 * Where the machine is in the program: `line` (1-based) and the `block` it executes (−1 when no
 * block is in the planner). `undefined` before the first line is acknowledged or sent.
 */
export interface Executing {
  readonly line: number
  readonly block: number
}

/** The block of [lo, hi) that fits the position best (`misfit`), the earliest on a tie. */
function nearest(trace: ProgramTrace, lo: number, hi: number, input: ExecutingInput): number {
  const p = input.position!
  const q = input.previous
  const m: Vec3 | undefined = q === undefined ? undefined : [p[0] - q[0], p[1] - q[1], p[2] - q[2]]
  const moved = m !== undefined && Math.hypot(m[0], m[1], m[2]) > 1e-3 ? m : undefined
  let best = lo
  let bestD = Number.POSITIVE_INFINITY
  for (let b = lo; b < hi; b++) {
    const d = misfit(trace, b, p, moved)
    if (d < bestD - 1e-9) {
      best = b
      bestD = d
    }
  }
  return best
}

/** Docs: docs/modes/run.md#gcode-panel-df84 (steps 2–5). */
export function estimateExecuting(
  trace: ProgramTrace,
  input: ExecutingInput,
): Executing | undefined {
  const acked = Math.max(0, Math.min(input.acknowledged, trace.lines))
  const sent = Math.max(acked, Math.min(input.sent, trace.lines))
  // not traced that far yet (a long program is traced in slices)
  if (sent === 0 || trace.traced < Math.min(sent, acked + 1)) return undefined
  const capacity = Math.max(1, input.capacity ?? PLANNER_BLOCKS)
  const floor = input.floor ?? -1
  // the acknowledged lines' blocks end at ackedEnd; the next sent line may have planned some of
  // its own (an arc GRBL is still splitting) up to `upper`
  const ackedEnd = trace.first[acked]!
  const upper = sent > acked ? trace.first[acked + 1]! : ackedEnd
  // blocks before the last synchronizing line have run, and so have those before the last estimate
  const settled = Math.max(trace.settled[acked]!, floor, 0)
  const at = (block: number): Executing => ({ line: lineOfBlock(trace, block), block })
  const free = input.blocksFree
  if (free !== undefined) {
    const inPlanner = Math.max(0, capacity - free)
    // nothing to move: GRBL is in the next line (a dwell, a spindle start) or past the last
    if (inPlanner === 0 || settled >= upper) return idle(acked, sent, floor)
    // the oldest block in the planner is ackedEnd + p − inPlanner, p the next line's blocks
    // planned so far (0 unless GRBL is still splitting an arc longer than the planner)
    const lo = Math.max(ackedEnd - inPlanner, settled)
    const hi = Math.min(Math.max(lo + 1, upper - inPlanner + 1), upper)
    if (input.position === undefined || hi - lo <= 1) return at(lo)
    return at(nearest(trace, lo, hi, input))
  }
  // no `Bf`: the nearest block of the window the planner can hold
  const lo = Math.max(ackedEnd - capacity, settled)
  if (lo >= upper) return idle(acked, sent, floor)
  return at(input.position === undefined ? lo : nearest(trace, lo, upper, input))
}

/** No block to execute: in the next line when one is sent and unanswered, else the last one. */
function idle(acked: number, sent: number, floor: number): Executing {
  return { line: sent > acked ? acked + 1 : Math.max(1, acked), block: floor }
}
