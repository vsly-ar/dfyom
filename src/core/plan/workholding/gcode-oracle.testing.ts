// Test-only: an independent G-code oracle for workholding (workholding.md § Testing). It parses
// an exported GRBL program (G0/G1/G2/G3, G20/G21, absolute XYZ, I/J arcs), walks every move in
// 0.05 mm steps along true lines and arcs, and returns the smallest XY gap between the tool
// (radius `radius`) and any box while the tip is below the box's top + `margin`. A later tool's
// own Z0 ("(Z0 for tool 2: Facing 1 floor, 1.00 below the stock top)", DF69) applies from its
// tool change's M0, so every height is from the stock top. It shares no code with
// `checkWorkholding`. Not app code.

export interface OracleBox {
  readonly x: readonly [number, number]
  readonly y: readonly [number, number]
  readonly top: number
}

const STEP = 0.05

function boxDistance(b: OracleBox, x: number, y: number): number {
  const dx = Math.max(b.x[0] - x, 0, x - b.x[1])
  const dy = Math.max(b.y[0] - y, 0, y - b.y[1])
  return Math.hypot(dx, dy)
}

/**
 * The smallest gap (mm) between the tool and a box over every executed move below the box's
 * top + margin; Infinity when no move passes below one. Moves from an unknown position (program
 * start, after a pause) count from their end point.
 */
export function gcodeClearance(
  text: string,
  boxes: readonly OracleBox[],
  radius: number,
  margin = 2,
): number {
  let scale = 1
  let mode = 0
  let pos: [number, number, number] | undefined
  let z = Number.NaN
  let best = Infinity
  // the current tool's Z0 below the stock top, and the next tool's (from its tool change's M0)
  let z0 = 0
  let nextZ0: number | undefined
  const visit = (x: number, y: number, zz: number) => {
    for (const b of boxes)
      if (zz - z0 < b.top + margin - 1e-6) best = Math.min(best, boxDistance(b, x, y) - radius)
  }
  for (const raw of text.split('\n')) {
    const below = /\(Z0 for tool \d+: .*, (-?[0-9.]+) below the stock top\)/.exec(raw)
    if (below !== null) nextZ0 = Number(below[1]) * scale
    const line = raw
      .replace(/\(.*?\)/g, '')
      .replace(/;.*$/, '')
      .trim()
      .toUpperCase()
    if (line === '') continue
    const words = new Map<string, number[]>()
    for (const m of line.matchAll(/([A-Z])\s*(-?[0-9.]+)/g)) {
      const list = words.get(m[1]!) ?? []
      list.push(Number(m[2]))
      words.set(m[1]!, list)
    }
    for (const g of words.get('G') ?? []) {
      if (g === 20) scale = 25.4
      else if (g === 21) scale = 1
      else if (g >= 0 && g <= 3) mode = g
    }
    if (words.has('M') && (words.get('M') ?? []).includes(0)) {
      // a pause: X and Y unknown afterwards (the operator may jog)
      pos = undefined
      if (nextZ0 !== undefined) z0 = nextZ0
      nextZ0 = undefined
    }
    const val = (k: string) => (words.has(k) ? words.get(k)![0]! * scale : undefined)
    const X = val('X')
    const Y = val('Y')
    const Z = val('Z')
    if (X === undefined && Y === undefined && Z === undefined) continue
    if (pos === undefined) {
      if (Z !== undefined) z = Z
      if (X === undefined || Y === undefined) continue
      pos = [X, Y, z]
      visit(X, Y, z)
      continue
    }
    const to: [number, number, number] = [X ?? pos[0], Y ?? pos[1], Z ?? pos[2]]
    if (mode === 2 || mode === 3) {
      const cx = pos[0] + (val('I') ?? 0)
      const cy = pos[1] + (val('J') ?? 0)
      const r = Math.hypot(pos[0] - cx, pos[1] - cy)
      const a0 = Math.atan2(pos[1] - cy, pos[0] - cx)
      let a1 = Math.atan2(to[1] - cy, to[0] - cx)
      if (mode === 2) {
        while (a1 >= a0) a1 -= 2 * Math.PI
      } else while (a1 <= a0) a1 += 2 * Math.PI
      const n = Math.max(1, Math.ceil((Math.abs(a1 - a0) * r) / STEP))
      for (let k = 0; k <= n; k++) {
        const a = a0 + ((a1 - a0) * k) / n
        visit(cx + r * Math.cos(a), cy + r * Math.sin(a), pos[2] + ((to[2] - pos[2]) * k) / n)
      }
    } else {
      const len = Math.hypot(to[0] - pos[0], to[1] - pos[1], to[2] - pos[2])
      const n = Math.max(1, Math.ceil(len / STEP))
      for (let k = 0; k <= n; k++) {
        const t = k / n
        visit(
          pos[0] + (to[0] - pos[0]) * t,
          pos[1] + (to[1] - pos[1]) * t,
          pos[2] + (to[2] - pos[2]) * t,
        )
      }
    }
    pos = to
    z = to[2]
  }
  return best
}
