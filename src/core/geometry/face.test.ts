import { describe, expect, it } from 'vitest'
import {
  adjacentStockFaces,
  DIRECTION,
  DIRECTIONS,
  directionOf,
  faceFrame,
  localStock,
  STOCK_FACE,
  stockFaceLevel,
  toPartFrame,
} from './face'
import type { Vec3 } from './model'

const L = 100
const W = 60
const T = 20
const stock = { length: L, width: W, thickness: T }

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const clean = (v: Vec3): Vec3 => [v[0] + 0, v[1] + 0, v[2] + 0]

describe('face frames (design-v0.2.md#face-frame)', () => {
  it('match the face table: n, u, v and the origin at the stock face', () => {
    const table = {
      '+z': { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], origin: [0, 0, 0] },
      '-z': { n: [0, 0, -1], u: [1, 0, 0], v: [0, -1, 0], origin: [0, W, -T] },
      '-y': { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], origin: [0, 0, -T] },
      '+x': { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], origin: [L, 0, -T] },
      '+y': { n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1], origin: [L, W, -T] },
      '-x': { n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1], origin: [0, W, -T] },
    } as const
    for (const d of DIRECTIONS) {
      const f = faceFrame(d, stock)
      expect(clean(f.origin), d).toEqual(table[d].origin)
      expect(f.n, d).toEqual(table[d].n)
      expect(f.u, d).toEqual(table[d].u)
      expect(f.v, d).toEqual(table[d].v)
    }
  })

  it('are right-handed (u × v = n) and orthonormal', () => {
    for (const d of DIRECTIONS) {
      const { u, v, n } = DIRECTION[d]
      expect(clean(cross(u, v)), d).toEqual(n)
      expect(dot(u, v) + dot(v, n) + dot(n, u), d).toBe(0)
    }
  })

  it('the face rectangle [0, U] × [0, V] covers the stock face, seen from outside', () => {
    for (const d of DIRECTIONS) {
      const f = faceFrame(d, stock)
      const { length: U, width: V } = localStock(d, stock)
      for (const [a, b] of [
        [0, 0],
        [U, 0],
        [0, V],
        [U, V],
      ] as const) {
        const p = toPartFrame(f, [a, b, 0])
        // on the stock face plane, inside the stock box
        expect(dot(DIRECTION[d].n, p), d).toBeCloseTo(stockFaceLevel(d, stock))
        expect(p[0]).toBeGreaterThanOrEqual(0)
        expect(p[0]).toBeLessThanOrEqual(L)
        expect(p[1]).toBeGreaterThanOrEqual(0)
        expect(p[1]).toBeLessThanOrEqual(W)
        expect(p[2]).toBeGreaterThanOrEqual(-T)
        expect(p[2]).toBeLessThanOrEqual(0)
      }
      // depth runs along −n: local z = −T_n is the opposite face
      const deep = toPartFrame(f, [0, 0, -localStock(d, stock).thickness])
      expect(dot(DIRECTION[d].n, deep), d).toBeCloseTo(
        stockFaceLevel(d, stock) - stock[DIRECTION[d].extent],
      )
    }
  })

  it('all faces of one direction share u, v and the origin (u, v); only the level differs', () => {
    const top = faceFrame('+x', stock)
    const floor = faceFrame('+x', stock, L - 5)
    expect(floor.origin).toEqual([L - 5, top.origin[1], top.origin[2]])
    expect(toPartFrame(floor, [10, 4, 0])).toEqual([L - 5, 10, -T + 4])
  })

  it('local stock: face rectangle and extent along n; levels of the stock faces', () => {
    expect(localStock('+z', stock)).toEqual(stock)
    expect(localStock('-z', stock)).toEqual(stock)
    expect(localStock('-y', stock)).toEqual({ length: L, width: T, thickness: W })
    expect(localStock('+x', stock)).toEqual({ length: W, width: T, thickness: L })
    expect(DIRECTIONS.map((d) => stockFaceLevel(d, stock))).toEqual([0, T, 0, L, W, 0])
  })

  it('adjacent stock faces around the face rectangle: v-min, u-max, v-max, u-min', () => {
    expect(adjacentStockFaces('+z')).toEqual([
      'stock.side[0]',
      'stock.side[1]',
      'stock.side[2]',
      'stock.side[3]',
    ])
    expect(adjacentStockFaces('+x')).toEqual([
      'stock.bottom',
      'stock.side[2]',
      'stock.top',
      'stock.side[0]',
    ])
    expect(adjacentStockFaces('-z')).toEqual([
      'stock.side[2]',
      'stock.side[1]',
      'stock.side[0]',
      'stock.side[3]',
    ])
    for (const d of DIRECTIONS) expect(directionOf(DIRECTION[d].n)).toBe(d)
    expect(STOCK_FACE['-x']).toBe('stock.side[3]')
  })
})
