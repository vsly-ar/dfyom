/**
 * Export of one setup's toolpaths: toolpaths → MachiningProgram → GRBL text, with the machine
 * checks and program stats. Doc: docs/architecture/grbl.md#input-boundary and #export-checks;
 * boundary: docs/modes/plan-v0.1.md#export-boundary-tasks-110-and-211
 *
 * Pure and synchronous. The `plan.export` command (task 2.9) maps a plan's generated toolpaths
 * and copies to `ExportInput` and calls `exportGrbl`.
 */
import type { Machine } from '../library/machine'
import type { PlanWarning } from '../plan/checks'
import { fail, Ok, type AppResult, type Option } from '../../shared/result'
import { arcSweep, expandDrill, PECK_CLEARANCE } from '../toolpath/stats'
import type { Move, Toolpath, Vec3 } from '../toolpath/model'
import { DEFAULT_SPIN_UP_SECONDS, postGrblLines, type PostOptions } from './grbl/post'
import type { Block, MachiningProgram, ProgramTool } from './program'

/** One plan operation's toolpath with its tool copy, in machining order. */
export interface ExportOperation {
  readonly toolpath: Toolpath
  /** The tool copy named by `toolpath.tool` (snapshot id). */
  readonly tool: ProgramTool
  /** Comment text before the operation, e.g. the operation's name. */
  readonly label: string
}

export interface ExportInput {
  /** Plan name. */
  readonly name: string
  readonly setup: { readonly name: string; readonly clearanceHeight: number }
  readonly operations: readonly ExportOperation[]
  /** The plan's machine copy; export requires one (`post.noMachine`). */
  readonly machine: Option<Machine>
  /**
   * Machine position (MPos, mm) of the work zero, when known (a connected controller's G54):
   * enables the soft-limit check. Without it only the program's extent is checked.
   */
  readonly workZero?: Vec3
}

export interface ProgramStats {
  /** Length of all feed moves (mm). */
  readonly cutLength: number
  /** Length of all rapid moves (mm). */
  readonly rapidLength: number
  /** Motion at the programmed feeds and the max rates (no acceleration) plus dwells (s). */
  readonly estimatedSeconds: number
  /** Spindle spin-up dwells, included in `estimatedSeconds` (s). */
  readonly dwellSeconds: number
  /** Tool changes that pause the program (`M0`). */
  readonly toolChanges: number
}

export interface GrblExport {
  readonly program: MachiningProgram
  /** gCode lines without line ends (what a sender streams). */
  readonly lines: readonly string[]
  /** The file content: LF line ends, final newline. */
  readonly text: string
  readonly stats: ProgramStats
  /** Machine checks (`plan.machine` warnings); they never block the export. */
  readonly warnings: readonly PlanWarning[]
}

const MM_PER_INCH = 25.4
const EPS = 1e-9

/**
 * The GRBL program of one setup. Fails with `post.noMachine` without a machine copy and with
 * `model.invariant` for an empty export or values the post cannot write.
 */
export function exportGrbl(input: ExportInput, opts: PostOptions): AppResult<GrblExport> {
  if (input.machine.isNone())
    return fail('post.noMachine', 'gCode export needs a machine', { where: 'exportGrbl' })
  const machine = input.machine.unwrap()
  const built = toMachiningProgram(input, machine)
  if (built.isErr()) return built
  const program = built.unwrap()
  return postGrblLines(program, opts).map((lines) => ({
    program,
    lines,
    text: `${lines.join('\n')}\n`,
    stats: programStats(program, machine, opts),
    warnings: machineChecks(input, program, machine, opts.firstToolLoaded !== false),
  }))
}

/**
 * Toolpaths → blocks: a tool change whenever the tool copy changes (tools numbered by first use),
 * a spindle block when the speed changes, the label comment, then the moves with drill cycles
 * expanded and arc centers as I/J offsets.
 */
export function toMachiningProgram(
  input: ExportInput,
  machine: Machine,
): AppResult<MachiningProgram> {
  if (input.operations.length === 0)
    return fail('model.invariant', 'nothing to export', {
      where: 'toMachiningProgram',
      issues: [{ path: ['operations'], rule: 'empty', message: 'no toolpaths to export' }],
    })
  // Clearance: above the stock top and above every toolpath (tool changes and the footer
  // retract to it; a lower one would move down there).
  const clearanceZ = input.setup.clearanceHeight
  let top = -Infinity
  for (const op of input.operations)
    for (const pass of op.toolpath.passes)
      for (const m of pass.moves) top = Math.max(top, m.kind === 'drill' ? m.retract : m.to[2])
  if (!(clearanceZ > 0) || top > clearanceZ + EPS)
    return fail('model.invariant', 'the clearance height is too low', {
      where: 'toMachiningProgram',
      issues: [
        {
          path: ['setup', 'clearanceHeight'],
          rule: 'clearance',
          message: 'must be > 0 and at least the highest toolpath Z',
          params: { clearanceHeight: clearanceZ, top },
        },
      ],
    })
  const units = machine.programUnits
  const peckClearance = units === 'in' ? 0.02 * MM_PER_INCH : PECK_CLEARANCE
  const blocks: Block[] = []
  const numbers = new Map<string, number>()
  let tool: string | undefined
  let rpm: number | undefined
  let pos: Vec3 | undefined
  const push = (m: Exclude<Move, { kind: 'drill' }>) => {
    if (m.kind === 'rapid') blocks.push({ kind: 'rapid', to: m.to })
    else if (m.kind === 'line') blocks.push({ kind: 'feed', to: m.to, feed: m.feed })
    else {
      // The post rejects an arc from an unknown position; toolpaths start with a rapid.
      const [x, y] = pos ?? [Number.NaN, Number.NaN]
      const [cx, cy] = m.center
      blocks.push({ kind: 'arc', to: m.to, i: cx - x, j: cy - y, cw: m.cw, feed: m.feed })
    }
    pos = m.to
  }
  for (const op of input.operations) {
    const tp = op.toolpath
    blocks.push({ kind: 'comment', text: op.label })
    if (tp.tool !== tool) {
      tool = tp.tool
      const n = numbers.get(tp.tool) ?? numbers.size + 1
      numbers.set(tp.tool, n)
      blocks.push({ kind: 'toolChange', number: n, tool: op.tool })
      rpm = undefined
    }
    if (tp.spindleSpeed !== rpm) {
      rpm = tp.spindleSpeed
      blocks.push({ kind: 'spindle', rpm })
    }
    for (const pass of tp.passes)
      for (const m of pass.moves)
        if (m.kind === 'drill') expandDrill(m, peckClearance).forEach(push)
        else push(m)
  }
  return Ok({
    name: input.name,
    setupName: input.setup.name,
    units,
    spindleControl: machine.spindle.control,
    clearanceZ,
    blocks,
  })
}

// ── Walking the program ───────────────────────────────────────────────────────────────────

type Motion = Extract<Block, { kind: 'rapid' | 'feed' | 'arc' }>

/** Position per axis; undefined = unknown (program start, after a tool-change pause). */
type Pos = [number | undefined, number | undefined, number | undefined]

/**
 * Calls `visit` for every motion block with the position before it, as the post writes the
 * program: Z at clearance after the header and after a tool-change pause, X and Y unknown.
 */
function walk(
  p: MachiningProgram,
  firstToolLoaded: boolean,
  visit: (from: Pos, b: Motion | { kind: 'clearance'; to: Vec3 }) => void,
  onBlock?: (b: Block) => void,
): void {
  let pos: Pos = [undefined, undefined, p.clearanceZ]
  let loaded = false
  const go = (b: Motion) => {
    visit(pos, b)
    pos = [...b.to]
  }
  const clearance = () => {
    const to: Vec3 = [pos[0] ?? Number.NaN, pos[1] ?? Number.NaN, p.clearanceZ]
    visit(pos, { kind: 'clearance', to })
    pos = [pos[0], pos[1], p.clearanceZ]
  }
  for (const b of p.blocks) {
    onBlock?.(b)
    if (b.kind === 'rapid' || b.kind === 'feed' || b.kind === 'arc') go(b)
    else if (b.kind === 'toolChange') {
      const first = !loaded
      loaded = true
      if (!first) clearance()
      if (!first || !firstToolLoaded) pos = [undefined, undefined, p.clearanceZ]
    }
  }
  clearance()
}

const known = (p: Pos): p is [number, number, number] => p.every((v) => v !== undefined)

function arcLength(from: Vec3, b: Extract<Block, { kind: 'arc' }>): number {
  const center: [number, number] = [from[0] + b.i, from[1] + b.j]
  const r = Math.hypot(b.i, b.j)
  const full = b.to[0] === from[0] && b.to[1] === from[1]
  const s = full ? 2 * Math.PI : Math.abs(arcSweep(from, { ...b, kind: 'arc', center }))
  return Math.hypot(r * s, b.to[2] - from[2])
}

/**
 * Lengths and time like the toolpath stats (no acceleration; rapids at the slowest axis' max
 * rate), plus the spin-up dwells. Moves from an unknown position are not counted.
 */
export function programStats(
  p: MachiningProgram,
  machine: Machine,
  opts: PostOptions,
): ProgramStats {
  const rate: Vec3 = [
    machine.maxFeedRate.x.canonical,
    machine.maxFeedRate.y.canonical,
    machine.maxFeedRate.z.canonical,
  ]
  let cut = 0
  let rapid = 0
  let seconds = 0
  let dwell = 0
  let toolChanges = 0
  const firstToolLoaded = opts.firstToolLoaded !== false
  const spin = p.spindleControl === 'gcode' ? (opts.spinUpSeconds ?? DEFAULT_SPIN_UP_SECONDS) : 0
  let loaded = false
  walk(
    p,
    firstToolLoaded,
    (from, b) => {
      if (b.kind === 'rapid' || b.kind === 'clearance') {
        // NaN in `to`: an unknown axis the move keeps (clearance before X/Y are known).
        const d: number[] = []
        for (let k = 0; k < 3; k++) {
          const a = from[k]
          if (Number.isNaN(b.to[k])) d.push(0)
          else if (a === undefined) return
          else d.push(b.to[k]! - a)
        }
        rapid += Math.hypot(...d)
        seconds += Math.max(...d.map((v, k) => Math.abs(v) / rate[k]!)) * 60
        return
      }
      if (!known(from)) return
      const len =
        b.kind === 'arc'
          ? arcLength(from, b)
          : Math.hypot(b.to[0] - from[0], b.to[1] - from[1], b.to[2] - from[2])
      cut += len
      seconds += (len / b.feed) * 60
    },
    (b) => {
      if (b.kind === 'spindle' && b.rpm !== 'off') dwell += spin
      if (b.kind === 'toolChange') {
        if (loaded || !firstToolLoaded) toolChanges++
        loaded = true
      }
    },
  )
  return {
    cutLength: cut,
    rapidLength: rapid,
    estimatedSeconds: seconds + dwell,
    dwellSeconds: dwell,
    toolChanges,
  }
}

// ── Machine checks ────────────────────────────────────────────────────────────────────────

const AXES = ['x', 'y', 'z'] as const

/** Axis-aligned bounds of an arc (or helix) from `from`: ends plus the quadrant points it passes. */
function arcBounds(from: Vec3, b: Extract<Block, { kind: 'arc' }>): Vec3[] {
  const cx = from[0] + b.i
  const cy = from[1] + b.j
  const r = Math.hypot(b.i, b.j)
  const full = b.to[0] === from[0] && b.to[1] === from[1]
  const a0 = Math.atan2(from[1] - cy, from[0] - cx)
  const s = full
    ? b.cw
      ? -2 * Math.PI
      : 2 * Math.PI
    : arcSweep(from, { ...b, kind: 'arc', center: [cx, cy] })
  const pts: Vec3[] = [from, b.to]
  const zMin = Math.min(from[2], b.to[2])
  for (let k = -8; k <= 8; k++) {
    const a = (k * Math.PI) / 2
    const t = (a - a0) / s
    if (t > 0 && t < 1) pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), zMin])
  }
  return pts
}

/**
 * `plan.machine` warnings (docs/architecture/grbl.md#export-checks): feed rates against the
 * max feed rate of every axis a move moves, spindle speeds against the spindle range, the
 * program's extent against the travel, and with `workZero` its machine positions against the
 * soft limits [−travel, 0] (GRBL's default homing direction).
 */
export function machineChecks(
  input: ExportInput,
  p: MachiningProgram,
  machine: Machine,
  firstToolLoaded = true,
): PlanWarning[] {
  const out: PlanWarning[] = []
  const warn = (w: Omit<PlanWarning, 'code' | 'severity'>) =>
    out.push({ code: 'plan.machine', severity: 'warning', ...w })

  // Spindle range and feed rates per operation.
  const min = machine.spindle.minSpeed.mapOr(0, (q) => q.canonical)
  const max = machine.spindle.maxSpeed.canonical
  const rates = AXES.map((a) => machine.maxFeedRate[a].canonical)
  for (const op of input.operations) {
    const id = op.toolpath.planOperationId
    const rpm = op.toolpath.spindleSpeed
    if (rpm < min - EPS || rpm > max + EPS)
      warn({
        planOperationId: id,
        field: 'spindleSpeed',
        rule: 'spindleRange',
        message: 'spindle speed is outside the spindle range (GRBL clamps silently)',
        params: { spindleSpeed: rpm, min, max },
      })
  }
  // Per axis: the move's speed along it (feed × the axis' share of the direction), where GRBL
  // starts to slow the move down. An arc may run along X and along Y at its full XY speed.
  const worst = new Map<string, { feed: number; axis: string; speed: number; max: number }>()
  for (const op of input.operations) {
    const id = op.toolpath.planOperationId
    let from: Vec3 | undefined
    const visit = (m: Exclude<Move, { kind: 'drill' }>) => {
      const start = from
      from = m.to
      if (m.kind === 'rapid' || start === undefined) return
      const dz = Math.abs(m.to[2] - start[2])
      const share: number[] =
        m.kind === 'arc'
          ? (() => {
              const r = Math.hypot(start[0] - m.center[0], start[1] - m.center[1])
              const h = r * Math.abs(arcSweep(start, m))
              const len = Math.hypot(h, dz)
              return [h / len, h / len, dz / len]
            })()
          : (() => {
              const d = [0, 1, 2].map((k) => Math.abs(m.to[k]! - start[k]!))
              const len = Math.hypot(...d)
              return len > 0 ? d.map((v) => v / len) : [0, 0, 0]
            })()
      share.forEach((f, k) => {
        const speed = m.feed * f
        const max = rates[k]!
        const w = worst.get(id)
        if (speed > max + EPS && (w === undefined || speed / max > w.speed / w.max))
          worst.set(id, { feed: m.feed, axis: AXES[k]!, speed, max })
      })
    }
    for (const pass of op.toolpath.passes)
      for (const m of pass.moves)
        if (m.kind === 'drill') expandDrill(m).forEach(visit)
        else visit(m)
  }
  for (const [id, w] of worst)
    warn({
      planOperationId: id,
      field: w.axis === 'z' ? 'plungeRate' : 'feedRate',
      rule: 'maxFeedRate',
      message: `a move runs faster along ${w.axis.toUpperCase()} than its max feed rate (GRBL slows it down)`,
      params: { feed: w.feed, axis: w.axis, speed: w.speed, max: w.max },
    })

  // Extent and soft limits.
  // The Z soft limits use the Z zero `workZero` was taken with: it holds until the first tool
  // change that pauses (the user re-zeroes Z for the new tool's length).
  const lo = [Infinity, Infinity, p.clearanceZ]
  const hi = [-Infinity, -Infinity, p.clearanceZ]
  const zLo = [firstToolLoaded ? p.clearanceZ : Infinity]
  const zHi = [firstToolLoaded ? p.clearanceZ : -Infinity]
  let zeroKnown = firstToolLoaded
  let tools = 0
  walk(
    p,
    firstToolLoaded,
    (from, b) => {
      const pts = b.kind === 'arc' && known(from) ? arcBounds(from, b) : [b.to]
      for (const q of pts)
        q.forEach((v, k) => {
          if (Number.isNaN(v)) return
          lo[k] = Math.min(lo[k]!, v)
          hi[k] = Math.max(hi[k]!, v)
          if (k === 2 && zeroKnown) {
            zLo[0] = Math.min(zLo[0]!, v)
            zHi[0] = Math.max(zHi[0]!, v)
          }
        })
    },
    (b) => {
      if (b.kind === 'toolChange' && ++tools > 1) zeroKnown = false
    },
  )
  AXES.forEach((axis, k) => {
    const travel = machine.travel[axis].canonical
    const size = hi[k]! - lo[k]!
    if (!Number.isFinite(size)) return
    if (size > travel + EPS)
      warn({
        field: 'machine',
        rule: 'travel',
        message: `the program spans more than the ${axis.toUpperCase()} travel`,
        params: { axis, size, travel },
      })
    const zero = input.workZero?.[k]
    if (zero === undefined) return
    const from = zero + (k === 2 ? zLo[0]! : lo[k]!)
    const to = zero + (k === 2 ? zHi[0]! : hi[k]!)
    if (!Number.isFinite(from - to)) return
    if (from < -travel - EPS || to > EPS)
      warn({
        field: 'machine',
        rule: 'softLimit',
        message: `the program leaves the ${axis.toUpperCase()} soft limits at this work zero`,
        params: { axis, min: from, max: to, travel },
      })
  })
  return out
}
