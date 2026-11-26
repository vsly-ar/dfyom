/**
 * Line (engraved-patterns.md E1): the lines of a Line operation and its groove. Every loop and
 * open path of the placed shapes is a line; its depth below the `on` face is a piecewise-linear
 * profile by arc length (E1: `start` → `end`). Coincident elements (a shape drawn twice, two
 * shapes sharing an edge) are cut once, the deeper kept. The removal solid is the tool swept
 * along each chord: the Minkowski sum of the tool's polyhedron with the chord (the convex hull of
 * the tool at the chord's two ends), one mesh per chord, unioned by the evaluation.
 * Shared by the evaluation (removal), the DFM (depth, width) and the toolpath (`generateLine`).
 * Doc: docs/modes/engraved-patterns.md#line-operation, docs/modes/engraved-patterns.md#implementation-e1
 */
import { Ok, type AppResult } from '../../shared/result'
import {
  arc,
  arcRadius,
  arcSweep,
  elementLength,
  line,
  regionLoops,
  type Element,
} from './2d/model'
import { ClipBoundary, clipLine } from './2d/clip-lines'
import { arcSegments } from './contour'
import { localSolids, Table, type LocalSolids } from './local-solids'
import type { LabelledMesh } from './loft'
import {
  CHORD_TOLERANCE,
  EPSILON,
  OVERSHOOT,
  type LineCutter,
  type LineGeometry,
  type Vec2,
  type Vec3,
} from './model'

/** The groove's tool when the operation has none yet: a pointed 60° V-bit, Ø 6 mm. */
export const DEFAULT_LINE_CUTTER: LineCutter = Object.freeze({
  kind: 'vBit',
  diameter: 6,
  angle: 60,
  tipDiameter: 0,
})

/** Elements whose ends and middles are this close coincide (mm, the doc's chaining tolerance). */
export const COINCIDENT_TOLERANCE = 0.01

/**
 * A depth profile along a line: depth below the `on` face (mm, ≥ 0) at arc lengths `s`
 * (ascending; two equal `s` are a step), linear between them.
 */
export interface LineProfile {
  readonly s: readonly number[]
  readonly d: readonly number[]
}

/** One line to cut: its elements end to end (a loop when `closed`), its length and depth profile. */
export interface ResolvedLine {
  readonly elements: readonly Element[]
  readonly closed: boolean
  readonly length: number
  readonly profile: LineProfile
}

/** The profile's depth at `s` (clamped to its ends; at a step, the depth after it). */
export function profileAt(p: LineProfile, s: number): number {
  const n = p.s.length
  if (s <= p.s[0]!) return p.d[0]!
  if (s >= p.s[n - 1]!) return p.d[n - 1]!
  for (let k = 1; k < n; k++)
    if (s < p.s[k]!) {
      const s0 = p.s[k - 1]!
      const s1 = p.s[k]!
      return s1 === s0 ? p.d[k]! : p.d[k - 1]! + ((p.d[k]! - p.d[k - 1]!) * (s - s0)) / (s1 - s0)
    }
  return p.d[n - 1]!
}

/** The deepest point of a profile (mm). */
export const profileMax = (p: LineProfile): number => Math.max(...p.d)

/** The profile between `a` and `b` (a < b), from s = 0. */
export function sliceProfile(p: LineProfile, a: number, b: number): { s: number[]; d: number[] } {
  const s = [0]
  const d = [profileAt(p, a)]
  p.s.forEach((x, k) => {
    if (x > a + EPSILON && x < b - EPSILON) {
      s.push(x - a)
      d.push(p.d[k]!)
    }
  })
  s.push(b - a)
  // the depth just before b (a step at b belongs to what follows)
  d.push(depthBefore(p, b))
  return { s, d }
}

/** The depth just before `s` (the left limit at a step). */
function depthBefore(p: LineProfile, s: number): number {
  const n = p.s.length
  for (let k = n - 1; k >= 1; k--)
    if (p.s[k]! >= s - EPSILON && p.s[k - 1]! < s - EPSILON) {
      const s0 = p.s[k - 1]!
      const s1 = p.s[k]!
      return p.d[k - 1]! + ((p.d[k]! - p.d[k - 1]!) * (s - s0)) / (s1 - s0)
    }
  return profileAt(p, s)
}

const translate = (e: Element, c: Vec2): Element => {
  const t = (p: Vec2): Vec2 => [p[0] + c[0], p[1] + c[1]]
  return e.kind === 'line' ? line(t(e.a), t(e.b)) : arc(t(e.a), t(e.b), t(e.centre), e.ccw)
}

/** The point at fraction `u` of an element. */
export function elementPoint(e: Element, u: number): Vec2 {
  if (e.kind === 'line') return [e.a[0] + (e.b[0] - e.a[0]) * u, e.a[1] + (e.b[1] - e.a[1]) * u]
  const r = arcRadius(e)
  const a = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0]) + arcSweep(e) * u
  return [e.centre[0] + r * Math.cos(a), e.centre[1] + r * Math.sin(a)]
}

const near = (p: Vec2, q: Vec2): boolean =>
  Math.hypot(p[0] - q[0], p[1] - q[1]) <= COINCIDENT_TOLERANCE

/** What `lineChains` found: the lines to cut and how many coincident elements it dropped. */
export interface LineChains {
  readonly lines: readonly ResolvedLine[]
  readonly coincident: number
}

const chainsMemo = new WeakMap<object, LineChains>()

/** What `lineChains` reads of a Line's geometry. */
export type LineChainsInput = Pick<LineGeometry, 'paths' | 'depth' | 'levels' | 'blend' | 'within'>

/** The default blend of a level step (mm, engraved-patterns.md § Line operation). */
export const DEFAULT_LINE_BLEND = 1

/** Whether a Line's depth comes from levels (`{ min, max }`, E2). */
export const isLevelDepth = (
  d: LineGeometry['depth'],
): d is { readonly min: number; readonly max: number } => 'min' in d

const reverseElement = (e: Element): Element =>
  e.kind === 'line' ? line(e.b, e.a) : arc(e.b, e.a, e.centre, !e.ccw)

/** A profile run backwards (s from the other end). */
const reverseProfile = (p: LineProfile, L: number): LineProfile => ({
  s: [...p.s].reverse().map((x) => L - x),
  d: [...p.d].reverse(),
})

/**
 * Every step of a profile (two equal `s` with different depths) turned into a slope over
 * ±`blend`, clamped to half the pieces on either side (to the next step or the line's end),
 * engraved-patterns.md § Toolpath. `blend` 0 keeps the steps.
 */
export function blendSteps(p: LineProfile, L: number, blend: number): LineProfile {
  if (!(blend > EPSILON)) return p
  const steps: number[] = []
  for (let k = 1; k < p.s.length; k++)
    if (Math.abs(p.s[k]! - p.s[k - 1]!) <= EPSILON && Math.abs(p.d[k]! - p.d[k - 1]!) > EPSILON)
      steps.push(p.s[k]!)
  if (steps.length === 0) return p
  const windows = steps.map((sj, i) => {
    const left = sj - (i === 0 ? 0 : steps[i - 1]!)
    const right = (i === steps.length - 1 ? L : steps[i + 1]!) - sj
    const b = Math.min(blend, left / 2, right / 2)
    return { a: sj - b, b: sj + b, da: depthBefore(p, sj - b), db: profileAt(p, sj + b) }
  })
  const s: number[] = []
  const d: number[] = []
  let w = 0
  let used = -1
  const push = (x: number, y: number) => {
    if (s.length > 0 && Math.abs(s.at(-1)! - x) <= EPSILON && Math.abs(d.at(-1)! - y) <= EPSILON)
      return
    s.push(x)
    d.push(y)
  }
  for (let k = 0; k < p.s.length; k++) {
    const x = p.s[k]!
    while (w < windows.length && x > windows[w]!.b + EPSILON) w++
    const win = windows[w]
    if (win !== undefined && win.b - win.a > EPSILON && x >= win.a - EPSILON) {
      // inside the window: its two ends replace every point there
      if (used !== w) {
        push(win.a, win.da)
        push(win.b, win.db)
        used = w
      }
      continue
    }
    push(x, p.d[k]!)
  }
  return { s, d }
}

/** The raw lines of a Line with their profiles (before coincident removal and chaining). */
function rawLines(op: LineChainsInput) {
  const levelled = isLevelDepth(op.depth) ? op.depth : undefined
  const depthOf = (level: number): number =>
    levelled === undefined ? 0 : levelled.min + (levelled.max - levelled.min) * level
  const out: {
    elements: Element[]
    closed: boolean
    starts: number[]
    length: number
    profile: LineProfile
  }[] = []
  op.paths.forEach((shape, pi) => {
    const lv = op.levels?.[pi] ?? null
    const c = shape.contour
    const raw: { elements: Element[]; closed: boolean }[] = []
    if (c.kind === 'region')
      for (const loop of regionLoops(c.region))
        raw.push({ elements: loop.elements.map((e) => translate(e, shape.center)), closed: true })
    else if (c.kind === 'path')
      raw.push({ elements: c.path.elements.map((e) => translate(e, shape.center)), closed: false })
    for (const r of raw) {
      const starts: number[] = []
      let L = 0
      for (const e of r.elements) {
        starts.push(L)
        L += elementLength(e)
      }
      let profile: LineProfile
      if (levelled === undefined) {
        const d = op.depth as { readonly start: number; readonly end: number }
        profile = { s: [0, L], d: [d.start, d.end] }
      } else if (lv?.kind === 'path' && !r.closed)
        profile = { s: lv.u.map((u) => u * L), d: lv.level.map(depthOf) }
      else {
        // a loop takes one level (a path's levels on a loop: the deepest)
        const level = lv === null ? 1 : lv.kind === 'loops' ? lv.level : Math.max(...lv.level)
        profile = { s: [0, L], d: [depthOf(level), depthOf(level)] }
      }
      out.push({ ...r, starts, length: L, profile })
    }
  })
  return out
}

/**
 * Open lines whose ends meet (within `COINCIDENT_TOLERANCE`, either orientation) chained into
 * one, greedily in order (engraved-patterns.md § SVG encoding 5): their profiles joined, a level
 * change at a junction a step (blended afterwards). Loops are kept as they are. The ends are
 * bucketed on a grid (E4: thousands of tile lines), and of the candidates near the chain's ends
 * the earliest in order is taken, so the result is the plain greedy scan's.
 */
export function chainOpen(lines: readonly ResolvedLine[]): ResolvedLine[] {
  const open = lines.filter((l) => !l.closed)
  const out: ResolvedLine[] = []
  const rev = (l: ResolvedLine): ResolvedLine => ({
    elements: [...l.elements].reverse().map(reverseElement),
    closed: false,
    length: l.length,
    profile: reverseProfile(l.profile, l.length),
  })
  const join = (a: ResolvedLine, b: ResolvedLine): ResolvedLine => ({
    elements: [...a.elements, ...b.elements],
    closed: false,
    length: a.length + b.length,
    profile: {
      s: [...a.profile.s, ...b.profile.s.map((x) => x + a.length)],
      d: [...a.profile.d, ...b.profile.d],
    },
  })
  // ends bucketed by a grid of twice the tolerance: a point's neighbours lie in the 3 × 3 cells
  const G = COINCIDENT_TOLERANCE * 2
  const grid = new Map<string, number[]>()
  const keyOf = (p: Vec2, dx = 0, dy = 0) =>
    `${Math.floor(p[0] / G) + dx},${Math.floor(p[1] / G) + dy}`
  open.forEach((l, k) => {
    for (const p of [l.elements[0]!.a, l.elements.at(-1)!.b]) {
      const key = keyOf(p)
      const list = grid.get(key)
      if (list === undefined) grid.set(key, [k])
      else if (list.at(-1) !== k) list.push(k)
    }
  })
  const used = open.map(() => false)
  const candidates = (p: Vec2, into: Set<number>) => {
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const k of grid.get(keyOf(p, dx, dy)) ?? []) if (!used[k]) into.add(k)
  }
  for (let first = 0; first < open.length; first++) {
    if (used[first]) continue
    used[first] = true
    let chain = open[first]!
    for (let grew = true; grew;) {
      grew = false
      const start = chain.elements[0]!.a
      const end = chain.elements.at(-1)!.b
      const close = new Set<number>()
      candidates(end, close)
      candidates(start, close)
      for (const k of [...close].sort((x, y) => x - y)) {
        const c = open[k]!
        const cs = c.elements[0]!.a
        const ce = c.elements.at(-1)!.b
        if (near(end, cs)) chain = join(chain, c)
        else if (near(end, ce)) chain = join(chain, rev(c))
        else if (near(start, ce)) chain = join(c, chain)
        else if (near(start, cs)) chain = join(rev(c), chain)
        else continue
        used[k] = true
        grew = true
        break
      }
    }
    out.push(chain)
  }
  return [...out, ...lines.filter((l) => l.closed)]
}

/**
 * The lines of a Line in its face frame: every loop of a placed region and every open path, each
 * with its depth profile by arc length (`start` → `end`; or, E2, its levels mapped by
 * `{ min, max }`); coincident elements removed (the deeper kept; equal: the later dropped), which
 * splits a line into open runs. With levels (E2) open lines whose ends meet are then chained and
 * level steps blended over ±`blend`. Cached per operation geometry object.
 */
export function lineChains(op: LineChainsInput): LineChains {
  const hit = chainsMemo.get(op)
  if (hit !== undefined) return hit
  const { lines: out, coincident } = dropCoincident(rawLines(op))
  const blend = op.blend ?? DEFAULT_LINE_BLEND
  const lines2 = isLevelDepth(op.depth)
    ? chainOpen(out).map((l) => ({ ...l, profile: blendSteps(l.profile, l.length, blend) }))
    : out
  const result = {
    lines: op.within === undefined ? lines2 : clipWithin(lines2, op.within),
    coincident,
  }
  chainsMemo.set(op, result)
  return result
}

/**
 * A split piece's Line (engraved-patterns.md § Split pieces): the resolved lines cut at the
 * piece's cell (`within`, face frame), each kept piece with its slice of the depth profile, so a
 * ramp, levels and blends stay exactly the source's along what is left.
 */
export function clipWithin(
  lines: readonly ResolvedLine[],
  within: { readonly min: Vec2; readonly max: Vec2 },
): ResolvedLine[] {
  const [x0, y0] = within.min
  const [x1, y1] = within.max
  const corners: Vec2[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
  const boundary = new ClipBoundary({
    pieces: [
      { outer: { elements: corners.map((p, i) => line(p, corners[(i + 1) % 4]!)) }, holes: [] },
    ],
  })
  const out: ResolvedLine[] = []
  for (const l of lines) {
    const c = clipLine(l.elements, l.closed, boundary)
    if (c === 'inside') out.push(l)
    else if (c !== 'outside')
      for (const run of c) {
        // a loop's run may pass its start: its profile in two slices
        const a = sliceProfile(l.profile, run.from, Math.min(run.to, l.length))
        const b = run.to > l.length + EPSILON ? sliceProfile(l.profile, 0, run.to - l.length) : null
        const profile =
          b === null
            ? a
            : {
                s: [...a.s, ...b.s.map((x) => x + a.s.at(-1)!)],
                d: [...a.d, ...b.d],
              }
        let length = 0
        for (const e of run.elements) length += elementLength(e)
        if (length > EPSILON) out.push({ elements: run.elements, closed: false, length, profile })
      }
  }
  return out
}

/** A line before coincident removal: its elements, whether a loop, and its profile. */
export interface RawLine {
  readonly elements: readonly Element[]
  readonly closed: boolean
  readonly profile: LineProfile
}

/**
 * Coincident elements removed from lines (the deeper kept; equal: the later dropped), which
 * splits a line into open runs with their sliced profiles; a line that loses nothing is kept as
 * it is. Shared with the engraved pattern's tiles (engraving/resolve.ts, E4: there the profile
 * is the level, so the higher level stays).
 */
export function dropCoincident(input: readonly RawLine[]): LineChains {
  const lines = input.map((l) => {
    const starts: number[] = []
    let L = 0
    for (const e of l.elements) {
      starts.push(L)
      L += elementLength(e)
    }
    return { elements: l.elements, closed: l.closed, starts, length: L, profile: l.profile }
  })
  // coincident elements: a grid of their middles, then ends and middle compared
  const GRID = 0.05
  const cells = new Map<string, { li: number; ei: number }[]>()
  const removed = lines.map((l) => l.elements.map(() => false))
  let coincident = 0
  const maxDepth = (li: number, ei: number): number => {
    const l = lines[li]!
    const s0 = l.starts[ei]!
    const s1 = s0 + elementLength(l.elements[ei]!)
    return Math.max(profileAt(l.profile, s0), depthBefore(l.profile, s1))
  }
  lines.forEach((l, li) =>
    l.elements.forEach((e, ei) => {
      const m = elementPoint(e, 0.5)
      const gx = Math.round(m[0] / GRID)
      const gy = Math.round(m[1] / GRID)
      for (let dx = -1; dx <= 1 && !removed[li]![ei]; dx++)
        for (let dy = -1; dy <= 1 && !removed[li]![ei]; dy++)
          for (const o of cells.get(`${gx + dx},${gy + dy}`) ?? []) {
            if (removed[o.li]![o.ei]) continue
            const f = lines[o.li]!.elements[o.ei]!
            if (f.kind !== e.kind || !near(elementPoint(f, 0.5), m)) continue
            if (!((near(f.a, e.a) && near(f.b, e.b)) || (near(f.a, e.b) && near(f.b, e.a))))
              continue
            coincident++
            // the deeper stays; equal: the later goes
            if (maxDepth(o.li, o.ei) < maxDepth(li, ei) - EPSILON) removed[o.li]![o.ei] = true
            else removed[li]![ei] = true
            break
          }
      const key = `${gx},${gy}`
      const list = cells.get(key)
      if (list === undefined) cells.set(key, [{ li, ei }])
      else list.push({ li, ei })
    }),
  )
  const out: ResolvedLine[] = []
  lines.forEach((l, li) => {
    const gone = removed[li]!
    if (!gone.some(Boolean)) {
      if (l.length > EPSILON)
        out.push({ elements: l.elements, closed: l.closed, length: l.length, profile: l.profile })
      return
    }
    const n = l.elements.length
    // a loop is cut open after a removed element, so no run wraps round its start
    const first = l.closed ? gone.findIndex(Boolean) + 1 : 0
    let run: number[] = []
    const flush = () => {
      if (run.length === 0) return
      const elements = run.map((k) => l.elements[k % n]!)
      const pieces: { s: number[]; d: number[] }[] = []
      let acc = 0
      // a run of a loop may pass its start: the profile in two slices
      let from = run[0]!
      for (let i = 0; i <= run.length; i++) {
        const wraps = i === run.length || run[i]! % n === 0
        if (i > 0 && wraps) {
          const s0 = l.starts[from % n]!
          const lastIdx = run[i - 1]! % n
          const s1 = l.starts[lastIdx]! + elementLength(l.elements[lastIdx]!)
          const piece = sliceProfile(l.profile, s0, s1)
          pieces.push({ s: piece.s.map((x) => x + acc), d: piece.d })
          acc += s1 - s0
          if (i < run.length) from = run[i]!
        }
      }
      const s = pieces.flatMap((p) => p.s)
      const d = pieces.flatMap((p) => p.d)
      out.push({ elements, closed: false, length: acc, profile: { s, d } })
      run = []
    }
    for (let i = 0; i < n; i++) {
      const k = first + i
      if (gone[k % n]) flush()
      else run.push(k)
    }
    flush()
  })
  return { lines: out, coincident }
}

/** The deepest depth of a Line below its face (mm); with levels (E2), of its resolved lines. */
export function lineMaxDepth(op: LineChainsInput): number {
  if (!isLevelDepth(op.depth)) return Math.max(op.depth.start, op.depth.end)
  const ls = lineChains(op).lines
  return ls.length === 0 ? op.depth.max : Math.max(...ls.map((l) => profileMax(l.profile)))
}

/** The shallowest depth of a Line below its face (mm); with levels (E2), of its resolved lines. */
export function lineMinDepth(op: LineChainsInput): number {
  if (!isLevelDepth(op.depth)) return Math.min(op.depth.start, op.depth.end)
  const ls = lineChains(op).lines
  return ls.length === 0 ? op.depth.min : Math.min(...ls.map((l) => Math.min(...l.profile.d)))
}

/** `[u, v]` of the deepest place of a Line's resolved lines (the first such profile point). */
export function lineDeepestPoint(op: LineChainsInput): number[] | undefined {
  let best: { l: ResolvedLine; s: number; d: number } | undefined
  for (const l of lineChains(op).lines)
    l.profile.d.forEach((d, k) => {
      if (best === undefined || d > best.d + EPSILON) best = { l, s: l.profile.s[k]!, d }
    })
  if (best === undefined) return undefined
  const { l, s } = best as { l: ResolvedLine; s: number }
  let acc = 0
  for (const e of l.elements) {
    const len = elementLength(e)
    if (s <= acc + len + EPSILON) {
      const p = elementPoint(e, len > 0 ? Math.min(1, Math.max(0, (s - acc) / len)) : 0)
      return [p[0], p[1]]
    }
    acc += len
  }
  const p = elementPoint(l.elements.at(-1)!, 1)
  return [p[0], p[1]]
}

/**
 * The groove's width at the face for a depth (research § Tools): V-bit dt + 2 d tan(α/2) up to its
 * Ø; ball 2 √(d (D − d)) up to D; flat D.
 */
export function grooveWidth(c: LineCutter, depth: number): number {
  if (c.kind === 'flat') return c.diameter
  if (c.kind === 'ball') {
    const R = c.diameter / 2
    return depth >= R ? c.diameter : 2 * Math.sqrt(depth * (c.diameter - depth))
  }
  return Math.min(c.diameter, c.tipDiameter + 2 * depth * Math.tan((c.angle * Math.PI) / 360))
}

/** A V-bit's cutting-edge height (DC − dt) / 2 / tan(α/2) (mm); undefined for end mills. */
export function vBitEdgeHeight(c: LineCutter): number | undefined {
  if (c.kind !== 'vBit') return undefined
  return (c.diameter - c.tipDiameter) / 2 / Math.tan((c.angle * Math.PI) / 360)
}

// ── removal solid ─────────────────────────────────────────────────────────────────────────

/** The tool's profile as rings (height above the tip, radius), bottom up, to height `H`. */
function cutterRings(c: LineCutter, H: number): { h: number; r: number }[] {
  const R = c.diameter / 2
  if (c.kind === 'flat')
    return [
      { h: 0, r: R },
      { h: H, r: R },
    ]
  if (c.kind === 'vBit') {
    const t = Math.tan((c.angle * Math.PI) / 360)
    const r0 = c.tipDiameter / 2
    const hc = (c.diameter - c.tipDiameter) / 2 / t
    if (H <= hc)
      return [
        { h: 0, r: r0 },
        { h: H, r: r0 + H * t },
      ]
    return [
      { h: 0, r: r0 },
      { h: hc, r: R },
      { h: H, r: R },
    ]
  }
  // the ball's quarter profile finer than the chord tolerance: its volume within 0.5 %
  const m = arcSegments(R, Math.PI / 2, CHORD_TOLERANCE / 4)
  const rings = [{ h: 0, r: 0 }]
  for (let k = 1; k <= m; k++) {
    const phi = (k / m) * (Math.PI / 2)
    const h = R * (1 - Math.cos(phi))
    if (h >= H) break
    rings.push({ h, r: R * Math.sin(phi) })
  }
  if (H > R) rings.push({ h: H, r: R })
  else if (rings.at(-1)!.h < H) rings.push({ h: H, r: Math.sqrt(H * (c.diameter - H)) })
  return rings
}

interface Polyhedron {
  readonly vertices: Vec3[]
  /** Counter-clockwise seen from outside. */
  readonly faces: number[][]
}

/** The tool solid as a convex polyhedron with its tip at the origin, `n` sides per ring. */
function cutterPolyhedron(c: LineCutter, H: number): Polyhedron {
  const rings = cutterRings(c, H)
  const rMax = Math.max(...rings.map((r) => r.r))
  const n = Math.max(8, arcSegments(rMax, 2 * Math.PI))
  // each ring's polygon has the circle's area (the groove's volume, not its width, is checked)
  const k = Math.sqrt((2 * Math.PI) / n / Math.sin((2 * Math.PI) / n))
  const vertices: Vec3[] = []
  const index: number[][] = []
  for (const ring of rings) {
    if (ring.r <= EPSILON) {
      vertices.push([0, 0, ring.h])
      index.push(Array.from({ length: n }, () => vertices.length - 1))
      continue
    }
    const ids: number[] = []
    for (let j = 0; j < n; j++) {
      const a = (2 * Math.PI * j) / n
      vertices.push([k * ring.r * Math.cos(a), k * ring.r * Math.sin(a), ring.h])
      ids.push(vertices.length - 1)
    }
    index.push(ids)
  }
  const faces: number[][] = []
  const bottom = index[0]!
  if (bottom[0] !== bottom[1]) faces.push([...bottom].reverse())
  for (let i = 0; i + 1 < index.length; i++) {
    const lo = index[i]!
    const hi = index[i + 1]!
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n
      const f = [lo[j]!, lo[k]!, hi[k]!, hi[j]!].filter((v, q, all) => all.indexOf(v) === q)
      if (f.length >= 3) faces.push(f)
    }
  }
  faces.push([...index.at(-1)!])
  return { vertices, faces }
}

/** Newell's normal of a polygon (not normalised). */
function normal(p: Polyhedron, f: readonly number[]): Vec3 {
  let x = 0
  let y = 0
  let z = 0
  for (let i = 0; i < f.length; i++) {
    const a = p.vertices[f[i]!]!
    const b = p.vertices[f[(i + 1) % f.length]!]!
    x += (a[1] - b[1]) * (a[2] + b[2])
    y += (a[2] - b[2]) * (a[0] + b[0])
    z += (a[0] - b[0]) * (a[1] + b[1])
  }
  return [x, y, z]
}

/**
 * The convex polyhedron `p` swept along the segment `at` → `at + d` (its Minkowski sum with the
 * segment): faces turned away from `d` stay at `at`, faces towards it move to `at + d`, and every
 * edge between the two groups is swept into a quad. Triangulated as fans, every face `label`.
 */
export function sweptPolyhedron(p: Polyhedron, at: Vec3, d: Vec3, label: number): LabelledMesh {
  const nv = p.vertices.length
  const positions = new Float64Array(nv * 6)
  p.vertices.forEach((v, i) => {
    positions.set([v[0] + at[0], v[1] + at[1], v[2] + at[2]], i * 3)
    positions.set([v[0] + at[0] + d[0], v[1] + at[1] + d[1], v[2] + at[2] + d[2]], (nv + i) * 3)
  })
  const moved = p.faces.map((f) => {
    const n = normal(p, f)
    return n[0] * d[0] + n[1] * d[1] + n[2] * d[2] > 0
  })
  const owner = new Map<string, number>()
  p.faces.forEach((f, fi) => f.forEach((u, i) => owner.set(`${u},${f[(i + 1) % f.length]}`, fi)))
  const tris: number[] = []
  const fan = (f: readonly number[]) => {
    for (let i = 1; i + 1 < f.length; i++) tris.push(f[0]!, f[i]!, f[i + 1]!)
  }
  p.faces.forEach((f, fi) => {
    fan(moved[fi] ? f.map((v) => v + nv) : f)
    if (moved[fi]) return
    // a silhouette edge u → w of a staying face whose twin face moves: the quad w, u, u', w'
    f.forEach((u, i) => {
      const w = f[(i + 1) % f.length]!
      const twin = owner.get(`${w},${u}`)
      if (twin !== undefined && moved[twin]) fan([w, u, u + nv, w + nv])
    })
  })
  const triangles = Uint32Array.from(tris)
  return { positions, triangles, faces: new Uint32Array(triangles.length / 3).fill(label) }
}

/** A line flattened for the removal solid: points with their depth, every profile break kept. */
export function flattenLine(l: ResolvedLine, tolerance = CHORD_TOLERANCE): Vec3[] {
  const out: Vec3[] = []
  let s0 = 0
  for (const e of l.elements) {
    const L = elementLength(e)
    const us = new Set<number>([0, 1])
    if (e.kind === 'arc') {
      const n = arcSegments(arcRadius(e), Math.abs(arcSweep(e)), tolerance)
      for (let k = 1; k < n; k++) us.add(k / n)
    }
    for (const s of l.profile.s) if (s > s0 + EPSILON && s < s0 + L - EPSILON) us.add((s - s0) / L)
    for (const u of [...us].sort((a, b) => a - b)) {
      if (out.length > 0 && u === 0) continue
      const p = elementPoint(e, u)
      const s = s0 + u * L
      out.push([p[0], p[1], u === 1 ? depthBefore(l.profile, s) : profileAt(l.profile, s)])
    }
    s0 += L
  }
  return out
}

/** A turn sharper than this (radians) is a corner: the loft stops there and a tool is placed. */
const CORNER_TURN = 0.35

/** The tool's half profile as a convex polygon in (w across the line, h up from the tip). */
function profilePolygon(rings: readonly { h: number; r: number }[]): [number, number][] {
  const right = rings.map((g): [number, number] => [g.r, g.h])
  const left = [...rings].reverse().map((g): [number, number] => [-g.r, g.h])
  const out: [number, number][] = []
  for (const p of [...right, ...left]) {
    const q = out.at(-1)
    if (q === undefined || Math.abs(q[0] - p[0]) > EPSILON || Math.abs(q[1] - p[1]) > EPSILON)
      out.push(p)
  }
  const f = out[0]!
  const l = out.at(-1)!
  if (out.length > 1 && Math.abs(f[0] - l[0]) <= EPSILON && Math.abs(f[1] - l[1]) <= EPSILON)
    out.pop()
  return out
}

/** The signed volume of a closed triangle mesh. */
function meshVolume(positions: Float64Array, tris: readonly number[]): number {
  let v = 0
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]! * 3
    const b = tris[t + 1]! * 3
    const c = tris[t + 2]! * 3
    const [ax, ay, az] = [positions[a]!, positions[a + 1]!, positions[a + 2]!]
    const [bx, by, bz] = [positions[b]!, positions[b + 1]!, positions[b + 2]!]
    const [cx, cy, cz] = [positions[c]!, positions[c + 1]!, positions[c + 2]!]
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  return v / 6
}

/**
 * The tool's profile swept along a smooth run of points (x, y, depth): at every station the
 * profile across the run (mitred at the bend), its tip at onZ − depth; closed runs wrap, open
 * ones get flat end caps (the tools at the ends round them).
 */
function loftRun(
  pts: readonly Vec3[],
  closed: boolean,
  profile: readonly [number, number][],
  onZ: number,
  label: number,
): LabelledMesh {
  const m = pts.length
  const k = profile.length
  const dir = (i: number): Vec2 => {
    const a = pts[i]!
    const b = pts[(i + 1) % m]!
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
  }
  const positions = new Float64Array(m * k * 3)
  for (let i = 0; i < m; i++) {
    const inDir = closed || i > 0 ? dir((i - 1 + m) % m) : undefined
    const outDir = closed || i < m - 1 ? dir(i) : undefined
    let n: Vec2
    let scale = 1
    if (inDir !== undefined && outDir !== undefined) {
      const t: Vec2 = [inDir[0] + outDir[0], inDir[1] + outDir[1]]
      const L = Math.hypot(t[0], t[1])
      n = [-t[1] / L, t[0] / L]
      // the mitre: the offset across a bend of θ is w / cos(θ/2)
      scale = 1 / Math.max(0.5, inDir[0] * n[1] - inDir[1] * n[0])
    } else {
      const t = (inDir ?? outDir)!
      n = [-t[1], t[0]]
    }
    const [x, y, depth] = pts[i]!
    profile.forEach(([w, h], j) =>
      positions.set([x + n[0] * w * scale, y + n[1] * w * scale, onZ - depth + h], (i * k + j) * 3),
    )
  }
  const tris: number[] = []
  const stations = closed ? m : m - 1
  for (let i = 0; i < stations; i++) {
    const a = i * k
    const b = ((i + 1) % m) * k
    for (let j = 0; j < k; j++) {
      const j1 = (j + 1) % k
      tris.push(a + j, b + j, b + j1, a + j, b + j1, a + j1)
    }
  }
  if (!closed)
    for (let j = 1; j + 1 < k; j++) {
      // each cap against its side quads' edges
      tris.push(0, j, j + 1)
      const e = (m - 1) * k
      tris.push(e, e + j + 1, e + j)
    }
  // one consistent winding: outward
  if (meshVolume(positions, tris) < 0)
    for (let t = 0; t < tris.length; t += 3) {
      const x = tris[t + 1]!
      tris[t + 1] = tris[t + 2]!
      tris[t + 2] = x
    }
  const triangles = Uint32Array.from(tris)
  return { positions, triangles, faces: new Uint32Array(triangles.length / 3).fill(label) }
}

/**
 * The removal solid of a Line in its face frame (engraved-patterns.md § Line operation): the tool
 * swept along each line, its top `OVERSHOOT` above the face at the line's deepest point. A smooth
 * run is the tool's profile lofted along its chords; a sharp turn (over 20°, or one whose inner
 * side would fold) ends the run, and the tool itself stands at every corner and open end, so the
 * union is the Minkowski sum of the tool and the chorded line. Role `groove`, no face target.
 */
export function lineSolids(op: LineGeometry): AppResult<LocalSolids> {
  const table = new Table()
  const groove = table.add('groove')
  const removal: { mesh: LabelledMesh; at: Vec3 }[] = []
  for (const l of lineChains(op).lines) {
    const raw = flattenLine(l)
    const pts: Vec3[] = []
    for (const p of raw) {
      const q = pts.at(-1)
      if (q === undefined || Math.hypot(p[0] - q[0], p[1] - q[1]) > EPSILON) pts.push(p)
    }
    const closed = l.closed && pts.length > 2
    if (closed) {
      const f = pts[0]!
      const e = pts.at(-1)!
      if (Math.hypot(f[0] - e[0], f[1] - e[1]) <= EPSILON) pts.pop()
    }
    if (pts.length < 2) continue
    const H = OVERSHOOT + Math.max(...pts.map((p) => p[2]))
    const rings = cutterRings(op.cutter, H)
    const profile = profilePolygon(rings)
    const tool = cutterPolyhedron(op.cutter, H)
    const rTop = Math.max(...rings.map((g) => g.r))
    const m = pts.length
    const len = (i: number) => {
      const a = pts[i % m]!
      const b = pts[(i + 1) % m]!
      return Math.hypot(b[0] - a[0], b[1] - a[1])
    }
    const turn = (i: number): number => {
      const a = pts[(i - 1 + m) % m]!
      const b = pts[i]!
      const c = pts[(i + 1) % m]!
      const u = Math.atan2(b[1] - a[1], b[0] - a[0])
      const v = Math.atan2(c[1] - b[1], c[0] - b[0])
      return Math.abs(Math.atan2(Math.sin(v - u), Math.cos(v - u)))
    }
    // corners: sharp turns, and both ends of a chord whose inner side the mitres would fold
    const corner = new Array<boolean>(m).fill(false)
    const inner = pts.map((_, i) =>
      closed || (i > 0 && i < m - 1) ? rTop * Math.tan(Math.min(turn(i), 1.5) / 2) : 0,
    )
    for (let i = 0; i < m; i++) if (inner[i]! > 0 && turn(i) > CORNER_TURN) corner[i] = true
    for (let i = 0; i < (closed ? m : m - 1); i++)
      if ((inner[i] ?? 0) + (inner[(i + 1) % m] ?? 0) >= 0.9 * len(i)) {
        corner[i] = closed || i > 0 ? true : corner[i]!
        corner[(i + 1) % m] = closed || i + 1 < m - 1 ? true : corner[(i + 1) % m]!
      }
    const place = (p: Vec3) =>
      removal.push({
        mesh: sweptPolyhedron(tool, [p[0], p[1], op.onZ - p[2]], [0, 0, 0], groove),
        at: [0, 0, 0],
      })
    const corners = pts.flatMap((_, i) => (corner[i] ? [i] : []))
    if (closed && corners.length === 0) {
      removal.push({ mesh: loftRun(pts, true, profile, op.onZ, groove), at: [0, 0, 0] })
      continue
    }
    // open runs between corners (a closed line: from its first corner round to it again)
    const order = closed ? [...pts.slice(corners[0]!), ...pts.slice(0, corners[0]! + 1)] : pts
    const isCorner = closed
      ? [...corner.slice(corners[0]!), ...corner.slice(0, corners[0]! + 1)]
      : corner.map((c, i) => c || i === 0 || i === m - 1)
    let run: Vec3[] = [order[0]!]
    place(order[0]!)
    for (let i = 1; i < order.length; i++) {
      run.push(order[i]!)
      if (isCorner[i] || i === order.length - 1) {
        removal.push({ mesh: loftRun(run, false, profile, op.onZ, groove), at: [0, 0, 0] })
        if (!(closed && i === order.length - 1)) place(order[i]!)
        run = [order[i]!]
      }
    }
  }
  return Ok(localSolids(op.id, table, { removal }))
}
