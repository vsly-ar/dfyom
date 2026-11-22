/**
 * Test oracles for toolpaths, independent of the generators: move walking and sampling,
 * signed distances to contours, a heightmap material-removal simulation and a text rendering
 * for golden files. Doc: docs/modes/plan-v0.1.md#toolpath-generators-task-210
 */
import type { AnalyticContour as Contour, Vec2, Vec3 } from '../../geometry/model'
import type { Move, Toolpath, ToolpathTool } from '../model'
import { arcSweep, expandDrill } from '../stats'

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

/** Height of the tool's lower surface at radial distance `rho` above its tip (Infinity outside). */
export function toolSurface(tool: ToolpathTool, rho: number): number {
  const R = tool.diameter / 2
  if (rho > R + 1e-12) return Infinity
  if (tool.type === 'drill') {
    const half = ((tool.pointAngle ?? 180) * Math.PI) / 360
    return half >= Math.PI / 2 - 1e-12 ? 0 : rho / Math.tan(half)
  }
  const re = tool.cornerRadius
  const flat = R - re
  if (rho <= flat) return 0
  const d = Math.min(re, rho - flat)
  return re - Math.sqrt(re * re - d * d)
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
    const i0 = Math.max(0, Math.floor((p[0] - R) / this.cell))
    const i1 = Math.min(this.nx - 1, Math.ceil((p[0] + R) / this.cell))
    const j0 = Math.max(0, Math.floor((p[1] - R) / this.cell))
    const j1 = Math.min(this.ny - 1, Math.ceil((p[1] + R) / this.cell))
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const [x, y] = this.center(i, j)
        const h = p[2] + toolSurface(tool, Math.sqrt((x - p[0]) ** 2 + (y - p[1]) ** 2))
        const k = j * this.nx + i
        if (h < this.z[k]!) this.z[k] = h
      }
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
