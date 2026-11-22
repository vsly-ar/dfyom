// Test-only generator of the v0.3 exit-criteria SVG (not app code).
// Doc: docs/conventions/testing.md#fixtures · plan: docs/plans/v0.3.md#exit-criteria (Q27)
//
// Slices the user's enclosure STL at mid-wall height and fits each section loop with lines (between
// corners) and G1 chains of cubic Béziers, written as a CAD tool would export a drawing (mm units,
// one `<path>` per section). `scripts/enclosure-sections.ts` writes the committed file; the test
// checks that the file is byte-identical to this output and within 0.2 mm of the section.
//
// No imports, so Node runs it as is through the script (type stripping, no module resolution).
// Only `+ − × ÷` and `Math.sqrt` (correctly rounded everywhere) feed the numbers, so the output is
// the same on every platform and Node version: no `Math.hypot` or trigonometry.

/** The committed fixture, next to the STL it was generated from. */
export const ENCLOSURE_SECTIONS_SVG = new URL(
  './__fixtures__/enclosure-sections.svg',
  import.meta.url,
)

/**
 * Mid-wall height in the STL's frame (bottom at z = 0, top at 39, cavity floor at 4.2): halfway up
 * the cavity wall, (4.2 + 39) / 2. The walls are vertical from z ≈ 4.2 to the top, so every height
 * there gives the same two loops; mid-wall is where the exit criteria's deviation check cuts.
 */
export const SECTION_Z = 21.6

/**
 * Max distance of a fitted cubic from the section's vertices (mm). The slice's vertices alternate
 * between points on the mesh's vertical edges (on the surface) and on its diagonals (on a chord,
 * up to ≈ 0.03 mm inside), so a smooth curve cannot come much closer than that.
 */
export const FIT_TOLERANCE = 0.05

/** A vertex is a corner when its edges turn by more than ≈ 10° (cos 10° = 0.9848). */
const CORNER_COS = 0.9848

/** A run of vertices is a straight line when every vertex is this close to its chord (mm). */
const LINE_TOLERANCE = 0.001

/** The SVG page (mm): the STL's centre at the page centre, +y (the back wall) up. */
export const PAGE = { width: 250, height: 178 } as const

export interface Pt {
  readonly x: number
  readonly y: number
}

/** A line (`c1`, `c2` absent) or a cubic: start, two controls, end (STL frame, mm). */
export interface Segment {
  readonly p0: Pt
  readonly c1?: Pt
  readonly c2?: Pt
  readonly p3: Pt
}

export interface Section {
  readonly id: 'outline' | 'cavity'
  /** Polygon from the slice, solid on its left (outline counter-clockwise, cavity clockwise). */
  readonly loop: readonly Pt[]
}

/** Triangle soup of a binary STL (9 values per triangle, float32 widened exactly). */
export function readBinaryStl(bytes: Uint8Array): Float64Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const n = view.getUint32(80, true)
  if (bytes.byteLength !== 84 + 50 * n) throw new Error('not a binary STL')
  const out = new Float64Array(n * 9)
  for (let t = 0; t < n; t++)
    for (let k = 0; k < 9; k++) out[t * 9 + k] = view.getFloat32(84 + t * 50 + 12 + k * 4, true)
  return out
}

/**
 * The closed loops where the plane z = `z` cuts a closed, outward-oriented mesh, each with the
 * solid on its left. Crossing points are keyed by their mesh edge, so loops join exactly.
 */
export function sliceMesh(soup: Float64Array, z: number): Pt[][] {
  const vertexKey = (i: number): string => `${soup[i]},${soup[i + 1]},${soup[i + 2]}`
  const points = new Map<string, Pt>()
  const next = new Map<string, string>()
  const order: string[] = []
  for (let t = 0; t < soup.length / 9; t++) {
    const crossings: { key: string; up: boolean }[] = []
    for (let e = 0; e < 3; e++) {
      const i = t * 9 + e * 3
      const j = t * 9 + ((e + 1) % 3) * 3
      const zi = soup[i + 2]! - z
      const zj = soup[j + 2]! - z
      if (zi < 0 === zj < 0) continue
      const ki = vertexKey(i)
      const kj = vertexKey(j)
      const key = ki < kj ? `${ki}|${kj}` : `${kj}|${ki}`
      if (!points.has(key)) {
        const s = zi / (zi - zj)
        points.set(key, {
          x: soup[i]! + s * (soup[j]! - soup[i]!),
          y: soup[i + 1]! + s * (soup[j + 1]! - soup[i + 1]!),
        })
      }
      crossings.push({ key, up: zi < 0 })
    }
    if (crossings.length !== 2) continue
    const [a, b] = crossings as [{ key: string; up: boolean }, { key: string; up: boolean }]
    // counter-clockwise triangle: from the edge going down to the edge going up, solid on the left
    const [from, to] = a.up ? [b.key, a.key] : [a.key, b.key]
    next.set(from, to)
    order.push(from)
  }
  const loops: Pt[][] = []
  const seen = new Set<string>()
  for (const start of order) {
    if (seen.has(start)) continue
    const loop: Pt[] = []
    let key: string | undefined = start
    while (key !== undefined && !seen.has(key)) {
      seen.add(key)
      loop.push(points.get(key)!)
      key = next.get(key)
    }
    if (key !== start) throw new Error(`open section loop at z = ${z}`)
    loops.push(loop)
  }
  return loops
}

/** Signed area (counter-clockwise positive). */
export function signedArea(loop: readonly Pt[]): number {
  let a = 0
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i]!
    const q = loop[(i + 1) % loop.length]!
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** The enclosure's two sections at `SECTION_Z`: the outline and the cavity. */
export function enclosureSections(stl: Uint8Array): Section[] {
  const loops = sliceMesh(readBinaryStl(stl), SECTION_Z)
  if (loops.length !== 2) throw new Error(`expected 2 section loops, got ${loops.length}`)
  const outline = loops.find((l) => signedArea(l) > 0)
  const cavity = loops.find((l) => signedArea(l) < 0)
  if (!outline || !cavity) throw new Error('expected one outer loop and one hole')
  return [
    { id: 'outline', loop: outline },
    { id: 'cavity', loop: cavity },
  ]
}

// ---------------------------------------------------------------- fitting

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y })
const mul = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s })
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y
const len = (a: Pt): number => Math.sqrt(a.x * a.x + a.y * a.y)
const unit = (a: Pt): Pt => mul(a, 1 / len(a))

/** Point of a segment at parameter u ∈ [0, 1]. */
export function pointAt(c: Segment, u: number): Pt {
  if (!c.c1 || !c.c2) return add(c.p0, mul(sub(c.p3, c.p0), u))
  const v = 1 - u
  const b0 = v * v * v
  const b1 = 3 * v * v * u
  const b2 = 3 * v * u * u
  const b3 = u * u * u
  return {
    x: b0 * c.p0.x + b1 * c.c1.x + b2 * c.c2.x + b3 * c.p3.x,
    y: b0 * c.p0.y + b1 * c.c1.y + b2 * c.c2.y + b3 * c.p3.y,
  }
}

interface Cubic {
  readonly p0: Pt
  readonly c1: Pt
  readonly c2: Pt
  readonly p3: Pt
}

function d1(c: Cubic, u: number): Pt {
  const v = 1 - u
  const a = mul(sub(c.c1, c.p0), 3 * v * v)
  const b = mul(sub(c.c2, c.c1), 6 * v * u)
  const d = mul(sub(c.p3, c.c2), 3 * u * u)
  return add(add(a, b), d)
}

function d2(c: Cubic, u: number): Pt {
  const a = add(sub(c.c2, mul(c.c1, 2)), c.p0)
  const b = add(sub(c.p3, mul(c.c2, 2)), c.c1)
  return add(mul(a, 6 * (1 - u)), mul(b, 6 * u))
}

/**
 * A run of section vertices between two corners (open), or a whole loop without corners (closed:
 * its last vertex repeats the first). Tangents come from a central difference over ±`h` mm of arc
 * length, one-sided at the ends of an open run, wrapping round a closed one.
 */
class Run {
  readonly pts: readonly Pt[]
  readonly closed: boolean
  readonly cum: number[] = [0]
  readonly length: number

  constructor(pts: readonly Pt[], closed: boolean) {
    this.pts = pts
    this.closed = closed
    for (let i = 1; i < pts.length; i++)
      this.cum.push(this.cum[i - 1]! + len(sub(pts[i]!, pts[i - 1]!)))
    this.length = this.cum[pts.length - 1]!
  }

  at(s: number): Pt {
    let t: number
    if (this.closed) {
      t = s % this.length
      if (t < 0) t += this.length
    } else t = Math.min(this.length, Math.max(0, s))
    let lo = 0
    let hi = this.pts.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (this.cum[mid]! <= t) lo = mid
      else hi = mid
    }
    const seg = this.cum[hi]! - this.cum[lo]!
    const a = this.pts[lo]!
    return seg === 0 ? a : add(a, mul(sub(this.pts[hi]!, a), (t - this.cum[lo]!) / seg))
  }

  tangent(i: number, h = 3): Pt {
    const s = this.cum[i]!
    return unit(sub(this.at(s + h), this.at(s - h)))
  }

  isLine(): boolean {
    const a = this.pts[0]!
    const b = this.pts[this.pts.length - 1]!
    if (this.closed) return false
    const d = unit(sub(b, a))
    return this.pts.every((p) => {
      const q = sub(p, a)
      return Math.abs(q.x * d.y - q.y * d.x) <= LINE_TOLERANCE
    })
  }
}

/**
 * One cubic through run vertices i0..i1 with the run's tangents at both ends, the two handle
 * lengths by least squares and the parameters refined by Newton steps (Schneider, Graphics Gems,
 * 1990). Returns the cubic and the largest distance of the vertices from it.
 */
function fitSpan(run: Run, i0: number, i1: number): { cubic: Cubic; error: number } {
  const data = run.pts.slice(i0, i1 + 1)
  const count = data.length
  const t0 = run.tangent(i0)
  const t1 = run.tangent(i1)
  const p0 = data[0]!
  const p3 = data[count - 1]!
  const u: number[] = [0]
  for (let k = 1; k < count; k++) u.push(u[k - 1]! + len(sub(data[k]!, data[k - 1]!)))
  const total = u[count - 1]!
  for (let k = 0; k < count; k++) u[k] = u[k]! / total

  const solve = (): Cubic => {
    let c00 = 0
    let c01 = 0
    let c11 = 0
    let x0 = 0
    let x1 = 0
    for (let k = 0; k < count; k++) {
      const s = u[k]!
      const v = 1 - s
      const a0 = mul(t0, 3 * v * v * s)
      const a1 = mul(t1, -3 * v * s * s)
      const base = add(mul(p0, v * v * v + 3 * v * v * s), mul(p3, 3 * v * s * s + s * s * s))
      const r = sub(data[k]!, base)
      c00 += dot(a0, a0)
      c01 += dot(a0, a1)
      c11 += dot(a1, a1)
      x0 += dot(a0, r)
      x1 += dot(a1, r)
    }
    const det = c00 * c11 - c01 * c01
    const chord = len(sub(p3, p0))
    let a = det === 0 ? 0 : (x0 * c11 - x1 * c01) / det
    let b = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det
    if (!(a > chord * 0.05) || !(b > chord * 0.05)) a = b = chord / 3
    return { p0, c1: add(p0, mul(t0, a)), c2: sub(p3, mul(t1, b)), p3 }
  }

  let cubic = solve()
  for (let pass = 0; pass < 6; pass++) {
    for (let k = 1; k < count - 1; k++) {
      const s = u[k]!
      const d = sub(pointAt(cubic, s), data[k]!)
      const v1 = d1(cubic, s)
      const den = dot(v1, v1) + dot(d, d2(cubic, s))
      if (den !== 0) u[k] = Math.min(1, Math.max(0, s - dot(d, v1) / den))
    }
    cubic = solve()
  }
  let error = 0
  for (let k = 1; k < count - 1; k++)
    error = Math.max(error, len(sub(pointAt(cubic, u[k]!), data[k]!)))
  return { cubic, error }
}

/** Greedy G1 chain over a curved run: from each break, the longest span that fits within `tol`. */
function fitRun(run: Run, tol: number): Segment[] {
  const out: Segment[] = []
  const last = run.pts.length - 1
  let i0 = 0
  while (i0 < last) {
    let lo = i0 + 1 // always fits (no inner vertices)
    let hi = last
    if (fitSpan(run, i0, hi).error <= tol) lo = hi
    else
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (fitSpan(run, i0, mid).error <= tol) lo = mid
        else hi = mid
      }
    out.push(fitSpan(run, i0, lo).cubic)
    i0 = lo
  }
  return out
}

/** The vertex on the ray from `c` along +x (the nearer end of the crossing edge). */
function rightmostOnAxis(pts: readonly Pt[], c: Pt): number {
  let best = 0
  let bestX = -Infinity
  for (let i = 0; i < pts.length; i++) {
    const a = sub(pts[i]!, c)
    const b = sub(pts[(i + 1) % pts.length]!, c)
    if (a.y < 0 === b.y < 0) continue
    const s = a.y / (a.y - b.y)
    const x = a.x + s * (b.x - a.x)
    if (x > bestX) {
      bestX = x
      best = s < 0.5 ? i : (i + 1) % pts.length
    }
  }
  return best
}

/**
 * Lines and G1 cubic chains for a closed section loop: split at corners; a straight run between
 * corners is one line, a curved one a greedy chain of cubics within `tol`. A loop without corners
 * starts on the +x axis through its bounding-box centre.
 */
export function fitLoop(loop: readonly Pt[], tol = FIT_TOLERANCE): Segment[] {
  const n = loop.length
  const corners: number[] = []
  for (let i = 0; i < n; i++) {
    const a = unit(sub(loop[i]!, loop[(i - 1 + n) % n]!))
    const b = unit(sub(loop[(i + 1) % n]!, loop[i]!))
    if (dot(a, b) < CORNER_COS) corners.push(i)
  }
  /** `steps` + 1 vertices from `from` on (wrapping; `n` steps return to the start). */
  const pick = (from: number, steps: number): Pt[] =>
    Array.from({ length: steps + 1 }, (_, k) => loop[(from + k) % n]!)
  if (corners.length === 0) {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const p of loop) {
      x0 = Math.min(x0, p.x)
      x1 = Math.max(x1, p.x)
      y0 = Math.min(y0, p.y)
      y1 = Math.max(y1, p.y)
    }
    const start = rightmostOnAxis(loop, { x: (x0 + x1) / 2, y: (y0 + y1) / 2 })
    return fitRun(new Run(pick(start, n), true), tol)
  }
  const out: Segment[] = []
  for (let k = 0; k < corners.length; k++) {
    const from = corners[k]!
    const to = corners[(k + 1) % corners.length]!
    const run = new Run(pick(from, (to - from + n) % n || n), false)
    if (run.isLine()) out.push({ p0: run.pts[0]!, p3: run.pts[run.pts.length - 1]! })
    else out.push(...fitRun(run, tol))
  }
  return out
}

// ---------------------------------------------------------------- SVG

/** STL frame → page: centre to the page centre, y flipped (SVG y points down). */
const toPage = (p: Pt): Pt => ({ x: p.x + PAGE.width / 2, y: PAGE.height / 2 - p.y })

/** Page → STL frame (the inverse of the page mapping, for checks). */
export const fromPage = (p: Pt): Pt => ({ x: p.x - PAGE.width / 2, y: PAGE.height / 2 - p.y })

/** Micrometre precision, no trailing zeros, no `-0`. */
function num(v: number): string {
  const s = v.toFixed(3).replace(/\.?0+$/, '')
  return s === '-0' ? '0' : s
}

const pt = (p: Pt): string => {
  const q = toPage(p)
  return `${num(q.x)},${num(q.y)}`
}

/** Path data: `M`, then an absolute `L` per line and `C` per cubic, closed with `Z`. */
export function pathData(segments: readonly Segment[]): string {
  const parts = [`M${pt(segments[0]!.p0)}`]
  segments.forEach((s, i) => {
    // the closing line is the `Z`
    if (!s.c1 || !s.c2) {
      if (i < segments.length - 1) parts.push(`L${pt(s.p3)}`)
    } else parts.push(`C${pt(s.c1)} ${pt(s.c2)} ${pt(s.p3)}`)
  })
  return `${parts.join(' ')} Z`
}

/** The fixture's text for the given STL bytes. */
export function generateEnclosureSections(stl: Uint8Array): string {
  const paths = enclosureSections(stl).map((s) => {
    const fill = s.id === 'outline' ? '#e3d3b4' : '#ffffff'
    const d = pathData(fitLoop(s.loop))
    return `  <path id="${s.id}" fill="${fill}" stroke="#000000" stroke-width="0.25" d="${d}"/>`
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- enclosure-wood-base.stl sectioned at z = 21.6 mm: outline and cavity. Generated by',
    '     scripts/enclosure-sections.ts (docs/conventions/testing.md#fixtures); do not edit. -->',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE.width}mm" height="${PAGE.height}mm" viewBox="0 0 ${PAGE.width} ${PAGE.height}">`,
    '  <title>Enclosure sections</title>',
    ...paths,
    '</svg>',
    '',
  ].join('\n')
}
