/**
 * Removal solid of an edge chamfer along a general edge (E1: inside edges, the top edge of a
 * pocket or an inside profile, every loop incl. islands). Spike S7: a V-bit whose axis follows
 * the toolpath region P (the air region shrunk by the tip radius) has swept P ⊕ ρ(z) at height z,
 * ρ(z) the tool's radius there. The solid is that sweep, so it is what the tool cuts:
 * - offset-loft (normal path): P's analytic offsets (parallels, joint arcs, trims; an arc whose
 *   radius reaches 0 collapses into its neighbours' trim point) at a few levels, ruled bands,
 *   triangulated caps; vertical from the face to the overshoot, 0.04 mm past the edge into the
 *   air below (no film, the C2 rule). Every level is checked against the 2D port's offset (loop
 *   count, area within the chord band);
 * - fallback (the offset changes structure between levels): the tool swept along each chord of
 *   P as its own labelled mesh (a stadium frustum), unioned in the kernel by the evaluation (a
 *   float32 round trip of a unioned mesh is not a valid solid, S7 failure 1).
 * Doc: docs/modes/edge-chamfers.md#removal-solid, docs/modes/edge-chamfers.md#implementation-e1
 */
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import { AIR, localSolids, Table, type LocalMesh, type LocalSolids } from './local-solids'
import { offsetLoft, type LabelledMesh } from './loft'
import {
  CHORD_TOLERANCE,
  EPSILON,
  OVERSHOOT,
  loopChamferDepth,
  type LoopChamferGeometry,
  type Vec2,
} from './model'
import { loopChamferAir } from './outline'
import { flattenLoop, type Triangulate } from './prism'
import { regionArea, regionLoops, type Element, type Loop, type Region } from './2d/model'
import type { Region2dPort } from './2d/port'

/**
 * How far the solid's tool runs past the edge into the air (mm): the circular chamfer's run-in
 * (`CHAMFER_RUN_IN`, 4 × the chord tolerance), so the bevel meets the edge's wall inside the edge
 * operation's removal and leaves no film.
 */
export const LOOP_CHAMFER_RUN = 4 * CHORD_TOLERANCE

/** Largest radius step between two loft levels (mm), as spike S7. */
const LEVEL_STEP = 0.5

/** What the builder needs besides the chamfer: the caps' triangulator and the 2D port. */
export interface ChamferSolidsContext {
  readonly triangulate: Triangulate
  readonly region2d: Region2dPort
}

/**
 * The geometry tool of a loop chamfer: a V-bit of the chamfer's angle with tip diameter `tip`,
 * its tip `run / tan(α/2)` below the bevel's depth and `run` further into the air, so its cone
 * still meets the face `width` into the material. The design solid takes a pointed bit (tip 0):
 * the tool's own tip matters only in inside corners sharper than the tip radius and in necks
 * narrower than the tip (edge-chamfers.md § Implementation (E1)).
 */
export interface ChamferSweep {
  /** Toolpath region of the geometry tool (face frame of the shape's centre). */
  readonly path: Region
  /** Bottom level: radius and z (the cone cut where its radius is half the run). */
  readonly bottom: { readonly rho: number; readonly z: number }
  /** Radius at the face. */
  readonly faceRho: number
  readonly faceZ: number
}

function sweepOf(
  op: LoopChamferGeometry,
  port: Region2dPort,
  tip = 0,
): AppResult<ChamferSweep | undefined> {
  const air = loopChamferAir(op, true)
  const r0 = tip / 2
  const tan = Math.tan(((op.angle / 2) * Math.PI) / 180)
  const tipZ = op.onZ - loopChamferDepth(op) - LOOP_CHAMFER_RUN / tan
  const rhoB = Math.max(r0, LOOP_CHAMFER_RUN / 2)
  return port.offset(air, r0 + LOOP_CHAMFER_RUN).map((path) =>
    path.pieces.length === 0
      ? undefined
      : {
          path,
          bottom: { rho: rhoB, z: tipZ + (rhoB - r0) / tan },
          faceRho: r0 + (op.onZ - tipZ) * tan,
          faceZ: op.onZ,
        },
  )
}

/**
 * The removal solid of a loop chamfer in its face frame: one offset-loft, else the swept chords
 * (`fallback`). Surfaces: `bevel` (display only, as a circular chamfer's `cone`).
 */
export function loopChamferSolids(
  op: LoopChamferGeometry,
  ctx: ChamferSolidsContext,
): AppResult<LocalSolids> {
  const table = new Table()
  const bevel = table.add('bevel')
  const at = [op.edge.shape.center[0], op.edge.shape.center[1], 0] as const
  return sweepOf(op, ctx.region2d).andThen((sweep) => {
    if (sweep === undefined)
      return fail('geometry.evaluation', `${op.id}: the edge leaves no room for the chamfer`, {
        issues: [
          {
            path: ['edgeOf'],
            rule: 'chamferEmpty',
            message: 'the edge operation is too narrow to chamfer',
            params: { edgeOf: op.edgeOf },
          },
        ],
        where: 'loopChamferSolids',
      })
    const levels = loftLevels(sweep)
    const loft = loopLoft(sweep.path, levels, bevel, ctx)
    const meshes = loft.isOk() ? Ok([loft.unwrap()]) : sweptChords(sweep, bevel)
    return meshes.map((ms) =>
      localSolids(op.id, table, {
        removal: ms.map((mesh): LocalMesh => ({ mesh, at })),
      }),
    )
  })
}

/** Which construction `loopChamferSolids` takes for `op` (tests, perf): `loft` or `fallback`. */
export function loopChamferConstruction(
  op: LoopChamferGeometry,
  ctx: ChamferSolidsContext,
): 'loft' | 'fallback' | 'empty' {
  const sweep = sweepOf(op, ctx.region2d)
  if (sweep.isErr() || sweep.unwrap() === undefined) return 'empty'
  const s = sweep.unwrap()!
  return loopLoft(s.path, loftLevels(s), 0, ctx).isOk() ? 'loft' : 'fallback'
}

interface LoftLevel {
  readonly z: number
  readonly rho: number
}

/** Bottom to face in radius steps of at most `LEVEL_STEP`, then the overshoot (vertical). */
function loftLevels(s: ChamferSweep): LoftLevel[] {
  const n = Math.max(1, Math.ceil((s.faceRho - s.bottom.rho) / LEVEL_STEP - 1e-9))
  const out: LoftLevel[] = []
  for (let k = 0; k <= n; k++)
    out.push({
      z: s.bottom.z + ((s.faceZ - s.bottom.z) * k) / n,
      rho: s.bottom.rho + ((s.faceRho - s.bottom.rho) * k) / n,
    })
  out.push({ z: Math.max(OVERSHOOT, s.faceZ + OVERSHOOT), rho: s.faceRho })
  return out
}

// ── offset-loft ──────────────────────────────────────────────────────────────────────────────

function loftInvalid(message: string, data: Readonly<Record<string, unknown>> = {}) {
  return fail('geometry.evaluation', message, {
    issues: [{ path: [], rule: 'chamferLoft', message, params: data }],
    where: 'loopLoft',
    data,
  })
}

/**
 * One closed mesh through `path` grown by each level's ρ (bottom first): per loop a ring of the
 * same point count at every level, bands between them, caps by `triangulate`. Fails (rule
 * `chamferLoft`) where the analytic offset is not valid: the caller then sweeps the chords.
 */
function loopLoft(
  path: Region,
  levels: readonly LoftLevel[],
  label: number,
  ctx: ChamferSolidsContext,
): AppResult<LabelledMesh> {
  const loops = regionLoops(path)
  const dMax = -Math.max(...levels.map((l) => l.rho))
  const plans = loops.map((l) => planFor(l, dMax, CHORD_TOLERANCE))
  const rings: Vec2[][][] = []
  let checked = -1
  for (const lv of levels) {
    const d = -lv.rho
    const rs: Vec2[][] = []
    for (const [k, l] of loops.entries()) {
      const r = offsetRing(l, d, plans[k]!)
      if (typeof r === 'string') return loftInvalid(r, { offset: d })
      rs.push(r)
    }
    // the vertical top repeats the face level's rings: checked once
    if (lv.rho !== checked) {
      const ok = sameAsPort(path, rs, d, ctx.region2d)
      if (ok !== undefined) return loftInvalid(ok, { offset: d })
      checked = lv.rho
    }
    rings.push(rs)
  }
  return loftMesh(rings, levels, label, ctx.triangulate)
}

/** Undefined when the rings match the port's offset (loop count; area within the chord band). */
function sameAsPort(
  path: Region,
  rings: readonly Vec2[][],
  d: number,
  port: Region2dPort,
): string | undefined {
  const ref = port.offset(path, d)
  if (ref.isErr()) return 'the 2D offset failed'
  const region = ref.unwrap()
  if (regionLoops(region).length !== rings.length) return 'the loop count changes'
  const area = rings.reduce((s, r) => s + ringArea(r), 0)
  const perimeter = rings.reduce(
    (s, r) => s + r.reduce((q, p, i) => q + dist(p, r[(i + 1) % r.length]!), 0),
    0,
  )
  return Math.abs(area - regionArea(region)) > perimeter * CHORD_TOLERANCE * 1.5 + 1e-6
    ? 'the offset area differs from the 2D offset'
    : undefined
}

function loftMesh(
  rings: readonly Vec2[][][],
  levels: readonly LoftLevel[],
  label: number,
  triangulate: Triangulate,
): AppResult<LabelledMesh> {
  const counts = rings[0]!.map((r) => r.length)
  const perLevel = counts.reduce((a, b) => a + b, 0)
  const positions = new Float64Array(levels.length * perLevel * 3)
  let v = 0
  for (const [k, rs] of rings.entries())
    for (const r of rs)
      for (const p of r) {
        positions[v++] = p[0]
        positions[v++] = p[1]
        positions[v++] = levels[k]!.z
      }
  const tris: number[] = []
  const starts = counts.map((_, l) => counts.slice(0, l).reduce((a, b) => a + b, 0))
  for (let k = 0; k + 1 < levels.length; k++)
    for (const [l, n] of counts.entries()) {
      const b0 = k * perLevel + starts[l]!
      const b1 = (k + 1) * perLevel + starts[l]!
      for (let i = 0; i < n; i++) {
        const i1 = (i + 1) % n
        // rings run with their region on the left: band faces point out of it
        tris.push(b0 + i, b0 + i1, b1 + i1, b0 + i, b1 + i1, b1 + i)
      }
    }
  const bottom = triangulate(rings[0]!)
  if (bottom.isErr()) return bottom
  const top = triangulate(rings.at(-1)!)
  if (top.isErr()) return top
  const capB = bottom.unwrap()
  for (let t = 0; t < capB.length; t += 3) tris.push(capB[t]!, capB[t + 2]!, capB[t + 1]!)
  const topBase = (levels.length - 1) * perLevel
  const capT = top.unwrap()
  for (let t = 0; t < capT.length; t += 3)
    tris.push(topBase + capT[t]!, topBase + capT[t + 1]!, topBase + capT[t + 2]!)
  // collapsed arcs give coincident points (distinct vertices): their degenerate band triangles
  // keep the mesh closed and the kernel drops them, as in spike S7
  const bandCount = (tris.length - capB.length - capT.length) / 3
  const faces = new Uint32Array(tris.length / 3)
  faces.fill(label, 0, bandCount)
  return Ok({ positions, triangles: Uint32Array.from(tris), faces })
}

// ── the analytic offset of one loop (spike S7 `loft.ts`) ────────────────────────────────────

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]]
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k]
const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0]
const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1]
const len = (a: Vec2): number => Math.hypot(a[0], a[1])
const dist = (a: Vec2, b: Vec2): number => len(sub(a, b))
const unit = (a: Vec2): Vec2 => mul(a, 1 / len(a))
const left = (t: Vec2): Vec2 => [-t[1], t[0]]
const angleOf = (c: Vec2, p: Vec2): number => Math.atan2(p[1] - c[1], p[0] - c[0])

type Arc = Extract<Element, { kind: 'arc' }>

function tangent(e: Element, end: 'a' | 'b'): Vec2 {
  if (e.kind === 'line') return unit(sub(e.b, e.a))
  const n = unit(sub(e[end], e.centre))
  return e.ccw ? left(n) : mul(left(n), -1)
}

function sweepOfArc(e: Arc): number {
  if (dist(e.a, e.b) < 1e-12) return 2 * Math.PI
  let d = e.ccw
    ? angleOf(e.centre, e.b) - angleOf(e.centre, e.a)
    : angleOf(e.centre, e.a) - angleOf(e.centre, e.b)
  while (d <= 0) d += 2 * Math.PI
  return d
}

/** An element's parallel at signed distance d to its left, as a full line or circle. */
interface Parallel {
  readonly kind: 'line' | 'arc'
  /** Line: a point and the direction. */
  readonly p: Vec2
  readonly t: Vec2
  /** Arc: centre, radius, sense. */
  readonly c: Vec2
  readonly r: number
  readonly ccw: boolean
  /** Its start and end point, trimmed at the joints. */
  s: Vec2
  e: Vec2
}

function parallel(e: Element, d: number): Parallel | undefined {
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
  const R = dist(e.a, e.centre)
  // the centre is on the left of a counter-clockwise arc: moving left shrinks it
  const r = e.ccw ? R - d : R + d
  if (!(r > 1e-9)) return undefined
  const at = (p: Vec2): Vec2 => add(e.centre, mul(unit(sub(p, e.centre)), r))
  return { kind: 'arc', p: [0, 0], t: [0, 0], c: e.centre, r, ccw: e.ccw, s: at(e.a), e: at(e.b) }
}

function intersections(u: Parallel, v: Parallel): Vec2[] {
  if (u.kind === 'line' && v.kind === 'line') {
    const den = cross(u.t, v.t)
    if (Math.abs(den) < 1e-15) return []
    return [add(u.p, mul(u.t, cross(sub(v.p, u.p), v.t) / den))]
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
  const dv = sub(v.c, u.c)
  const D = len(dv)
  if (D < 1e-15 || D > u.r + v.r || D < Math.abs(u.r - v.r)) return []
  const a = (u.r * u.r - v.r * v.r + D * D) / (2 * D)
  const h = Math.sqrt(Math.max(0, u.r * u.r - a * a))
  const m = add(u.c, mul(dv, a / D))
  const n = mul(left(unit(dv)), h)
  return [add(m, n), sub(m, n)]
}

/**
 * Point counts fixed for every level of one loop: per element (arc segments) and per joint
 * (0 = trimmed, −1 = tangent, else joint arc segments).
 */
interface RingPlan {
  readonly elementSegs: readonly number[]
  readonly jointSegs: readonly number[]
}

function planFor(loop: Loop, dMax: number, tol: number): RingPlan {
  const els = loop.elements
  const segs = (r: number, sweep: number) =>
    Math.max(1, Math.ceil(sweep / (2 * Math.acos(Math.max(-1, 1 - tol / Math.max(r, tol))))))
  const elementSegs = els.map((e) =>
    e.kind === 'line' ? 1 : segs(dist(e.a, e.centre) + Math.abs(dMax), sweepOfArc(e)),
  )
  const jointSegs = els.map((e, i) => {
    const t1 = tangent(e, 'b')
    const t2 = tangent(els[(i + 1) % els.length]!, 'a')
    const c = cross(t1, t2)
    if (Math.abs(c) < 1e-6 && dot(t1, t2) > 0) return -1
    // a left turn opens a gap when moving right (d < 0), a right turn when moving left
    const gap = dMax < 0 ? c > 0 : c < 0
    if (!gap) return 0
    return segs(Math.abs(dMax), Math.abs(Math.atan2(c, dot(t1, t2))))
  })
  return { elementSegs, jointSegs }
}

/** The loop's analytic offset by `d` (left) as points, or why it is not valid. */
function offsetRing(loop: Loop, d: number, plan: RingPlan): Vec2[] | string {
  const els = loop.elements
  const n = els.length
  const pars = els.map((e) => parallel(e, d))
  const alive = pars.map((p) => p !== undefined)
  if (!alive.some(Boolean)) return 'every element collapsed'
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
    if (between.length === 0 && (plan.jointSegs[i] === -1 || dist(u.e, v.s) < 1e-7)) {
      const m = mul(add(u.e, v.s), 0.5)
      u.e = m
      v.s = m
      continue
    }
    if (
      between.some((k) => plan.jointSegs[k]! > 0) ||
      (between.length > 0 && plan.jointSegs[i]! > 0)
    )
      return 'a collapsed arc next to a joint arc'
    const xs = intersections(u, v)
    if (xs.length === 0) return `no trim point at joint ${i}`
    let best = xs[0]!
    for (const x of xs) if (dist(x, V) < dist(best, V)) best = x
    u.e = best
    v.s = best
    for (const k of between) collapsedAt.set(k, best)
  }
  const out: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const e = els[i]!
    if (!alive[i]) {
      const p = collapsedAt.get(i)
      if (p === undefined) return `arc ${i} collapsed without a trim point`
      for (let j = 0; j < plan.elementSegs[i]!; j++) out.push(p)
      continue
    }
    const u = pars[i]!
    if (u.kind === 'line') {
      // the trimmed line keeps its direction, else the element vanished
      if (dot(sub(u.e, u.s), u.t) <= 1e-9) return `line ${i} vanished`
      out.push(u.s)
    } else {
      const a0 = angleOf(u.c, u.s)
      let sw = u.ccw ? angleOf(u.c, u.e) - a0 : a0 - angleOf(u.c, u.e)
      const full = sweepOfArc(e as Arc)
      while (sw <= -Math.PI) sw += 2 * Math.PI
      while (sw > 2 * Math.PI) sw -= 2 * Math.PI
      if (full >= 2 * Math.PI - 1e-12 && dist(u.s, u.e) < 1e-9) sw = 2 * Math.PI
      else if (sw <= 0) {
        if (full > Math.PI) sw += 2 * Math.PI
        else return `arc ${i} vanished`
      }
      if (Math.abs(sw - full) > Math.PI) return `arc ${i} flipped`
      const k = plan.elementSegs[i]!
      for (let j = 0; j < k; j++) {
        const t = a0 + ((u.ccw ? 1 : -1) * (sw * j)) / k
        out.push([u.c[0] + u.r * Math.cos(t), u.c[1] + u.r * Math.sin(t)])
      }
    }
    const m = plan.jointSegs[i]!
    if (m > 0) {
      // the joint arc round the vertex from this parallel's end to the next one's start
      const V = e.b
      const v = pars[(i + 1) % n]
      if (v === undefined) return 'a joint arc before a collapsed arc'
      const a0 = angleOf(V, u.e)
      let sw = angleOf(V, v.s) - a0
      if (d < 0) while (sw < 0) sw += 2 * Math.PI
      else while (sw > 0) sw -= 2 * Math.PI
      for (let j = 0; j < m; j++) {
        const t = a0 + (sw * j) / m
        out.push([V[0] + Math.abs(d) * Math.cos(t), V[1] + Math.abs(d) * Math.sin(t)])
      }
    }
  }
  return out
}

function ringArea(r: readonly Vec2[]): number {
  let s = 0
  for (let i = 0; i < r.length; i++) s += cross(r[i]!, r[(i + 1) % r.length]!)
  return s / 2
}

// ── fallback: the tool swept along each chord ───────────────────────────────────────────────

/**
 * Per chord a→b of P (flattened within the chord tolerance, into the air): the tool swept along
 * it, a stadium of length |ab| + 2ρ and width 2ρ lofted from ρ at the bottom to the face and on
 * vertically to the overshoot, turned along ab. Each is one labelled mesh; the evaluation unions
 * an operation's removal meshes in the kernel.
 */
function sweptChords(s: ChamferSweep, label: number): AppResult<LabelledMesh[]> {
  const top = Math.max(OVERSHOOT, s.faceZ + OVERSHOOT)
  const out: LabelledMesh[] = []
  for (const loop of regionLoops(s.path)) {
    const { points } = flattenLoop(loop, 'shrink')
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!
      const b = points[(i + 1) % points.length]!
      const L = dist(a, b)
      if (L <= EPSILON) continue
      const mesh = offsetLoft(
        {
          kind: 'rectangle',
          length: L + 2 * s.faceRho,
          width: 2 * s.faceRho,
          cornerRadius: s.faceRho,
        },
        [
          { offset: 0, z: top },
          { offset: 0, z: s.faceZ },
          { offset: s.faceRho - s.bottom.rho, z: s.bottom.z },
        ],
        { band: () => label, top: AIR, bottom: AIR },
      )
      if (mesh.isErr()) return Err(mesh.unwrapErr())
      out.push(placeChord(mesh.unwrap(), a, b))
    }
  }
  return Ok(out)
}

/** A mesh built along +x about the origin, turned along a→b and moved to its middle. */
function placeChord(mesh: LabelledMesh, a: Vec2, b: Vec2): LabelledMesh {
  const t = unit(sub(b, a))
  const m = mul(add(a, b), 0.5)
  const p = Float64Array.from(mesh.positions)
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!
    const y = p[i + 1]!
    p[i] = m[0] + x * t[0] - y * t[1]
    p[i + 1] = m[1] + x * t[1] + y * t[0]
  }
  return { ...mesh, positions: p }
}
