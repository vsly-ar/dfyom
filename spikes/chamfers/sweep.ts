/**
 * Spike S7: the removal solid of an edge chamfer along a general closed loop, built as the swept
 * volume of the V-bit along its toolpath (the edge loop offset into the air by the tip radius),
 * plus the oracles. Report: docs/research/2026-11-25-spike-s7-edge-chamfers.md. Throwaway code.
 *
 * Swept volume of a tool of revolution moving at constant Z along lines and arcs:
 * - line a→b: hull(tool at a, tool at b) (both convex, so the hull is the exact sweep);
 * - arc around c of radius R: the tool's half profile at distance R from the axis, revolved over
 *   the arc's sweep (Manifold `revolve` keeps only x ≥ 0, so R < ρ(z) is exact too), plus the
 *   tool at each end where the neighbour is not a line (a line's hull already holds its ends);
 * - union of all pieces (Manifold batch union).
 */
import Module, {
  type CrossSection,
  type Manifold,
  type ManifoldToplevel,
} from 'manifold-3d/manifold.js'
import type { Vec2 } from '../../src/core/geometry/model'
import {
  regionArea,
  regionLoops,
  type Element,
  type Loop,
  type Region,
} from '../../src/core/geometry/2d/model'
import type { Region2dPort } from '../../src/core/geometry/2d/port'

export type Wasm = ManifoldToplevel

export async function loadWasm(): Promise<Wasm> {
  const wasm = await (Module as () => Promise<ManifoldToplevel>)()
  wasm.setup()
  return wasm
}

/** A V-bit / chamfer mill: included angle (deg), tip diameter (mm). */
export interface VTool {
  readonly angle: number
  readonly tip: number
}

export interface ChamferSpec {
  /** Bevel width at the face (mm). */
  readonly width: number
  readonly tool: VTool
  /** Face Z (the edge's `on`). */
  readonly face: number
  /** Overshoot above the face (mm). */
  readonly overshoot: number
  /** Extra run past the edge into the air (geometry only, no film): the C2 rule, 0.04 mm. */
  readonly run: number
  /** Chord tolerance (mm). */
  readonly tolerance: number
}

export const tanHalf = (t: VTool): number => Math.tan(((t.angle / 2) * Math.PI) / 180)
export const depthOf = (s: ChamferSpec): number => s.width / tanHalf(s.tool)

/** The geometry tool: tip at the chamfer depth + run / tan, axis on the path (offset e). */
export function geometryTool(s: ChamferSpec): {
  tipZ: number
  topZ: number
  r0: number
  rTop: number
  e: number
} {
  const tan = tanHalf(s.tool)
  const tipZ = s.face - depthOf(s) - s.run / tan
  const topZ = s.face + s.overshoot
  const r0 = s.tool.tip / 2
  return { tipZ, topZ, r0, rTop: r0 + (topZ - tipZ) * tan, e: r0 + s.run }
}

const segmentsFor = (radius: number, tol: number): number =>
  Math.max(8, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - tol / Math.max(radius, tol)))))

const angleOf = (c: Vec2, p: Vec2): number => Math.atan2(p[1] - c[1], p[0] - c[0])

function arcSweepRad(e: Extract<Element, { kind: 'arc' }>): number {
  const a0 = angleOf(e.centre, e.a)
  const a1 = angleOf(e.centre, e.b)
  const same = Math.hypot(e.a[0] - e.b[0], e.a[1] - e.b[1]) < 1e-12
  if (same) return 2 * Math.PI
  let d = e.ccw ? a1 - a0 : a0 - a1
  while (d <= 0) d += 2 * Math.PI
  return d
}

const tangentAt = (e: Element, end: 'a' | 'b'): Vec2 => {
  if (e.kind === 'line') {
    const l = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])
    return [(e.b[0] - e.a[0]) / l, (e.b[1] - e.a[1]) / l]
  }
  const p = e[end]
  const r = Math.hypot(p[0] - e.centre[0], p[1] - e.centre[1])
  const n: Vec2 = [(p[0] - e.centre[0]) / r, (p[1] - e.centre[1]) / r]
  return e.ccw ? [-n[1], n[0]] : [n[1], -n[0]]
}

export interface SweepStats {
  pieces: number
  build: number
  union: number
  triangles: number
}

/**
 * Swept tool along every loop of `path` (the toolpath: loops of lines and arcs at the tool
 * axis). Returns a raw Manifold (caller deletes).
 */
export function sweep(
  wasm: Wasm,
  path: readonly Loop[],
  s: ChamferSpec,
): {
  solid: Manifold
  meshes: { positions: Float64Array; triangles: Uint32Array }[]
  stats: SweepStats
} {
  const t0 = performance.now()
  const g = geometryTool(s)
  const H = g.topZ - g.tipZ
  // a multiple of 4, rotated per line so a vertex points along the line's normal: the hull of two
  // inscribed polygons then has the exact width (no chord loss across the bevel)
  const toolSegs = 4 * Math.ceil(segmentsFor(g.rTop, s.tolerance) / 4)
  const toolAt = (p: Vec2, turn = 0): Manifold => {
    const c = wasm.Manifold.cylinder(H, Math.max(g.r0, 1e-6), g.rTop, toolSegs)
    const r = c.rotate([0, 0, turn])
    const out = r.translate([p[0], p[1], g.tipZ])
    c.delete()
    r.delete()
    return out
  }
  const pieces: Manifold[] = []
  for (const loop of path) {
    const els = loop.elements
    for (let i = 0; i < els.length; i++) {
      const e = els[i]!
      if (e.kind === 'line') {
        const turn = (Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]) * 180) / Math.PI
        const a = toolAt(e.a, turn)
        const b = toolAt(e.b, turn)
        pieces.push(wasm.Manifold.hull([a, b]))
        a.delete()
        b.delete()
        continue
      }
      const R = Math.hypot(e.a[0] - e.centre[0], e.a[1] - e.centre[1])
      const sweepRad = arcSweepRad(e)
      const cs: CrossSection = new wasm.CrossSection([
        [
          [R - g.r0, g.tipZ],
          [R + g.r0, g.tipZ],
          [R + g.rTop, g.topZ],
          [R - g.rTop, g.topZ],
        ],
      ])
      const deg = (sweepRad * 180) / Math.PI
      // manifold-3d 3.5.4 `revolve` uses `circularSegments` slices for any sweep (not per 360°), and
      // fewer than 3 gave an empty solid for short arcs of large radius
      const slices = Math.max(3, Math.ceil((segmentsFor(R + g.rTop, s.tolerance) * deg) / 360))
      const rev = wasm.Manifold.revolve(cs, slices, deg)
      cs.delete()
      // revolve starts at +X and turns counter-clockwise: start at the ccw-first end
      const start = e.ccw ? angleOf(e.centre, e.a) : angleOf(e.centre, e.b)
      const rot = rev.rotate([0, 0, (start * 180) / Math.PI])
      rev.delete()
      pieces.push(rot.translate([e.centre[0], e.centre[1], 0]))
      rot.delete()
      if (sweepRad >= 2 * Math.PI - 1e-12) continue
      // tool at the arc's ends unless the neighbour is a line (its hull holds the end) or the
      // joint is tangent (the neighbour's revolve meets this one's end face exactly)
      const prev = els[(i - 1 + els.length) % els.length]!
      const next = els[(i + 1) % els.length]!
      const ta = tangentAt(e, 'a')
      const tb = tangentAt(e, 'b')
      const pa = tangentAt(prev, 'b')
      const nb = tangentAt(next, 'a')
      const kink = (u: Vec2, v: Vec2) =>
        u[0] * v[1] - u[1] * v[0] !== 0 && Math.abs(u[0] * v[1] - u[1] * v[0]) > 1e-9
      if (prev.kind !== 'line' && kink(pa, ta)) pieces.push(toolAt(e.a))
      if (next.kind !== 'line' && kink(tb, nb)) pieces.push(toolAt(e.b))
    }
  }
  const t1 = performance.now()
  const solid = wasm.Manifold.union(pieces)
  const triangles = solid.numTri() // forces the union
  const t2 = performance.now()
  // the pieces as plain meshes (float32 positions, as every mesh the app passes to the kernel)
  const meshes = pieces.map((p) => {
    const m = p.getMesh()
    return {
      positions: Float64Array.from(m.vertProperties),
      triangles: Uint32Array.from(m.triVerts),
    }
  })
  for (const p of pieces) p.delete()
  return {
    solid,
    meshes,
    stats: { pieces: pieces.length, build: t1 - t0, union: t2 - t1, triangles },
  }
}

/**
 * The toolpath: the edge loop offset into the air by the tip radius. `air` is the region on the
 * air side of the edge (a pocket's region; for an outside profile, the region's complement:
 * `grow` = true offsets the material region outward instead).
 */
export function chamferPath(
  port: Region2dPort,
  material: Region | undefined,
  air: Region | undefined,
  e: number,
): Loop[] {
  if (air !== undefined) return regionLoops(port.offset(air, e).unwrap())
  return regionLoops(port.offset(material!, -e).unwrap())
}

/**
 * Oracle: the removed area at depth t (below the face) as machined by the swept tool, from 2D
 * offsets only. Pocket (air region A): (A ⊖ e) ⊕ ρ(t) ∪ A minus A. Outside profile (material M):
 * M minus ((M ⊕ e) ⊖ ρ(t)). Same thing in both cases: the morphological opening of the air.
 */
export function removedArea(
  port: Region2dPort,
  material: Region | undefined,
  air: Region | undefined,
  e: number,
  rho: number,
): number {
  if (air !== undefined) {
    const path = port.offset(air, e).unwrap()
    if (path.pieces.length === 0) return 0
    const grown = port.offset(path, -rho).unwrap()
    return regionArea(port.union(grown, air).unwrap()) - regionArea(air)
  }
  const grownM = port.offset(material!, -e).unwrap()
  const shrunk = rho > 0 ? port.offset(grownM, rho).unwrap() : grownM
  const kept = port.intersect(shrunk, material!).unwrap()
  return regionArea(material!) - regionArea(kept)
}

/** Removed volume between the chamfer depth and the face by Simpson's rule on `removedArea`. */
export function removedVolume(
  port: Region2dPort,
  material: Region | undefined,
  air: Region | undefined,
  s: ChamferSpec,
  n = 24,
): number {
  const tan = tanHalf(s.tool)
  const h = depthOf(s)
  const e = s.tool.tip / 2
  // at depth t below the face the tool (tip at h) has radius r0 + (h − t)·tan
  const f = (t: number) => removedArea(port, material, air, e, e + (h - t) * tan)
  let sum = f(0) + f(h)
  for (let k = 1; k < n; k++) sum += (k % 2 === 1 ? 4 : 2) * f((k * h) / n)
  return (sum * h) / (3 * n)
}
