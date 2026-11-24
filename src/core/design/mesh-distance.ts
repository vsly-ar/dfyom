/**
 * Closest-point distances to a triangle mesh (DF60 P4): a bounding volume hierarchy over the
 * triangles and the distance from a point to the nearest one, for compare's `maxDev` (the largest
 * distance of a missing or extra piece's vertices to the other surface). Pure and headless; the
 * signed distance per vertex for the overlay comes with P5.
 * Doc: docs/modes/reference-tools.md#method-rt-f
 */

/** Triangles per leaf. */
const LEAF = 8

/**
 * A static BVH over `count` triangles: corner `k` of triangle `t` is vertex `indices[3t + k]` of
 * `positions` (x, y, z per vertex), or vertex `3t + k` without `indices` (a triangle soup).
 */
export class MeshBvh {
  /** Per node: min x, y, z, max x, y, z. */
  private readonly boxes: Float64Array
  /** Per node: first child (inner) or first triangle in `order` (leaf). */
  private readonly first: Int32Array
  /** Per node: 0 for an inner node (children `first`, `first + 1`), else the leaf's triangle count. */
  private readonly count: Int32Array
  /** Triangle ids in leaf order. */
  private readonly order: Int32Array
  /** Corner coordinates per triangle (9 float64 each), in triangle order. */
  private readonly corners: Float64Array
  readonly triangles: number

  constructor(positions: ArrayLike<number>, indices?: ArrayLike<number>) {
    const n = indices === undefined ? positions.length / 9 : indices.length / 3
    this.triangles = n
    const corners = new Float64Array(n * 9)
    for (let t = 0; t < n; t++)
      for (let k = 0; k < 3; k++) {
        const v = indices === undefined ? 3 * t + k : indices[3 * t + k]!
        corners[9 * t + 3 * k] = positions[3 * v]!
        corners[9 * t + 3 * k + 1] = positions[3 * v + 1]!
        corners[9 * t + 3 * k + 2] = positions[3 * v + 2]!
      }
    this.corners = corners
    const centre = new Float64Array(n * 3)
    for (let t = 0; t < n; t++)
      for (let a = 0; a < 3; a++)
        centre[3 * t + a] =
          (corners[9 * t + a]! + corners[9 * t + 3 + a]! + corners[9 * t + 6 + a]!) / 3
    const order = new Int32Array(n)
    for (let t = 0; t < n; t++) order[t] = t
    const maxNodes = Math.max(1, 2 * Math.ceil(n / LEAF) * 2)
    const boxes = new Float64Array(maxNodes * 6)
    const first = new Int32Array(maxNodes)
    const count = new Int32Array(maxNodes)
    let nodes = 1
    // iterative build: [node, start, end]
    const stack: number[] = [0, 0, n]
    while (stack.length > 0) {
      const end = stack.pop()!
      const start = stack.pop()!
      const node = stack.pop()!
      let lo0 = Infinity,
        lo1 = Infinity,
        lo2 = Infinity,
        hi0 = -Infinity,
        hi1 = -Infinity,
        hi2 = -Infinity
      let c0 = Infinity,
        c1 = Infinity,
        c2 = Infinity,
        d0 = -Infinity,
        d1 = -Infinity,
        d2 = -Infinity
      for (let i = start; i < end; i++) {
        const t = order[i]!
        for (let k = 0; k < 3; k++) {
          const x = corners[9 * t + 3 * k]!,
            y = corners[9 * t + 3 * k + 1]!,
            z = corners[9 * t + 3 * k + 2]!
          if (x < lo0) lo0 = x
          if (y < lo1) lo1 = y
          if (z < lo2) lo2 = z
          if (x > hi0) hi0 = x
          if (y > hi1) hi1 = y
          if (z > hi2) hi2 = z
        }
        const x = centre[3 * t]!,
          y = centre[3 * t + 1]!,
          z = centre[3 * t + 2]!
        if (x < c0) c0 = x
        if (y < c1) c1 = y
        if (z < c2) c2 = z
        if (x > d0) d0 = x
        if (y > d1) d1 = y
        if (z > d2) d2 = z
      }
      boxes.set([lo0, lo1, lo2, hi0, hi1, hi2], node * 6)
      if (end - start <= LEAF || nodes + 2 > maxNodes) {
        first[node] = start
        count[node] = end - start
        continue
      }
      // split at the median of the widest centre extent
      const ex = [d0 - c0, d1 - c1, d2 - c2]
      const axis = ex[0]! >= ex[1]! && ex[0]! >= ex[2]! ? 0 : ex[1]! >= ex[2]! ? 1 : 2
      const mid = (start + end) >> 1
      selectNth(order, start, end, mid, (t) => centre[3 * t + axis]!)
      const left = nodes
      nodes += 2
      first[node] = left
      count[node] = 0
      stack.push(left, start, mid, left + 1, mid, end)
    }
    this.boxes = boxes
    this.first = first
    this.count = count
    this.order = order
  }

  /**
   * The nearest point of the mesh to `p`: its distance and the triangle; `Infinity` for an empty
   * mesh. Stops early once a triangle is closer than `stopBelow` (a caller that only needs to
   * know the distance is under a bound).
   */
  closest(
    px: number,
    py: number,
    pz: number,
    stopBelow = 0,
  ): { distance: number; triangle: number } {
    let best = Infinity
    let bestT = -1
    if (this.triangles === 0) return { distance: Infinity, triangle: -1 }
    const stop2 = stopBelow * stopBelow
    const stack: number[] = [0]
    const q = new Float64Array(3)
    while (stack.length > 0) {
      const node = stack.pop()!
      if (boxDistance2(this.boxes, node, px, py, pz) >= best) continue
      const c = this.count[node]!
      if (c > 0) {
        const s = this.first[node]!
        for (let i = s; i < s + c; i++) {
          const t = this.order[i]!
          closestOnTriangle(this.corners, t, px, py, pz, q)
          const dx = q[0]! - px,
            dy = q[1]! - py,
            dz = q[2]! - pz
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 < best) {
            best = d2
            bestT = t
            if (d2 <= stop2) return { distance: Math.sqrt(best), triangle: bestT }
          }
        }
        continue
      }
      const a = this.first[node]!
      const da = boxDistance2(this.boxes, a, px, py, pz)
      const db = boxDistance2(this.boxes, a + 1, px, py, pz)
      // nearer child last, so it is popped first
      if (da < db) stack.push(a + 1, a)
      else stack.push(a, a + 1)
    }
    return { distance: Math.sqrt(best), triangle: bestT }
  }
}

function boxDistance2(b: Float64Array, node: number, x: number, y: number, z: number): number {
  const o = node * 6
  const dx = x < b[o]! ? b[o]! - x : x > b[o + 3]! ? x - b[o + 3]! : 0
  const dy = y < b[o + 1]! ? b[o + 1]! - y : y > b[o + 4]! ? y - b[o + 4]! : 0
  const dz = z < b[o + 2]! ? b[o + 2]! - z : z > b[o + 5]! ? z - b[o + 5]! : 0
  return dx * dx + dy * dy + dz * dz
}

/** Quickselect: `order[start..end)` partitioned so `order[nth]` has the nth smallest key. */
function selectNth(
  order: Int32Array,
  start: number,
  end: number,
  nth: number,
  key: (t: number) => number,
): void {
  let lo = start
  let hi = end - 1
  while (hi > lo) {
    const pivot = key(order[(lo + hi) >> 1]!)
    let i = lo
    let j = hi
    while (i <= j) {
      while (key(order[i]!) < pivot) i++
      while (key(order[j]!) > pivot) j--
      if (i <= j) {
        const t = order[i]!
        order[i] = order[j]!
        order[j] = t
        i++
        j--
      }
    }
    if (nth <= j) hi = j
    else if (nth >= i) lo = i
    else return
  }
}

/**
 * The point of triangle `t` nearest to p (Ericson, Real-Time Collision Detection § 5.1.5), into
 * `out`.
 */
export function closestOnTriangle(
  c: Float64Array,
  t: number,
  px: number,
  py: number,
  pz: number,
  out: Float64Array,
): void {
  const o = 9 * t
  const ax = c[o]!,
    ay = c[o + 1]!,
    az = c[o + 2]!
  const abx = c[o + 3]! - ax,
    aby = c[o + 4]! - ay,
    abz = c[o + 5]! - az
  const acx = c[o + 6]! - ax,
    acy = c[o + 7]! - ay,
    acz = c[o + 8]! - az
  const apx = px - ax,
    apy = py - ay,
    apz = pz - az
  const set = (x: number, y: number, z: number) => {
    out[0] = x
    out[1] = y
    out[2] = z
  }
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  if (d1 <= 0 && d2 <= 0) return set(ax, ay, az)
  const bpx = px - (ax + abx),
    bpy = py - (ay + aby),
    bpz = pz - (az + abz)
  const d3 = abx * bpx + aby * bpy + abz * bpz
  const d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) return set(ax + abx, ay + aby, az + abz)
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    return set(ax + v * abx, ay + v * aby, az + v * abz)
  }
  const cpx = px - (ax + acx),
    cpy = py - (ay + acy),
    cpz = pz - (az + acz)
  const d5 = abx * cpx + aby * cpy + abz * cpz
  const d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) return set(ax + acx, ay + acy, az + acz)
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    return set(ax + w * acx, ay + w * acy, az + w * acz)
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    const bx = ax + abx,
      by = ay + aby,
      bz = az + abz
    return set(bx + w * (acx - abx), by + w * (acy - aby), bz + w * (acz - abz))
  }
  const denom = 1 / (va + vb + vc)
  const v = vb * denom
  const w = vc * denom
  return set(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w)
}
