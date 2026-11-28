/**
 * `generateLine` (engraved-patterns.md E1): a Line's grooves on their centrelines, in depth passes
 * of at most `stepdown`. Pass k cuts z_k(s) = max(z(s), onZ − k · stepdown), the last the profile.
 * Open lines alternate direction (no return rapid) and enter each pass by a ramp-back: along the
 * floor already cut `Lr` ahead, then back to the pass start at ≤ `rampAngle`, never below the
 * pass; a line too short for that zigzags on itself. Closed lines keep their direction, start at
 * the middle of their longest element (a constant depth; else at their start) and ramp along the
 * loop. `entry: 'plunge'` feeds straight down. Arcs become helical arcs, split at 90° and at the
 * profile's breaks. Lines in nearest-neighbour order from the face frame's origin (front-left),
 * each open line entered at its nearer end; all passes of a line before the next.
 * Doc: docs/modes/engraved-patterns.md#toolpath-plan
 */
import { Err, Ok, type AppResult } from '../../shared/result'
import { arcRadius, arcSweep, elementLength, type Element } from '../geometry/2d/model'
import { elementPoint, lineChains, type LineProfile, type ResolvedLine } from '../geometry/line'
import type { LineGeometry, Vec2, Vec3 } from '../geometry/model'
import { noSteps, type Steps } from '../workers/steps'
import { commonIssues, toolpath } from './common'
import type { CuttingParams, GeneratorInput, Toolpath, ToolpathTool } from './model'
import { MoveBuilder, segSlice, type Seg } from './path'

/** A Line in the face frame without its direction (generators are top-down). */
export type LineOperation = Omit<LineGeometry, 'direction'>

export interface LineStrategy {
  /** `ramp`: ramp-back at ≤ `rampAngle`; `plunge`: straight down at the plunge rate (V-bits). */
  readonly entry: 'ramp' | 'plunge'
  /** Degrees, (0, 90). */
  readonly rampAngle: number
}

export type LineCutting = Pick<
  CuttingParams,
  'spindleSpeed' | 'feedRate' | 'plungeRate' | 'stepdown'
>

export type LineInput = GeneratorInput<LineOperation, LineStrategy, LineCutting>

/**
 * Whether `tool` has the shape of `cutter` (DF135 C4 follow-up): a recut Line credits its as-cut
 * groove only then (the groove was cut by the Line's cutter; a wider tool would meet more than one
 * stepdown of material on its first kept pass).
 * Doc: docs/modes/cut-state.md#edge-operations-engravings-and-through-holes-c4-follow-up
 */
export function isCutter(tool: ToolpathTool, cutter: LineGeometry['cutter']): boolean {
  const same = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) <= 1e-9
  if (!same(tool.diameter, cutter.diameter)) return false
  if (cutter.kind === 'vBit')
    return (
      tool.type === 'chamferMill' &&
      same(tool.angle, cutter.angle) &&
      same(tool.tipDiameter ?? 0, cutter.tipDiameter)
    )
  if (cutter.kind === 'taperedBall')
    return (
      tool.type === 'taperedBallEndMill' &&
      same(tool.tipDiameter, cutter.tipDiameter) &&
      same(tool.taperAngle, cutter.taperAngle)
    )
  return tool.type === (cutter.kind === 'ball' ? 'ballEndMill' : 'flatEndMill')
}

const EPS = 1e-9
/** Moves shorter than this are dropped (mm). */
const MIN_MOVE = 1e-6

/** A piecewise-linear Z along a line (s ascending, two equal s = a step). */
export interface ZProfile {
  readonly s: readonly number[]
  readonly z: readonly number[]
}

export function evalZ(f: ZProfile, s: number): number {
  const n = f.s.length
  if (s <= f.s[0]!) return f.z[0]!
  if (s >= f.s[n - 1]!) return f.z[n - 1]!
  for (let k = 1; k < n; k++)
    if (s <= f.s[k]!) {
      const s0 = f.s[k - 1]!
      const s1 = f.s[k]!
      return s1 === s0 ? f.z[k]! : f.z[k - 1]! + ((f.z[k]! - f.z[k - 1]!) * (s - s0)) / (s1 - s0)
    }
  return f.z[n - 1]!
}

/** max(f, g), the shallower of two profiles, with their crossings inserted. */
export function maxZ(f: ZProfile, g: ZProfile): ZProfile {
  const ss = [...new Set([...f.s, ...g.s])].sort((a, b) => a - b)
  const s: number[] = []
  const z: number[] = []
  for (let k = 0; k < ss.length; k++) {
    const a = ss[k]!
    if (k > 0) {
      const p = ss[k - 1]!
      const d0 = evalZ(f, p) - evalZ(g, p)
      const d1 = evalZ(f, a) - evalZ(g, a)
      if (d0 * d1 < 0) {
        const c = p + ((a - p) * d0) / (d0 - d1)
        s.push(c)
        z.push(evalZ(f, c))
      }
    }
    s.push(a)
    z.push(Math.max(evalZ(f, a), evalZ(g, a)))
  }
  return { s, z }
}

const flatZ = (L: number, z: number): ZProfile => ({ s: [0, L], z: [z, z] })

/** The Z profile of a line's depths below `onZ`. */
export const zOf = (p: LineProfile, onZ: number): ZProfile => ({
  s: p.s,
  z: p.d.map((d) => onZ - d),
})

/** The number of depth passes: ⌈max depth / stepdown⌉, at least one. */
export function linePassCount(maxDepth: number, stepdown: number): number {
  return Math.max(1, Math.ceil(maxDepth / stepdown - 1e-9))
}

/** Pass k's target (1-based): the profile, no deeper than onZ − k · stepdown. */
export function passTarget(z: ZProfile, onZ: number, k: number, stepdown: number): ZProfile {
  const L = z.s[z.s.length - 1]!
  return maxZ(z, flatZ(L, onZ - k * stepdown))
}

/** A line as a path by arc length: points, pieces and breaks (element ends, every 90° of arc). */
export class LinePath {
  readonly length: number
  private readonly starts: number[] = []
  readonly breaks: readonly number[]
  constructor(
    readonly elements: readonly Element[],
    readonly closed: boolean,
  ) {
    let acc = 0
    const breaks: number[] = []
    for (const e of elements) {
      this.starts.push(acc)
      breaks.push(acc)
      const L = elementLength(e)
      if (e.kind === 'arc') {
        const n = Math.ceil(Math.abs(arcSweep(e)) / (Math.PI / 2) - 1e-9)
        for (let j = 1; j < n; j++) breaks.push(acc + (L * j) / n)
      }
      acc += L
    }
    breaks.push(acc)
    this.length = acc
    this.breaks = breaks
  }

  /** `s` folded into [0, L] (a closed line wraps; an open one clamps). */
  fold(s: number): number {
    const L = this.length
    if (!this.closed) return Math.min(L, Math.max(0, s))
    const m = ((s % L) + L) % L
    return m
  }

  private index(s: number): number {
    for (let k = this.elements.length - 1; k > 0; k--) if (s >= this.starts[k]! - 1e-12) return k
    return 0
  }

  point(s: number): Vec2 {
    const f = this.fold(s)
    const k = this.index(f)
    const L = elementLength(this.elements[k]!)
    return elementPoint(this.elements[k]!, L <= 0 ? 0 : Math.min(1, (f - this.starts[k]!) / L))
  }

  /** The planar piece from `s0` to `s1` (both within one element of the folded line). */
  piece(s0: number, s1: number): Seg {
    // a closed line's unwrapped s: shifted by the laps its middle is past
    const mid = this.fold((s0 + s1) / 2)
    const off = mid - (s0 + s1) / 2
    const k = this.index(mid)
    const e = this.elements[k]!
    const L = elementLength(e)
    const u0 = (s0 + off - this.starts[k]!) / L
    const u1 = (s1 + off - this.starts[k]!) / L
    const seg: Seg =
      e.kind === 'line'
        ? { kind: 'line', from: e.a, to: e.b }
        : {
            kind: 'arc',
            center: e.centre,
            radius: arcRadius(e),
            start: Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0]),
            sweep: arcSweep(e),
          }
    return segSlice(seg, u0, u1)
  }

  /** The breaks between `lo` and `hi` (unwrapped, ascending), the closed line's repeated per lap. */
  breaksIn(lo: number, hi: number, extra: readonly number[]): number[] {
    const L = this.length
    const base = [...this.breaks, ...extra]
    const out: number[] = []
    if (!this.closed) {
      for (const b of base) if (b > lo && b < hi) out.push(b)
      return out.sort((a, b) => a - b)
    }
    for (let lap = Math.floor(lo / L) - 1; lap * L <= hi; lap++)
      for (const b of base) {
        const x = lap * L + b
        if (x > lo && x < hi) out.push(x)
      }
    return out.sort((a, b) => a - b)
  }
}

/**
 * Moves along the line from `sA` to `sB` (either way; a closed line's unwrapped) at z(s): `G1`s
 * on lines, helical arcs on arcs, split at every break of the path and of `breaks`.
 */
function along(
  b: MoveBuilder,
  path: LinePath,
  sA: number,
  sB: number,
  z: (s: number) => number,
  breaks: readonly number[],
  feed: number,
): void {
  const lo = Math.min(sA, sB)
  const hi = Math.max(sA, sB)
  const cuts = [lo, ...path.breaksIn(lo, hi, breaks), hi]
  const unique = cuts.filter((x, i) => i === 0 || x - cuts[i - 1]! > MIN_MOVE)
  if (unique.length > 1 && hi - unique.at(-1)! <= MIN_MOVE) unique[unique.length - 1] = hi
  if (sB < sA) unique.reverse()
  for (let k = 1; k < unique.length; k++) {
    const s0 = unique[k - 1]!
    const s1 = unique[k]!
    if (Math.abs(s1 - s0) <= MIN_MOVE) continue
    const seg = path.piece(Math.min(s0, s1), Math.max(s0, s1))
    const oriented: Seg =
      s1 > s0
        ? seg
        : seg.kind === 'line'
          ? { kind: 'line', from: seg.to, to: seg.from }
          : { ...seg, start: seg.start + seg.sweep, sweep: -seg.sweep }
    b.seg({ seg: oriented, z0: z(s0), z1: z(s1) }, feed)
  }
}

/** A closed line with a constant depth starts at the middle of its longest element. */
function startAtLongest(l: ResolvedLine): readonly Element[] {
  if (!l.closed || l.elements.length === 0) return l.elements
  const d = l.profile.d
  if (d.some((x) => Math.abs(x - d[0]!) > EPS)) return l.elements
  let best = 0
  l.elements.forEach((e, i) => {
    if (elementLength(e) > elementLength(l.elements[best]!) + 1e-9) best = i
  })
  const e = l.elements[best]!
  const m = elementPoint(e, 0.5)
  const first: Element =
    e.kind === 'line' ? { ...e, b: m } : { kind: 'arc', a: e.a, b: m, centre: e.centre, ccw: e.ccw }
  const second: Element =
    e.kind === 'line' ? { ...e, a: m } : { kind: 'arc', a: m, b: e.b, centre: e.centre, ccw: e.ccw }
  return [second, ...l.elements.slice(best + 1), ...l.elements.slice(0, best), first]
}

/** A line to cut: its path and Z profile; an open line maybe reversed (entered at its far end). */
interface Cut {
  readonly path: LinePath
  readonly z: ZProfile
}

function reversed(l: ResolvedLine): ResolvedLine {
  const L = l.length
  const elements = [...l.elements]
    .reverse()
    .map((e): Element =>
      e.kind === 'line'
        ? { ...e, a: e.b, b: e.a }
        : { kind: 'arc', a: e.b, b: e.a, centre: e.centre, ccw: !e.ccw },
    )
  const s = [...l.profile.s].reverse().map((x) => L - x)
  const d = [...l.profile.d].reverse()
  return { ...l, elements, profile: { s, d } }
}

/** What one line's cut came to (tests and the read-out). */
export interface LineCutReport {
  readonly passes: number
  /** Per pass, the ramp's length along the line (mm; 0 for a plunge). */
  readonly rampLengths: readonly number[]
}

/**
 * One line's passes (the tool above its start at clearance before, at clearance after).
 * Returns where it ended (XY). With `top` (below `onZ`: DF135 C4, a recut Line's as-cut groove
 * cut down to there along the line) the floor is already cut at `top`: the passes nowhere below it
 * are dropped (the last is always kept) and the first kept pass enters from it.
 * Doc: docs/modes/cut-state.md#edge-operations-engravings-and-through-holes-c4-follow-up
 */
export function cutLine(
  b: MoveBuilder,
  cut: Cut,
  onZ: number,
  c: LineCutting,
  st: LineStrategy,
  heights: { readonly clearanceHeight: number; readonly retractHeight: number },
  top?: number,
): LineCutReport & { readonly end: Vec2 } {
  const { path, z } = cut
  const L = path.length
  const deepest = Math.min(...z.z)
  const n = linePassCount(onZ - deepest, c.stepdown)
  const floor = top === undefined ? onZ : Math.min(onZ, top)
  const tan = Math.tan((st.rampAngle * Math.PI) / 180)
  const at = (s: number, h: number): Vec3 => {
    const p = path.point(s)
    return [p[0], p[1], h]
  }
  const retract = onZ + heights.retractHeight
  const rampLengths: number[] = []
  // the floor already cut: the old groove's, never below the line itself
  let prev = floor < onZ ? maxZ(flatZ(L, floor), z) : flatZ(L, onZ)
  let here = 0
  // passes cut so far (the first enters from clearance; open lines alternate by it)
  let cuts = 0
  const zf = (f: ZProfile) => (s: number) => evalZ(f, path.fold(s))
  for (let k = 1; k <= n; k++) {
    const target = passTarget(z, onZ, k, c.stepdown)
    // C4: a pass nowhere below the as-cut groove's floor is in the air
    if (k < n && floor < onZ && Math.min(...target.z) >= floor - EPS) continue
    const first = cuts === 0
    cuts++
    if (path.closed) {
      // a closed line: from where the last pass ended, down along the loop, then one lap
      const sA = here
      const zA = evalZ(prev, path.fold(sA))
      if (first) {
        b.rapid(at(sA, heights.clearanceHeight))
        b.rapid(at(sA, retract))
        b.line(at(sA, evalZ(prev, path.fold(sA))), c.plungeRate)
      }
      let Lr = 0
      if (st.entry === 'plunge') b.line(at(sA, evalZ(target, path.fold(sA))), c.plungeRate)
      else {
        const drop = zA - Math.min(...target.z)
        Lr = Math.max(0, drop / tan)
        if (Lr > MIN_MOVE) {
          const ramp = (s: number) => Math.max(zA - (s - sA) * tan, evalZ(target, path.fold(s)))
          along(b, path, sA, sA + Lr, ramp, target.s, c.feedRate)
        }
      }
      rampLengths.push(Lr)
      const s0 = sA + Lr
      along(b, path, s0, s0 + L, zf(target), target.s, c.feedRate)
      here = path.fold(s0 + L)
      prev = target
      continue
    }
    // an open line: alternating direction, ramp-back from Lr ahead
    const fwd = cuts % 2 === 1
    const sA = fwd ? 0 : L
    const dir = fwd ? 1 : -1
    const zA = evalZ(target, sA)
    if (st.entry === 'plunge') {
      if (first) {
        b.rapid(at(sA, heights.clearanceHeight))
        b.rapid(at(sA, retract))
      }
      b.line(at(sA, zA), c.plungeRate)
      rampLengths.push(0)
    } else {
      let Lr = Math.max(0, (evalZ(prev, sA) - zA) / tan)
      Lr = Math.max(Lr, (evalZ(prev, sA + dir * Math.min(L, Lr)) - zA) / tan)
      if (Lr <= L) {
        const sR = sA + dir * Lr
        if (first) {
          b.rapid(at(sR, heights.clearanceHeight))
          b.rapid(at(sR, retract))
          b.line(at(sR, evalZ(prev, sR)), c.plungeRate)
        } else along(b, path, here, sR, zf(prev), prev.s, c.feedRate)
        if (Lr > MIN_MOVE) {
          const zR = evalZ(prev, sR)
          const ramp = (s: number) =>
            Math.max(zR + ((zA - zR) * Math.abs(s - sR)) / Lr, evalZ(target, s))
          along(b, path, sR, sA, ramp, target.s, c.feedRate)
        }
        rampLengths.push(Lr)
      } else {
        // too short to ramp back: zigzag on itself, an even number of legs, ≤ rampAngle
        const zS = evalZ(prev, sA)
        const legs = 2 * Math.ceil(Lr / (2 * L) - 1e-9)
        const drop = zS - zA
        if (first) {
          b.rapid(at(sA, heights.clearanceHeight))
          b.rapid(at(sA, retract))
          b.line(at(sA, zS), c.plungeRate)
        }
        for (let leg = 0; leg < legs; leg++) {
          const from = leg % 2 === 0 ? sA : L - sA
          const to = L - from
          const t0 = leg * L
          const ramp = (s: number) =>
            Math.max(zS - (drop * (t0 + Math.abs(s - from))) / (legs * L), evalZ(target, s))
          along(b, path, from, to, ramp, target.s, c.feedRate)
        }
        rampLengths.push(legs * L)
      }
    }
    along(b, path, sA, fwd ? L : 0, zf(target), target.s, c.feedRate)
    here = fwd ? L : 0
    prev = target
  }
  const end = path.point(here)
  b.rapid([end[0], end[1], heights.clearanceHeight])
  return { passes: cuts, rampLengths, end }
}

export function generateLine(input: LineInput, steps: Steps = noSteps): AppResult<Toolpath> {
  const { cutting: c, operation: op, strategy: st, heights } = input
  const issues = commonIssues(input)
  if (!(st.rampAngle > 0 && st.rampAngle < 90))
    issues.rule('invariant', 'strategy.rampAngle', 'range', 'rampAngle must be in (0°, 90°)', {
      rampAngle: st.rampAngle,
    })
  if ('min' in op.depth) {
    issues.positive('operation.depth.min', op.depth.min)
    issues.positive('operation.depth.max', op.depth.max)
  } else {
    issues.positive('operation.depth.start', op.depth.start)
    issues.positive('operation.depth.end', op.depth.end)
  }
  const ok = issues.result('generateLine', input.planOperationId)
  if (ok.isErr()) return Err(ok.unwrapErr())
  const left = lineChains(op).lines.filter((l) => l.length > 1e-6)
  const b = new MoveBuilder()
  b.pass('rough')
  let here: Vec2 = [0, 0]
  const total = left.length
  for (let done = 0; done < total; done++) {
    const step = steps.step({ done, total, label: `line ${done + 1}/${total}` })
    if (step.isErr()) return Err(step.unwrapErr())
    // nearest start (an open line by either end)
    let best = 0
    let bestD = Infinity
    let flip = false
    left.forEach((l, i) => {
      const a = elementPoint(l.elements[0]!, 0)
      const e = elementPoint(l.elements.at(-1)!, 1)
      const da = Math.hypot(a[0] - here[0], a[1] - here[1])
      const de = l.closed ? Infinity : Math.hypot(e[0] - here[0], e[1] - here[1])
      if (Math.min(da, de) < bestD - 1e-12) {
        best = i
        bestD = Math.min(da, de)
        flip = de < da - 1e-12
      }
    })
    const l0 = left.splice(best, 1)[0]!
    const l = flip ? reversed(l0) : l0
    const path = new LinePath(startAtLongest(l), l.closed)
    const r = cutLine(
      b,
      { path, z: zOf(l.profile, op.onZ) },
      op.onZ,
      c,
      st,
      heights,
      input.material?.top,
    )
    here = r.end
  }
  return Ok(toolpath(input, b.build()))
}
