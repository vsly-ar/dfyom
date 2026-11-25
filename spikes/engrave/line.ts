/**
 * Spike E0 (throwaway): SVG strokes → depth-profiled lines → a variable-depth toolpath with
 * ramped entries and depth passes. Not app code.
 * Doc: docs/research/2026-11-25-engraved-patterns-and-lines.md#spike-e0
 */
import { arcRadius, arcSweep, elementLength, type Element } from '../../src/core/geometry/2d/model'
import type { Block } from '../../src/core/post/program'
import type { XmlElement } from '../../src/core/import/svg/xml'
import type { SvgShape } from '../../src/core/import/svg'

type V2 = readonly [number, number]

// ---------- depth encoding in the SVG ----------

/** Stroke style and data-level of an element, with `stroke` inherited from groups. */
export interface StrokeInfo {
  readonly stroke?: string
  readonly strokeWidth?: number
  readonly dataLevel?: readonly number[]
}

const styleMap = (el: XmlElement): Map<string, string> => {
  const m = new Map<string, string>()
  for (const d of (el.attrs.get('style') ?? '').split(';')) {
    const c = d.indexOf(':')
    if (c > 0) m.set(d.slice(0, c).trim(), d.slice(c + 1).trim())
  }
  return m
}

/**
 * Element key (as the importer's `SvgShape.source.element`: `#id`, else `tag[n]` for the n-th
 * top-level element) → stroke info, with `stroke` and `stroke-width` inherited from groups and the
 * root. The importer drops paint today; E2 carries it on the shapes instead.
 */
export function strokesById(root: XmlElement): Map<string, StrokeInfo> {
  const out = new Map<string, StrokeInfo>()
  const own = (el: XmlElement, inh: StrokeInfo): StrokeInfo => {
    const st = styleMap(el)
    const stroke = st.get('stroke') ?? el.attrs.get('stroke') ?? inh.stroke
    const sw = st.get('stroke-width') ?? el.attrs.get('stroke-width')
    const width = sw === undefined ? inh.strokeWidth : Number.parseFloat(sw)
    const dl = el.attrs.get('data-level')
    return {
      ...(stroke === undefined ? {} : { stroke }),
      ...(width === undefined ? {} : { strokeWidth: width }),
      ...(dl === undefined
        ? {}
        : {
            dataLevel: dl
              .trim()
              .split(/[\s,]+/)
              .map(Number),
          }),
    }
  }
  const walk = (el: XmlElement, inh: StrokeInfo): StrokeInfo => {
    const info = own(el, inh)
    const id = el.attrs.get('id')
    if (id) out.set(`#${id}`, info)
    const pass: StrokeInfo = {
      ...(info.stroke === undefined ? {} : { stroke: info.stroke }),
      ...(info.strokeWidth === undefined ? {} : { strokeWidth: info.strokeWidth }),
    }
    for (const c of el.children) walk(c, pass)
    return info
  }
  const base = own(root, {})
  let n = 0
  for (const ch of root.children) {
    n++
    const info = walk(ch, base)
    if (!ch.attrs.get('id')) {
      const c = ch.name.indexOf(':')
      out.set(`${c < 0 ? ch.name : ch.name.slice(c + 1)}[${n}]`, info)
    }
  }
  return out
}

const NAMED: Readonly<Record<string, V3>> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  red: [255, 0, 0],
  blue: [0, 0, 255],
}
type V3 = readonly [number, number, number]

export function parseColour(s: string): V3 | undefined {
  const t = s.trim().toLowerCase()
  if (NAMED[t]) return NAMED[t]
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t)
  if (m) return [m[1]!, m[2]!, m[3]!].map((h) => Number.parseInt(h + h, 16)) as unknown as V3
  m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(t)
  if (m) return [m[1]!, m[2]!, m[3]!].map((h) => Number.parseInt(h, 16)) as unknown as V3
  m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(t)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  return undefined
}

/** Level 0..1 from a colour: 1 − Rec. 709 luma of the sRGB values (black = 1 = deepest). */
export function levelOfColour(s: string | undefined): number | undefined {
  const c = s === undefined ? undefined : parseColour(s)
  if (!c) return undefined
  return 1 - (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255
}

// ---------- lines ----------

export interface Piece {
  readonly el: Element
  /** Level at the piece's start and end (0..1). */
  readonly l0: number
  readonly l1: number
  readonly source: string
}

export interface Line {
  readonly pieces: readonly Piece[]
  readonly closed: boolean
}

const near = (a: V2, b: V2, eps = 0.01): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps

const reverseEl = (e: Element): Element =>
  e.kind === 'line' ? { kind: 'line', a: e.b, b: e.a } : { ...e, a: e.b, b: e.a, ccw: !e.ccw }

/** Imported shapes + stroke info → lines (open paths chained end to end, loops as closed lines). */
export function linesFromImport(
  shapes: readonly SvgShape[],
  strokes: Map<string, StrokeInfo>,
): {
  lines: Line[]
  unlevelled: string[]
} {
  const unlevelled: string[] = []
  const open: Piece[][] = []
  const closed: Line[] = []
  for (const sh of shapes) {
    const info = strokes.get(sh.source.element) ?? {}
    for (const it of sh.items) {
      const els = it.kind === 'loop' ? it.loop.elements : it.path.elements
      const total = els.reduce((s, e) => s + elementLength(e), 0)
      const dl = info.dataLevel
      // data-level: one value, or N stops evenly spaced along the element (start → end)
      let level: (t: number) => number
      if (dl && dl.length >= 1 && dl.every((x) => x >= 0 && x <= 1)) {
        level = (t) => {
          if (dl.length === 1) return dl[0]!
          const u = t * (dl.length - 1)
          const i = Math.min(dl.length - 2, Math.floor(u))
          return dl[i]! + (dl[i + 1]! - dl[i]!) * (u - i)
        }
      } else {
        const l = levelOfColour(info.stroke)
        if (l === undefined) unlevelled.push(sh.source.element)
        level = () => l ?? 1
      }
      let acc = 0
      const pieces = els.map((el): Piece => {
        const a = acc / total
        acc += elementLength(el)
        const b = acc / total
        return { el, l0: level(a), l1: level(b), source: sh.source.element }
      })
      if (it.kind === 'loop') closed.push({ pieces, closed: true })
      else open.push(pieces)
    }
  }
  // greedy chaining of open paths whose ends meet (either orientation)
  const lines: Line[] = []
  const left = [...open]
  while (left.length > 0) {
    let chain = left.shift()!
    let grew = true
    while (grew) {
      grew = false
      for (let k = 0; k < left.length; k++) {
        const c = left[k]!
        const end = chain[chain.length - 1]!.el.b
        const start = chain[0]!.el.a
        const rev = (p: Piece[]): Piece[] =>
          [...p].reverse().map((q) => ({ ...q, el: reverseEl(q.el), l0: q.l1, l1: q.l0 }))
        if (near(end, c[0]!.el.a)) chain = [...chain, ...c]
        else if (near(end, c[c.length - 1]!.el.b)) chain = [...chain, ...rev(c)]
        else if (near(start, c[c.length - 1]!.el.b)) chain = [...c, ...chain]
        else if (near(start, c[0]!.el.a)) chain = [...rev(c), ...chain]
        else continue
        left.splice(k, 1)
        grew = true
        break
      }
    }
    lines.push({ pieces: chain, closed: false })
  }
  return { lines: [...lines, ...closed], unlevelled }
}

// ---------- piecewise-linear depth profiles z(s) ----------

/** Breakpoints s ascending (duplicates = a step), z values (mm, ≤ 0). */
export interface PL {
  readonly s: readonly number[]
  readonly z: readonly number[]
}

export function evalPL(f: PL, s: number): number {
  const n = f.s.length
  if (s <= f.s[0]!) return f.z[0]!
  if (s >= f.s[n - 1]!) return f.z[n - 1]!
  for (let k = 1; k < n; k++)
    if (s <= f.s[k]!) {
      const s0 = f.s[k - 1]!
      const s1 = f.s[k]!
      return s1 === s0 ? f.z[k]! : f.z[k - 1]! + ((f.z[k]! - f.z[k - 1]!) * (s - s0)) / (s1 - s0)
    }
  return f.z[n - 1]!
}

/** The line's depth profile: level → depth by min/max, steps at joints blended over ±`blend`. */
export function profileOf(line: Line, min: number, max: number, blend: number): PL {
  const depth = (l: number): number => -(min + l * (max - min))
  const s: number[] = []
  const z: number[] = []
  let acc = 0
  const lens = line.pieces.map((p) => elementLength(p.el))
  line.pieces.forEach((p, k) => {
    const L = lens[k]!
    const z0 = depth(p.l0)
    const z1 = depth(p.l1)
    const prev = line.pieces[k - 1]
    const stepIn = prev !== undefined && Math.abs(prev.l1 - p.l0) > 1e-9
    const next = line.pieces[k + 1]
    const stepOut = next !== undefined && Math.abs(next.l0 - p.l1) > 1e-9
    const bIn = stepIn ? Math.min(blend, L / 2, lens[k - 1]! / 2) : 0
    const bOut = stepOut ? Math.min(blend, L / 2, lens[k + 1]! / 2) : 0
    const at = (t: number): number => z0 + ((z1 - z0) * t) / L
    if (k === 0 || !stepIn) {
      if (k === 0) {
        s.push(acc)
        z.push(z0)
      }
    } else {
      // blend across the joint: from the previous piece at −b to this piece at +b
      s.push(acc + bIn)
      z.push(at(bIn))
    }
    if (bOut > 0) {
      s.push(acc + L - bOut)
      z.push(at(L - bOut))
    } else {
      s.push(acc + L)
      z.push(z1)
    }
    acc += L
  })
  return { s, z }
}

/** max(f, g) (the shallower of two profiles), with crossings inserted. */
export function maxPL(f: PL, g: PL): PL {
  const ss = [...new Set([...f.s, ...g.s])].sort((a, b) => a - b)
  const s: number[] = []
  const z: number[] = []
  for (let k = 0; k < ss.length; k++) {
    const a = ss[k]!
    if (k > 0) {
      const p = ss[k - 1]!
      const d0 = evalPL(f, p) - evalPL(g, p)
      const d1 = evalPL(f, a) - evalPL(g, a)
      if (d0 * d1 < 0) {
        const c = p + ((a - p) * d0) / (d0 - d1)
        s.push(c)
        z.push(evalPL(f, c))
      }
    }
    s.push(a)
    z.push(Math.max(evalPL(f, a), evalPL(g, a)))
  }
  return { s, z }
}

const constPL = (s0: number, s1: number, z: number): PL => ({ s: [s0, s1], z: [z, z] })

// ---------- toolpath ----------

export interface LineCut {
  readonly stepdown: number
  readonly rampAngle: number
  readonly feed: number
  readonly plunge: number
  readonly retract: number
  readonly clearance: number
}

interface At {
  readonly el: Element
  readonly t: number
}

/** Point at fraction `t` of an element. */
function pointOn(e: Element, t: number): V2 {
  if (e.kind === 'line') return [e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t]
  const r = arcRadius(e)
  const a0 = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0]) + arcSweep(e) * t
  return [e.centre[0] + r * Math.cos(a0), e.centre[1] + r * Math.sin(a0)]
}

export class LinePath {
  readonly length: number
  private readonly starts: number[] = []
  constructor(readonly line: Line) {
    let acc = 0
    for (const p of line.pieces) {
      this.starts.push(acc)
      acc += elementLength(p.el)
    }
    this.length = acc
  }
  at(s: number): At & { k: number } {
    const n = this.line.pieces.length
    for (let k = n - 1; k >= 0; k--)
      if (s >= this.starts[k]! - 1e-12 || k === 0) {
        const L = elementLength(this.line.pieces[k]!.el)
        return {
          el: this.line.pieces[k]!.el,
          t: Math.min(1, Math.max(0, (s - this.starts[k]!) / L)),
          k,
        }
      }
    throw new Error('unreachable')
  }
  point(s: number): V2 {
    const a = this.at(s)
    return pointOn(a.el, a.t)
  }
  /** Breakpoints where moves must split: element ends and every 90° of an arc. */
  breaks(): number[] {
    const out: number[] = []
    this.line.pieces.forEach((p, k) => {
      const s0 = this.starts[k]!
      out.push(s0)
      if (p.el.kind === 'arc') {
        const L = elementLength(p.el)
        const n = Math.ceil(Math.abs(arcSweep(p.el)) / (Math.PI / 2) - 1e-9)
        for (let j = 1; j < n; j++) out.push(s0 + (L * j) / n)
      }
    })
    out.push(this.length)
    return out
  }
}

/** Moves along the line from `sA` to `sB` (either way) at z = f(s): G1 lines and helical G2/G3. */
function along(path: LinePath, sA: number, sB: number, f: PL, feed: number, out: Block[]): void {
  const lo = Math.min(sA, sB)
  const hi = Math.max(sA, sB)
  const cuts = [...new Set([sA, sB, ...path.breaks(), ...f.s].filter((s) => s >= lo && s <= hi))]
  cuts.sort((a, b) => (sB >= sA ? a - b : b - a))
  for (let k = 1; k < cuts.length; k++) {
    const s0 = cuts[k - 1]!
    const s1 = cuts[k]!
    if (Math.abs(s1 - s0) < 1e-6) continue
    const mid = path.at((s0 + s1) / 2)
    const p0 = path.point(s0)
    const p1 = path.point(s1)
    const to = [p1[0], p1[1], evalPL(f, s1)] as const
    if (mid.el.kind === 'line') out.push({ kind: 'feed', to, feed })
    else {
      const fwd = s1 > s0
      const ccw = fwd ? mid.el.ccw : !mid.el.ccw
      out.push({
        kind: 'arc',
        to,
        i: mid.el.centre[0] - p0[0],
        j: mid.el.centre[1] - p0[1],
        cw: !ccw,
        feed,
      })
    }
  }
}

export interface CutReport {
  readonly passes: number
  readonly rampLengths: number[]
  readonly minZ: number
}

/**
 * An open line cut in depth passes, alternating direction. Each pass enters by a ramp-back: the
 * tool reaches a point `Lr` ahead in the pass direction (pass 1: rapid and plunge to the surface;
 * later passes: along the previous pass's floor, cutting air), then ramps back to the pass start at
 * ≤ rampAngle, never below the pass's profile, and cuts the pass over its own ramp.
 */
export function cutOpenLine(path: LinePath, prof: PL, c: LineCut, out: Block[]): CutReport {
  const L = path.length
  const deepest = Math.min(...prof.z)
  const n = Math.max(1, Math.ceil(-deepest / c.stepdown - 1e-9))
  const tan = Math.tan((c.rampAngle * Math.PI) / 180)
  let prev: PL = constPL(0, L, 0)
  let at = 0
  const rampLengths: number[] = []
  for (let k = 1; k <= n; k++) {
    const target = maxPL(prof, constPL(0, L, -k * c.stepdown))
    const fwd = k % 2 === 1
    const sA = fwd ? 0 : L
    const dir = fwd ? 1 : -1
    const zA = evalPL(target, sA)
    // ramp length so the slope ≤ rampAngle from the previous floor there
    let Lr = Math.min(L, Math.max(0, (evalPL(prev, sA) - zA) / tan))
    Lr = Math.min(L, Math.max(Lr, (evalPL(prev, sA + dir * Lr) - zA) / tan))
    const sR = sA + dir * Lr
    rampLengths.push(Lr)
    if (k === 1) {
      const p = path.point(sR)
      out.push({ kind: 'rapid', to: [p[0], p[1], c.clearance] })
      out.push({ kind: 'rapid', to: [p[0], p[1], c.retract] })
      out.push({ kind: 'feed', to: [p[0], p[1], evalPL(prev, sR)], feed: c.plunge })
    } else {
      along(path, at, sR, prev, c.feed, out) // air: along the floor just cut
    }
    if (Lr > 1e-6) {
      const ramp: PL =
        sR > sA
          ? { s: [sA, sR], z: [zA, evalPL(prev, sR)] }
          : { s: [sR, sA], z: [evalPL(prev, sR), zA] }
      along(path, sR, sA, maxPL(ramp, target), c.feed, out)
    }
    along(path, sA, fwd ? L : 0, target, c.feed, out)
    at = fwd ? L : 0
    prev = target
  }
  const end = path.point(at)
  out.push({ kind: 'rapid', to: [end[0], end[1], c.clearance] })
  return { passes: n, rampLengths, minZ: deepest }
}
