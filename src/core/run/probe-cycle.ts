/**
 * The shared probe-cycle runner (v0.5 RV3): one probe along one axis over a `ProbePort` (the
 * machine host wires the sender to it). Guards, fast seek, back off, slow re-probe(s), retract,
 * the modal state back; a failure unlocks and returns to the start (or stays, for Probe Z);
 * never targets past the configured distance or the travel. Headless.
 * Doc: docs/modes/run-probing.md#the-cycle-runner-rv3
 */
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import type { Vec3 } from '../toolpath/model'
import { alarmText } from './grbl/status'

/** The status the runner reads (positions in mm, as the sender reports them). */
export interface ProbePortStatus {
  readonly state: string
  readonly mpos: Vec3
  readonly wpos: Vec3
  /** rpm (`FS`). */
  readonly spindle: number
  /** `Pn:` of the report (`P`: the probe input is closed). */
  readonly pins?: string
}

/** What the runner needs from a connection. */
export interface ProbePort {
  /** A fresh status report (taken now). */
  status(): Promise<AppResult<ProbePortStatus>>
  /** Sends one line and waits for its `ok`; the reply lines (e.g. `[PRB:…]`) come back. */
  command(
    line: string,
    opts?: { readonly timeoutMs?: number },
  ): Promise<AppResult<readonly string[]>>
  /** Calls `listener` on every `ALARM:n` until the returned function is called. */
  onAlarm(listener: (code: number) => void): () => void
  /** `$X` and whatever the connection keeps about the alarm. */
  unlock(): Promise<AppResult<void>>
}

export type ProbeAxis = 'x' | 'y' | 'z'

export interface ProbeCycleSpec {
  readonly axis: ProbeAxis
  /** −1: toward minus (Z down), +1: toward plus. */
  readonly direction: -1 | 1
  /** mm along the axis from the start; the runner never targets past it. */
  readonly maxDistance: number
  /** mm/min of the seek (the only probe without `slow`). */
  readonly fastFeed: number
  /** Back off and re-probe slowly (absent: the seek's contact is the result). */
  readonly slow?: {
    readonly feed: number
    /** mm back from the seek's contact before the slow probe. */
    readonly backOff: number
    /** Slow probes (default 1); more give a spread for the uncertainty. */
    readonly repeats?: number
  }
  /** mm back from the contact at the end (toward the start; Z down: up, at most to MPos 0). */
  readonly retract: number
  /** The machine travel in MPos when soft limits are on: probe targets stay 0.01 mm inside. */
  readonly travel?: { readonly min: Vec3; readonly max: Vec3 }
  /** `$13=1`: `[PRB]` comes in inch. */
  readonly inches?: boolean
  /**
   * On `ALARM:4`/`5`: `'recover'` (default) unlocks, returns to the start and restores the modal
   * state; `'stay'` leaves the alarm to the operator (Probe Z, M4) and hands the restore lines over.
   */
  readonly onAlarm?: 'recover' | 'stay'
  /** Checked before every line; true ends the cycle with `op.aborted` and sends nothing more. */
  readonly cancelled?: () => boolean
  /** Reading resolution, mm (default 0.001: GRBL's mm report). */
  readonly resolution?: number
}

export interface ProbeCycleResult {
  readonly axis: ProbeAxis
  /** The contact on the axis, MPos mm (the mean of the slow probes, else the seek's). */
  readonly value: number
  /** ± mm: the reading resolution, or half the slow probes' spread when larger. */
  readonly uncertainty: number
  /** The last contact, MPos mm. */
  readonly contact: Vec3
  /** The seek's contact, MPos mm. */
  readonly seek: Vec3
  /** The slow probes' contacts on the axis (empty without `slow`). */
  readonly samples: readonly number[]
  /** Where the cycle started, MPos mm. */
  readonly start: Vec3
}

export interface ProbeCycleHooks {
  /** `onAlarm: 'stay'`: the gCode that restores the modal state once GRBL takes gCode again. */
  readonly restorePending?: (lines: readonly string[]) => void
}

const AXES: readonly ProbeAxis[] = ['x', 'y', 'z']
/** Probe targets stay this far inside the travel (GRBL's soft-limit check is inclusive). */
const TRAVEL_MARGIN = 0.01
/** A probe distance shorter than this is refused (`run.travel`). */
const MIN_DISTANCE = 1

export const fmt = (v: number): string => {
  const s = v.toFixed(3).replace(/\.?0+$/, '')
  return s === '-0' ? '0' : s
}

/** `[PRB:x,y,z:flag]` → the contact (report units) and whether the probe touched. */
export function probeResult(lines: readonly string[]): { pos: Vec3; ok: boolean } | undefined {
  for (const l of lines) {
    const m = /^\[PRB:([-\d.]+),([-\d.]+),([-\d.]+):([01])\]$/.exec(l)
    if (m) return { pos: [Number(m[1]), Number(m[2]), Number(m[3])], ok: m[4] === '1' }
  }
  return undefined
}

/**
 * The gCode that puts back what a probe changes in the modal state `$G` reported: units,
 * distance mode and motion (`G1 F…` for a feed motion with a feed set, else `G0`: GRBL cannot set
 * `G2`/`G3` without an arc). Docs: docs/modes/run-machine.md#probing-and-re-zero-m4
 */
export function modalRestore(words: readonly string[], inches: boolean): string[] {
  const has = (w: string) => words.includes(w)
  const motion = words.find((w) => /^G(0|1|2|3|38\.[2-5])$/.test(w)) ?? 'G0'
  const f = Number(words.find((w) => w.startsWith('F'))?.slice(1) ?? '0')
  const feed = (Number.isFinite(f) ? f : 0) * (inches ? 25.4 : 1)
  const feedMotion = motion === 'G1' || motion === 'G2' || motion === 'G3'
  const move = feedMotion && feed > 0 ? `G1 F${fmt(feed)}` : 'G0'
  const lines = [`G21 ${has('G91') ? 'G91' : 'G90'} ${move}`]
  if (has('G20')) lines.push('G20')
  return lines
}

const where = 'probeCycle'

const withAxis = (v: Vec3, i: number, value: number): Vec3 =>
  [i === 0 ? value : v[0], i === 1 ? value : v[1], i === 2 ? value : v[2]] as const

function malformed(path: string, message: string): AppResult<never> {
  return fail('input.malformed', message, {
    where,
    issues: [{ path: [path], rule: 'positive', message }],
  })
}

function checkSpec(s: ProbeCycleSpec): AppResult<void> {
  const positive = (v: number) => Number.isFinite(v) && v > 0
  if (!positive(s.maxDistance)) return malformed('maxDistance', 'the probe distance must be > 0')
  if (!positive(s.fastFeed)) return malformed('fastFeed', 'the probe feed must be > 0')
  if (!(Number.isFinite(s.retract) && s.retract >= 0))
    return malformed('retract', 'the retract must be ≥ 0')
  if (s.slow !== undefined) {
    if (!positive(s.slow.feed)) return malformed('slow.feed', 'the slow feed must be > 0')
    if (!positive(s.slow.backOff)) return malformed('slow.backOff', 'the back-off must be > 0')
    const n = s.slow.repeats ?? 1
    if (!Number.isInteger(n) || n < 1 || n > 10)
      return malformed('slow.repeats', 'the slow probes must be 1 to 10')
  }
  return Ok(undefined)
}

/**
 * Runs one probe cycle (docs/modes/run-probing.md#the-cycle-runner-rv3). The port's alarm and
 * command errors come back as they are (a reset by Stop fails the line in flight).
 */
export async function runProbeCycle(
  port: ProbePort,
  spec: ProbeCycleSpec,
  hooks: ProbeCycleHooks = {},
): Promise<AppResult<ProbeCycleResult>> {
  const checked = checkSpec(spec)
  if (checked.isErr()) return Err(checked.unwrapErr())
  const i = AXES.indexOf(spec.axis)
  const dir = spec.direction
  const A = spec.axis.toUpperCase()
  const k = spec.inches === true ? 25.4 : 1
  const cancelled = () => spec.cancelled?.() === true

  // ── guards: nothing is sent before they pass ──
  const st = await port.status()
  if (st.isErr()) return Err(st.unwrapErr())
  const s = st.unwrap()
  if (s.state !== 'Idle')
    return fail('run.state', `cannot probe in state ${s.state}`, {
      where,
      data: { state: s.state },
    })
  if (s.spindle > 0)
    return fail('run.state', 'the spindle is on: stop it before probing', {
      where,
      data: { state: s.state, spindle: s.spindle },
      issues: [{ path: ['spindle'], rule: 'spindleOn', message: 'turn the spindle off' }],
    })
  if (s.pins?.includes('P') === true)
    return fail(
      'run.state',
      'The probe reads as touching: check the clip, the plate and the probe wire before probing.',
      {
        where,
        data: { state: s.state, pins: s.pins },
        issues: [{ path: [], rule: 'probeTouching', message: 'the probe input is closed' }],
      },
    )
  const start = s.mpos
  const wco: Vec3 = [s.mpos[0] - s.wpos[0], s.mpos[1] - s.wpos[1], s.mpos[2] - s.wpos[2]]
  let distance = spec.maxDistance
  if (spec.travel !== undefined) {
    // never target outside the travel: GRBL would raise a soft-limit alarm before moving
    const limit = dir < 0 ? spec.travel.min[i]! : spec.travel.max[i]!
    distance = Math.min(distance, dir * (limit - start[i]!) - TRAVEL_MARGIN)
    if (distance < MIN_DISTANCE) {
      const end = spec.axis === 'z' ? (dir < 0 ? 'bottom' : 'top') : dir < 0 ? 'minimum' : 'maximum'
      return fail('run.travel', `${A} is at the ${end} of its travel: no room to probe`, {
        where,
        data: {
          axis: spec.axis,
          target: start[i],
          min: spec.travel.min[i],
          max: spec.travel.max[i],
          atEdge: true,
        },
      })
    }
  }
  /** The farthest point the cycle may reach on the axis (MPos). */
  const limitAt = start[i]! + dir * distance
  /** Clamps an axis value to the segment the seek travels (start → limit). */
  const onPath = (v: number) =>
    dir < 0 ? Math.min(start[i]!, Math.max(limitAt, v)) : Math.max(start[i]!, Math.min(limitAt, v))

  const send = async (line: string, timeoutMs?: number): Promise<AppResult<readonly string[]>> => {
    if (cancelled()) return fail('op.aborted', 'the probe cycle was cancelled', { where })
    return port.command(line, timeoutMs === undefined ? {} : { timeoutMs })
  }

  const gc = await send('$G')
  if (gc.isErr()) return Err(gc.unwrapErr())
  const modes = gc.unwrap().find((l) => l.startsWith('[GC:'))
  const restore = modalRestore(modes?.slice(4, -1).split(' ') ?? [], spec.inches === true)

  /** A rapid in machine coordinates on the probe's axis (a path the probe already travelled). */
  const rapid = (v: number) => send(`G21 G53 G0 ${A}${fmt(v)}`)

  /** Restores the modal state; the dwell's `ok` waits for the motion before it. */
  const finish = async (): Promise<AppResult<void>> => {
    for (const line of [...restore, 'G4 P0']) {
      const r = await send(line)
      if (r.isErr()) return Err(r.unwrapErr())
    }
    return Ok(undefined)
  }

  /** On an alarm: stay (Probe Z), or unlock, back to the start, the modal state back. */
  const failed = async (code: number, at: Vec3): Promise<AppResult<never>> => {
    const recover = (spec.onAlarm ?? 'recover') === 'recover'
    if (!recover) hooks.restorePending?.(restore)
    else {
      const u = cancelled()
        ? fail('op.aborted', 'the probe cycle was cancelled', { where })
        : await port.unlock()
      if (u.isErr()) return Err(u.unwrapErr())
      // the failed probe moved along the axis only: going back retraces it
      if (Math.abs(at[i]! - start[i]!) > 1e-6) {
        const r = await rapid(start[i]!)
        if (r.isErr()) return Err(r.unwrapErr())
      }
      const f = await finish()
      if (f.isErr()) return Err(f.unwrapErr())
    }
    return fail('machine.alarm', `ALARM:${code} ${alarmText(code)}`, {
      where,
      data: { code, text: alarmText(code), recovered: recover },
    })
  }

  /** One `G38.2` toward `to` (MPos on the axis): the contact, or the failure handled. */
  let here: Vec3 = start
  const probe = async (to: number, feed: number): Promise<AppResult<Vec3>> => {
    let alarm: number | undefined
    const off = port.onAlarm((code) => {
      alarm = code
    })
    const length = Math.abs(to - here[i]!)
    const r = await send(
      `G21 G90 G38.2 ${A}${fmt(to - wco[i]!)} F${fmt(feed)}`,
      (length / feed) * 60_000 + 10_000,
    )
    off()
    if (r.isErr()) return Err(r.unwrapErr())
    const prb = probeResult(r.unwrap())
    const pos: Vec3 | undefined =
      prb === undefined ? undefined : [prb.pos[0] * k, prb.pos[1] * k, prb.pos[2] * k]
    if (alarm !== undefined || prb?.ok !== true) {
      // ALARM:4 leaves no [PRB] and no motion; a miss ends at its target
      const at: Vec3 = alarm === 4 || pos === undefined ? here : pos
      return failed(alarm ?? 5, at)
    }
    here = pos!
    return Ok(pos!)
  }

  // ── the seek ──
  const seek = await probe(limitAt, spec.fastFeed)
  if (seek.isErr()) return Err(seek.unwrapErr())
  let contact = seek.unwrap()
  const samples: number[] = []
  if (spec.slow !== undefined) {
    const { feed, backOff } = spec.slow
    for (let n = 0; n < (spec.slow.repeats ?? 1); n++) {
      // back along the path the seek came (no contact possible), then slowly toward the surface
      const back = onPath(contact[i]! - dir * backOff)
      const b = await rapid(back)
      if (b.isErr()) return Err(b.unwrapErr())
      here = withAxis(here, i, back)
      const to = onPath(contact[i]! + dir * backOff)
      const slow = await probe(to, feed)
      if (slow.isErr()) return Err(slow.unwrapErr())
      contact = slow.unwrap()
      samples.push(contact[i]!)
    }
  }
  // ── retract: Z up (as far as MPos 0), X/Y back toward the start ──
  const away = contact[i]! - dir * spec.retract
  const retractTo =
    spec.axis === 'z' && dir < 0 ? Math.min(away, spec.travel?.max[2] ?? 0) : onPath(away)
  const r = await rapid(retractTo)
  if (r.isErr()) return Err(r.unwrapErr())
  const f = await finish()
  if (f.isErr()) return Err(f.unwrapErr())

  const values = samples.length > 0 ? samples : [seek.unwrap()[i]!]
  const value = values.reduce((a, b) => a + b, 0) / values.length
  const spread = Math.max(...values) - Math.min(...values)
  const resolution = spec.resolution ?? (spec.inches === true ? 0.00254 : 0.001)
  return Ok({
    axis: spec.axis,
    value,
    uncertainty: Math.max(resolution, spread / 2),
    contact,
    seek: seek.unwrap(),
    samples,
    start,
  })
}
