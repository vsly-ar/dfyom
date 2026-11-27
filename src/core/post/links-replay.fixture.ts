// Test-only: replays an exported program on the virtual machine and checks every executed rapid
// against an independent stock simulation (hardening DF64). Not app code.
// Doc: docs/modes/safe-links.md#verification-on-the-virtual-machine (2)
import { expect } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import type { Machine } from '../library/machine'
import { GrblEmulator } from '../run/grbl/emulator/emulator'
import { initialParserState, parseBlock, type Move as GMove } from '../run/grbl/emulator/gcode'
import { machineSettings } from '../run/grbl/emulator/settings'
import { connected, drive, HOUR, until } from '../run/grbl/sender.fixture'
import { LINK_RADIAL_MARGIN } from '../toolpath/links'
import type { ToolpathTool, Vec3 } from '../toolpath/model'
import { Heightmap, toolSurface } from '../toolpath/testing/oracles'
import { toolChangePauses, type GrblExport } from './export'

/** The oracle's cell (mm): finer than the field's 0.5 mm. */
const CELL = 0.1
/** Rapids are sampled this far apart (mm). */
const STEP = 0.1
/** Float noise and the oracle's sampling (mm). */
const TOL = 0.01

export interface ReplayCheck {
  /** The tool of each tool number (1-based, as the program numbers them). */
  readonly tools: readonly ToolpathTool[]
  /** Stock X, Y extents and thickness in the setup (mm). */
  readonly stock: Vec3
  readonly clearance: number
  /** Vertical margin (the setup's retract height, mm). */
  readonly margin: number
  readonly clampHeight?: number
  /**
   * Rapid keys (`moveKey`) of the same program with `retraction: 'full'`: rapids found there are
   * the generators' own and are checked for collisions only, the others are links.
   */
  readonly fullRapids?: ReadonlySet<string>
  /**
   * DF132 H4: modelled items. Links may leave the cleared footprint (the items are known), keep
   * the tool the margin and the holder `above` over every item (needs `fullRapids`).
   */
  readonly holder?: HolderReplay
}

/**
 * The items and the holder floor, independently (docs/modes/tool-holder.md#testing): the items as
 * boxes in the setup frame and each tool's stepped envelope; on every link rapid the tool keeps
 * its tip the `margin` over a box it comes within its radius + the margin of, and each holder
 * cylinder so near a box keeps its bottom `above` over the box's top.
 */
export interface HolderReplay {
  readonly boxes: readonly {
    readonly x: readonly [number, number]
    readonly y: readonly [number, number]
    readonly top: number
  }[]
  readonly margin: number
  readonly above: number
  /** Per tool number (1-based): cylinders by radius and bottom above the tip (mm). */
  readonly envelopes: readonly (readonly { readonly radius: number; readonly above: number }[])[]
}

export interface ReplayMove {
  readonly rapid: boolean
  readonly from: Vec3
  readonly to: Vec3
  /** Tool number. */
  readonly tool: number
  /** The program line. */
  readonly line: string
}

export interface Replay {
  /** Virtual run time without the waits (s). */
  readonly seconds: number
  /** Executed motion in the setup frame (mm), arcs as GRBL's chords. */
  readonly moves: readonly ReplayMove[]
  /** Links found (rapids not in `fullRapids`, below the clearance height). */
  readonly links: readonly ReplayMove[]
  /** The oracle stock after the program. */
  readonly heightmap: Heightmap
  /** Every failed check, one line each (empty = clean). */
  readonly failures: readonly string[]
}

const r3 = (v: number) => Math.round(v * 1000) / 1000
/** A rapid's identity: tool, from and to rounded to 1 µm. */
export const moveKey = (m: Pick<ReplayMove, 'tool' | 'from' | 'to'>): string =>
  `${m.tool} ${m.from.map(r3).join(',')} ${m.to.map(r3).join(',')}`

/**
 * Streams `e` through GrblSender and the virtual machine (no homing, G54 at the origin; at each
 * tool change Z is zeroed again on the run's Z reference, so machine positions are the setup
 * frame), takes every executed line's end from the emulator's trace and its shape from GRBL's
 * parser (arcs as chords), then checks it against the oracle `Heightmap` (0.1 mm, exact tool
 * profiles) lowered by every executed feed line.
 */
export async function replayRapids(
  e: GrblExport,
  machine: Machine,
  check: ReplayCheck,
): Promise<Replay> {
  expect(machine.programUnits).toBe('mm')
  // the Z reference level of each pausing tool change, in order (DF69)
  // and its tool number; the first tool is loaded without a pause
  const pausing: { level: number; tool: number }[] = []
  let first: number | undefined
  for (const b of e.program.blocks)
    if (b.kind === 'toolChange') {
      if (toolChangePauses(b, first === undefined, true))
        pausing.push({ level: b.zRef?.level ?? 0, tool: b.number })
      first ??= b.number
    }
  // where each pausing tool change falls in the trace (the sender holds the lines after it)
  const toolFrom: { line: number; tool: number }[] = [{ line: 0, tool: first ?? 1 }]
  const emu = expectOk(GrblEmulator.create({ settings: machineSettings(machine), homing: false }))
  const r = await connected(emu)
  const { sender, clock } = r
  expectOk(await drive(clock, sender.command('G10 L2 P1 X0 Y0 Z0')))
  let finished = false
  let seconds = 0
  void r.sender.run({ lines: e.lines, sections: [] }).then((res) => {
    finished = true
    seconds = expectOk(res).seconds
  })
  let pauses = 0
  for (;;) {
    expect(await until(clock, () => finished || waiting(), 24 * HOUR)).toBe(true)
    if (finished) break
    if (sender.phase === 'toolChange') {
      const at = pausing[pauses++]
      const level = at?.level ?? 0
      if (at !== undefined) toolFrom.push({ line: emu.trace.lines.length, tool: at.tool })
      expectOk(await drive(clock, sender.command(`G21 G10 L2 P1 Z${level}`)))
      await drive(clock, sender.freshStatus())
    }
    expectOk(sender.continueProgram())
  }
  function waiting() {
    return sender.phase === 'toolChange' || sender.phase === 'programPause'
  }
  expect(r.io.received.filter((l) => l.startsWith('error') || l.startsWith('ALARM'))).toEqual([])
  expect(emu.trace.violations).toEqual([])

  // ── Executed motion: the trace's lines in order, re-parsed with the WCO they ran with ────
  const failures: string[] = []
  const samples = emu.trace.samples
  const endAt = (t: number): Vec3 | undefined => {
    let lo = 0
    let hi = samples.length - 1
    let best: Vec3 | undefined
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (samples[mid]!.t <= t) {
        best = samples[mid]!.mpos
        lo = mid + 1
      } else hi = mid - 1
    }
    return best
  }
  const moves: ReplayMove[] = []
  let state = initialParserState([0, 0, 0], [0, 0, 0])
  let tool = 0
  let next = 0
  for (const [index, t] of emu.trace.lines.entries()) {
    while (next < toolFrom.length && toolFrom[next]!.line <= index) tool = toolFrom[next++]!.tool
    const code = t.text
      .replace(/\([^)]*\)/g, '')
      .replace(/;.*$/, '')
      .replace(/\s/g, '')
      .toUpperCase()
    if (code === '' || code.startsWith('$') || code.startsWith('?')) continue
    const parsed = parseBlock(code, state, { arcTolerance: 0.002 })
    if (parsed.isErr()) {
      failures.push(`parse error in "${t.text}"`)
      continue
    }
    const start = state.position
    const p = parsed.unwrap()
    state = p.state
    const gm = p.actions.filter((a): a is GMove => a.kind === 'move')
    if (gm.length === 0 || t.endedAt === undefined) continue
    let from = start
    for (const m of gm) {
      moves.push({ rapid: m.rapid, from, to: m.target, tool, line: t.text })
      from = m.target
    }
    // the trace's end of the line is where the parser says it ends
    const end = endAt(t.endedAt)
    if (end !== undefined && end.some((v, k) => Math.abs(v - from[k]!) > 0.002))
      failures.push(`trace end ${end.join(',')} ≠ ${from.join(',')} at "${t.text}"`)
  }

  // ── Checks ────────────────────────────────────────────────────────────────────────────
  const hm = new Heightmap(check.stock[0], check.stock[1], CELL)
  const toolOf = (n: number) => check.tools[n - 1]!
  // the cleared footprint, independently: cells within the tool's radius of a feed sample at or
  // below the stock top (pass 1 over the whole program)
  const foot = new Footprint(moves, check.tools)
  // (only links need it: not for a replay without `fullRapids`)
  if (check.fullRapids !== undefined)
    for (const m of moves)
      if (!m.rapid && Math.min(m.from[2], m.to[2]) <= 1e-9)
        for (const p of along(m.from, m.to))
          if (p[2] <= 1e-9) foot.mark(toolOf(m.tool).diameter / 2 + STEP / 2, p)
  const links: ReplayMove[] = []
  for (const m of moves) {
    const t = toolOf(m.tool)
    if (!m.rapid) {
      for (const p of along(m.from, m.to)) hm.stamp(t, p)
      continue
    }
    if (m.to[2] > check.clearance + 1e-6) failures.push(`above the clearance height: ${m.line}`)
    const link =
      check.fullRapids !== undefined &&
      !check.fullRapids.has(moveKey(m)) &&
      m.to[2] < check.clearance - 1e-6
    if (link) links.push(m)
    // a vertical link move stays in the column the full program climbs too (exit to clearance,
    // clearance to entry): checked for collisions only; the horizontal ones get the margins
    const across =
      link && (Math.abs(m.from[0] - m.to[0]) > 1e-6 || Math.abs(m.from[1] - m.to[1]) > 1e-6)
    const R = t.diameter / 2
    const h = check.holder
    if (h !== undefined && across) {
      const low = holderLow(h, R, h.envelopes[m.tool - 1] ?? [], m.from, m.to)
      if (low !== undefined) failures.push(`link "${m.line}": ${low}`)
    }
    // Z is linear along a move: wholly above the stock top (and the margin) needs no samples,
    // and the footprint matters only below the clamps' need
    const low = Math.min(m.from[2], m.to[2])
    const clampNeed = check.clampHeight === undefined ? Infinity : check.clampHeight + check.margin
    if (low >= Math.max(0, across ? check.margin : 0) && (!across || low >= clampNeed)) continue
    for (const p of along(m.from, m.to)) {
      const hit = collision(
        hm,
        t,
        p,
        across ? check.margin - CELL : -TOL,
        across ? [m.from, m.to] : [],
      )
      if (hit !== undefined) {
        failures.push(
          `${link ? 'link' : 'rapid'} "${m.line}" at ${p.map(r3).join(',')}: ${hit.toFixed(3)} mm over material`,
        )
        break
      }
      if (across && !foot.covers(p, R + LINK_RADIAL_MARGIN, R, [m.from, m.to])) {
        const c = check.clampHeight
        // modelled items (DF132 H4 cases): checked above, the material alone here
        if (h !== undefined) continue
        if (c === undefined) {
          failures.push(`link "${m.line}" leaves the cleared footprint without a clamp height`)
          break
        }
        if (p[2] < c + check.margin - CELL) {
          failures.push(`link "${m.line}" passes ${r3(p[2] - c)} mm over the clamps`)
          break
        }
      }
    }
  }
  return { seconds, moves, links, heightmap: hm, failures }
}

/** The first point of a->b where a cylinder of `envelope` passes too low over a box, or undefined. */
function holderLow(
  h: HolderReplay,
  radius: number,
  envelope: readonly { readonly radius: number; readonly above: number }[],
  a: Vec3,
  b: Vec3,
): string | undefined {
  const parts = [
    { radius, above: 0, keep: h.margin },
    ...envelope.map((c) => ({ ...c, keep: h.above })),
  ]
  for (const p of along(a, b))
    for (const box of h.boxes)
      for (const c of parts) {
        const bottom = p[2] + c.above
        if (bottom >= box.top + c.keep - TOL) continue
        const dx = Math.max(box.x[0] - p[0], 0, p[0] - box.x[1])
        const dy = Math.max(box.y[0] - p[1], 0, p[1] - box.y[1])
        if (Math.hypot(dx, dy) - c.radius < h.margin - TOL)
          return `${c.above === 0 ? 'the tool' : 'the holder'} (Ø${2 * c.radius}) at Z${r3(bottom)} passes ${r3(bottom - box.top)} mm over an item at ${p.map(r3).join(',')}`
      }
  return undefined
}

/** Points along a straight move, at most STEP apart, both ends included. */
function along(a: Vec3, b: Vec3): Vec3[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  const n = Math.max(1, Math.ceil(len / STEP))
  return Array.from({ length: n + 1 }, (_, i) => {
    const u = i / n
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]
  })
}

/**
 * The lowest clearance of the tool at `p` over the oracle when it is too low, else undefined:
 * under the tool (exact profile) never below the material (strict collision); for a link
 * (`need` ≥ 0) the tip at least `need` over every cell within the radius + the radial margin,
 * but the cells within the radius of either of `ends` (its own column at a link's ends).
 */
function collision(
  hm: Heightmap,
  tool: ToolpathTool,
  p: Vec3,
  need: number,
  ends: readonly Vec3[],
): number | undefined {
  // the stock never rises above Z0: nothing to check above that (and above `need` for a link)
  if (p[2] >= Math.max(0, need)) return undefined
  const R = tool.diameter / 2
  const reach = need >= 0 ? R + LINK_RADIAL_MARGIN : R
  const i0 = Math.max(0, Math.floor((p[0] - reach) / hm.cell))
  const i1 = Math.min(hm.nx - 1, Math.ceil((p[0] + reach) / hm.cell))
  const j0 = Math.max(0, Math.floor((p[1] - reach) / hm.cell))
  const j1 = Math.min(hm.ny - 1, Math.ceil((p[1] + reach) / hm.cell))
  let worst: number | undefined
  const reach2 = reach * reach
  const link = need >= 0
  for (let j = j0; j <= j1; j++) {
    const y = (j + 0.5) * hm.cell
    const dy2 = (y - p[1]) ** 2
    for (let i = i0; i <= i1; i++) {
      const x = (i + 0.5) * hm.cell
      const d2 = (x - p[0]) ** 2 + dy2
      if (d2 > reach2) continue
      const material = hm.z[j * hm.nx + i]!
      // nothing cut here is above the tip by more than the tool's own surface can reach
      if (p[2] - material >= (link ? need : 0)) continue
      const rho = Math.sqrt(d2)
      const strict = rho <= R ? p[2] + toolSurface(tool, rho) - material : Infinity
      let bad: number | undefined = strict < -TOL ? strict : undefined
      if (bad === undefined && link && !ends.some((q) => Math.hypot(x - q[0], y - q[1]) <= R)) {
        const gap = p[2] - material
        if (gap < need) bad = gap
      }
      if (bad !== undefined && (worst === undefined || bad < worst)) worst = bad
    }
  }
  return worst
}

/** The cleared footprint at the oracle's resolution, over the moves' extent. */
class Footprint {
  readonly x0: number
  readonly y0: number
  readonly nx: number
  readonly ny: number
  readonly on: Uint8Array

  constructor(moves: readonly ReplayMove[], tools: readonly ToolpathTool[]) {
    const R = Math.max(...tools.map((t) => t.diameter / 2)) + LINK_RADIAL_MARGIN + 2
    const xs = moves.flatMap((m) => [m.from[0], m.to[0]])
    const ys = moves.flatMap((m) => [m.from[1], m.to[1]])
    this.x0 = Math.min(...xs) - R
    this.y0 = Math.min(...ys) - R
    this.nx = Math.ceil((Math.max(...xs) + R - this.x0) / CELL)
    this.ny = Math.ceil((Math.max(...ys) + R - this.y0) / CELL)
    this.on = new Uint8Array(this.nx * this.ny)
  }

  private range(p: Vec3, r: number): [number, number, number, number] {
    return [
      Math.max(0, Math.floor((p[0] - r - this.x0) / CELL)),
      Math.min(this.nx - 1, Math.floor((p[0] + r - this.x0) / CELL)),
      Math.max(0, Math.floor((p[1] - r - this.y0) / CELL)),
      Math.min(this.ny - 1, Math.floor((p[1] + r - this.y0) / CELL)),
    ]
  }

  /** Marks every cell whose centre is within `r` of `p` (the hot loop: no closures). */
  mark(r: number, p: Vec3): void {
    const [i0, i1, j0, j1] = this.range(p, r)
    const r2 = r * r
    for (let j = j0; j <= j1; j++) {
      const dy2 = (this.y0 + (j + 0.5) * CELL - p[1]) ** 2
      const row = j * this.nx
      for (let i = i0; i <= i1; i++)
        if ((this.x0 + (i + 0.5) * CELL - p[0]) ** 2 + dy2 <= r2) this.on[row + i] = 1
    }
  }

  /** Every cell within `r` of `p` is cleared, but the tool's own columns (radius `own`) at the ends. */
  covers(p: Vec3, r: number, own: number, ends: readonly Vec3[]): boolean {
    const [i0, i1, j0, j1] = this.range(p, r)
    for (let j = j0; j <= j1; j++) {
      const y = this.y0 + (j + 0.5) * CELL
      for (let i = i0; i <= i1; i++) {
        if (this.on[j * this.nx + i] === 1) continue
        const x = this.x0 + (i + 0.5) * CELL
        if (Math.hypot(x - p[0], y - p[1]) > r) continue
        if (ends.some((q) => Math.hypot(x - q[0], y - q[1]) <= own)) continue
        return false
      }
    }
    return true
  }
}
