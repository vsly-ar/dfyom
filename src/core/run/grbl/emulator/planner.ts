/**
 * GRBL planner: block buffer, junction-deviation corner speeds and look-ahead passes.
 * Doc: docs/architecture/grbl.md#motion-timing (follows gnea/grbl planner.c, in mm and seconds).
 *
 * `blocks[0]` is always the block being executed (or held); its entry speed is fixed to the
 * current speed, like GRBL re-planning the executing block from the stepper's current state.
 */

export type Vec3 = readonly [number, number, number]

/** Free blocks of GRBL's planner (BLOCK_BUFFER_SIZE 16, one slot kept empty). */
export const PLANNER_BLOCKS = 15
/** GRBL's MINIMUM_FEED_RATE, 1 mm/min, in mm/s. */
const MIN_SPEED = 1 / 60
const SOME_LARGE_VALUE = 1e38

export interface PlannerLimits {
  /** `$110–$112`, mm/min. */
  readonly maxRate: Vec3
  /** `$120–$122`, mm/s². */
  readonly accel: Vec3
  /** `$11`, mm. */
  readonly junctionDeviation: number
}

export interface Overrides {
  /** Percent. */
  readonly feed: number
  readonly rapid: number
}

export interface BlockInput {
  readonly target: Vec3
  readonly rapid: boolean
  /** Programmed feed rate, mm/min (ignored for rapids). */
  readonly feed: number
  /** Jog motion: no feed override (GRBL PL_COND_FLAG_NO_FEED_OVERRIDE). */
  readonly jog: boolean
  /** Index into the emulator's line trace, for timing records. */
  readonly line: number
  /** Last block of its line. */
  readonly lastOfLine: boolean
}

export interface Block extends BlockInput {
  start: Vec3
  /** Remaining length, mm (shrinks when the executing block is re-planned mid-way). */
  length: number
  readonly unit: Vec3
  /** mm/s². */
  readonly accel: number
  /** Axis-limited maximum rate along the block, mm/s. */
  readonly rapidRate: number
  readonly maxJunctionSq: number
  nominal: number
  maxEntrySq: number
  entrySq: number
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
}

export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** GRBL limit_value_by_axis_maximum(): the largest value along `unit` within every axis limit. */
function limitByAxes(limits: Vec3, unit: Vec3): number {
  let v = SOME_LARGE_VALUE
  for (let i = 0; i < 3; i++) {
    const u = Math.abs(unit[i] ?? 0)
    if (u > 0) v = Math.min(v, (limits[i] ?? 0) / u)
  }
  return v
}

export class Planner {
  readonly blocks: Block[] = []
  overrides: Overrides = { feed: 100, rapid: 100 }

  constructor(readonly limits: PlannerLimits) {}

  get free(): number {
    return PLANNER_BLOCKS - this.blocks.length
  }

  /** Nominal speed (mm/s) after overrides, as GRBL plan_compute_profile_nominal_speed(). */
  nominalOf(b: Pick<Block, 'rapid' | 'jog' | 'feed' | 'rapidRate'>): number {
    let v = b.rapid ? b.rapidRate * (this.overrides.rapid / 100) : b.feed / 60
    if (!b.rapid && !b.jog) v *= this.overrides.feed / 100
    return Math.max(MIN_SPEED, Math.min(v, b.rapidRate))
  }

  /**
   * Appends a block from `start`; returns false for a zero-length move (GRBL PLAN_EMPTY_BLOCK).
   * The caller checks `free` first.
   */
  add(start: Vec3, input: BlockInput): boolean {
    const length = distance(start, input.target)
    if (length < 1e-6) return false
    const unit: Vec3 = [
      (input.target[0] - start[0]) / length,
      (input.target[1] - start[1]) / length,
      (input.target[2] - start[2]) / length,
    ]
    const accel = limitByAxes(this.limits.accel, unit)
    const rapidRate = limitByAxes(this.limits.maxRate, unit) / 60
    const prev = this.blocks[this.blocks.length - 1]
    const maxJunctionSq = prev === undefined ? 0 : this.junctionSq(prev.unit, unit)
    const block: Block = {
      ...input,
      start,
      length,
      unit,
      accel,
      rapidRate,
      maxJunctionSq,
      nominal: 0,
      maxEntrySq: 0,
      entrySq: 0,
    }
    block.nominal = this.nominalOf(block)
    this.blocks.push(block)
    this.recalculate()
    return true
  }

  /** Junction-deviation corner speed², as GRBL plan_buffer_line(). */
  private junctionSq(prev: Vec3, unit: Vec3): number {
    let cos = 0
    const ju: [number, number, number] = [0, 0, 0]
    for (let i = 0; i < 3; i++) {
      cos -= (prev[i] ?? 0) * (unit[i] ?? 0)
      ju[i] = (unit[i] ?? 0) - (prev[i] ?? 0)
    }
    if (cos > 0.999999) return 0 // 0° acute junction: MINIMUM_JUNCTION_SPEED
    if (cos < -0.999999) return SOME_LARGE_VALUE // straight line
    const n = Math.hypot(ju[0], ju[1], ju[2])
    const junctionAccel = limitByAxes(this.limits.accel, [ju[0] / n, ju[1] / n, ju[2] / n])
    const sinHalf = Math.sqrt(0.5 * (1 - cos))
    return (junctionAccel * this.limits.junctionDeviation * sinHalf) / (1 - sinHalf)
  }

  /**
   * Recomputes nominal and maximum entry speeds (after an override change) and the look-ahead.
   * The executing block keeps its fixed entry speed.
   */
  recalculate(): void {
    const bs = this.blocks
    let prevNominal = SOME_LARGE_VALUE
    for (const b of bs) {
      b.nominal = this.nominalOf(b)
      b.maxEntrySq = Math.min(Math.min(b.nominal, prevNominal) ** 2, b.maxJunctionSq)
      prevNominal = b.nominal
    }
    const n = bs.length
    // Reverse pass: every block must be able to stop by the end of the buffer.
    let next: Block | undefined
    for (let i = n - 1; i >= 1; i--) {
      const b = bs[i]
      if (b === undefined) continue
      const exitSq = next === undefined ? 0 : next.entrySq
      b.entrySq = Math.min(b.maxEntrySq, exitSq + 2 * b.accel * b.length)
      next = b
    }
    // Forward pass: entry speeds reachable by accelerating from the executing block.
    for (let i = 0; i < n - 1; i++) {
      const cur = bs[i]
      const nb = bs[i + 1]
      if (cur === undefined || nb === undefined) continue
      const reach = cur.entrySq + 2 * cur.accel * cur.length
      if (nb.entrySq > reach) nb.entrySq = reach
    }
  }

  /** Planned exit speed of the executing block, mm/s. */
  exitSpeed(): number {
    return Math.sqrt(this.blocks[1]?.entrySq ?? 0)
  }

  clear(): void {
    this.blocks.length = 0
  }
}
