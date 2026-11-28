/**
 * v0.5 RV9: calibration cuts on the open stock (Q221, Q222): the dimension test (a square pocket,
 * a square boss and a slot of nominal sizes) and the feed ladder (parallel slots at stepped feed or
 * stepdown around the tool's resolved feeds), as toolpaths in the setup's WCS from the existing
 * pocket and profile generators (the slots are straight full-width moves); the free-spot search
 * and the placement check (inside the stock top, clear of the setup's operations and earlier
 * calibration cuts); and the readings → suggestions math (tool Ø, `$100`/`$101` lines, backlash
 * and depth hints, the ladder's preset change). Pure and headless; the commands are in
 * calibration-job.ts. Doc: docs/modes/run-calibration.md
 */
import { fail, Ok, Some, type AppResult } from '../../shared/result'
import type { Vec2, Vec3 } from '../geometry/model'
import { levels } from '../toolpath/common'
import type {
  AxisRates,
  CuttingParams,
  Move,
  Pass,
  PocketInput,
  ProfileInput,
  Toolpath,
  ToolpathTool,
} from '../toolpath/model'
import { MoveBuilder } from '../toolpath/path'
import { generatePocket } from '../toolpath/pocket'
import { generateProfile } from '../toolpath/profile'
import { toolpathStats } from '../toolpath/stats'
import type { Machine } from '../library/machine'
import { exportGrbl, type GrblExport } from '../post/export'
import type { ProgramTool } from '../post/program'

export const CALIBRATION_TESTS = ['dimension', 'feedLadder'] as const
export type CalibrationTest = (typeof CALIBRATION_TESTS)[number]

/** Dimension test defaults and bounds (mm). */
export const DIMENSION_SIZE = { default: 15, min: 6, max: 50 } as const
/** Feed ladder defaults and bounds: steps, ± spread (%), slot length (mm). */
export const LADDER = {
  steps: { default: 5, min: 3, max: 9 },
  spread: { default: 30, min: 5, max: 60 },
  length: 20,
} as const
/** Material left between features and around the footprint (mm). */
export const CALIBRATION_WALL = 4
/** The footprint keeps this far from the stock edges, operations and earlier cuts (mm). */
export const CALIBRATION_CLEARANCE = 2
/** Ramp angle of every entry (degrees, as the pocket strategy's default). */
const RAMP_ANGLE = 3

/** An axis-aligned rectangle in the setup's WCS (mm). */
export interface Rect {
  readonly x: readonly [number, number]
  readonly y: readonly [number, number]
}

export interface CalibrationSpec {
  readonly test: CalibrationTest
  /** The footprint's centre in the WCS (mm). */
  readonly at: Vec2
  /** Dimension: the nominal pocket and boss size (mm). */
  readonly size?: number
  /** Dimension: the depth of every feature (mm); default min(2, D/2). */
  readonly depth?: number
  /** Feed ladder: what the steps vary. */
  readonly vary?: 'feed' | 'stepdown'
  /** Feed ladder: ± spread around the resolved value (%). */
  readonly spread?: number
  readonly steps?: number
}

/** What a calibration program is cut with: the tool and its resolved feeds. */
export interface CalibrationTooling {
  readonly tool: ToolpathTool
  readonly cutting: CuttingParams
  readonly heights: { readonly clearanceHeight: number; readonly retractHeight: number }
  readonly maxFeedRate?: AxisRates
}

/** One feature of the dimension test, nominal sizes in mm. */
export type DimensionFeature =
  | { readonly kind: 'pocket'; readonly center: Vec2; readonly size: number }
  | { readonly kind: 'boss'; readonly center: Vec2; readonly size: number; readonly groove: number }
  | { readonly kind: 'slot'; readonly from: Vec2; readonly to: Vec2; readonly width: number }

/** One step of the feed ladder. */
export interface LadderStep {
  readonly n: number
  readonly factor: number
  readonly feed: number
  readonly stepdown: number
  readonly from: Vec2
  readonly to: Vec2
}

export interface CalibrationProgram {
  readonly test: CalibrationTest
  /** One toolpath per feature or step (the export labels each). */
  readonly toolpaths: readonly { readonly label: string; readonly toolpath: Toolpath }[]
  /** Everything the tool reaches, tool radius included. */
  readonly footprint: Rect
  readonly depth: number
  readonly features?: readonly DimensionFeature[]
  readonly steps?: readonly LadderStep[]
  readonly vary?: 'feed' | 'stepdown'
}

const ID = 'calibration'
const EPS = 1e-6

/** The test's default depth for a tool of diameter `D`: min(2, D/2) mm. */
export const defaultDepth = (D: number): number => Math.min(2, D / 2)

/** Width × height (mm) of a test's footprint for a tool of diameter `D` (tool radius included). */
export function footprintSize(spec: Omit<CalibrationSpec, 'at'>, D: number): Vec2 {
  if (spec.test === 'dimension') {
    const N = spec.size ?? DIMENSION_SIZE.default
    const g = groove(D)
    return [N + CALIBRATION_WALL + (N + 2 * g) + CALIBRATION_WALL + D, N + 2 * g]
  }
  const n = spec.steps ?? LADDER.steps.default
  return [LADDER.length + D, n * D + (n - 1) * CALIBRATION_WALL]
}

/** The boss's groove width: room for the caliper jaws (mm). */
const groove = (D: number): number => Math.max(D + 4, 1.5 * D)

/** Checks the spec against its bounds and the tool (`input.malformed` / `plan.check`). */
function specIssues(spec: CalibrationSpec, t: CalibrationTooling, where: string): AppResult<void> {
  const D = t.tool.diameter
  const bad = (path: string, rule: string, message: string) =>
    fail('input.malformed', message, { where, issues: [{ path: [path], rule, message }] })
  if (t.tool.type !== 'flatEndMill')
    return fail('plan.check', 'calibration cuts need a flat end mill', {
      where,
      issues: [{ path: ['toolId'], rule: 'flatEndMill', message: 'pick a flat end mill' }],
    })
  if (spec.test === 'dimension') {
    const N = spec.size ?? DIMENSION_SIZE.default
    if (!(N >= DIMENSION_SIZE.min && N <= DIMENSION_SIZE.max))
      return bad('size', 'range', `size must be ${DIMENSION_SIZE.min}–${DIMENSION_SIZE.max} mm`)
    if (N < 2 * D)
      return bad('size', 'toolTooLarge', `size must be at least twice the tool Ø (${2 * D} mm)`)
  } else {
    const n = spec.steps ?? LADDER.steps.default
    const s = spec.spread ?? LADDER.spread.default
    if (!(Number.isInteger(n) && n >= LADDER.steps.min && n <= LADDER.steps.max))
      return bad('steps', 'range', `steps must be ${LADDER.steps.min}–${LADDER.steps.max}`)
    if (!(s >= LADDER.spread.min && s <= LADDER.spread.max))
      return bad('spread', 'range', `spread must be ${LADDER.spread.min}–${LADDER.spread.max} %`)
  }
  const depth = spec.depth ?? defaultDepth(D)
  if (!(depth > 0 && depth <= Math.min(D, t.tool.fluteLength)))
    return bad('depth', 'range', 'depth must be > 0 and at most the tool Ø and its flute length')
  return Ok(undefined)
}

/**
 * The calibration program's toolpaths for `spec` with `t`, in the WCS (Z0 = stock top). Fails on
 * a spec out of bounds, a tool that is no flat end mill, or a generator error.
 */
export function calibrationToolpaths(
  spec: CalibrationSpec,
  t: CalibrationTooling,
  where = 'calibrationToolpaths',
): AppResult<CalibrationProgram> {
  const ok = specIssues(spec, t, where)
  if (ok.isErr()) return ok
  return spec.test === 'dimension' ? dimensionTest(spec, t) : feedLadder(spec, t)
}

function dimensionTest(
  spec: CalibrationSpec,
  t: CalibrationTooling,
): AppResult<CalibrationProgram> {
  const D = t.tool.diameter
  const R = D / 2
  const N = spec.size ?? DIMENSION_SIZE.default
  const depth = spec.depth ?? defaultDepth(D)
  const g = groove(D)
  const [w, h] = footprintSize(spec, D)
  const x0 = spec.at[0] - w / 2
  const cy = spec.at[1]
  const pocket: Vec2 = [x0 + N / 2, cy]
  const boss: Vec2 = [x0 + N + CALIBRATION_WALL + g + N / 2, cy]
  const slotX = x0 + w - R
  const slot = { from: [slotX, cy - N / 2] as Vec2, to: [slotX, cy + N / 2] as Vec2 }
  const cutting = { ...t.cutting, stepdown: Math.min(t.cutting.stepdown, depth) }
  const base = {
    tool: t.tool,
    cutting,
    heights: t.heights,
    // only the profile reads it (its depth is `throughDepth`); never the stock's real size
    stock: { length: w, width: h, thickness: depth },
    ...(t.maxFeedRate === undefined ? {} : { maxFeedRate: t.maxFeedRate }),
  }
  const pocketInput: PocketInput = {
    ...base,
    planOperationId: ID,
    operation: {
      kind: 'pocket',
      id: 'calibrationPocket',
      onZ: 0,
      shape: {
        center: pocket,
        contour: { kind: 'rectangle', length: N, width: N, cornerRadius: R },
      },
      depth,
      floorRadius: 0,
    },
    strategy: {
      entry: 'helix',
      helixDiameter: 0.8 * D,
      rampAngle: RAMP_ANGLE,
      finishAllowance: 0.2,
      finishStepdown: depth,
      direction: 'climb',
    },
  }
  const bossInput: ProfileInput = {
    ...base,
    planOperationId: ID,
    operation: {
      kind: 'profile',
      id: 'calibrationBoss',
      shape: { center: boss, contour: { kind: 'rectangle', length: N, width: N, cornerRadius: 0 } },
      side: 'outside',
      slotWidth: g,
      throughDepth: depth,
      tabs: { count: 0, width: 0, thickness: 0 },
    },
    strategy: {
      entry: 'ramp',
      rampAngle: RAMP_ANGLE,
      breakthrough: 0,
      finishAllowance: 0.2,
      direction: 'climb',
    },
  }
  const p = generatePocket({
    ...pocketInput,
    cutting: { ...cutting, stepover: Math.min(cutting.stepover, 0.9 * D) },
  })
  if (p.isErr()) return p
  const b = generateProfile({
    ...bossInput,
    cutting: { ...cutting, stepover: Math.min(cutting.stepover, D) },
  })
  if (b.isErr()) return b
  const s = slotToolpath(slot.from, slot.to, depth, cutting.stepdown, cutting.feedRate, t)
  return Ok({
    test: 'dimension',
    toolpaths: [
      { label: `Calibration pocket ${fmt(N)} mm`, toolpath: p.unwrap() },
      { label: `Calibration boss ${fmt(N)} mm`, toolpath: b.unwrap() },
      { label: `Calibration slot ${fmt(D)} mm`, toolpath: s },
    ],
    footprint: { x: [x0, x0 + w], y: [cy - h / 2, cy + h / 2] },
    depth,
    features: [
      { kind: 'pocket', center: pocket, size: N },
      { kind: 'boss', center: boss, size: N, groove: g },
      { kind: 'slot', from: slot.from, to: slot.to, width: D },
    ],
  })
}

/** The ladder's factors: `n` steps evenly from 1 − spread to 1 + spread. */
export function ladderFactors(n: number, spread: number): number[] {
  const s = spread / 100
  return Array.from({ length: n }, (_, k) => round(1 - s + (2 * s * k) / (n - 1), 4))
}

function feedLadder(spec: CalibrationSpec, t: CalibrationTooling): AppResult<CalibrationProgram> {
  const D = t.tool.diameter
  const R = D / 2
  const n = spec.steps ?? LADDER.steps.default
  const vary = spec.vary ?? 'feed'
  const [w, h] = footprintSize(spec, D)
  const x0 = spec.at[0] - w / 2
  const y0 = spec.at[1] - h / 2
  // slotting is full engagement: one level of at most half the tool Ø (DF141's power stays low)
  const base = Math.min(t.cutting.stepdown, D / 2, spec.depth ?? Infinity)
  const steps: LadderStep[] = []
  const toolpaths: { label: string; toolpath: Toolpath }[] = []
  let deepest = 0
  for (const [k, f] of ladderFactors(n, spec.spread ?? LADDER.spread.default).entries()) {
    // never past the machine's X/Y max feed
    const cap =
      t.maxFeedRate === undefined ? Infinity : Math.min(t.maxFeedRate[0], t.maxFeedRate[1])
    const feed = Math.min(
      vary === 'feed' ? Math.round(t.cutting.feedRate * f) : t.cutting.feedRate,
      cap,
    )
    const stepdown =
      vary === 'stepdown' ? round(Math.min(base * f, D, t.tool.fluteLength), 3) : round(base, 3)
    const y = y0 + R + k * (D + CALIBRATION_WALL)
    const from: Vec2 = [x0 + R, y]
    const to: Vec2 = [x0 + w - R, y]
    steps.push({ n: k + 1, factor: f, feed, stepdown, from, to })
    deepest = Math.max(deepest, stepdown)
    toolpaths.push({
      label: `Ladder step ${k + 1}: ${vary === 'feed' ? `F${feed}` : `stepdown ${fmt(stepdown)} mm`}`,
      // the measured pass at the step's value; the ramps in at the lower of it and the preset
      toolpath: slotToolpath(from, to, stepdown, stepdown, feed, t),
    })
  }
  return Ok({
    test: 'feedLadder',
    toolpaths,
    footprint: { x: [x0, x0 + w], y: [y0, y0 + h] },
    depth: deepest,
    steps,
    vary,
  })
}

/**
 * A straight full-width slot from `a` to `b` down to `depth`: per level a zigzag ramp along the
 * slot (≤ 3°) from the level above, then one flat leg at the level and `feed`.
 */
function slotToolpath(
  a: Vec2,
  b: Vec2,
  depth: number,
  stepdown: number,
  feed: number,
  t: CalibrationTooling,
): Toolpath {
  const { clearanceHeight, retractHeight } = t.heights
  const length = Math.hypot(b[0] - a[0], b[1] - a[1])
  const tan = Math.tan((RAMP_ANGLE * Math.PI) / 180)
  const rampFeed = Math.min(feed, t.cutting.feedRate)
  const at = (p: Vec2, z: number): Vec3 => [p[0], p[1], z]
  const mb = new MoveBuilder()
  mb.pass('rough')
  mb.rapid(at(a, clearanceHeight))
  mb.rapid(at(a, retractHeight))
  mb.line(at(a, 0), t.cutting.plungeRate)
  let previous = 0
  let end: Vec2 = a
  for (const z of levels(0, -depth, stepdown)) {
    const legs = Math.max(1, Math.ceil((previous - z) / (length * tan) - 1e-9))
    for (let i = 1; i <= legs; i++) {
      end = end === a ? b : a
      mb.line(at(end, previous + ((z - previous) * i) / legs), rampFeed)
    }
    end = end === a ? b : a
    mb.line(at(end, z), feed)
    previous = z
  }
  mb.rapid(at(end, retractHeight))
  mb.rapid(at(end, clearanceHeight))
  const passes: Pass[] = mb.build()
  return {
    planOperationId: ID,
    tool: t.tool.id,
    spindleSpeed: t.cutting.spindleSpeed,
    passes,
    stats: toolpathStats(passes, t.maxFeedRate),
  }
}

/**
 * The calibration program's gCode: the plan's machine copy, the setup's clearance, one labelled
 * operation per feature or step, and the tool change at the start always pausing (the tool and its
 * Z zero are set before anything cuts: the spindle may hold another tool). `workZero` (the live
 * G54) adds the soft-limit findings.
 */
export function calibrationExport(
  program: CalibrationProgram,
  opts: {
    readonly planName: string
    readonly machine: Machine
    readonly tool: ProgramTool
    readonly clearanceHeight: number
    readonly stockThickness?: number
    readonly workZero?: Vec3
    readonly generator: string
  },
): AppResult<GrblExport> {
  return exportGrbl(
    {
      name: opts.planName,
      setup: {
        name:
          program.test === 'dimension' ? 'Calibration: dimension test' : 'Calibration: feed ladder',
        clearanceHeight: opts.clearanceHeight,
        ...(opts.stockThickness === undefined ? {} : { stockThickness: opts.stockThickness }),
      },
      operations: program.toolpaths.map((t) => ({
        toolpath: t.toolpath,
        tool: opts.tool,
        label: t.label,
      })),
      machine: Some(opts.machine),
      ...(opts.workZero === undefined ? {} : { workZero: opts.workZero }),
    },
    { generator: opts.generator, firstToolLoaded: false },
  )
}

// ── Placement ─────────────────────────────────────────────────────────────────────────────

/** A placement problem: the spot is refused until it is moved. */
export interface PlacementProblem {
  readonly rule: 'outsideStock' | 'operation' | 'earlierCut'
  readonly message: string
  /** `operation`: the plan operation's id; `earlierCut`: the earlier cut's index. */
  readonly ref?: string
}

/** A region the calibration must keep out of: an operation's reach or an earlier calibration cut. */
export interface KeepOutRect {
  readonly rect: Rect
  readonly kind: 'operation' | 'earlierCut'
  readonly ref: string
  readonly label: string
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x[0] < b.x[1] - EPS && b.x[0] < a.x[1] - EPS && a.y[0] < b.y[1] - EPS && b.y[0] < a.y[1] - EPS

/** `r` grown by `d` on every side. */
export const grow = (r: Rect, d: number): Rect => ({
  x: [r.x[0] - d, r.x[1] + d],
  y: [r.y[0] - d, r.y[1] + d],
})

/**
 * Whether a footprint may be cut: inside the stock top less the clearance, and its clearance-grown
 * rectangle clear of every keep-out (the setup's operations, earlier calibration cuts).
 */
export function placementProblems(
  footprint: Rect,
  stockTop: Rect,
  keepOut: readonly KeepOutRect[],
): PlacementProblem[] {
  const out: PlacementProblem[] = []
  const inner = grow(stockTop, -CALIBRATION_CLEARANCE)
  if (
    footprint.x[0] < inner.x[0] - EPS ||
    footprint.x[1] > inner.x[1] + EPS ||
    footprint.y[0] < inner.y[0] - EPS ||
    footprint.y[1] > inner.y[1] + EPS
  )
    out.push({
      rule: 'outsideStock',
      message: `the test needs ${fmt(footprint.x[1] - footprint.x[0])} × ${fmt(footprint.y[1] - footprint.y[0])} mm on the stock top, ${CALIBRATION_CLEARANCE} mm from its edges`,
    })
  const grown = grow(footprint, CALIBRATION_CLEARANCE)
  for (const k of keepOut)
    if (overlaps(grown, k.rect))
      out.push({
        rule: k.kind,
        ref: k.ref,
        message:
          k.kind === 'operation'
            ? `it would cut where ${k.label} cuts`
            : `it would cut into ${k.label}`,
      })
  return out
}

/**
 * A free centre for a footprint of `size` on the stock top: candidates on a 1 mm grid from the
 * work zero's corner outwards (nearest the WCS origin first), the first without placement
 * problems; undefined when none fits.
 */
export function findFreeSpot(
  size: Vec2,
  stockTop: Rect,
  keepOut: readonly KeepOutRect[],
): Vec2 | undefined {
  const inner = grow(stockTop, -CALIBRATION_CLEARANCE)
  const [w, h] = size
  const xs = range(inner.x[0] + w / 2, inner.x[1] - w / 2)
  const ys = range(inner.y[0] + h / 2, inner.y[1] - h / 2)
  const candidates = xs.flatMap((x) => ys.map((y): Vec2 => [x, y]))
  candidates.sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]) || p[1] - q[1])
  return candidates.find(
    (c) =>
      placementProblems(
        { x: [c[0] - w / 2, c[0] + w / 2], y: [c[1] - h / 2, c[1] + h / 2] },
        stockTop,
        keepOut,
      ).length === 0,
  )
}

/** Grid positions from `a` to `b` every 1 mm (plus `b`); empty when `b < a`. */
function range(a: number, b: number): number[] {
  if (b < a - EPS) return []
  const out: number[] = []
  for (let v = Math.ceil(a); v <= b + EPS; v++) out.push(v)
  if (out.length === 0) out.push(round((a + b) / 2, 3))
  return out
}

/** The XY reach of a toolpath's feed moves (tool centres ± radius); undefined without one. */
export function toolpathReach(tp: Toolpath, radius: number): Rect | undefined {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  let prev: Vec3 | undefined
  const add = (p: readonly number[]) => {
    x0 = Math.min(x0, p[0]!)
    x1 = Math.max(x1, p[0]!)
    y0 = Math.min(y0, p[1]!)
    y1 = Math.max(y1, p[1]!)
  }
  const visit = (m: Move) => {
    if (m.kind === 'drill') {
      add(m.at)
      prev = [m.at[0], m.at[1], m.retract]
      return
    }
    if (m.kind !== 'rapid' && m.to[2] < 0) {
      if (prev !== undefined) add(prev)
      add(m.to)
      // an arc bulges up to its radius from the centre
      if (m.kind === 'arc') {
        const r = Math.hypot(m.to[0] - m.center[0], m.to[1] - m.center[1])
        add([m.center[0] - r, m.center[1] - r])
        add([m.center[0] + r, m.center[1] + r])
      }
    }
    prev = m.to
  }
  for (const p of tp.passes) for (const m of p.moves) visit(m)
  if (x0 > x1) return undefined
  return { x: [x0 - radius, x1 + radius], y: [y0 - radius, y1 + radius] }
}

// ── Suggestions ───────────────────────────────────────────────────────────────────────────

/** Caliper readings of the dimension test (mm); any may be left out. */
export interface DimensionReadings {
  readonly pocketX?: number
  readonly pocketY?: number
  readonly bossX?: number
  readonly bossY?: number
  readonly slot?: number
  readonly depth?: number
}

/** One suggestion: the text and, where one applies, the value to apply or the line to copy. */
export type CalibrationSuggestion =
  | { readonly kind: 'toolDiameter'; readonly diameter: number; readonly delta: number }
  | {
      readonly kind: 'stepsPerMm'
      readonly axis: 'x' | 'y'
      readonly setting: '$100' | '$101'
      readonly scale: number
      /** The `$10n=…` line; absent when the controller's value is unknown. */
      readonly line?: string
    }
  | { readonly kind: 'backlash'; readonly axis: 'x' | 'y'; readonly difference: number }
  | { readonly kind: 'depth'; readonly error: number }
  | { readonly kind: 'ok' }

/** Below these the readings agree with the nominal within caliper and machine noise (mm). */
export const SUGGEST_TOLERANCE = { diameter: 0.02, scale: 0.05, backlash: 0.04, depth: 0.05 }

/**
 * Suggestions from the dimension test's readings (docs/modes/run-calibration.md#suggestions):
 * per axis the pocket P and the boss B of nominal N give the scale s = (P + B)/(2N) − 1 and the
 * tool's extra width ΔD = (P − B)/2; the slot W gives ΔD = W − D. The tool Ø is D + mean ΔD; a
 * scale error beyond 0.05 mm over N is a `$10n` line from the controller's value; X and Y ΔD that
 * differ point at backlash; the depth against the nominal.
 */
export function dimensionSuggestions(
  nominal: { readonly size: number; readonly depth: number; readonly diameter: number },
  r: DimensionReadings,
  steps: { readonly x?: number; readonly y?: number } = {},
): CalibrationSuggestion[] {
  const out: CalibrationSuggestion[] = []
  const N = nominal.size
  const D = nominal.diameter
  const deltas: number[] = []
  const perAxis: Partial<Record<'x' | 'y', number>> = {}
  for (const axis of ['x', 'y'] as const) {
    const P = axis === 'x' ? r.pocketX : r.pocketY
    const B = axis === 'x' ? r.bossX : r.bossY
    if (P === undefined || B === undefined) continue
    const s = (P + B) / (2 * N) - 1
    const dD = (P - B) / 2
    deltas.push(dD)
    perAxis[axis] = dD
    if (Math.abs(s * N) >= SUGGEST_TOLERANCE.scale) {
      const setting = axis === 'x' ? '$100' : '$101'
      const current = steps[axis]
      out.push({
        kind: 'stepsPerMm',
        axis,
        setting,
        scale: round(s, 6),
        ...(current === undefined ? {} : { line: `${setting}=${(current / (1 + s)).toFixed(3)}` }),
      })
    }
  }
  if (r.slot !== undefined) deltas.push(r.slot - D)
  if (deltas.length > 0) {
    const dD = deltas.reduce((a, b) => a + b, 0) / deltas.length
    if (Math.abs(dD) >= SUGGEST_TOLERANCE.diameter)
      out.push({ kind: 'toolDiameter', diameter: round(D + dD, 3), delta: round(dD, 3) })
  }
  if (perAxis.x !== undefined && perAxis.y !== undefined) {
    const diff = perAxis.x - perAxis.y
    if (Math.abs(diff) >= SUGGEST_TOLERANCE.backlash)
      out.push({
        kind: 'backlash',
        axis: diff > 0 ? 'x' : 'y',
        difference: round(Math.abs(diff), 3),
      })
  }
  if (r.depth !== undefined && Math.abs(r.depth - nominal.depth) >= SUGGEST_TOLERANCE.depth)
    out.push({ kind: 'depth', error: round(r.depth - nominal.depth, 3) })
  return out.length === 0 && (deltas.length > 0 || r.depth !== undefined) ? [{ kind: 'ok' }] : out
}

/** The feed ladder's suggestion: the chosen step's value against the resolved one. */
export interface LadderSuggestion {
  readonly vary: 'feed' | 'stepdown'
  readonly step: number
  readonly value: number
  /** Percent change from the resolved value (rounded). */
  readonly percent: number
}

export function ladderSuggestion(
  program: {
    readonly steps?: readonly Pick<LadderStep, 'n' | 'factor' | 'feed' | 'stepdown'>[]
    readonly vary?: 'feed' | 'stepdown'
  },
  step: number,
): LadderSuggestion | undefined {
  const s = program.steps?.find((x) => x.n === step)
  if (s === undefined) return undefined
  const vary = program.vary ?? 'feed'
  return {
    vary,
    step,
    value: vary === 'feed' ? s.feed : s.stepdown,
    percent: Math.round((s.factor - 1) * 100),
  }
}

const round = (v: number, d: number): number => Math.round(v * 10 ** d) / 10 ** d
const fmt = (v: number): string => String(round(v, 3))
