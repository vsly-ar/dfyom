/**
 * The simulated cut (v0.4 follow-up V2): per setup direction a height map of the material left
 * by the plan's toolpaths, the stock top swept by every feed move with the tool's real profile
 * (flat, bull nose, ball, drill point, chamfer cone), in machining order. Point sampled at cell
 * centres on the face-frame grid of the reference map (`compareHeightmap`), so the two maps
 * subtract cell by cell. Pure, headless, float64 inside.
 * Doc: docs/modes/deviation.md#height-map-method, #implementation-s9-v2
 *
 * Exact up to float rounding for straight moves (any slope) of a flat end and for level moves,
 * level arcs and drill cycles of every tool; a helix is cut into chords within `CHORD_TOL`, and a
 * sloped move of a shaped tool into pieces of at most `Z_STEP` height (the map is then at most
 * `Z_STEP` high, never too deep).
 */
import { fail, Ok, type AppResult } from '../../shared/result'
import { localStock, type Direction, type StockSize } from '../geometry/face'
import { noSteps, type Steps } from '../workers/steps'
import type { Move, Toolpath, ToolpathTool, Vec2, Vec3 } from './model'
import { arcSweep, expandDrill } from './stats'
import { taperedBallProfile } from './stock-heights'
import { fromWcs, setupWcs, type WcsRotation } from './wcs'

/** Default cell (mm): deviation.md § The command. */
export const SIMULATE_CELL = 0.5
/** Smallest cell (mm). */
export const SIMULATE_CELL_MIN = 0.1
/** Largest map per direction (cells). */
export const SIMULATE_CELLS_MAX = 4_000_000
/** Largest sagitta of a helix's chord (mm). */
export const CHORD_TOL = 0.002
/** Largest Z change of one piece of a sloped move of a shaped (not flat) tool (mm). */
export const Z_STEP = 0.01
/** Feed moves between two progress steps (one step stays well under 50 ms). */
const MOVES_PER_STEP = 2000

const EPS = 1e-9

/** One setup's toolpaths in machining order, in its WCS (as the plan stores them). */
export interface SimulateSetup {
  readonly direction: Direction
  readonly rotation: WcsRotation
  /** The setup's work zero (alignment DF78), as for `setupWcs`. */
  readonly zero?: Vec2 | undefined
  readonly toolpaths: readonly { readonly tool: ToolpathTool; readonly toolpath: Toolpath }[]
}

export interface SimulateInput {
  readonly stock: StockSize
  /** mm, default `SIMULATE_CELL`. */
  readonly cell?: number | undefined
  /** In machining order; setups of one direction cut one map. */
  readonly setups: readonly SimulateSetup[]
}

/**
 * The cut map of one direction: cell (i, j) is centred at ((i + ½)·cell, (j + ½)·cell) of the
 * direction's face frame (`faceFrame`), row by row (`j·nu + i`); `h` is the material's top in
 * that frame: 0 = the stock face (uncut), −thickness = cut through.
 */
export interface CutMap {
  readonly direction: Direction
  readonly cell: number
  readonly nu: number
  readonly nv: number
  readonly h: Float32Array
  /**
   * Which toolpath last lowered each cell: its 1-based index over every setup's toolpaths in
   * input order; 0 = never cut (V3 names the operation of a region, deviation.md#result).
   */
  readonly by: Uint16Array
}

/** The lower surface of a tool above its tip at radial distance ρ ≤ R (`toolSurface`). */
export interface ToolProfile {
  readonly radius: number
  /** A flat end: the surface is 0 everywhere under the tool. */
  readonly flat: boolean
  readonly surface: (rho: number) => number
}

/** `toolSurface` with the tool's constants taken once (no `Math.tan` per cell). */
export function toolProfile(tool: ToolpathTool): ToolProfile {
  if (tool.type === 'taperedBallEndMill') return { ...taperedBallProfile(tool), flat: false }
  const R = tool.diameter / 2
  if (tool.type === 'chamferMill') {
    const tip = (tool.tipDiameter ?? 0) / 2
    const tan = Math.tan(((tool.angle ?? 90) * Math.PI) / 360)
    return { radius: R, flat: false, surface: (rho) => (rho <= tip ? 0 : (rho - tip) / tan) }
  }
  if (tool.type === 'drill') {
    const half = ((tool.pointAngle ?? 180) * Math.PI) / 360
    if (half >= Math.PI / 2 - 1e-12) return { radius: R, flat: true, surface: () => 0 }
    const tan = Math.tan(half)
    return { radius: R, flat: false, surface: (rho) => rho / tan }
  }
  const re = Math.min(tool.cornerRadius, R)
  if (re <= 0) return { radius: R, flat: true, surface: () => 0 }
  const flat = R - re
  return {
    radius: R,
    flat: false,
    surface: (rho) => {
      if (rho <= flat) return 0
      const d = Math.min(re, rho - flat)
      return re - Math.sqrt(re * re - d * d)
    },
  }
}

/** A height map being cut: float64, starting at the stock face (0). */
export class CutGrid {
  readonly nu: number
  readonly nv: number
  readonly h: Float64Array
  /** The `by` of `CutMap`; `owner` is written into every cell a move lowers. */
  readonly by: Uint16Array
  owner = 0

  constructor(
    readonly length: number,
    readonly width: number,
    readonly cell: number,
  ) {
    this.nu = Math.max(1, Math.ceil(length / cell - EPS))
    this.nv = Math.max(1, Math.ceil(width / cell - EPS))
    this.h = new Float64Array(this.nu * this.nv)
    this.by = new Uint16Array(this.nu * this.nv)
  }

  /** Lowers the map under every feed move of `moves` from `from`; returns the end position. */
  cut(p: ToolProfile, from: Vec3 | undefined, moves: readonly Move[]): Vec3 | undefined {
    let at = from
    for (const m of moves) at = this.move(p, at, m)
    return at
  }

  private move(p: ToolProfile, from: Vec3 | undefined, m: Move): Vec3 | undefined {
    if (m.kind === 'drill') {
      let at: Vec3 = from ?? [m.at[0], m.at[1], m.retract]
      for (const f of expandDrill(m)) at = this.move(p, at, f) ?? at
      return [m.at[0], m.at[1], m.retract]
    }
    if (m.kind === 'rapid' || from === undefined) return m.to
    if (m.kind === 'line') {
      this.segment(p, from, m.to)
      return m.to
    }
    const a = from
    const b = m.to
    const sweep = arcSweep(a, m)
    const [cx, cy] = m.center
    const r = Math.hypot(a[0] - cx, a[1] - cy)
    const a0 = Math.atan2(a[1] - cy, a[0] - cx)
    if (Math.abs(b[2] - a[2]) < EPS) {
      // a level arc, exact: in pieces of at most a half turn
      const n = Math.max(1, Math.ceil(Math.abs(sweep) / Math.PI - EPS))
      for (let k = 0; k < n; k++)
        this.arc(p, cx, cy, r, a0 + (sweep * k) / n, a0 + (sweep * (k + 1)) / n, a[2])
      return b
    }
    // a helix: chords within CHORD_TOL
    const maxAngle = r <= CHORD_TOL ? Math.PI : 2 * Math.acos(Math.max(-1, 1 - CHORD_TOL / r))
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / maxAngle))
    let prev: Vec3 = a
    for (let k = 1; k <= n; k++) {
      const t = k / n
      const q: Vec3 =
        k === n
          ? b
          : [
              cx + r * Math.cos(a0 + sweep * t),
              cy + r * Math.sin(a0 + sweep * t),
              a[2] + (b[2] - a[2]) * t,
            ]
      this.segment(p, prev, q)
      prev = q
    }
    return b
  }

  /** Cell index range covering `[lo, hi]` along one axis. */
  private range(lo: number, hi: number, n: number): [number, number] {
    const c = this.cell
    return [Math.max(0, Math.ceil(lo / c - 0.5)), Math.min(n - 1, Math.floor(hi / c - 0.5))]
  }

  /** A straight feed move a → b. */
  segment(p: ToolProfile, a: Vec3, b: Vec3): void {
    const dz = b[2] - a[2]
    if (!p.flat && Math.abs(dz) > Z_STEP) {
      // a shaped tool on a slope: pieces of at most Z_STEP, each evaluated at its closest point
      const n = Math.ceil(Math.abs(dz) / Z_STEP)
      let prev = a
      for (let k = 1; k <= n; k++) {
        const t = k / n
        const q: Vec3 =
          k === n ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + dz * t]
        this.piece(p, prev, q)
        prev = q
      }
      return
    }
    this.piece(p, a, b)
  }

  private piece(p: ToolProfile, a: Vec3, b: Vec3): void {
    const R = p.radius
    const reach2 = (R + EPS) * (R + EPS)
    const c = this.cell
    const { nu, h, by, owner } = this
    const [i0, i1] = this.range(Math.min(a[0], b[0]) - R, Math.max(a[0], b[0]) + R, nu)
    const [j0, j1] = this.range(Math.min(a[1], b[1]) - R, Math.max(a[1], b[1]) + R, this.nv)
    if (i1 < i0 || j1 < j0) return
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const dz = b[2] - a[2]
    const l2 = dx * dx + dy * dy
    const za = a[2]
    const vertical = l2 < EPS * EPS
    const level = Math.abs(dz) < EPS
    const zLow = Math.min(a[2], b[2])
    const surface = p.surface
    for (let j = j0; j <= j1; j++) {
      const py = (j + 0.5) * c - a[1]
      const row = j * nu
      for (let i = i0; i <= i1; i++) {
        const px = (i + 0.5) * c - a[0]
        let v: number
        if (vertical) {
          const d2 = px * px + py * py
          if (d2 > reach2) continue
          v = p.flat ? zLow : zLow + surface(Math.sqrt(d2))
        } else {
          const tp = (px * dx + py * dy) / l2
          const t = tp < 0 ? 0 : tp > 1 ? 1 : tp
          const ex = px - t * dx
          const ey = py - t * dy
          const d2 = ex * ex + ey * ey
          if (d2 > reach2) continue
          if (!p.flat) v = za + dz * t + surface(Math.sqrt(d2))
          else if (level) v = za
          else {
            // a flat end on a slope: the lowest tip Z where the point is under the tool
            const h2 = Math.max(0, px * px + py * py - tp * tp * l2)
            const w = Math.sqrt(Math.max(0, (R * R - h2) / l2))
            const t1 = Math.max(0, tp - w)
            const t2 = Math.min(1, tp + w)
            v = za + dz * (dz > 0 ? t1 : t2)
          }
        }
        const k = row + i
        if (v < h[k]!) {
          h[k] = v
          by[k] = owner
        }
      }
    }
  }

  /** A level arc of at most a half turn about (cx, cy) from angle `s` to `e` at Z `z`. */
  private arc(p: ToolProfile, cx: number, cy: number, r: number, s: number, e: number, z: number) {
    const R = p.radius
    const reach2 = (R + EPS) * (R + EPS)
    const c = this.cell
    const { nu, h, owner } = this
    const cutBy = this.by
    // start and end directions; ccw from `lo` to `hi`
    const [lo, hi] = e >= s ? [s, e] : [e, s]
    const lx = Math.cos(lo)
    const ly = Math.sin(lo)
    const hx = Math.cos(hi)
    const hy = Math.sin(hi)
    // the arc's bounds: its ends and the axis extremes it passes
    let minX = cx + r * Math.min(lx, hx)
    let maxX = cx + r * Math.max(lx, hx)
    let minY = cy + r * Math.min(ly, hy)
    let maxY = cy + r * Math.max(ly, hy)
    for (let k = Math.ceil(lo / (Math.PI / 2)); k * (Math.PI / 2) <= hi; k++) {
      const q = ((k % 4) + 4) % 4
      if (q === 0) maxX = cx + r
      else if (q === 1) maxY = cy + r
      else if (q === 2) minX = cx - r
      else minY = cy - r
    }
    const [i0, i1] = this.range(minX - R, maxX + R, nu)
    const [j0, j1] = this.range(minY - R, maxY + R, this.nv)
    if (i1 < i0 || j1 < j0) return
    const ax = cx + r * lx
    const ay = cy + r * ly
    const bx = cx + r * hx
    const by = cy + r * hy
    const surface = p.surface
    for (let j = j0; j <= j1; j++) {
      const y = (j + 0.5) * c
      const vy = y - cy
      const row = j * nu
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * c
        const vx = x - cx
        let d2: number
        // inside the sector (≤ a half turn): ccw of `lo` and cw of `hi`
        if (lx * vy - ly * vx >= 0 && vx * hy - vy * hx >= 0) {
          const d = Math.sqrt(vx * vx + vy * vy) - r
          d2 = d * d
        } else {
          const da = (x - ax) * (x - ax) + (y - ay) * (y - ay)
          const db = (x - bx) * (x - bx) + (y - by) * (y - by)
          d2 = da < db ? da : db
        }
        if (d2 > reach2) continue
        const v = p.flat ? z : z + surface(Math.sqrt(d2))
        const k = row + i
        if (v < h[k]!) {
          h[k] = v
          cutBy[k] = owner
        }
      }
    }
  }
}

/** A toolpath from the setup's WCS back in the direction's face frame (`fromWcs`). */
function toFace(moves: readonly Move[], back: (q: Vec2) => Vec2): Move[] {
  const xyz = (p: Vec3): Vec3 => {
    const [u, v] = back([p[0], p[1]])
    return [u, v, p[2]]
  }
  return moves.map((m): Move => {
    switch (m.kind) {
      case 'rapid':
      case 'line':
        return { ...m, to: xyz(m.to) }
      case 'arc':
        return { ...m, to: xyz(m.to), center: back(m.center) }
      case 'drill':
        return { ...m, at: back(m.at) }
    }
  })
}

function tooLarge(cells: number, cell: number): AppResult<never> {
  return fail('input.malformed', `the cut map would have ${cells} cells`, {
    where: 'simulateHeightmap',
    issues: [
      {
        path: ['cell'],
        rule: 'tooLarge',
        message: `more than ${SIMULATE_CELLS_MAX} cells per direction at ${cell} mm`,
        params: { limit: SIMULATE_CELLS_MAX, actual: cells },
      },
    ],
  })
}

/**
 * The cut maps of a plan's setups, one per direction in order of first use: each setup's feed
 * moves swept over the stock top of its direction (setups of other directions do not lower it:
 * no in-process stock across directions yet), clamped at the stock bottom. One step per
 * toolpath and per `MOVES_PER_STEP` moves.
 */
export function simulateHeightmap(
  input: SimulateInput,
  steps: Steps = noSteps,
): AppResult<CutMap[]> {
  const cell = input.cell ?? SIMULATE_CELL
  if (!(cell >= SIMULATE_CELL_MIN))
    return fail('input.malformed', `cell ${cell} mm is below ${SIMULATE_CELL_MIN} mm`, {
      where: 'simulateHeightmap',
      issues: [{ path: ['cell'], rule: 'tooSmall', message: `at least ${SIMULATE_CELL_MIN} mm` }],
    })
  const grids = new Map<Direction, CutGrid>()
  for (const s of input.setups) {
    if (grids.has(s.direction)) continue
    const face = localStock(s.direction, input.stock)
    const grid = new CutGrid(face.length, face.width, cell)
    if (grid.nu * grid.nv > SIMULATE_CELLS_MAX) return tooLarge(grid.nu * grid.nv, cell)
    grids.set(s.direction, grid)
  }
  const total = input.setups.reduce((n, s) => n + s.toolpaths.length, 0)
  let done = 0
  for (const s of input.setups) {
    const grid = grids.get(s.direction)!
    const wcs = setupWcs(s.direction, s.rotation, input.stock, s.zero)
    for (const { tool, toolpath } of s.toolpaths) {
      const label = `Simulating ${s.direction}: ${toolpath.planOperationId}`
      const step = steps.step({ done, total, label })
      if (step.isErr()) return step
      const profile = toolProfile(tool)
      grid.owner = Math.min(done + 1, 0xffff)
      let at: Vec3 | undefined
      let count = 0
      for (const pass of toolpath.passes) {
        const moves = wcs === undefined ? pass.moves : toFace(pass.moves, (q) => fromWcs(q, wcs))
        for (let k = 0; k < moves.length; k += MOVES_PER_STEP) {
          if (count > 0) {
            const more = steps.step({ done, total, label })
            if (more.isErr()) return more
          }
          at = grid.cut(profile, at, moves.slice(k, k + MOVES_PER_STEP))
          count += MOVES_PER_STEP
        }
      }
      done++
    }
  }
  return Ok(
    [...grids].map(([direction, g]) => {
      const floor = -localStock(direction, input.stock).thickness
      const h = new Float32Array(g.h.length)
      for (let k = 0; k < h.length; k++) h[k] = Math.max(floor, g.h[k]!)
      return { direction, cell, nu: g.nu, nv: g.nv, h, by: g.by }
    }),
  )
}
