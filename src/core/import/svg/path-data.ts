/**
 * SVG path data (`d`) → subpaths of source segments in user units: lines, cubic Béziers
 * (quadratics degree-elevated, exact) and elliptical arcs in an affine-closed form, so transforms
 * apply exactly before fitting. Grammar of SVG 2 § 9.3.9 (absolute and relative M L H V C S Q T A
 * Z, implicit repeats, compact arc flags).
 * Doc: docs/architecture/shapes.md#svg-import
 *
 * On an error the data up to it is kept, as SVG renders it, and the error is returned beside it
 * (the importer warns `pathData`).
 */
import { apply, applyLinear, type Affine, type Pt } from './transform'

/**
 * Source segments. An ellipse is `c + u·cos θ + v·sin θ` for θ from `t0` over `dt` (signed);
 * `a` and `b` are its exact end points from the path data (the parameter form may miss them by
 * rounding).
 */
export type Seg =
  | { readonly kind: 'line'; readonly a: Pt; readonly b: Pt }
  | {
      readonly kind: 'cubic'
      readonly p0: Pt
      readonly c1: Pt
      readonly c2: Pt
      readonly p3: Pt
      /** Came from a quadratic Bézier (counted apart in the report). */
      readonly quad: boolean
    }
  | {
      readonly kind: 'ellipse'
      readonly c: Pt
      readonly u: Pt
      readonly v: Pt
      readonly t0: number
      readonly dt: number
      readonly a: Pt
      readonly b: Pt
    }

export interface Subpath {
  readonly closed: boolean
  readonly segs: readonly Seg[]
}

export interface PathData {
  readonly subpaths: Subpath[]
  /** The first error: data after it was not read. */
  readonly error?: { readonly at: number; readonly message: string }
}

export const segStart = (s: Seg): Pt => (s.kind === 'cubic' ? s.p0 : s.a)
export const segEnd = (s: Seg): Pt => (s.kind === 'cubic' ? s.p3 : s.b)

export function transformSeg(m: Affine, s: Seg): Seg {
  switch (s.kind) {
    case 'line':
      return { kind: 'line', a: apply(m, s.a), b: apply(m, s.b) }
    case 'cubic':
      return {
        kind: 'cubic',
        p0: apply(m, s.p0),
        c1: apply(m, s.c1),
        c2: apply(m, s.c2),
        p3: apply(m, s.p3),
        quad: s.quad,
      }
    case 'ellipse':
      return {
        kind: 'ellipse',
        c: apply(m, s.c),
        u: applyLinear(m, s.u),
        v: applyLinear(m, s.v),
        t0: s.t0,
        dt: s.dt,
        a: apply(m, s.a),
        b: apply(m, s.b),
      }
  }
}

/** Elliptical arc from the endpoint form (SVG 2 § 9.5.1, implementation notes B.2.4). */
export function svgArcSeg(
  p1: Pt,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  large: boolean,
  sweep: boolean,
  p2: Pt,
): Seg | undefined {
  if (p1.x === p2.x && p1.y === p2.y) return undefined
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if (rx === 0 || ry === 0) return { kind: 'line', a: p1, b: p2 }
  const phi = (phiDeg * Math.PI) / 180
  const cp = Math.cos(phi)
  const sp = Math.sin(phi)
  const dx = (p1.x - p2.x) / 2
  const dy = (p1.y - p2.y) / 2
  const x1 = cp * dx + sp * dy
  const y1 = -sp * dx + cp * dy
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (lam > 1) {
    rx *= Math.sqrt(lam)
    ry *= Math.sqrt(lam)
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den))
  const cx1 = (co * rx * y1) / ry
  const cy1 = (-co * ry * x1) / rx
  const c = {
    x: cp * cx1 - sp * cy1 + (p1.x + p2.x) / 2,
    y: sp * cx1 + cp * cy1 + (p1.y + p2.y) / 2,
  }
  const ang = (ux: number, uy: number, vx: number, vy: number): number =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const ux = (x1 - cx1) / rx
  const uy = (y1 - cy1) / ry
  const vx = (-x1 - cx1) / rx
  const vy = (-y1 - cy1) / ry
  const t0 = ang(1, 0, ux, uy)
  let dt = ang(ux, uy, vx, vy)
  if (!sweep && dt > 0) dt -= 2 * Math.PI
  if (sweep && dt < 0) dt += 2 * Math.PI
  return {
    kind: 'ellipse',
    c,
    u: { x: rx * cp, y: rx * sp },
    v: { x: -ry * sp, y: ry * cp },
    t0,
    dt,
    a: p1,
    b: p2,
  }
}

const Ch = {
  Plus: 43,
  Comma: 44,
  Minus: 45,
  Dot: 46,
  Zero: 48,
  One: 49,
  Nine: 57,
  E: 69,
  e: 101,
} as const

const isWsp = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 12
/** Number of arguments per command (upper case). */
const ARITY: Readonly<Record<string, number>> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
}

/** Parses path data. Never throws; see `PathData.error`. */
export function parsePathData(d: string): PathData {
  const n = d.length
  let i = 0
  const subpaths: Subpath[] = []
  let segs: Seg[] = []
  let cur: Pt = { x: 0, y: 0 }
  let start: Pt = cur
  let lastC: Pt | undefined
  let lastQ: Pt | undefined
  let started = false

  const skipWsp = (): void => {
    while (i < n && isWsp(d.charCodeAt(i))) i++
  }
  const skipCommaWsp = (): void => {
    skipWsp()
    if (d.charCodeAt(i) === Ch.Comma) {
      i++
      skipWsp()
    }
  }
  const number = (): number | undefined => {
    const s = i
    let c = d.charCodeAt(i)
    if (c === Ch.Plus || c === Ch.Minus) c = d.charCodeAt(++i)
    let digits = 0
    while (c >= Ch.Zero && c <= Ch.Nine) {
      digits++
      c = d.charCodeAt(++i)
    }
    if (c === Ch.Dot) {
      c = d.charCodeAt(++i)
      while (c >= Ch.Zero && c <= Ch.Nine) {
        digits++
        c = d.charCodeAt(++i)
      }
    }
    if (digits === 0) {
      i = s
      return undefined
    }
    if (c === Ch.E || c === Ch.e) {
      const e = i
      c = d.charCodeAt(++i)
      if (c === Ch.Plus || c === Ch.Minus) c = d.charCodeAt(++i)
      let ed = 0
      while (c >= Ch.Zero && c <= Ch.Nine) {
        ed++
        c = d.charCodeAt(++i)
      }
      if (ed === 0) i = e
    }
    const v = Number(d.slice(s, i))
    return Number.isFinite(v) ? v : undefined
  }
  const flag = (): number | undefined => {
    const c = d.charCodeAt(i)
    if (c === Ch.Zero || c === Ch.One) {
      i++
      return c - Ch.Zero
    }
    return undefined
  }
  const flush = (closed: boolean): void => {
    if (segs.length > 0) subpaths.push({ closed, segs })
    segs = []
  }
  const done = (message?: string): PathData => {
    flush(false)
    return message === undefined ? { subpaths } : { subpaths, error: { at: i, message } }
  }

  skipWsp()
  let cmd = ''
  while (i < n) {
    const c = d[i]!
    const isCmd = ARITY[c.toUpperCase()] !== undefined && /[a-zA-Z]/.test(c)
    if (isCmd) {
      cmd = c
      i++
      skipWsp()
    } else if (cmd === '' || cmd === 'z' || cmd === 'Z') {
      return done(`expected a command at ${i}`)
    }
    if (!started && cmd !== 'M' && cmd !== 'm') return done('path data must start with M')
    started = true
    const up = cmd.toUpperCase()
    const rel = cmd !== up
    const arity = ARITY[up]!
    const args: number[] = []
    for (let k = 0; k < arity; k++) {
      if (k > 0) skipCommaWsp()
      const v = up === 'A' && (k === 3 || k === 4) ? flag() : number()
      if (v === undefined) return done(`expected a number for ${cmd} at ${i}`)
      args.push(v)
    }
    const ox = rel ? cur.x : 0
    const oy = rel ? cur.y : 0
    let nextC: Pt | undefined
    let nextQ: Pt | undefined
    switch (up) {
      case 'M':
        flush(false)
        cur = { x: ox + args[0]!, y: oy + args[1]! }
        start = cur
        cmd = rel ? 'l' : 'L'
        break
      case 'L':
      case 'H':
      case 'V': {
        const p =
          up === 'L'
            ? { x: ox + args[0]!, y: oy + args[1]! }
            : up === 'H'
              ? { x: ox + args[0]!, y: cur.y }
              : { x: cur.x, y: oy + args[0]! }
        if (p.x !== cur.x || p.y !== cur.y) segs.push({ kind: 'line', a: cur, b: p })
        cur = p
        break
      }
      case 'C':
      case 'S': {
        const o = up === 'C' ? 2 : 0
        const c1 =
          up === 'S'
            ? lastC
              ? { x: 2 * cur.x - lastC.x, y: 2 * cur.y - lastC.y }
              : cur
            : { x: ox + args[0]!, y: oy + args[1]! }
        const c2 = { x: ox + args[o]!, y: oy + args[o + 1]! }
        const p = { x: ox + args[o + 2]!, y: oy + args[o + 3]! }
        segs.push({ kind: 'cubic', p0: cur, c1, c2, p3: p, quad: false })
        nextC = c2
        cur = p
        break
      }
      case 'Q':
      case 'T': {
        const q =
          up === 'T'
            ? lastQ
              ? { x: 2 * cur.x - lastQ.x, y: 2 * cur.y - lastQ.y }
              : cur
            : { x: ox + args[0]!, y: oy + args[1]! }
        const o = up === 'Q' ? 2 : 0
        const p = { x: ox + args[o]!, y: oy + args[o + 1]! }
        segs.push({
          kind: 'cubic',
          p0: cur,
          c1: { x: cur.x + ((q.x - cur.x) * 2) / 3, y: cur.y + ((q.y - cur.y) * 2) / 3 },
          c2: { x: p.x + ((q.x - p.x) * 2) / 3, y: p.y + ((q.y - p.y) * 2) / 3 },
          p3: p,
          quad: true,
        })
        nextQ = q
        cur = p
        break
      }
      case 'A': {
        const p = { x: ox + args[5]!, y: oy + args[6]! }
        const s = svgArcSeg(cur, args[0]!, args[1]!, args[2]!, args[3] === 1, args[4] === 1, p)
        if (s) segs.push(s)
        cur = p
        break
      }
      case 'Z':
        if (cur.x !== start.x || cur.y !== start.y) segs.push({ kind: 'line', a: cur, b: start })
        cur = start
        flush(true)
        break
    }
    lastC = nextC
    lastQ = nextQ
    skipCommaWsp()
  }
  return done()
}
