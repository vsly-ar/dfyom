/**
 * A uniform grid over the elements of some loops, for the port's offset checks (B2): the
 * distance from a point to the nearest element within a radius, without visiting every
 * element. Doc: docs/architecture/shapes.md#implementation-k1
 */
import type { Vec2 } from '../../model'
import { elementClosest } from '../measure'
import { chainBounds, type Element, type Loop } from '../model'

export interface NearestIndex {
  /** The distance from `p` to the nearest element closer than `r`; Infinity when there is none. */
  within(p: Vec2, r: number): number
}

/** The most cells along a side: the grid has about one cell per element, never finer than this. */
const MAX_CELLS_PER_SIDE = 1024

export function nearestIndex(loops: readonly Loop[]): NearestIndex {
  const elements: Element[] = loops.flatMap((l) => l.elements)
  const boxes = elements.map((e) => chainBounds([e])!)
  if (elements.length === 0) return { within: () => Infinity }
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const b of boxes) {
    x0 = Math.min(x0, b.min[0])
    y0 = Math.min(y0, b.min[1])
    x1 = Math.max(x1, b.max[0])
    y1 = Math.max(y1, b.max[1])
  }
  const w = x1 - x0
  const h = y1 - y0
  const cell = Math.max(
    Math.sqrt((w * h) / elements.length),
    w / MAX_CELLS_PER_SIDE,
    h / MAX_CELLS_PER_SIDE,
    1e-6,
  )
  const nx = Math.floor(w / cell) + 1
  const ny = Math.floor(h / cell) + 1
  const cx = (x: number) => Math.min(nx - 1, Math.max(0, Math.floor((x - x0) / cell)))
  const cy = (y: number) => Math.min(ny - 1, Math.max(0, Math.floor((y - y0) / cell)))
  const cells = new Map<number, number[]>()
  boxes.forEach((b, i) => {
    for (let x = cx(b.min[0]); x <= cx(b.max[0]); x++)
      for (let y = cy(b.min[1]); y <= cy(b.max[1]); y++) {
        const k = y * nx + x
        const list = cells.get(k)
        if (list) list.push(i)
        else cells.set(k, [i])
      }
  })
  const stamp = new Int32Array(elements.length)
  let query = 0
  return {
    within(p, r) {
      query++
      let best = Infinity
      if (p[0] + r < x0 || p[0] - r > x1 || p[1] + r < y0 || p[1] - r > y1) return best
      for (let x = cx(p[0] - r); x <= cx(p[0] + r); x++)
        for (let y = cy(p[1] - r); y <= cy(p[1] + r); y++) {
          const list = cells.get(y * nx + x)
          if (list === undefined) continue
          for (const i of list) {
            if (stamp[i] === query) continue
            stamp[i] = query
            const c = elementClosest(elements[i]!, p)
            const dist = Math.hypot(p[0] - c[0], p[1] - c[1])
            if (dist < r && dist < best) best = dist
          }
        }
      return best
    },
  }
}
