/**
 * Spike S7 fast path: the chamfer's removal as ONE offset-loft per side instead of a union of
 * per-element sweeps. The swept V-bit at height z covers the toolpath region offset by ρ(z), so
 * the solid is a loft of the toolpath region's analytic offsets (parallels of every element,
 * joint arcs where they part, trimmed where they cross), valid while no element vanishes and the
 * offset does not change topology — checked against the 2D port's offset area at every level;
 * otherwise `undefined` (the caller falls back to the sweep union). Throwaway code.
 */
import type { Vec2 } from '../../src/core/geometry/model'
import {
  regionArea,
  regionLoops,
  type Element,
  type Loop,
  type Region,
} from '../../src/core/geometry/2d/model'
import type { Region2dPort } from '../../src/core/geometry/2d/port'
import type { Wasm } from './sweep'

type Arc = Extract<Element, { kind: 'arc' }>

/** Why the last `offsetLoft` returned undefined (spike diagnostics). */
export let loftFailure = ''
const fail = (why: string): undefined => {
  loftFailure = why
  return undefined
}

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]]
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k]
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0]
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1]
const len = (a: Vec2) => Math.hypot(a[0], a[1])
const unit = (a: Vec2): Vec2 => mul(a, 1 / len(a))
const left = (t: Vec2): Vec2 => [-t[1], t[0]]
const angle = (c: Vec2, p: Vec2) => Math.atan2(p[1] - c[1], p[0] - c[0])

function tangent(e: Element, end: 'a' | 'b'): Vec2 {
  if (e.kind === 'line') return unit(sub(e.b, e.a))
  const n = unit(sub(e[end], e.centre))
  return e.ccw ? left(n) : mul(left(n), -1)
}

function arcSweep(e: Arc): number {
  if (len(sub(e.a, e.b)) < 1e-12) return 2 * Math.PI
  let d = e.ccw
    ? angle(e.centre, e.b) - angle(e.centre, e.a)
    : angle(e.centre, e.a) - angle(e.centre, e.b)
  while (d <= 0) d += 2 * Math.PI
  return d
}

/** An element's parallel at signed distance d to its left (d > 0: towards the left normal). */
interface Par {
  readonly kind: 'line' | 'arc'
  // line: point + direction; arc: centre, radius, ccw
  readonly p: Vec2
  readonly t: Vec2
  readonly c: Vec2
  readonly r: number
  readonly ccw: boolean
  s: Vec2
  e: Vec2
}

function parallel(e: Element, d: number): Par | undefined {
  if (e.kind === 'line') {
    const t = unit(sub(e.b, e.a))
    const n = mul(left(t), d)
    return {
      kind: 'line',
      p: add(e.a, n),
      t,
      c: [0, 0],
      r: 0,
      ccw: true,
      s: add(e.a, n),
      e: add(e.b, n),
    }
  }
  const R = len(sub(e.a, e.centre))
  // the centre is on the left of a ccw arc: moving left shrinks it
  const r = e.ccw ? R - d : R + d
  if (!(r > 1e-9)) return undefined
  const at = (p: Vec2) => add(e.centre, mul(unit(sub(p, e.centre)), r))
  return { kind: 'arc', p: [0, 0], t: [0, 0], c: e.centre, r, ccw: e.ccw, s: at(e.a), e: at(e.b) }
}

/** Intersections of two parallels (as full lines / circles). */
function intersections(u: Par, v: Par): Vec2[] {
  if (u.kind === 'line' && v.kind === 'line') {
    const den = cross(u.t, v.t)
    if (Math.abs(den) < 1e-15) return []
    const k = cross(sub(v.p, u.p), v.t) / den
    return [add(u.p, mul(u.t, k))]
  }
  if (u.kind === 'arc' && v.kind === 'line') return intersections(v, u)
  if (u.kind === 'line') {
    const f = sub(u.p, v.c)
    const b = dot(f, u.t)
    const disc = b * b - (dot(f, f) - v.r * v.r)
    if (disc < 0) return []
    const q = Math.sqrt(disc)
    return [add(u.p, mul(u.t, -b - q)), add(u.p, mul(u.t, -b + q))]
  }
  const dvec = sub(v.c, u.c)
  const D = len(dvec)
  if (D < 1e-15 || D > u.r + v.r || D < Math.abs(u.r - v.r)) return []
  const a = (u.r * u.r - v.r * v.r + D * D) / (2 * D)
  const h = Math.sqrt(Math.max(0, u.r * u.r - a * a))
  const m = add(u.c, mul(dvec, a / D))
  const n = mul(left(unit(dvec)), h)
  return [add(m, n), sub(m, n)]
}

/** Points of one loop's analytic offset at d (left), `n` per item fixed by `plan`. */
interface Plan {
  /** Per element: arc segments; per joint: 0 = trimmed, −1 = tangent, else joint arc segments. */
  readonly elementSegs: number[]
  readonly jointSegs: number[]
}

function offsetRing(loop: Loop, d: number, plan: Plan): Vec2[] | undefined {
  const els = loop.elements
  const n = els.length
  // an arc whose parallel radius is ≤ 0 has collapsed: its neighbours meet (trim) in its place,
  // and its points all sit at that trim point (degenerate band triangles, collapsed by Manifold)
  const pars: (Par | undefined)[] = els.map((e) => parallel(e, d))
  const alive = pars.map((p) => p !== undefined)
  if (!alive.some(Boolean)) return fail('every element collapsed')
  const collapsedAt = new Map<number, Vec2>()
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue
    let j = (i + 1) % n
    const between: number[] = []
    while (!alive[j]) {
      between.push(j)
      j = (j + 1) % n
    }
    const u = pars[i]!
    const v = pars[j]!
    if (between.length === 0 && plan.jointSegs[i]! > 0) continue
    const V = els[i]!.b
    if (between.length === 0 && (plan.jointSegs[i] === -1 || len(sub(u.e, v.s)) < 1e-7)) {
      const m = mul(add(u.e, v.s), 0.5)
      u.e = m
      v.s = m
      continue
    }
    if (
      between.some((k) => plan.jointSegs[k]! > 0) ||
      (between.length > 0 && plan.jointSegs[i]! > 0)
    )
      return fail('collapsed arc next to a joint arc')
    const xs = intersections(u, v)
    if (xs.length === 0) return fail(`no trim point at joint ${i} (${u.kind}/${v.kind})`)
    let best = xs[0]!
    for (const x of xs) if (len(sub(x, V)) < len(sub(best, V))) best = x
    u.e = best
    v.s = best
    for (const k of between) collapsedAt.set(k, best)
  }
  const out: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const e = els[i]!
    if (!alive[i]) {
      const p = collapsedAt.get(i)
      if (p === undefined) return fail(`arc ${i} collapsed without a trim point`)
      for (let j = 0; j < plan.elementSegs[i]!; j++) out.push(p)
      continue
    }
    const u = pars[i]!
    if (u.kind === 'line') {
      // the trimmed line must keep its direction (else the element vanished)
      if (dot(sub(u.e, u.s), u.t) <= 1e-9) return fail(`line ${i} vanished`)
      out.push(u.s)
    } else {
      const a0 = angle(u.c, u.s)
      let sw = u.ccw ? angle(u.c, u.e) - a0 : a0 - angle(u.c, u.e)
      const full = arcSweep(e as Arc)
      while (sw <= -Math.PI) sw += 2 * Math.PI
      while (sw > 2 * Math.PI) sw -= 2 * Math.PI
      if (full >= 2 * Math.PI - 1e-12 && len(sub(u.s, u.e)) < 1e-9) sw = 2 * Math.PI
      else if (sw <= 0) {
        if (full > Math.PI) sw += 2 * Math.PI
        else return fail(`arc ${i} vanished`)
      }
      if (Math.abs(sw - full) > Math.PI) return fail(`arc ${i} flipped`)
      const k = plan.elementSegs[i]!
      for (let j = 0; j < k; j++) {
        const t = a0 + ((u.ccw ? 1 : -1) * (sw * j)) / k
        out.push([u.c[0] + u.r * Math.cos(t), u.c[1] + u.r * Math.sin(t)])
      }
    }
    const m = plan.jointSegs[i]!
    if (m > 0) {
      // joint arc around the vertex from this parallel's end to the next one's start
      const V = e.b
      const v = pars[(i + 1) % n]
      if (v === undefined) return fail('joint arc before a collapsed arc')
      const a0 = angle(V, u.e)
      let sw = angle(V, v.s) - a0
      const turnLeft = d < 0 // growing to the right of a left turn: the joint turns ccw
      if (turnLeft) while (sw < 0) sw += 2 * Math.PI
      else while (sw > 0) sw -= 2 * Math.PI
      for (let j = 0; j < m; j++) {
        const t = a0 + (sw * j) / m
        out.push([V[0] + Math.abs(d) * Math.cos(t), V[1] + Math.abs(d) * Math.sin(t)])
      }
    }
  }
  return out
}

const signedRingArea = (r: readonly Vec2[]) => {
  let s = 0
  for (let i = 0; i < r.length; i++) s += cross(r[i]!, r[(i + 1) % r.length]!)
  return s / 2
}

function planFor(loop: Loop, dMax: number, tol: number): Plan {
  const els = loop.elements
  const segs = (r: number, sweep: number) =>
    Math.max(1, Math.ceil(sweep / (2 * Math.acos(Math.max(-1, 1 - tol / Math.max(r, tol))))))
  const elementSegs = els.map((e) => {
    if (e.kind === 'line') return 1
    const R = len(sub(e.a, e.centre))
    return segs(R + Math.abs(dMax), arcSweep(e))
  })
  const jointSegs = els.map((e, i) => {
    const t1 = tangent(e, 'b')
    const t2 = tangent(els[(i + 1) % els.length]!, 'a')
    const c = cross(t1, t2)
    if (Math.abs(c) < 1e-6 && dot(t1, t2) > 0) return -1 // tangent: ends meet within 1e-6 · d
    // a left turn opens a gap when moving right (d < 0), a right turn when moving left
    const gap = dMax < 0 ? c > 0 : c < 0
    if (!gap) return 0
    const turn = Math.abs(Math.atan2(c, dot(t1, t2)))
    return segs(Math.abs(dMax), turn)
  })
  return { elementSegs, jointSegs }
}

export interface LoftStats {
  levels: number
  triangles: number
  build: number
}

/**
 * The loft of `region`'s offsets by `sign · ρ_k` at z_k (sign −1 grows, +1 shrinks), plus a
 * vertical band to `topZ`. Positions and triangles of one closed mesh, or undefined when the
 * analytic offset is not valid at some level (checked against the port's offset area).
 */
export function offsetLoft(
  wasm: Wasm,
  port: Region2dPort,
  region: Region,
  sign: 1 | -1,
  levels: readonly { z: number; rho: number }[],
  topZ: number,
  tol: number,
): { positions: Float64Array; triangles: Uint32Array; stats: LoftStats } | undefined {
  const t0 = performance.now()
  const loops = regionLoops(region)
  const dMax = sign * Math.max(...levels.map((l) => l.rho))
  const plans = loops.map((l) => planFor(l, dMax, tol))
  const all = [...levels, { z: topZ, rho: levels[levels.length - 1]!.rho }]
  const rings: Vec2[][][] = []
  for (const lv of all) {
    const d = sign * lv.rho
    const rs: Vec2[][] = []
    for (const [k, l] of loops.entries()) {
      const r = offsetRing(l, d, plans[k]!)
      if (r === undefined) return fail(`d ${d.toFixed(3)}: ${loftFailure}`)
      rs.push(r)
    }
    // topology check: same area as the library's offset (to the chord error of the rings)
    const ref = port.offset(region, d)
    if (ref.isErr()) return fail('port offset failed')
    const refRegion = ref.unwrap()
    if (regionLoops(refRegion).length !== loops.length)
      return fail(`d ${d.toFixed(3)}: loop count changes`)
    const area = rs.reduce((s, r) => s + signedRingArea(r), 0)
    const perimeter = rs.reduce(
      (s, r) => s + r.reduce((q, p, i) => q + len(sub(p, r[(i + 1) % r.length]!)), 0),
      0,
    )
    if (Math.abs(area - regionArea(refRegion)) > perimeter * tol * 1.5 + 1e-6)
      return fail(
        `d ${d.toFixed(3)}: area ${area.toFixed(4)} vs port ${regionArea(refRegion).toFixed(4)}`,
      )
    rings.push(rs)
  }
  // mesh: vertices level by level, loop by loop
  const counts = rings[0]!.map((r) => r.length)
  const perLevel = counts.reduce((a, b) => a + b, 0)
  const positions = new Float64Array(all.length * perLevel * 3)
  let v = 0
  for (const [k, rs] of rings.entries())
    for (const r of rs)
      for (const p of r) {
        positions[v++] = p[0]
        positions[v++] = p[1]
        positions[v++] = all[k]!.z
      }
  const tris: number[] = []
  const base = (k: number, loop: number) =>
    k * perLevel + counts.slice(0, loop).reduce((a, b) => a + b, 0)
  for (let k = 0; k + 1 < all.length; k++)
    for (let l = 0; l < counts.length; l++) {
      const n = counts[l]!
      const b0 = base(k, l)
      const b1 = base(k + 1, l)
      for (let i = 0; i < n; i++) {
        const i1 = (i + 1) % n
        // ring counter-clockwise (outer) / clockwise (holes): outward band faces
        tris.push(b0 + i, b0 + i1, b1 + i1, b0 + i, b1 + i1, b1 + i)
      }
    }
  const capOf = (rs: Vec2[][]) =>
    wasm.triangulate(
      rs.map((r) => r.map((p) => [p[0], p[1]])) as never,
      -1,
    ) as unknown as number[][]
  for (const t of capOf(rings[0]!)) tris.push(t[0]!, t[2]!, t[1]!) // bottom faces down
  const topBase = (all.length - 1) * perLevel
  for (const t of capOf(rings[all.length - 1]!))
    tris.push(topBase + t[0]!, topBase + t[1]!, topBase + t[2]!)
  return {
    positions,
    triangles: Uint32Array.from(tris),
    stats: { levels: all.length, triangles: tris.length / 3, build: performance.now() - t0 },
  }
}
