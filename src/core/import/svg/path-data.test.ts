import { describe, expect, it } from 'vitest'
import { parsePathData, segEnd, segStart, svgArcSeg, transformSeg, type Seg } from './path-data'

const ends = (segs: readonly Seg[]): number[][] =>
  segs.map((s) => [segStart(s).x, segStart(s).y, segEnd(s).x, segEnd(s).y])

describe('parsePathData', () => {
  it('reads absolute and relative lines, H, V, implicit repeats and Z', () => {
    const r = parsePathData('M10,10 L20 10 l0 10 H10 v-10 Z m5 5 h1 1 v1 z')
    expect(r.error).toBeUndefined()
    expect(r.subpaths.map((s) => s.closed)).toEqual([true, true])
    expect(ends(r.subpaths[0]!.segs)).toEqual([
      [10, 10, 20, 10],
      [20, 10, 20, 20],
      [20, 20, 10, 20],
      [10, 20, 10, 10],
    ])
    // m after z is relative to the subpath start; implicit h repeat
    expect(ends(r.subpaths[1]!.segs)).toEqual([
      [15, 15, 16, 15],
      [16, 15, 17, 15],
      [17, 15, 17, 16],
      [17, 16, 15, 15],
    ])
  })

  it('treats coordinates after M as implicit L, and splits subpaths at M', () => {
    const r = parsePathData('M0 0 10 0 10 10 M20 20 30 20')
    expect(r.subpaths.map((s) => [s.closed, s.segs.length])).toEqual([
      [false, 2],
      [false, 1],
    ])
  })

  it('reads compact numbers', () => {
    const r = parsePathData('M.5.5-1-1e0L1E1,+2')
    expect(r.error).toBeUndefined()
    expect(ends(r.subpaths[0]!.segs)).toEqual([
      [0.5, 0.5, -1, -1],
      [-1, -1, 10, 2],
    ])
  })

  it('reflects control points for S and T, elevates quadratics exactly', () => {
    const r = parsePathData('M0 0 C0 10 10 10 10 0 S20 -10 20 0 Q25 5 30 0 T40 0')
    const [c1, s, q, t] = r.subpaths[0]!.segs as [Seg, Seg, Seg, Seg]
    expect(c1.kind).toBe('cubic')
    if (s.kind !== 'cubic' || q.kind !== 'cubic' || t.kind !== 'cubic') throw new Error('kind')
    expect(s.c1).toEqual({ x: 10, y: -10 })
    expect(q.quad).toBe(true)
    // elevated: c1 = p0 + 2/3 (q − p0) with p0 (20, 0), q (25, 5)
    expect(q.c1.x).toBeCloseTo(20 + (2 / 3) * 5, 12)
    // T reflects the quadratic control (25, 5) about (30, 0) → (35, −5)
    expect(t.c1.x).toBeCloseTo(30 + (2 / 3) * 5, 12)
    expect(t.c1.y).toBeCloseTo((2 / 3) * -5, 12)
    // S without a preceding C uses the current point
    const lone = parsePathData('M0 0 S10 10 20 0').subpaths[0]!.segs[0]!
    expect(lone.kind === 'cubic' && lone.c1).toEqual({ x: 0, y: 0 })
  })

  it('reads arcs with compact flags', () => {
    const r = parsePathData('M0 0a5 5 0 1010 0A5,5,0,0,1,20,0')
    expect(r.error).toBeUndefined()
    const [a, b] = r.subpaths[0]!.segs
    expect(a!.kind).toBe('ellipse')
    expect(ends([a!, b!])).toEqual([
      [0, 0, 10, 0],
      [10, 0, 20, 0],
    ])
  })

  it('keeps the data before an error and reports it', () => {
    const r = parsePathData('M0 0 L10 0 L10 x L0 10')
    expect(r.error?.message).toMatch(/expected a number/)
    expect(r.subpaths[0]!.segs).toHaveLength(1)
    expect(parsePathData('L0 0').error?.message).toMatch(/start with M/)
    expect(parsePathData('M0 0 Z 5').error).toBeDefined()
    expect(parsePathData('M0 0 A1 1 0 2 0 5 5').error).toBeDefined()
    expect(parsePathData('').subpaths).toEqual([])
  })

  it('drops zero-length lines and arcs, turns zero-radius arcs into lines', () => {
    const r = parsePathData('M0 0 L0 0 A5 5 0 0 1 0 0 A0 5 0 0 1 10 0')
    expect(r.subpaths[0]!.segs.map((s) => s.kind)).toEqual(['line'])
  })
})

describe('svgArcSeg', () => {
  it('converts the endpoint form to the centre form, scaling radii up when too small', () => {
    const s = svgArcSeg({ x: 0, y: 0 }, 1, 1, 0, false, true, { x: 10, y: 0 })!
    if (s.kind !== 'ellipse') throw new Error('kind')
    expect(s.c.x).toBeCloseTo(5, 12)
    expect(Math.hypot(s.u.x, s.u.y)).toBeCloseTo(5, 12)
    expect(Math.abs(s.dt)).toBeCloseTo(Math.PI, 12)
  })

  it('hits its end points with the rotated ellipse', () => {
    const s = svgArcSeg({ x: 1, y: 2 }, 8, 3, 30, true, false, { x: 9, y: 4 })!
    if (s.kind !== 'ellipse') throw new Error('kind')
    const at = (t: number) => ({
      x: s.c.x + s.u.x * Math.cos(t) + s.v.x * Math.sin(t),
      y: s.c.y + s.u.y * Math.cos(t) + s.v.y * Math.sin(t),
    })
    expect(at(s.t0).x).toBeCloseTo(1, 9)
    expect(at(s.t0).y).toBeCloseTo(2, 9)
    expect(at(s.t0 + s.dt).x).toBeCloseTo(9, 9)
    expect(at(s.t0 + s.dt).y).toBeCloseTo(4, 9)
    expect(s.dt).toBeLessThan(-Math.PI) // large, counter-sweep
  })
})

describe('transformSeg', () => {
  it('maps points with the full matrix and ellipse axes with the linear part', () => {
    const s = svgArcSeg({ x: 0, y: 0 }, 5, 5, 0, false, true, { x: 10, y: 0 })!
    const t = transformSeg([2, 0, 0, 3, 100, 200], s)
    if (t.kind !== 'ellipse' || s.kind !== 'ellipse') throw new Error('kind')
    expect(t.c).toEqual({ x: 2 * s.c.x + 100, y: 3 * s.c.y + 200 })
    expect(t.u).toEqual({ x: 2 * s.u.x, y: 3 * s.u.y })
    expect(t.b).toEqual({ x: 120, y: 200 })
  })
})
