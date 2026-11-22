// Spike S4 (docs/research/s4-offset-clearing.md): coverage by the toolpath heightmap oracle of
// src/core/toolpath/testing/oracles.ts (the same `Heightmap.sweep` the v0.1 generators are tested
// with). Every cell centre of the region is classified:
// - reachable: within R − tol of the tool-centre region C0 = offset(region, R) (the morphological
//   opening, eroded by the tolerance); must be cut to the floor, else it is **leftover**;
// - rest: the rest of the region (corners and necks the tool cannot reach); must stay;
// - outside the region (stock outside the pocket, islands): cut deeper than the tolerance beyond
//   the boundary is a **gouge**.

import { flatten, segments, type Loop, type Pt } from '../2d/geom.ts'
import type { Toolpath, ToolpathTool } from '../../src/core/toolpath/model.ts'
import { Heightmap } from '../../src/core/toolpath/testing/oracles.ts'
import { distToLoops, insidePoly, poly } from './loops.ts'

export interface Coverage {
  /** Cells that should be cut to the floor but are not (mm²). */
  leftover: number
  /** Largest leftover cluster's cell count (a coarse size of the biggest cusp). */
  leftoverCells: number
  /** Region not reachable by the tool, uncut as it must be (mm²). */
  rest: number
  /** Cells cut beyond tol outside the region (mm²). */
  gouge: number
  ms: number
}

/** Row intervals inside the region (even-odd over all loops), at height y. */
function rowSpans(polys: readonly Pt[][], y: number): number[] {
  const xs: number[] = []
  for (const pts of polys)
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i]!
      const b = pts[j]!
      if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y))
    }
  return xs.sort((p, q) => p - q)
}

function inSpans(xs: readonly number[], x: number): boolean {
  let n = 0
  for (const v of xs) if (v < x) n++
  return n % 2 === 1
}

export function coverage(
  region: readonly Loop[],
  c0: readonly Loop[],
  tp: Toolpath,
  tool: ToolpathTool,
  size: { length: number; width: number },
  z: number,
  cell = 0.1,
  tol = 0.01,
): Coverage {
  const t0 = performance.now()
  const hm = new Heightmap(size.length, size.width, cell)
  hm.sweep(tool, tp, cell)
  const regionPolys = region.map((l) => flatten(l, 0.001))
  const c0Polys = c0.map(poly)
  const R = tool.diameter / 2
  const inC0 = (p: Pt) => {
    let n = 0
    for (const pts of c0Polys) if (insidePoly(pts, p)) n++
    return n % 2 === 1
  }
  const cellA = cell * cell
  let leftover = 0
  let rest = 0
  let gouge = 0
  const left = new Uint8Array(hm.nx * hm.ny)
  for (let j = 0; j < hm.ny; j++) {
    const y = (j + 0.5) * cell
    const spans = rowSpans(regionPolys, y)
    for (let i = 0; i < hm.nx; i++) {
      const k = j * hm.nx + i
      const h = hm.z[k]!
      const p = { x: (i + 0.5) * cell, y }
      const inside = inSpans(spans, p.x)
      if (inside) {
        if (h <= z + 1e-6) continue
        const d = inC0(p) ? 0 : distToLoops(c0, p)
        if (d <= R - tol) {
          leftover += cellA
          left[k] = 1
        } else rest += cellA
      } else if (h < -1e-9 && distToLoops(region, p) > tol) gouge += cellA
    }
  }
  // largest 4-connected leftover cluster
  let biggest = 0
  const stack: number[] = []
  for (let k0 = 0; k0 < left.length; k0++) {
    if (left[k0] !== 1) continue
    let n = 0
    left[k0] = 2
    stack.push(k0)
    while (stack.length > 0) {
      const k = stack.pop()!
      n++
      const i = k % hm.nx
      for (const q of [k - 1, k + 1, k - hm.nx, k + hm.nx]) {
        if (q < 0 || q >= left.length || left[q] !== 1) continue
        if ((q === k - 1 && i === 0) || (q === k + 1 && i === hm.nx - 1)) continue
        left[q] = 2
        stack.push(q)
      }
    }
    biggest = Math.max(biggest, n)
  }
  return { leftover, leftoverCells: biggest, rest, gouge, ms: performance.now() - t0 }
}

/** Bounding box of loops (from their flattening). */
export function bbox(loops: readonly Loop[]) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const l of loops)
    for (const p of flatten(l, 0.01)) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  return { minX, minY, maxX, maxY }
}

export const segCountOf = (loops: readonly Loop[]) =>
  loops.reduce((s, l) => s + [...segments(l)].length, 0)
