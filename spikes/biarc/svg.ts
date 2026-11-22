// Spike S5 (docs/research/s5-biarc-fitting.md): SVG path data → source curves (M L H V C S Q T A Z,
// absolute and relative). Just enough to read the S1 corpus; the real tokenizer is task I1.

import { cubic, line, quad, svgArc, type Curve, type Pt } from './curves.ts'

export interface Subpath {
  readonly closed: boolean
  readonly curves: readonly Curve[]
}

export function parsePathData(d: string): Subpath[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []
  const out: Subpath[] = []
  let curves: Curve[] = []
  let cur: Pt = { x: 0, y: 0 }
  let start: Pt = cur
  let lastC: Pt | null = null // last cubic control (S)
  let lastQ: Pt | null = null // last quadratic control (T)
  let cmd = ''
  let i = 0
  const n = (): number => Number(tokens[i++])
  const flush = (closed: boolean): void => {
    if (curves.length > 0) out.push({ closed, curves })
    curves = []
  }
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i]!)) cmd = tokens[i++]!
    const rel = cmd === cmd.toLowerCase()
    const o = rel ? cur : { x: 0, y: 0 }
    const pt = (): Pt => {
      const x = n()
      return { x: o.x + x, y: o.y + n() }
    }
    const u = cmd.toUpperCase()
    let nextC: Pt | null = null
    let nextQ: Pt | null = null
    switch (u) {
      case 'M':
        flush(false)
        cur = pt()
        start = cur
        cmd = rel ? 'l' : 'L'
        break
      case 'L':
      case 'H':
      case 'V': {
        const p =
          u === 'L' ? pt() : u === 'H' ? { x: o.x + n(), y: cur.y } : { x: cur.x, y: o.y + n() }
        if (p.x !== cur.x || p.y !== cur.y) curves.push(line(cur, p))
        cur = p
        break
      }
      case 'C':
      case 'S': {
        const c1 =
          u === 'S' ? (lastC ? { x: 2 * cur.x - lastC.x, y: 2 * cur.y - lastC.y } : cur) : pt()
        const c2 = pt()
        const p = pt()
        curves.push(cubic(cur, c1, c2, p))
        nextC = c2
        cur = p
        break
      }
      case 'Q':
      case 'T': {
        const c: Pt =
          u === 'T' ? (lastQ ? { x: 2 * cur.x - lastQ.x, y: 2 * cur.y - lastQ.y } : cur) : pt()
        const p = pt()
        curves.push(quad(cur, c, p))
        nextQ = c
        cur = p
        break
      }
      case 'A': {
        const rx = n()
        const ry = n()
        const phi = n()
        const large = n() !== 0
        const sweep = n() !== 0
        const p = pt()
        curves.push(svgArc(cur, rx, ry, phi, large, sweep, p))
        cur = p
        break
      }
      case 'Z':
        if (cur.x !== start.x || cur.y !== start.y) curves.push(line(cur, start))
        cur = start
        flush(true)
        break
      default:
        throw new Error(`unsupported path command ${cmd}`)
    }
    lastC = nextC
    lastQ = nextQ
  }
  flush(false)
  return out
}

/** Every `<path d>` of a document (the S1 corpus has no transforms). */
export function parseSvgPaths(svg: string): Subpath[] {
  return [...svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].flatMap((m) => parsePathData(m[1]!))
}
