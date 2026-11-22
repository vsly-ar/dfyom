// Spike S1 (docs/decisions/0019-2d-geometry-library.md): the three candidates behind one interface.
// Convention (as in CavalierContours): outer loops counter-clockwise, islands clockwise; a positive
// offset shrinks the region (tool centre region of a pocket), a negative one grows it.

import { Polyline, Shape } from 'cavalier-contours-js'
import {
  EndType,
  FillRule,
  JoinType,
  differenceD,
  inflatePathsD,
  unionD,
  type PathsD,
} from 'clipper2-ts'
import { area, flatten, reverse, type Loop, type Vertex } from './geom.ts'
import { refit } from './refit.ts'

export interface Candidate {
  readonly name: string
  /** Region (outer + islands) offset; positive shrinks. */
  offset(region: readonly Loop[], d: number): Loop[]
  /** Boolean of two closed counter-clockwise loops. */
  union(a: Loop, b: Loop): Loop[]
  difference(a: Loop, b: Loop): Loop[]
}

// --- CavalierContours, TypeScript port ------------------------------------------------------

const toPline = (l: Loop): Polyline => {
  const p = Polyline.withCapacity(l.verts.length, l.closed)
  for (const v of l.verts) p.add(v[0], v[1], v[2])
  return p
}
const fromPline = (p: Polyline): Loop => {
  const verts: Vertex[] = []
  for (let i = 0; i < p.vertexCount; i++) {
    const v = p.at(i)
    verts.push([v.x, v.y, v.bulge])
  }
  return { closed: p.isClosed, verts }
}

/** Boolean results come in arbitrary orientation: filled loops counter-clockwise, holes clockwise. */
const orient = (l: Loop, hole: boolean): Loop => (area(l) > 0 === !hole ? l : reverse(l))

export const cavalierJs: Candidate = {
  name: 'cavalier-contours-js 0.1.1',
  offset(region, d) {
    const res = Shape.fromPlines(region.map(toPline)).parallelOffset(d)
    return [...res.ccwPlines, ...res.cwPlines].map((ip) => fromPline(ip.polyline))
  },
  union(a, b) {
    const r = toPline(a).boolean(toPline(b), 'or')
    return [
      ...r.posPlines.map((p) => orient(fromPline(p.pline), false)),
      ...r.negPlines.map((p) => orient(fromPline(p.pline), true)),
    ]
  },
  difference(a, b) {
    const r = toPline(a).boolean(toPline(b), 'not')
    return [
      ...r.posPlines.map((p) => orient(fromPline(p.pline), false)),
      ...r.negPlines.map((p) => orient(fromPline(p.pline), true)),
    ]
  },
}

// --- CavalierContours, Rust crate 0.9.0 as WASM (cc-wasm/) ----------------------------------

interface CcExports {
  memory: { buffer: ArrayBuffer }
  buf_alloc(len: number): number
  buf_free(ptr: number, len: number): void
  result_ptr(): number
  shape_offset(ptr: number, len: number, offset: number): number
  pline_boolean(ptr: number, len: number, op: number): number
}

function encode(loops: readonly Loop[]): Float64Array {
  let len = 1
  for (const l of loops) len += 2 + 3 * l.verts.length
  const a = new Float64Array(len)
  a[0] = loops.length
  let i = 1
  for (const l of loops) {
    a[i++] = l.closed ? 1 : 0
    a[i++] = l.verts.length
    for (const v of l.verts) {
      a[i++] = v[0]
      a[i++] = v[1]
      a[i++] = v[2]
    }
  }
  return a
}

function decode(a: Float64Array, orientBool: boolean): Loop[] {
  const out: Loop[] = []
  let i = 1
  for (let k = 0; k < a[0]!; k++) {
    const flags = a[i++]!
    const n = a[i++]!
    const verts: Vertex[] = []
    for (let j = 0; j < n; j++, i += 3) verts.push([a[i]!, a[i + 1]!, a[i + 2]!])
    const l = { closed: (flags & 1) === 1, verts }
    out.push(orientBool ? orient(l, (flags & 2) === 2) : l)
  }
  return out
}

/** Instantiate from bytes: the host reads the file, as for manifold.wasm (src/core has no fs). */
export async function cavalierWasm(bytes: Uint8Array): Promise<Candidate> {
  // ES2023 lib without DOM has no WebAssembly typings (as in src/core); type the one call used
  const wasmApi = (
    globalThis as unknown as {
      WebAssembly: {
        instantiate(b: Uint8Array, i: object): Promise<{ instance: { exports: unknown } }>
      }
    }
  ).WebAssembly
  const { instance } = await wasmApi.instantiate(bytes, {})
  const x = instance.exports as unknown as CcExports
  const call = (
    loops: readonly Loop[],
    f: (ptr: number, len: number) => number,
    bool = true,
  ): Loop[] => {
    const data = encode(loops)
    const ptr = x.buf_alloc(data.length)
    new Float64Array(x.memory.buffer, ptr, data.length).set(data)
    const outLen = f(ptr, data.length)
    x.buf_free(ptr, data.length)
    return decode(new Float64Array(x.memory.buffer, x.result_ptr(), outLen), bool)
  }
  return {
    name: 'cavalier_contours 0.9.0 (WASM)',
    offset: (region, d) => call(region, (p, l) => x.shape_offset(p, l, d), false),
    union: (a, b) => call([a, b], (p, l) => x.pline_boolean(p, l, 0)),
    difference: (a, b) => call([a, b], (p, l) => x.pline_boolean(p, l, 2)),
  }
}

// --- Clipper2 (clipper2-ts), polygons + arc re-fitting ----------------------------------------

/** Chord tolerance split: flattening input, Clipper's round joins and re-fitting each get 1/3 of 0.01 mm. */
const TOL = 0.01 / 3
const PRECISION = 4 // decimal places: 0.1 µm grid

const toPaths = (loops: readonly Loop[]): PathsD => loops.map((l) => flatten(l, TOL))

export function clipper(refitOutput: boolean): Candidate {
  const out = (paths: PathsD): Loop[] =>
    paths.map((p) =>
      refitOutput ? refit(p, TOL) : { closed: true, verts: p.map((q) => [q.x, q.y, 0] as const) },
    )
  return {
    name: refitOutput ? 'clipper2-ts 2.0.1-19 + re-fit' : 'clipper2-ts 2.0.1-19 (polygons)',
    offset: (region, d) =>
      out(inflatePathsD(toPaths(region), -d, JoinType.Round, EndType.Polygon, 2, PRECISION, TOL)),
    union: (a, b) => out(unionD(toPaths([a]), toPaths([b]), FillRule.NonZero, PRECISION)),
    difference: (a, b) => out(differenceD(toPaths([a]), toPaths([b]), FillRule.NonZero, PRECISION)),
  }
}

/**
 * Pocket rings with Clipper: each ring is the *original* region offset by the cumulative distance
 * (exact, since eroding by a then b equals eroding by a + b). Offsetting the previous polygon ring
 * instead adds round-join points at every flattened vertex each step: measured 42 394 segments and
 * 2.7 s after 20 rings of a 52-segment star (ADR 0019), so `iterative` exists only to show that.
 */
export function clipperRings(
  region: readonly Loop[],
  first: number,
  step: number,
  count: number,
  refitOutput: boolean,
  iterative = false,
): Loop[][] {
  const rings: Loop[][] = []
  const base = toPaths(region)
  let paths = base
  for (let k = 0; k < count; k++) {
    paths = iterative
      ? inflatePathsD(
          paths,
          -(k === 0 ? first : step),
          JoinType.Round,
          EndType.Polygon,
          2,
          PRECISION,
          TOL,
        )
      : inflatePathsD(base, -(first + k * step), JoinType.Round, EndType.Polygon, 2, PRECISION, TOL)
    if (paths.length === 0) break
    rings.push(
      paths.map((p) =>
        refitOutput ? refit(p, TOL) : { closed: true, verts: p.map((q) => [q.x, q.y, 0] as const) },
      ),
    )
  }
  return rings
}
