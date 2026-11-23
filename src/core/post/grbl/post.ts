/**
 * GRBL 1.1 post-processor: MachiningProgram → gCode text.
 * Doc: docs/architecture/grbl.md#post-processor-task-211
 *
 * Pure and deterministic: same program and options → byte-identical text (LF, final newline,
 * no dates). Modal suppression, number formatting, header, tool changes and footer follow the
 * output dialect in the doc.
 */
import type { Issue } from '../../../shared/errors/app-error'
import { fail, Ok, type AppResult } from '../../../shared/result'
import type { Vec3 } from '../../toolpath/model'
import type { Block, MachiningProgram, SetupHeader } from '../program'
import {
  commentLine,
  formatNumber,
  MAX_ABS_VALUE,
  MAX_LINE_BYTES,
  toolChangeMarker,
} from './format'

export interface PostOptions {
  /** Generator string for the header (e.g. `DFYOM 0.1.42`); tests pass a fixed one. */
  readonly generator: string
  /** Dwell after `M3` (s); GRBL does not wait for the spindle. Default 3. */
  readonly spinUpSeconds?: number
  /** The first tool is already in the spindle: no `M0` for it. Default true. */
  readonly firstToolLoaded?: boolean
}

export const DEFAULT_SPIN_UP_SECONDS = 3

const MM_PER_INCH = 25.4
const AXES = ['X', 'Y', 'Z'] as const
/** An arc whose written chord is below this many resolution units is written as `G1`. */
const MIN_ARC_CHORD_UNITS = 10
/** An arc whose sagitta is at most this many resolution units is written as `G1`. */
const ARC_FLAT_STEPS = 0.5
/**
 * Arcs of a larger radius (mm) are written as `G1` chords: GRBL holds I/J in float32, whose step
 * at 10 m is ≈ 0.001 mm, so its centre (and its `error:33` check) would drift.
 */
export const ARC_HUGE_RADIUS = 10_000
/** Max sagitta of each chord of a huge-radius arc (mm): one mm resolution step. */
const ARC_HUGE_TOLERANCE = 0.001
/** GRBL's arc target check (gc_execute_line, error:33), mm. */
const ARC_RADIUS_ERROR = 0.005
const ARC_RADIUS_ERROR_REL = 0.001
/**
 * Max distance (mm) along the arc between the intended end and the one GRBL computes, beyond
 * rounding (plus 4 resolution steps): catches wrap-arounds and direction flips only.
 */
const ARC_SWEEP_TOLERANCE = 0.005
const ARC_SWEEP_STEPS = 4

type Motion = 'G0' | 'G1' | 'G2' | 'G3'

/** Units of the text: factor from mm, decimals of coordinates. */
interface Units {
  readonly perMm: number
  readonly decimals: number
}

/** The gCode lines of `program` (no line ends). */
export function postGrblLines(program: MachiningProgram, opts: PostOptions): AppResult<string[]> {
  const issues = validate(program, opts)
  if (issues.length > 0)
    return fail('model.invariant', `${issues.length} invalid program value(s)`, {
      issues,
      where: 'postGrbl',
    })
  return new Writer(program, opts).write()
}

/** gCode text of `program`: LF line ends and a final newline. */
export function postGrbl(program: MachiningProgram, opts: PostOptions): AppResult<string> {
  return postGrblLines(program, opts).map((lines) => `${lines.join('\n')}\n`)
}

function validate(p: MachiningProgram, opts: PostOptions): Issue[] {
  const issues: Issue[] = []
  const perMm = p.units === 'in' ? 1 / MM_PER_INCH : 1
  /**
   * `v` as written is `v × scale` (lengths and feeds: `perMm`; rpm: 1). `decimals`: the written
   * value must stay > 0 with that many decimals.
   */
  const num = (path: (string | number)[], v: number, scale = perMm, decimals?: number) => {
    const w = v * scale
    if (!Number.isFinite(w) || Math.abs(w) > MAX_ABS_VALUE)
      issues.push({ path, message: `must be finite and within ±${MAX_ABS_VALUE}`, rule: 'range' })
    else if (decimals !== undefined && !(w > 0 && formatNumber(w, decimals) !== '0'))
      issues.push({ path, message: 'must be > 0 when written', rule: 'positive' })
  }
  num(['clearanceZ'], p.clearanceZ)
  const spin = opts.spinUpSeconds ?? DEFAULT_SPIN_UP_SECONDS
  if (!Number.isFinite(spin) || spin < 0 || spin > 3600)
    issues.push({ path: ['spinUpSeconds'], message: 'must be 0..3600 s', rule: 'range' })
  let spindleOn = false
  p.blocks.forEach((b, k) => {
    const at = ['blocks', k]
    if (b.kind === 'rapid' || b.kind === 'feed' || b.kind === 'arc')
      b.to.forEach((v, a) => num([...at, 'to', a], v))
    if (b.kind === 'feed' || b.kind === 'arc') {
      num([...at, 'feed'], b.feed, perMm, 1)
      if (!spindleOn)
        issues.push({ path: at, message: 'feed move with the spindle off', rule: 'spindleOff' })
    }
    if (b.kind === 'arc') {
      // huge radii go out as chords (Writer.arc): their I/J are never written
      if (!(Math.hypot(b.i, b.j) > ARC_HUGE_RADIUS)) {
        num([...at, 'i'], b.i)
        num([...at, 'j'], b.j)
      }
      if (b.i === 0 && b.j === 0)
        issues.push({ path: at, message: 'arc without a radius', rule: 'arcRadius' })
    }
    if (b.kind === 'spindle') {
      if (b.rpm !== 'off') num([...at, 'rpm'], b.rpm, 1, 0)
      spindleOn = b.rpm !== 'off'
    }
    if (b.kind === 'toolChange') {
      num([...at, 'tool', 'diameter'], b.tool.diameter)
      if (!Number.isInteger(b.number) || b.number < 1)
        issues.push({ path: [...at, 'number'], message: 'must be 1, 2, …', rule: 'integer' })
      spindleOn = false
    }
  })
  return issues
}

class Writer {
  private readonly lines: string[] = []
  private readonly units: Units
  /** Last written axis words (text) and the float position they stand for; undefined = unknown. */
  private readonly text: (string | undefined)[] = [undefined, undefined, undefined]
  private readonly pos: (number | undefined)[] = [undefined, undefined, undefined]
  private motion: Motion | undefined
  private feed: string | undefined
  private toolLoaded = false
  private readonly issues: Issue[] = []

  constructor(
    private readonly p: MachiningProgram,
    private readonly opts: PostOptions,
  ) {
    this.units =
      p.units === 'in' ? { perMm: 1 / MM_PER_INCH, decimals: 4 } : { perMm: 1, decimals: 3 }
  }

  write(): AppResult<string[]> {
    this.header()
    this.p.blocks.forEach((b, k) => this.block(b, k))
    this.footer()
    for (const [k, l] of this.lines.entries())
      if (l.length > MAX_LINE_BYTES)
        this.issues.push({
          path: ['lines', k],
          message: `line over ${MAX_LINE_BYTES} bytes: ${l}`,
          rule: 'lineLength',
        })
    if (this.issues.length > 0)
      return fail('model.invariant', `${this.issues.length} block(s) cannot be written`, {
        issues: this.issues,
        where: 'postGrbl',
      })
    return Ok(this.lines)
  }

  // ── Sections ──────────────────────────────────────────────────────────────────────────

  private header(): void {
    const p = this.p
    this.comment(`Program: ${p.name}`)
    if (p.setup === undefined) this.comment(`Setup: ${p.setupName}`)
    else this.setupComments(p.setup)
    this.comment(`Units: ${p.units === 'in' ? 'inch' : 'mm'}`)
    const seen = new Set<number>()
    for (const b of p.blocks) {
      if (b.kind !== 'toolChange' || seen.has(b.number)) continue
      seen.add(b.number)
      const d = this.coord(b.tool.diameter)
      this.comment(`Tool ${b.number}: ${b.tool.name}, dia ${d} ${p.units}`)
    }
    this.comment(`Generator: ${this.opts.generator}`)
    this.modes()
    this.clearance()
  }

  /** The setup instructions (DF58): docs/architecture/grbl.md#setup-header-hardening-df58. */
  private setupComments(h: SetupHeader): void {
    const [x, y, z] = h.stock.map((v) => this.coord(v))
    const corner = h.corner.replace(' ', '-')
    this.comment(`Setup ${h.number} of ${h.count}: ${this.p.setupName}`)
    this.comment(`Stock X ${x} Y ${y} Z ${z} ${this.p.units} on the machine`)
    this.comment(`Faces: ${h.up} up, ${h.front} towards you, ${h.right} on the right`)
    if (h.fromFirst !== undefined) this.comment(`From setup 1: ${h.fromFirst}`)
    this.comment(`Work zero G54 X0 Y0: ${corner} corner of the ${h.up} face`)
    this.comment('That corner sits front left on the machine')
    this.comment(`Z0 on the ${h.up} face: the stock surface facing up`)
  }

  private modes(): void {
    this.lines.push(`G90 G94 G17 ${this.p.units === 'in' ? 'G20' : 'G21'}`)
    this.lines.push('G54')
  }

  private footer(): void {
    this.clearance(false)
    this.lines.push('M5')
    if (this.p.spindleControl === 'manual') {
      this.comment('Stop the spindle')
      this.lines.push('M0')
    }
    this.lines.push('M30')
  }

  private block(b: Block, k: number): void {
    switch (b.kind) {
      case 'comment':
        return this.comment(b.text)
      case 'toolChange':
        return this.toolChange(b.number, b.tool.name)
      case 'spindle':
        return this.spindle(b.rpm)
      case 'rapid':
        return this.move('G0', b.to)
      case 'feed':
        return this.move('G1', b.to, b.feed)
      case 'arc':
        return this.arc(b, k)
    }
  }

  /** `M5`, retract, marker, `M0`; the first tool only gets the marker unless it is not loaded. */
  private toolChange(number: number, name: string): void {
    const first = !this.toolLoaded
    this.toolLoaded = true
    if (!first) {
      this.lines.push('M5')
      this.clearance(false)
      // Before the marker: the marker line must be followed directly by M0 (sender rule).
      if (this.p.spindleControl === 'manual') this.comment('Stop the spindle')
    }
    this.lines.push(toolChangeMarker(number, name))
    if (first && this.opts.firstToolLoaded !== false) return
    this.lines.push('M0')
    // The user jogged and re-zeroed Z while paused: forget the position and modal motion/feed,
    // and go back to clearance in the new WCS before the spindle starts.
    this.text.fill(undefined)
    this.pos.fill(undefined)
    this.motion = undefined
    this.feed = undefined
    // ... and may have left other modes (MDI in G91, another WCS): state them again.
    this.modes()
    this.clearance()
  }

  private spindle(rpm: number | 'off'): void {
    if (rpm === 'off') {
      this.lines.push('M5')
      return
    }
    const s = formatNumber(rpm, 0)
    this.lines.push(`M3 S${s}`)
    if (this.p.spindleControl === 'manual') {
      this.comment(`Set spindle to ${s} rpm`)
      this.lines.push('M0')
      return
    }
    const p = formatNumber(this.opts.spinUpSeconds ?? DEFAULT_SPIN_UP_SECONDS, 2)
    if (p !== '0') this.lines.push(`G4 P${p}`)
  }

  // ── Motion ────────────────────────────────────────────────────────────────────────────

  /**
   * `G0 Z<clearanceZ>`. `force` (header, after a tool change's `M0`, where Z is unknown or in a
   * new WCS) writes it always; otherwise (before a tool change, footer) only when Z differs.
   */
  private clearance(force = true): void {
    const z = this.p.clearanceZ
    this.emit('G0', [this.pos[0], this.pos[1], z], [false, false, force], [])
  }

  private move(code: 'G0' | 'G1', to: Vec3, feed?: number): void {
    this.emit(code, to, [false, false, false], [], feed)
  }

  private arc(b: Extract<Block, { kind: 'arc' }>, k: number): void {
    const [x0, y0] = this.pos
    const [tx0, ty0] = this.text
    if (x0 === undefined || y0 === undefined || tx0 === undefined || ty0 === undefined) {
      this.issues.push({
        path: ['blocks', k],
        message: 'arc from an unknown position',
        rule: 'arcStart',
      })
      return this.skip(b.to)
    }
    const u = this.units
    const cx = x0 + b.i
    const cy = y0 + b.j
    const full = b.to[0] === x0 && b.to[1] === y0
    // Written start (what GRBL holds) and end, in text units.
    const sx = Number(tx0)
    const sy = Number(ty0)
    const ex = Number(this.coord(b.to[0]))
    const ey = Number(this.coord(b.to[1]))
    const res = 10 ** -u.decimals
    if (!full && Math.hypot(ex - sx, ey - sy) < MIN_ARC_CHORD_UNITS * res - res / 2) {
      // Too short to write as an arc: GRBL would read near-equal ends as a full circle.
      return this.move('G1', b.to, b.feed)
    }
    // Flat arcs as G1: a line within half a resolution step of the arc is the same cut as
    // written. Huge radii (offsets of fitted curves) as G1 chords within 0.001 mm: GRBL computes
    // I/J in float32 (docs/architecture/grbl.md#output-dialect).
    const r = Math.hypot(b.i, b.j)
    if (!full) {
      const half = Math.hypot(b.to[0] - x0, b.to[1] - y0) / 2
      if (r - Math.sqrt(Math.max(0, r * r - half * half)) <= (res / u.perMm) * ARC_FLAT_STEPS)
        return this.move('G1', b.to, b.feed)
    }
    if (r > ARC_HUGE_RADIUS) {
      const z0 = this.pos[2] ?? b.to[2]
      const total = full
        ? (b.cw ? -2 : 2) * Math.PI
        : sweep(x0 - cx, y0 - cy, b.to[0] - cx, b.to[1] - cy, b.cw)
      const n = Math.max(
        1,
        Math.ceil(Math.abs(total) / (2 * Math.acos(1 - ARC_HUGE_TOLERANCE / r))),
      )
      const a0 = Math.atan2(y0 - cy, x0 - cx)
      for (let k = 1; k < n; k++) {
        const a = a0 + (total * k) / n
        this.move(
          'G1',
          [cx + r * Math.cos(a), cy + r * Math.sin(a), z0 + ((b.to[2] - z0) * k) / n],
          b.feed,
        )
      }
      return this.move('G1', b.to, b.feed)
    }
    // I/J: center − written start, rounded. GRBL checks that the end lies on that circle
    // (error:33 beyond 0.005 mm and 0.1 %); at 4 inch decimals and small radii rounding can
    // miss that, so the post then takes the neighbouring I/J (± one step) closest to the end.
    const toMm = 1 / u.perMm
    const fit = (i: string, j: string) => {
      const ci = sx + Number(i)
      const cj = sy + Number(j)
      const r0 = Math.hypot(sx - ci, sy - cj) * toMm
      const delta = Math.abs(Math.hypot(ex - ci, ey - cj) * toMm - r0)
      const ok = !(delta > ARC_RADIUS_ERROR && (delta > 0.5 || delta > ARC_RADIUS_ERROR_REL * r0))
      return { i, j, ci, cj, r0, delta, ok }
    }
    const i0 = cx * u.perMm - sx
    const j0 = cy * u.perMm - sy
    let best = fit(formatNumber(i0, u.decimals), formatNumber(j0, u.decimals))
    if (!best.ok)
      for (const di of [-1, 0, 1])
        for (const dj of [-1, 0, 1]) {
          const c = fit(
            formatNumber(Number(best.i) + di * res, u.decimals),
            formatNumber(Number(best.j) + dj * res, u.decimals),
          )
          if (c.delta < best.delta) best = c
        }
    const { i, j, ci, cj, r0 } = best
    if (!best.ok) {
      this.issues.push({
        path: ['blocks', k],
        message: `arc ends ${best.delta} mm off its radius`,
        rule: 'arcRadius',
      })
      return this.skip(b.to)
    }
    if (!full) {
      const want = sweep(x0 - cx, y0 - cy, b.to[0] - cx, b.to[1] - cy, b.cw)
      const got = sweep(sx - ci, sy - cj, ex - ci, ey - cj, b.cw)
      if (Math.abs(want - got) * r0 > ARC_SWEEP_TOLERANCE + ARC_SWEEP_STEPS * res * toMm) {
        this.issues.push({
          path: ['blocks', k],
          message: 'arc sweep changes when written',
          rule: 'arcSweep',
        })
        return this.skip(b.to)
      }
    }
    // An arc needs an axis word in the plane (GRBL error:32): full circles write X and Y.
    this.emit(b.cw ? 'G2' : 'G3', b.to, [full, full, false], [`I${i}`, `J${j}`], b.feed)
  }

  /**
   * Writes a motion line: the motion code if it changed, the axis words that changed (or are
   * forced), `ij`, and F if it changed. Drops the line when no axis word is left (F stays
   * pending, as it is compared with the last written F).
   */
  private emit(
    code: Motion,
    to: readonly (number | undefined)[],
    force: readonly boolean[],
    ij: readonly string[],
    feed?: number,
  ): void {
    const words: string[] = []
    const next = [...this.text]
    AXES.forEach((a, k) => {
      const v = to[k]
      if (v === undefined) return
      const t = this.coord(v)
      if (t !== this.text[k] || force[k]) words.push(`${a}${t}`)
      next[k] = t
    })
    // A dropped line still moves the float position (arc offsets are relative to it).
    if (words.length > 0) {
      const f = feed === undefined ? undefined : formatNumber(feed * this.units.perMm, 1)
      const fw = f === undefined || f === this.feed ? [] : [`F${f}`]
      const head = code === this.motion ? [] : [code]
      this.lines.push([...head, ...words, ...ij, ...fw].join(' '))
      this.motion = code
      if (f !== undefined) this.feed = f
    }
    AXES.forEach((_, k) => {
      const v = to[k]
      if (v === undefined) return
      this.text[k] = next[k]
      this.pos[k] = v
    })
  }

  /** After a failed block: continue from its end, so later blocks are checked on their own. */
  private skip(to: Vec3): void {
    to.forEach((v, k) => {
      this.pos[k] = v
      this.text[k] = this.coord(v)
    })
  }

  /** A length (mm) in text units. */
  private coord(mm: number): string {
    return formatNumber(mm * this.units.perMm, this.units.decimals)
  }

  private comment(text: string): void {
    this.lines.push(commentLine(text))
  }
}

/** Signed sweep (CCW > 0) from vector a to vector b around the center, GRBL's convention. */
function sweep(ax: number, ay: number, bx: number, by: number, cw: boolean): number {
  let t = Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
  const EPS = 5e-7 // ARC_ANGULAR_TRAVEL_EPSILON
  if (cw) {
    if (t >= -EPS) t -= 2 * Math.PI
  } else if (t <= EPS) t += 2 * Math.PI
  return t
}
