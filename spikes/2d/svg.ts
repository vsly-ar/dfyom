// Spike S1 (docs/decisions/0019-2d-geometry-library.md): just enough SVG to read the corpus
// (`path` with M L H V C S Q A Z, absolute and relative; `circle`). Béziers become arcs and lines by
// 3-point arc subdivision within `tol`; v0.3 (lane D) replaces this with a real parser and
// tangent-continuous biarcs. Y is flipped so SVG shapes keep their look in a y-up face frame.

import { area, flatten, reverse, type Loop, type Pt, type Vertex } from './geom.ts'

type Curve = (t: number) => Pt

function circle3(a: Pt, b: Pt, c: Pt): { x: number; y: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < 1e-14) return null
  const a2 = a.x * a.x + a.y * a.y
  const b2 = b.x * b.x + b.y * b.y
  const c2 = c.x * c.x + c.y * c.y
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d
  const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d
  return { x, y, r: Math.hypot(a.x - x, a.y - y) }
}

/** Arcs/lines for curve(t0..t1); pushes vertices (start point + bulge), not the end point. */
function curveToArcs(
  f: Curve,
  t0: number,
  t1: number,
  tol: number,
  out: Vertex[],
  depth = 0,
): void {
  const a = f(t0)
  const b = f(t1)
  const m = f((t0 + t1) / 2)
  const samples = [0.125, 0.25, 0.375, 0.625, 0.75, 0.875].map((s) => f(t0 + (t1 - t0) * s))
  const chord = Math.hypot(b.x - a.x, b.y - a.y)
  // line?
  const lineErr = Math.max(
    ...[m, ...samples].map((q) =>
      chord < 1e-12
        ? Math.hypot(q.x - a.x, q.y - a.y)
        : Math.abs((q.x - a.x) * (b.y - a.y) - (q.y - a.y) * (b.x - a.x)) / chord,
    ),
  )
  if (lineErr <= tol || depth > 16) {
    out.push([a.x, a.y, 0])
    return
  }
  const c = circle3(a, m, b)
  if (c) {
    const err = Math.max(...samples.map((q) => Math.abs(Math.hypot(q.x - c.x, q.y - c.y) - c.r)))
    if (err <= tol) {
      const half = Math.atan2(
        (m.x - a.x) * (b.y - m.y) - (m.y - a.y) * (b.x - m.x),
        (m.x - a.x) * (b.x - m.x) + (m.y - a.y) * (b.y - m.y),
      )
      // turning angle a→m→b equals half the arc sweep
      out.push([a.x, a.y, Math.tan(half / 2)])
      return
    }
  }
  const tm = (t0 + t1) / 2
  curveToArcs(f, t0, tm, tol, out, depth + 1)
  curveToArcs(f, tm, t1, tol, out, depth + 1)
}

export function parsePath(d: string, tol: number): Loop[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []
  const loops: Loop[] = []
  let verts: Vertex[] = []
  let cur: Pt = { x: 0, y: 0 }
  let start: Pt = { x: 0, y: 0 }
  let lastCtrl: Pt | null = null
  let cmd = ''
  let i = 0
  const n = (): number => Number(tokens[i++])
  const close = (): void => {
    if (verts.length > 1) {
      const f = verts[0]!
      const l = verts[verts.length - 1]!
      // drop the closing duplicate if the last segment ended on the start
      if (Math.hypot(l[0] - f[0], l[1] - f[1]) < 1e-9 && l[2] === 0) verts.pop()
      loops.push({ closed: true, verts })
    }
    verts = []
  }
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i]!)) cmd = tokens[i++]!
    const rel = cmd === cmd.toLowerCase()
    const ox = rel ? cur.x : 0
    const oy = rel ? cur.y : 0
    switch (cmd.toUpperCase()) {
      case 'M': {
        close()
        cur = { x: ox + n(), y: oy + n() }
        start = cur
        cmd = rel ? 'l' : 'L'
        lastCtrl = null
        break
      }
      case 'L':
      case 'H':
      case 'V': {
        const u = cmd.toUpperCase()
        const p =
          u === 'L'
            ? { x: ox + n(), y: oy + n() }
            : u === 'H'
              ? { x: ox + n(), y: cur.y }
              : { x: cur.x, y: oy + n() }
        verts.push([cur.x, cur.y, 0])
        cur = p
        lastCtrl = null
        break
      }
      case 'C':
      case 'S':
      case 'Q': {
        const u = cmd.toUpperCase()
        const p0 = cur
        let c1: Pt
        if (u === 'S') c1 = lastCtrl ? { x: 2 * p0.x - lastCtrl.x, y: 2 * p0.y - lastCtrl.y } : p0
        else c1 = { x: ox + n(), y: oy + n() }
        const c2 = u === 'Q' ? c1 : { x: ox + n(), y: oy + n() }
        const p3 = { x: ox + n(), y: oy + n() }
        const f: Curve =
          u === 'Q'
            ? (t) => {
                const s = 1 - t
                return {
                  x: s * s * p0.x + 2 * s * t * c1.x + t * t * p3.x,
                  y: s * s * p0.y + 2 * s * t * c1.y + t * t * p3.y,
                }
              }
            : (t) => {
                const s = 1 - t
                const a = s * s * s
                const b = 3 * s * s * t
                const c = 3 * s * t * t
                const e = t * t * t
                return {
                  x: a * p0.x + b * c1.x + c * c2.x + e * p3.x,
                  y: a * p0.y + b * c1.y + c * c2.y + e * p3.y,
                }
              }
        curveToArcs(f, 0, 1, tol, verts)
        lastCtrl = c2
        cur = p3
        break
      }
      case 'A': {
        const rx = n()
        const ry = n()
        n() // x-axis rotation: irrelevant for circular arcs
        const large = n() !== 0
        const sweep = n() !== 0
        const p = { x: ox + n(), y: oy + n() }
        if (Math.abs(rx - ry) > 1e-9) throw new Error('elliptical arcs are not in the spike corpus')
        const chord = Math.hypot(p.x - cur.x, p.y - cur.y)
        const r = Math.max(rx, chord / 2)
        let theta = 2 * Math.asin(Math.min(1, chord / (2 * r)))
        if (large) theta = 2 * Math.PI - theta
        // SVG y is down: sweep-flag 1 is clockwise on screen, counter-clockwise in SVG coordinates
        verts.push([cur.x, cur.y, (sweep ? 1 : -1) * Math.tan(theta / 4)])
        cur = p
        lastCtrl = null
        break
      }
      case 'Z': {
        if (Math.hypot(cur.x - start.x, cur.y - start.y) > 1e-9) verts.push([cur.x, cur.y, 0])
        close()
        cur = start
        lastCtrl = null
        break
      }
      default:
        throw new Error(`unsupported path command ${cmd}`)
    }
  }
  close()
  return loops
}

function attr(tag: string, name: string): number {
  const m = new RegExp(`\\s${name}="([^"]+)"`).exec(tag)
  return m ? Number(m[1]) : 0
}

function inside(p: Pt, poly: readonly Pt[]): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!
    const b = poly[j]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c
  }
  return c
}

/** Loops of an SVG document, y flipped, outer loops counter-clockwise and holes clockwise (even-odd nesting). */
export function parseSvg(svg: string, tol: number): Loop[] {
  const loops: Loop[] = []
  for (const m of svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)) loops.push(...parsePath(m[1]!, tol))
  for (const m of svg.matchAll(/<circle\b[^>]*>/g)) {
    const [cx, cy, r] = [attr(m[0], 'cx'), attr(m[0], 'cy'), attr(m[0], 'r')]
    loops.push({
      closed: true,
      verts: [
        [cx - r, cy, 1],
        [cx + r, cy, 1],
      ],
    })
  }
  const flipped = loops.map((l) => ({
    closed: true,
    verts: l.verts.map((v) => [v[0], -v[1], -v[2]] as const),
  }))
  const polys = flipped.map((l) => flatten(l, 0.01))
  return flipped.map((l, i) => {
    const probe = polys[i]![0]!
    const depth = polys.filter((p, j) => j !== i && inside(probe, p)).length
    const wantCcw = depth % 2 === 0
    return area(l) > 0 === wantCcw ? l : reverse(l)
  })
}
