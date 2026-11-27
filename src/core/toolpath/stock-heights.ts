/**
 * The in-process stock height field of a setup (hardening DF64): per 0.5 mm cell an upper bound
 * of the material's top, lowered by feed moves with the tool's real profile (conservative
 * rasterisation: a cell is lowered only to the highest point of the tool's envelope anywhere
 * over it), and the cleared footprint's clamp floor (where the program's tool proves no clamp
 * rises above its envelope). Pure, headless, float64.
 * Doc: docs/modes/safe-links.md#in-process-stock-height-field, #clamps
 */
import type { Move, ToolpathTool, Vec2, Vec3 } from './model'
import { arcSweep, expandDrill } from './stats'

/** Cell size of the field (mm), anchored at the setup's WCS origin. */
export const STOCK_CELL = 0.5

/** Largest Z change of one stamped piece of a sloped move or helix (mm). */
const Z_STEP = 0.1
/** Largest sagitta of an arc's chord (mm); added to the stamped distance. */
const CHORD_TOL = 0.01
/** A move at or below the stock top counts for the cleared footprint (mm). */
const AT_TOP = 1e-9

/**
 * Height of the tool's lower surface at radial distance `rho` above its tip (Infinity outside): flat,
 * bull nose, ball, a drill's point, a chamfer mill's cone over its tip diameter. Shared with the
 * test oracle `Heightmap`, so the field and the simulated cut agree about tool shapes.
 */
export function toolSurface(tool: ToolpathTool, rho: number): number {
  if (tool.type === 'taperedBallEndMill') {
    const p = taperedBallProfile(tool)
    return rho > p.radius + 1e-12 ? Infinity : p.surface(rho)
  }
  const R = tool.diameter / 2
  if (rho > R + 1e-12) return Infinity
  if (tool.type === 'chamferMill') {
    // a cone of the included angle above a flat tip of `tipDiameter` (v0.4 T1)
    const tip = (tool.tipDiameter ?? 0) / 2
    return rho <= tip ? 0 : (rho - tip) / Math.tan(((tool.angle ?? 90) * Math.PI) / 360)
  }
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

/**
 * A tapered ball end mill's lower surface (docs/modes/tapered-ball-nose.md#the-tool): a ball of
 * radius r under a cone of θ per side, tangent to it, up to min(h_D, LCF); `radius` is the cutting
 * radius there (DC/2, or the cone's radius at the flute length when the flutes end first).
 */
export function taperedBallProfile(tool: ToolpathTool): {
  readonly radius: number
  readonly surface: (rho: number) => number
} {
  const R = tool.diameter / 2
  const r = Math.min((tool.tipDiameter ?? 0) / 2, R)
  const theta = ((tool.taperAngle ?? 0) * Math.PI) / 180
  const tan = Math.tan(theta)
  const rc = r * Math.cos(theta)
  const ht = r * (1 - Math.sin(theta))
  const lcf = tool.fluteLength
  // the cutting radius at the flute length, capped at DC/2
  const atFlutes =
    lcf >= ht ? rc + (lcf - ht) * tan : Math.sqrt(Math.max(0, r * r - (r - Math.max(0, lcf)) ** 2))
  return {
    radius: Math.min(R, atFlutes),
    surface: (rho) =>
      rho <= rc || tan <= 0
        ? r - Math.sqrt(Math.max(0, r * r - Math.min(rho, r) ** 2))
        : ht + (rho - rc) / tan,
  }
}

/** One straight XY piece of a feed move, stamped at its highest Z. */
interface Piece {
  readonly ax: number
  readonly ay: number
  readonly bx: number
  readonly by: number
  /** The highest tip Z along the piece (its lowest for a vertical piece). */
  readonly z: number
  /** Its lowest tip Z (through-cut test). */
  readonly zMin: number
  /** Added to every distance (an arc chord's sagitta). */
  readonly extra: number
}

/** The feed moves of a toolpath move from `from` as straight pieces; rapids give none. */
export function feedPieces(from: Vec3 | undefined, m: Move, out: Piece[]): Vec3 {
  if (m.kind === 'drill') {
    let at: Vec3 = from ?? [m.at[0], m.at[1], m.retract]
    for (const f of expandDrill(m)) at = feedPieces(at, f, out)
    return [m.at[0], m.at[1], m.retract]
  }
  if (m.kind === 'rapid' || from === undefined) return m.to
  const a = from
  const b = m.to
  if (m.kind === 'line') {
    linePieces(a, b, 0, out)
    return b
  }
  const r = Math.hypot(a[0] - m.center[0], a[1] - m.center[1])
  const sweep = arcSweep(a, m)
  const full = a[0] === b[0] && a[1] === b[1]
  const s = full ? (m.cw ? -2 * Math.PI : 2 * Math.PI) : sweep
  // chords within CHORD_TOL of the arc (sagitta r (1 − cos(θ/2)))
  const maxAngle = r <= CHORD_TOL ? Math.PI : 2 * Math.acos(Math.max(-1, 1 - CHORD_TOL / r))
  const n = Math.max(1, Math.ceil(Math.abs(s) / maxAngle))
  const sag = r * (1 - Math.cos(Math.abs(s) / n / 2))
  const a0 = Math.atan2(a[1] - m.center[1], a[0] - m.center[0])
  let prev: Vec3 = a
  for (let k = 1; k <= n; k++) {
    const t = k / n
    const p: Vec3 =
      k === n
        ? b
        : [
            m.center[0] + r * Math.cos(a0 + s * t),
            m.center[1] + r * Math.sin(a0 + s * t),
            a[2] + (b[2] - a[2]) * t,
          ]
    linePieces(prev, p, sag, out)
    prev = p
  }
  return b
}

function linePieces(a: Vec3, b: Vec3, extra: number, out: Piece[]): void {
  const dz = b[2] - a[2]
  if (Math.abs(b[0] - a[0]) < 1e-9 && Math.abs(b[1] - a[1]) < 1e-9) {
    // vertical: the tool reaches its lowest point at the same XY
    const z = Math.min(a[2], b[2])
    out.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], z, zMin: z, extra })
    return
  }
  const n = Math.max(1, Math.ceil(Math.abs(dz) / Z_STEP - 1e-9))
  for (let k = 0; k < n; k++) {
    const u0 = k / n
    const u1 = (k + 1) / n
    const z0 = a[2] + dz * u0
    const z1 = a[2] + dz * u1
    out.push({
      ax: a[0] + (b[0] - a[0]) * u0,
      ay: a[1] + (b[1] - a[1]) * u0,
      bx: a[0] + (b[0] - a[0]) * u1,
      by: a[1] + (b[1] - a[1]) * u1,
      z: Math.max(z0, z1),
      zMin: Math.min(z0, z1),
      extra,
    })
  }
}

/** Squared distance from (px, py) to the segment a–b. */
function segDist2(
  px: number,
  py: number,
  ax: number,
  ay: number,
  dx: number,
  dy: number,
  l2: number,
): number {
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const x = px - ax - t * dx
  const y = py - ay - t * dy
  return x * x + y * y
}

/** The XY rectangle the field covers (mm, setup WCS). */
export interface FieldExtent {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

/**
 * The field over `extent` (grown to whole cells anchored at the WCS origin): material top Z0
 * inside the stock rectangle `[o, o + size]` (a cell touching it counts), none (−∞) outside; no
 * clamp floor known (+∞) anywhere. `origin` (o): the stock's front-left corner in the WCS, `−zero`
 * when the setup's work zero is moved (alignment DF78); default the WCS origin.
 */
export class StockHeights {
  /** Index of the first cell column / row (cell i spans [i·c, (i+1)·c]). */
  readonly i0: number
  readonly j0: number
  readonly nx: number
  readonly ny: number
  /** Upper bound of the material's top per cell; −∞ = no material. */
  readonly top: Float64Array
  /** Cells a through cut touched: the freed piece may move, they count at Z0. */
  readonly pinned: Uint8Array
  /** Lowest tool envelope over the whole cell at or below the stock top; +∞ = not cleared. */
  readonly floor: Float64Array
  private corners = new Float64Array(0)

  constructor(
    size: Vec2,
    extent: FieldExtent,
    readonly cell = STOCK_CELL,
    origin: Vec2 = [0, 0],
  ) {
    const c = cell
    const [ox, oy] = origin
    this.i0 = Math.floor(Math.min(extent.minX, ox) / c) - 1
    this.j0 = Math.floor(Math.min(extent.minY, oy) / c) - 1
    this.nx = Math.floor(Math.max(extent.maxX, ox + size[0]) / c) + 2 - this.i0
    this.ny = Math.floor(Math.max(extent.maxY, oy + size[1]) / c) + 2 - this.j0
    const n = this.nx * this.ny
    this.top = new Float64Array(n).fill(-Infinity)
    this.pinned = new Uint8Array(n)
    this.floor = new Float64Array(n).fill(Infinity)
    for (let j = 0; j < this.ny; j++) {
      const y0 = (this.j0 + j) * c
      if (y0 + c < oy || y0 > oy + size[1]) continue
      for (let i = 0; i < this.nx; i++) {
        const x0 = (this.i0 + i) * c
        if (x0 + c < ox || x0 > ox + size[0]) continue
        this.top[j * this.nx + i] = 0
      }
    }
  }

  /** The material bound of cell k (a pinned cell counts at least at Z0). */
  height(k: number): number {
    const t = this.top[k]!
    return this.pinned[k] === 1 && t < 0 ? 0 : t
  }

  /** Cell index of a point, or −1 outside the field. */
  cellAt(x: number, y: number): number {
    const i = Math.floor(x / this.cell) - this.i0
    const j = Math.floor(y / this.cell) - this.j0
    return i < 0 || j < 0 || i >= this.nx || j >= this.ny ? -1 : j * this.nx + i
  }

  /**
   * Lowers the material under every feed move of `moves` (from `from`) with `tool`; moves
   * reaching `through` (the setup's through depth, ≤ 0) pin the cells they touch at Z0.
   * Returns the position after the last move.
   */
  cut(
    tool: ToolpathTool,
    from: Vec3 | undefined,
    moves: readonly Move[],
    through: number,
  ): Vec3 | undefined {
    const pieces: Piece[] = []
    let at = from
    for (const m of moves) at = feedPieces(at, m, pieces)
    for (const p of pieces) {
      this.stamp(tool, p, 'top')
      if (p.zMin <= through + 1e-6) this.pin(tool.diameter / 2, p)
    }
    return at
  }

  /**
   * The cleared footprint: lowers the clamp floor under every feed move at or below the stock top
   * (pass 1, over the whole program). With `stickout`, a move whose tip + stickout stays below
   * `clearance` does not count (the column is known clear only up to there).
   */
  clear(
    tool: ToolpathTool,
    from: Vec3 | undefined,
    moves: readonly Move[],
    clearance: number,
    stickout?: number,
  ): Vec3 | undefined {
    const pieces: Piece[] = []
    let at = from
    for (const m of moves) at = feedPieces(at, m, pieces)
    for (const p of pieces) {
      if (p.z > AT_TOP) continue
      if (stickout !== undefined && p.zMin + stickout < clearance) continue
      this.stamp(tool, p, 'floor')
    }
    return at
  }

  /**
   * Lowers `top` or `floor` per cell to the tool's envelope at the cell's farthest point from
   * the piece (the farthest of its corners: distance to a segment is convex), only where the
   * whole cell lies within the tool's radius.
   */
  private stamp(tool: ToolpathTool, p: Piece, into: 'top' | 'floor'): void {
    const R = tool.diameter / 2
    const reach = R - p.extra
    if (!(reach > 0)) return
    const c = this.cell
    const ci0 = Math.max(0, Math.floor((Math.min(p.ax, p.bx) - reach) / c) - this.i0)
    const ci1 = Math.min(this.nx - 1, Math.floor((Math.max(p.ax, p.bx) + reach) / c) - this.i0)
    const cj0 = Math.max(0, Math.floor((Math.min(p.ay, p.by) - reach) / c) - this.j0)
    const cj1 = Math.min(this.ny - 1, Math.floor((Math.max(p.ay, p.by) + reach) / c) - this.j0)
    if (ci1 < ci0 || cj1 < cj0) return
    const w = ci1 - ci0 + 2
    const h = cj1 - cj0 + 2
    if (this.corners.length < w * h) this.corners = new Float64Array(w * h * 2)
    const d2 = this.corners
    const dx = p.bx - p.ax
    const dy = p.by - p.ay
    const l2 = dx * dx + dy * dy
    for (let j = 0; j < h; j++) {
      const y = (this.j0 + cj0 + j) * c
      for (let i = 0; i < w; i++)
        d2[j * w + i] = segDist2((this.i0 + ci0 + i) * c, y, p.ax, p.ay, dx, dy, l2)
    }
    const flat = tool.type !== 'chamferMill' && tool.type !== 'drill' && tool.cornerRadius === 0
    const r2 = reach * reach
    const arr = into === 'top' ? this.top : this.floor
    for (let j = 0; j < h - 1; j++) {
      const row = (cj0 + j) * this.nx
      const k0 = j * w
      for (let i = 0; i < w - 1; i++) {
        const far = Math.max(d2[k0 + i]!, d2[k0 + i + 1]!, d2[k0 + w + i]!, d2[k0 + w + i + 1]!)
        if (far > r2) continue
        const v = flat ? p.z : p.z + toolSurface(tool, Math.sqrt(far) + p.extra)
        const k = row + ci0 + i
        if (v < arr[k]!) arr[k] = v
      }
    }
  }

  /** Pins every cell the tool touches at all along the piece. */
  private pin(R: number, p: Piece): void {
    const c = this.cell
    const reach = R + p.extra + c * Math.SQRT1_2
    const ci0 = Math.max(0, Math.floor((Math.min(p.ax, p.bx) - reach) / c) - this.i0)
    const ci1 = Math.min(this.nx - 1, Math.floor((Math.max(p.ax, p.bx) + reach) / c) - this.i0)
    const cj0 = Math.max(0, Math.floor((Math.min(p.ay, p.by) - reach) / c) - this.j0)
    const cj1 = Math.min(this.ny - 1, Math.floor((Math.max(p.ay, p.by) + reach) / c) - this.j0)
    const dx = p.bx - p.ax
    const dy = p.by - p.ay
    const l2 = dx * dx + dy * dy
    const r2 = reach * reach
    for (let j = cj0; j <= cj1; j++) {
      const y = (this.j0 + j + 0.5) * c
      for (let i = ci0; i <= ci1; i++)
        if (segDist2((this.i0 + i + 0.5) * c, y, p.ax, p.ay, dx, dy, l2) <= r2)
          this.pinned[j * this.nx + i] = 1
    }
  }
}
