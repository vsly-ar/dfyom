/**
 * Trapezoidal velocity profiles, as GRBL's stepper prep computes them per planner block.
 * Doc: docs/architecture/grbl.md#motion-timing
 *
 * Units: mm, mm/s, mm/s², seconds. A profile is a list of constant-acceleration phases.
 */

export interface Phase {
  /** Start of the phase, seconds from the start of the profile. */
  readonly t0: number
  readonly dt: number
  /** Distance covered before the phase, mm. */
  readonly s0: number
  readonly v0: number
  /** Signed acceleration, mm/s². */
  readonly a: number
}

export interface Profile {
  readonly phases: readonly Phase[]
  /** Seconds. */
  readonly duration: number
  /** Distance covered, mm (less than the block length when a hold stops inside it). */
  readonly length: number
  readonly exitSpeed: number
}

const EPS = 1e-9

class Builder {
  phases: Phase[] = []
  t = 0
  s = 0
  v: number

  constructor(v0: number) {
    this.v = v0
  }

  /** Constant acceleration from the current speed to `v1` (may be equal: cruise over `d`). */
  ramp(v1: number, d: number): void {
    if (d <= EPS) {
      this.v = v1
      return
    }
    const v0 = this.v
    const dt = Math.abs(v1 - v0) <= EPS ? d / Math.max(v0, EPS) : (2 * d) / (v0 + v1)
    const acc = Math.abs(v1 - v0) <= EPS ? 0 : (v1 - v0) / dt
    this.phases.push({ t0: this.t, dt, s0: this.s, v0, a: acc })
    this.t += dt
    this.s += d
    this.v = v1
  }

  done(): Profile {
    return { phases: this.phases, duration: this.t, length: this.s, exitSpeed: this.v }
  }
}

/**
 * Profile over `length` from `entry` towards `exit`, cruising at most at `nominal`, with
 * acceleration `accel`. Mirrors GRBL's st_prep_buffer() ramp types, including the
 * deceleration-override case (entry above a lowered nominal speed after an override).
 */
export function trapezoid(
  length: number,
  entry: number,
  nominal: number,
  exit: number,
  accel: number,
): Profile {
  const b = new Builder(entry)
  let rest = length
  if (entry > nominal + EPS) {
    // Override reduction: decelerate to the new nominal speed first.
    const d = (entry * entry - nominal * nominal) / (2 * accel)
    if (d >= rest) {
      b.ramp(Math.sqrt(Math.max(0, entry * entry - 2 * accel * rest)), rest)
      return b.done()
    }
    b.ramp(nominal, d)
    rest -= d
  }
  const v0 = b.v
  const v1 = Math.min(exit, nominal)
  if (v1 * v1 >= v0 * v0 + 2 * accel * rest) {
    // Acceleration only: the exit speed cannot be reached (or is reached exactly).
    b.ramp(Math.sqrt(v0 * v0 + 2 * accel * rest), rest)
    return b.done()
  }
  if (v0 * v0 >= v1 * v1 + 2 * accel * rest) {
    // Deceleration only.
    b.ramp(Math.sqrt(Math.max(0, v0 * v0 - 2 * accel * rest)), rest)
    return b.done()
  }
  const peak = Math.sqrt((2 * accel * rest + v0 * v0 + v1 * v1) / 2)
  const vMax = Math.min(peak, nominal)
  const dAccel = (vMax * vMax - v0 * v0) / (2 * accel)
  const dDecel = (vMax * vMax - v1 * v1) / (2 * accel)
  b.ramp(vMax, dAccel)
  b.ramp(vMax, Math.max(0, rest - dAccel - dDecel))
  b.ramp(v1, dDecel)
  return b.done()
}

/** Feed-hold profile: decelerate from `entry` until stopped or the block ends. */
export function holdProfile(length: number, entry: number, accel: number): Profile {
  const b = new Builder(entry)
  const stop = (entry * entry) / (2 * accel)
  if (stop <= length) b.ramp(0, stop)
  else b.ramp(Math.sqrt(entry * entry - 2 * accel * length), length)
  return b.done()
}

/** Distance and speed `t` seconds into the profile (clamped to its end). */
export function sampleProfile(p: Profile, t: number): { s: number; v: number } {
  if (t >= p.duration) return { s: p.length, v: p.exitSpeed }
  for (let i = p.phases.length - 1; i >= 0; i--) {
    const ph = p.phases[i]
    if (ph === undefined || t < ph.t0) continue
    const dt = t - ph.t0
    return { s: ph.s0 + ph.v0 * dt + 0.5 * ph.a * dt * dt, v: ph.v0 + ph.a * dt }
  }
  return { s: 0, v: p.phases[0]?.v0 ?? p.exitSpeed }
}
