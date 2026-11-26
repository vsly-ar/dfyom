/**
 * Test oracles for toolpaths, independent of the generators: move walking and sampling,
 * signed distances to contours, a heightmap material-removal simulation and a text rendering
 * for golden files. Doc: docs/modes/plan-v0.1.md#toolpath-generators-task-210
 */
import type { AnalyticContour as Contour, Vec2, Vec3 } from '../../geometry/model'
import type { Move, Toolpath, ToolpathTool } from '../model'
import { arcSweep, expandDrill } from '../stats'
import { toolSurface } from '../stock-heights'

export type FlatMove = Exclude<Move, { kind: 'drill' }>

export interface Step {
  readonly from: Vec3
  readonly move: FlatMove
  readonly pass: number
}

/** Every move with its start, drill cycles expanded; the first move has no start and is skipped. */
export function steps(tp: Toolpath): Step[] {
  const out: Step[] = []
  let pos: Vec3 | undefined
  tp.passes.forEach((p, pass) => {
    for (const m of p.moves) {
      const flat: FlatMove[] = m.kind === 'drill' ? expandDrill(m) : [m]
      for (const f of flat) {
        if (pos !== undefined) out.push({ from: pos, move: f, pass })
        pos = f.to
      }
    }
  })
  return out
}

/** Points along a move, at most `step` apart, both ends included. */
export function samples(s: Step, step: number): Vec3[] {
  const { from, move: m } = s
  if (m.kind !== 'arc') {
    const len = Math.hypot(m.to[0] - from[0], m.to[1] - from[1], m.to[2] - from[2])
    const n = Math.max(1, Math.ceil(len / step))
    return Array.from({ length: n + 1 }, (_, i) => {
      const u = i / n
      return [
        from[0] + (m.to[0] - from[0]) * u,
        from[1] + (m.to[1] - from[1]) * u,
        from[2] + (m.to[2] - from[2]) * u,
      ]
    })
  }
  const r = Math.hypot(from[0] - m.center[0], from[1] - m.center[1])
  const a0 = Math.atan2(from[1] - m.center[1], from[0] - m.center[0])
  const sweep = arcSweep(from, m)
  const n = Math.max(1, Math.ceil((r * Math.abs(sweep)) / step))
  return Array.from({ length: n + 1 }, (_, i) => {
    const u = i / n
    const a = a0 + sweep * u
    return [
      m.center[0] + r * Math.cos(a),
      m.center[1] + r * Math.sin(a),
      from[2] + (m.to[2] - from[2]) * u,
    ]
  })
}

/** Signed distance from `p` to a contour centered at `center` (positive inside). */
export function insideDistance(c: Contour, center: Vec2, p: Vec2): number {
  const x = p[0] - center[0]
  const y = p[1] - center[1]
  if (c.kind === 'circle') return c.radius - Math.hypot(x, y)
  const r = c.cornerRadius
  const qx = Math.abs(x) - (c.length / 2 - r)
  const qy = Math.abs(y) - (c.width / 2 - r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return -(outside + Math.min(Math.max(qx, qy), 0) - r)
}

/** The tool's lower surface (production code since DF64: the field and the oracle share it). */
export { toolSurface }

/**
 * `toolSurface(tool, ·)` with the tool's constants taken once: the same numbers, without a
 * `Math.tan` per cell (that tangent was most of a chamfer or drill sweep's time;
 * docs/conventions/testing.md#load-stable-tests).
 */
export function surfaceOf(tool: ToolpathTool): (rho: number) => number {
  const R = tool.diameter / 2
  if (tool.type === 'chamferMill') {
    const tip = (tool.tipDiameter ?? 0) / 2
    const tan = Math.tan(((tool.angle ?? 90) * Math.PI) / 360)
    return (rho) => (rho > R + 1e-12 ? Infinity : rho <= tip ? 0 : (rho - tip) / tan)
  }
  if (tool.type === 'drill') {
    const half = ((tool.pointAngle ?? 180) * Math.PI) / 360
    if (half >= Math.PI / 2 - 1e-12) return (rho) => (rho > R + 1e-12 ? Infinity : 0)
    const tan = Math.tan(half)
    return (rho) => (rho > R + 1e-12 ? Infinity : rho / tan)
  }
  return (rho) => toolSurface(tool, rho)
}

/** Heightmap over `0..length × 0..width` (cell centers), starting at the stock top Z0. */
export class Heightmap {
  readonly nx: number
  readonly ny: number
  readonly z: Float64Array

  constructor(
    readonly length: number,
    readonly width: number,
    readonly cell: number,
  ) {
    this.nx = Math.round(length / cell)
    this.ny = Math.round(width / cell)
    this.z = new Float64Array(this.nx * this.ny).fill(0)
  }

  center(i: number, j: number): Vec2 {
    return [(i + 0.5) * this.cell, (j + 0.5) * this.cell]
  }

  /** Lower every cell the tool at `p` (tip) reaches. */
  stamp(tool: ToolpathTool, p: Vec3): void {
    const R = tool.diameter / 2
    const { cell, nx, z } = this
    const i0 = Math.max(0, Math.floor((p[0] - R) / cell))
    const i1 = Math.min(nx - 1, Math.ceil((p[0] + R) / cell))
    const j0 = Math.max(0, Math.floor((p[1] - R) / cell))
    const j1 = Math.min(this.ny - 1, Math.ceil((p[1] + R) / cell))
    // the same numbers as center() and toolSurface() cell by cell, without an array per cell and
    // row by row in memory: sweeps stamp millions of cells (docs/conventions/testing.md, Load-stable tests)
    // a flat end: toolSurface is 0 up to R + 1e-12 and Infinity beyond, so the cell takes the tip's Z
    const flat = tool.type !== 'chamferMill' && tool.type !== 'drill' && tool.cornerRadius === 0
    const reach = R + 1e-12
    const surface = flat ? undefined : surfaceOf(tool)
    for (let j = j0; j <= j1; j++) {
      const dy2 = ((j + 0.5) * cell - p[1]) ** 2
      const row = j * nx
      if (flat) {
        for (let i = i0; i <= i1; i++)
          if (Math.sqrt(((i + 0.5) * cell - p[0]) ** 2 + dy2) <= reach && p[2] < z[row + i]!)
            z[row + i] = p[2]
        continue
      }
      for (let i = i0; i <= i1; i++) {
        const h = p[2] + surface!(Math.sqrt(((i + 0.5) * cell - p[0]) ** 2 + dy2))
        if (h < z[row + i]!) z[row + i] = h
      }
    }
  }

  /** How far (mm) the tool at `p` would lower the cell it lowers most (0: air); changes nothing. */
  probe(tool: ToolpathTool, p: Vec3): number {
    const R = tool.diameter / 2
    const { cell, nx, z } = this
    const surface = surfaceOf(tool)
    let most = 0
    for (
      let j = Math.max(0, Math.floor((p[1] - R) / cell));
      j <= Math.min(this.ny - 1, Math.ceil((p[1] + R) / cell));
      j++
    )
      for (
        let i = Math.max(0, Math.floor((p[0] - R) / cell));
        i <= Math.min(nx - 1, Math.ceil((p[0] + R) / cell));
        i++
      ) {
        const h = p[2] + surface(Math.hypot((i + 0.5) * cell - p[0], (j + 0.5) * cell - p[1]))
        const k = j * nx + i
        if (h < z[k]!) most = Math.max(most, z[k]! - h)
      }
    return most
  }

  /** Sweep every feed move of a toolpath (rapids are checked separately: they never cut). */
  sweep(tool: ToolpathTool, tp: Toolpath, step = 0.1): void {
    for (const s of steps(tp))
      if (s.move.kind !== 'rapid') for (const p of samples(s, step)) this.stamp(tool, p)
  }
}

const f = (n: number) => {
  const s = (Math.round(n * 1e4) / 1e4).toFixed(4).replace(/\.?0+$/, '')
  return s === '-0' ? '0' : s
}
const v = (p: readonly number[]) => p.map(f).join(' ')

/** One line per move, numbers rounded to 0.1 µm: the golden-file format. */
export function render(tp: Toolpath): string {
  const lines = [
    `toolpath ${tp.planOperationId} tool ${tp.tool} S${tp.spindleSpeed}`,
    `stats cut ${f(tp.stats.cutLength)} rapid ${f(tp.stats.rapidLength)} s ${f(tp.stats.estimatedSeconds)}`,
  ]
  for (const p of tp.passes) {
    lines.push(`pass ${p.kind}`)
    for (const m of p.moves) {
      if (m.kind === 'rapid') lines.push(`  rapid ${v(m.to)}`)
      else if (m.kind === 'line') lines.push(`  line ${v(m.to)} F${f(m.feed)}`)
      else if (m.kind === 'arc')
        lines.push(`  arc ${v(m.to)} c ${v(m.center)} ${m.cw ? 'cw' : 'ccw'} F${f(m.feed)}`)
      else
        lines.push(
          `  drill ${v(m.at)} top ${f(m.top)} bottom ${f(m.bottom)} ${m.cycle}` +
            `${m.peck === undefined ? '' : ` peck ${f(m.peck)}`}${m.back === undefined ? '' : ` back ${f(m.back)}`}` +
            ` retract ${f(m.retract)} F${f(m.feed)}`,
        )
    }
  }
  return lines.join('\n') + '\n'
}
