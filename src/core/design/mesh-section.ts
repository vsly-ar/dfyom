/**
 * Triangle-soup queries for the reference model (task U3), pure and synchronous: the **section**
 * of a mesh by a plane (the reference section the Shape Editor draws and snaps to) and its
 * **feature edges** (the ghost's crease lines, moved off the renderer thread).
 * Doc: docs/modes/design-v0.3.md#implementation-u3, docs/modes/reference-model.md#ghost-mesh-task-r3
 *
 * Both take the STL's positions as read (9 float32 per triangle, source units) and call
 * `steps.step()` every `STEP_TRIANGLES` triangles (workers.md: no step over 50 ms).
 */
import { Ok, type AppResult } from '../../shared/result'
import { noSteps, type Steps } from '../workers/steps'
import type { Box } from './stl'

/** Triangles between two `steps.step()` calls (≈ 25 ms each at most, measured on the enclosure ×20). */
export const STEP_TRIANGLES = 25_000

/**
 * The section of a mesh by the plane `w = level` after `matrix` (column-major 4 × 4, as three.js
 * `Matrix4.toArray`: source units → a frame whose third axis is the plane normal): line segments
 * `[u0, v0, u1, v1, …]` in that frame's first two axes. A vertex on the plane counts as above it,
 * so a face lying in the plane gives no segments but its border does (through its neighbours),
 * and no segment is reported twice.
 */
export function meshSection(
  positions: Float32Array,
  matrix: readonly number[],
  level: number,
  steps: Steps = noSteps,
): AppResult<Float32Array> {
  const m = matrix
  const out: number[] = []
  const n = Math.floor(positions.length / 9)
  const u = [0, 0, 0]
  const v = [0, 0, 0]
  const w = [0, 0, 0]
  for (let t = 0; t < n; t++) {
    if (t % STEP_TRIANGLES === 0 && t > 0) {
      const s = steps.step({ done: t, total: n, label: 'Reference section' })
      if (s.isErr()) return s
    }
    let above = 0
    for (let k = 0; k < 3; k++) {
      const o = 9 * t + 3 * k
      const x = positions[o]!
      const y = positions[o + 1]!
      const z = positions[o + 2]!
      u[k] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
      v[k] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
      w[k] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]! - level
      if (w[k]! >= 0) above++
    }
    if (above === 0 || above === 3) continue
    // the two edges whose ends lie on different sides
    let found = 0
    for (let k = 0; k < 3; k++) {
      const a = k
      const b = (k + 1) % 3
      if (w[a]! >= 0 === w[b]! >= 0) continue
      const f = w[a]! / (w[a]! - w[b]!)
      out.push(u[a]! + f * (u[b]! - u[a]!), v[a]! + f * (v[b]! - v[a]!))
      found++
    }
    if (found !== 2) out.length -= 2 * found
  }
  return Ok(Float32Array.from(out))
}

/** A chained section: vertices `[u0, v0, u1, v1, …]` in the frame; `closed` unless the mesh is open. */
export interface SectionChain {
  readonly points: Float64Array
  readonly closed: boolean
}

/**
 * The section of a mesh by the plane `w = level` after `matrix` (as `meshSection`) chained into
 * loops (DF60 P1, promoted from the test slicer `sliceMesh`): each crossing point is keyed by its
 * mesh edge (the two vertices as read), so neighbouring triangles share it exactly and loops
 * close without welding by distance. A chain that does not close (an open mesh) comes back with
 * `closed: false`. Directions are as found; the caller orients loops by nesting.
 * Doc: docs/modes/reference-tools.md#fitting
 */
export function sectionChains(
  positions: Float32Array,
  matrix: readonly number[],
  level: number,
  steps: Steps = noSteps,
): AppResult<SectionChain[]> {
  const m = matrix
  const n = Math.floor(positions.length / 9)
  const key = (o: number): string => `${positions[o]},${positions[o + 1]},${positions[o + 2]}`
  const points = new Map<string, [number, number]>()
  /** Edge key → the (up to two) edge keys it is joined to by a segment. */
  const links = new Map<string, string[]>()
  const link = (a: string, b: string) => {
    const la = links.get(a)
    if (la === undefined) links.set(a, [b])
    else la.push(b)
  }
  const u = [0, 0, 0]
  const v = [0, 0, 0]
  const w = [0, 0, 0]
  for (let t = 0; t < n; t++) {
    if (t % STEP_TRIANGLES === 0 && t > 0) {
      const s = steps.step({ done: t, total: n, label: 'Reference section' })
      if (s.isErr()) return s
    }
    let above = 0
    for (let k = 0; k < 3; k++) {
      const o = 9 * t + 3 * k
      const x = positions[o]!
      const y = positions[o + 1]!
      const z = positions[o + 2]!
      u[k] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
      v[k] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
      w[k] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]! - level
      if (w[k]! >= 0) above++
    }
    if (above === 0 || above === 3) continue
    const ends: string[] = []
    for (let k = 0; k < 3; k++) {
      const a = k
      const b = (k + 1) % 3
      if (w[a]! >= 0 === w[b]! >= 0) continue
      const ka = key(9 * t + 3 * a)
      const kb = key(9 * t + 3 * b)
      const edge = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
      if (!points.has(edge)) {
        const f = w[a]! / (w[a]! - w[b]!)
        points.set(edge, [u[a]! + f * (u[b]! - u[a]!), v[a]! + f * (v[b]! - v[a]!)])
      }
      ends.push(edge)
    }
    if (ends.length !== 2 || ends[0] === ends[1]) continue
    link(ends[0]!, ends[1]!)
    link(ends[1]!, ends[0]!)
  }
  const seen = new Set<string>()
  const chains: SectionChain[] = []
  const walk = (start: string, first: string | undefined): string[] => {
    const out = [start]
    seen.add(start)
    let prev = start
    let cur = first
    while (cur !== undefined && !seen.has(cur)) {
      out.push(cur)
      seen.add(cur)
      const next: string | undefined = (links.get(cur) ?? []).find(
        (x) => x !== prev && !seen.has(x),
      )
      prev = cur
      cur = next
    }
    return out
  }
  // open chains first, from their ends (an edge key with one link)
  for (const [k, l] of links)
    if (!seen.has(k) && l.length === 1) {
      const keys = walk(k, l[0])
      chains.push({ points: flat(keys, points), closed: false })
    }
  for (const [k, l] of links) {
    if (seen.has(k)) continue
    const keys = walk(k, l[0])
    const last = keys[keys.length - 1]!
    const closed = keys.length > 2 && (links.get(last) ?? []).includes(k)
    chains.push({ points: flat(keys, points), closed })
  }
  return Ok(chains)
}

function flat(keys: readonly string[], points: Map<string, [number, number]>): Float64Array {
  const out = new Float64Array(keys.length * 2)
  keys.forEach((k, i) => {
    const p = points.get(k)!
    out[2 * i] = p[0]
    out[2 * i + 1] = p[1]
  })
  return out
}

/**
 * The axis-aligned box (mm) of a triangle soup after `matrix` (column-major 4 × 4, source units →
 * the part frame, the ghost's matrix): the reference's exact extent, where the placed box is
 * larger for free angles (DF4's facing depth). Undefined for an empty mesh. One pass, no steps:
 * ~10 ms per million vertices.
 * Doc: docs/modes/reference-model.md#facing-depth-from-the-reference-df4
 */
export function meshBounds(positions: Float32Array, matrix: readonly number[]): Box | undefined {
  const m = matrix
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  const count = Math.floor(positions.length / 3)
  for (let i = 0; i < count; i++) {
    const x = positions[3 * i]!
    const y = positions[3 * i + 1]!
    const z = positions[3 * i + 2]!
    for (let r = 0; r < 3; r++) {
      const v = m[r]! * x + m[4 + r]! * y + m[8 + r]! * z + m[12 + r]!
      if (v < lo[r]!) lo[r] = v
      if (v > hi[r]!) hi[r] = v
    }
  }
  if (count === 0) return undefined
  return { min: { x: lo[0]!, y: lo[1]!, z: lo[2]! }, max: { x: hi[0]!, y: hi[1]!, z: hi[2]! } }
}

/** Faces meeting at a smaller angle than this are smooth (as the part mesh, viewport/mesh.ts). */
export const FEATURE_EDGE_DEG = 30

/** Vertices closer than this (source units, per coordinate) are one (three's `EdgesGeometry`). */
const WELD = 1e-4

/**
 * The feature edges of a triangle soup, as three.js `EdgesGeometry(geometry, angle)` finds them:
 * an edge shared by two faces whose normals differ by at least `angleDeg`, or used by one face
 * only (an open border). Degenerate faces are skipped. Segments `[x0, y0, z0, x1, y1, z1, …]` in
 * source units.
 */
export function featureEdges(
  positions: Float32Array,
  angleDeg = FEATURE_EDGE_DEG,
  steps: Steps = noSteps,
): AppResult<Float32Array> {
  const n = Math.floor(positions.length / 9)
  const threshold = Math.cos((angleDeg * Math.PI) / 180)
  const ids = new Map<string, number>()
  const vertexOf = (o: number): number => {
    const key = `${Math.round(positions[o]! / WELD)},${Math.round(positions[o + 1]! / WELD)},${Math.round(positions[o + 2]! / WELD)}`
    let id = ids.get(key)
    if (id === undefined) {
      id = ids.size
      ids.set(key, id)
    }
    return id
  }
  // edge (lower id, higher id) → first face's normal index and its start offset, until matched
  const open = new Map<number, { face: number; a: number; b: number }>()
  const normals = new Float64Array(n * 3)
  const out: number[] = []
  const tri = [0, 0, 0]
  const push = (oa: number, ob: number) => {
    out.push(
      positions[oa]!,
      positions[oa + 1]!,
      positions[oa + 2]!,
      positions[ob]!,
      positions[ob + 1]!,
      positions[ob + 2]!,
    )
  }
  const SCALE = 2 ** 26 // vertex ids stay below this, so the pair fits a double exactly
  for (let t = 0; t < n; t++) {
    if (t % STEP_TRIANGLES === 0 && t > 0) {
      const s = steps.step({ done: t, total: n, label: 'Reference edges' })
      if (s.isErr()) return s
    }
    const o = 9 * t
    for (let k = 0; k < 3; k++) tri[k] = vertexOf(o + 3 * k)
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue
    const ax = positions[o + 3]! - positions[o]!
    const ay = positions[o + 4]! - positions[o + 1]!
    const az = positions[o + 5]! - positions[o + 2]!
    const bx = positions[o + 6]! - positions[o]!
    const by = positions[o + 7]! - positions[o + 1]!
    const bz = positions[o + 8]! - positions[o + 2]!
    const nx = ay * bz - az * by
    const ny = az * bx - ax * bz
    const nz = ax * by - ay * bx
    const len = Math.hypot(nx, ny, nz)
    if (len === 0) continue
    normals[3 * t] = nx / len
    normals[3 * t + 1] = ny / len
    normals[3 * t + 2] = nz / len
    for (let k = 0; k < 3; k++) {
      const i = tri[k]!
      const j = tri[(k + 1) % 3]!
      const key = i < j ? i * SCALE + j : j * SCALE + i
      const prev = open.get(key)
      if (prev === undefined) {
        open.set(key, { face: t, a: o + 3 * k, b: o + 3 * ((k + 1) % 3) })
        continue
      }
      open.delete(key)
      const f = 3 * prev.face
      const dot =
        normals[f]! * normals[3 * t]! +
        normals[f + 1]! * normals[3 * t + 1]! +
        normals[f + 2]! * normals[3 * t + 2]!
      if (dot <= threshold) push(prev.a, prev.b)
    }
  }
  // edges used by one face only: open borders
  for (const e of open.values()) push(e.a, e.b)
  return Ok(Float32Array.from(out))
}
