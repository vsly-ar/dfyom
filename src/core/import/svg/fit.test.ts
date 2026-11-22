// Arc fitting on spike S5's corpus (spikes/biarc/corpus.ts, docs/research/s5-biarc-fitting.md):
// every case within 0.01 mm (S5's independent two-sided oracle), tangent-continuous except at
// cusps, element counts as S5 measured for approach B.
import { describe, expect, it } from 'vitest'
import { arcRadius, arcSweep, type Element } from '../../geometry/2d/model'
import { buildChain, emptyStats } from './chain'
import { cross, cubicCurve, curveOf, dist, dot, ellipseCurve } from './curves'
import { biarc, elemTangents, fitCurve, type BElem } from './fit'
import { parsePathData, type Seg } from './path-data'
import { deviation } from './testing/oracle'

/** S5 corpus path data (y down as written; fitting does not care) with S5's B element counts. */
const CORPUS: readonly { name: string; d: string; elements?: number }[] = [
  {
    name: 'heart',
    d: 'M 50 88 C 20 65 0 45 0 25 C 0 10 12 0 26 0 C 37 0 46 7 50 16 C 54 7 63 0 74 0 C 88 0 100 10 100 25 C 100 45 80 65 50 88 Z',
    elements: 40,
  },
  {
    name: 'letter D',
    d: 'M 5 5 H 35 C 60 5 75 25 75 50 S 60 95 35 95 H 5 Z M 20 20 V 80 H 34 Q 58 80 58 50 Q 58 20 34 20 Z',
    elements: 50,
  },
  { name: 'cusp', d: 'M0 0 C30 30 0 30 30 0', elements: 16 },
  // S5: 16 arcs + 2 micro corners, which the clean-up merges
  { name: 'near-cusp', d: 'M0 0 C30 30 0 30.001 30 0', elements: 16 },
  { name: 'loop', d: 'M0 0 C60 40 -20 40 40 0', elements: 28 },
  { name: 'inflection', d: 'M0 0 C30 40 30 -40 60 0', elements: 32 },
  { name: 'two inflections', d: 'M0 0 C50 60 10 -60 60 0', elements: 36 },
  { name: 'control on end', d: 'M0 0 C0 0 40 30 60 0', elements: 14 },
  { name: 'line in disguise', d: 'M0 0 C0 0 60 10 60 10', elements: 1 },
  { name: 'collinear backtrack', d: 'M0 0 C40 0 -10 0 30 0', elements: 3 },
  { name: 'nearly straight', d: 'M0 0 C20 0.000001 40 -0.000001 60 0', elements: 3 },
  { name: 'huge radius 2 µm', d: 'M0 0 C100 0.002 200 0.002 300 0', elements: 2 },
  { name: 'huge radius 50 µm', d: 'M0 0 C100 0.0667 200 0.0667 300 0', elements: 2 },
  {
    name: 'tiny cubic',
    d: 'M0.025 0.044 C0.01 0.0325 0 0.0225 0 0.0125 C0 0.005 0.006 0 0.013 0 C0.0185 0 0.023 0.0035 0.025 0.008',
    elements: 6,
  },
  { name: 'tiny arcs', d: 'M0 0 A0.005 0.005 0 0 1 0.01 0 A0.02 0.01 0 0 1 0.05 0', elements: 5 },
  { name: 'ellipse', d: 'M0 20 A50 20 0 0 1 100 20 A50 20 0 0 1 0 20 Z', elements: 48 },
  {
    name: 'thin ellipse',
    d: 'M0 0 A100 1 30 0 1 173.205 100 A100 1 30 0 1 0 0 Z',
    elements: 40,
  },
  { name: 'flat elliptical arc', d: 'M0 0 A100000 50000 20 0 1 100 0', elements: 2 },
  { name: 'quadratic chain', d: 'M0 0 Q20 40 40 0 T80 0 T120 0', elements: 48 },
]

const angle = (u: { x: number; y: number }, v: { x: number; y: number }): number =>
  Math.abs(Math.atan2(cross(u, v), dot(u, v)))

function chains(d: string): { segs: readonly Seg[]; elements: readonly Element[] }[] {
  return parsePathData(d).subpaths.map((s) => {
    const c = buildChain(s.segs, s.closed, emptyStats())
    if (!c) throw new Error('no chain')
    return { segs: s.segs, elements: c.elements }
  })
}

describe('arc fitting on the S5 corpus (approach B)', () => {
  for (const c of CORPUS)
    it(`${c.name}: within 0.01 mm both ways, S5's element count`, () => {
      let n = 0
      for (const ch of chains(c.d)) {
        expect(deviation(ch.segs, ch.elements)).toBeLessThanOrEqual(0.01)
        n += ch.elements.length
        for (const e of ch.elements)
          if (e.kind === 'arc') expect(Math.abs(arcSweep(e))).toBeLessThanOrEqual(Math.PI + 1e-12)
      }
      if (c.elements !== undefined) expect(n).toBe(c.elements)
    })

  it('keeps every fitted curve G1 inside, corners only at cusps', () => {
    for (const c of CORPUS)
      for (const s of parsePathData(c.d).subpaths)
        for (const seg of s.segs) {
          const curve = curveOf(seg)
          const r = fitCurve(curve)
          expect(r.forced, c.name).toBe(0)
          expect(r.maxError, c.name).toBeLessThanOrEqual(0.01)
          const cuspPts = curve.cusps.map((t) => curve.p(t))
          for (let k = 0; k + 1 < r.elems.length; k++) {
            const e: BElem = r.elems[k]!
            const f: BElem = r.elems[k + 1]!
            if (e.micro || f.micro || cuspPts.some((p) => dist(p, e.b) < 1e-9)) continue
            expect(angle(elemTangents(e).t1, elemTangents(f).t0), c.name).toBeLessThanOrEqual(
              1e-4 + 1e-9,
            )
          }
          // chain ends follow the curve's own end tangents (G1 with the neighbours)
          if (curve.kind === 'cubic' || curve.kind === 'ellipse') {
            const first = r.elems[0]!
            const d0 = curve.d(0)
            if (Math.hypot(d0.x, d0.y) > 1e-9)
              expect(angle(elemTangents(first).t0, d0), c.name).toBeLessThanOrEqual(1e-4 + 1e-9)
          }
        }
  })

  it('reports cusps and micro corners', () => {
    const cusp = fitCurve(curveOf(parsePathData('M0 0 C30 30 0 30 30 0').subpaths[0]!.segs[0]!))
    expect(cusp.cusps).toBe(1)
    const near = fitCurve(curveOf(parsePathData('M0 0 C30 30 0 30.001 30 0').subpaths[0]!.segs[0]!))
    expect(near.micro).toBe(2)
    const stats = emptyStats()
    buildChain(parsePathData('M0 0 C30 30 0 30.001 30 0').subpaths[0]!.segs, false, stats)
    expect(stats.microCorners).toBe(2)
    expect(stats.beziers).toBe(1)
  })
})

describe('exact lines and circular arcs', () => {
  it('keeps a circular arc as one arc with its centre', () => {
    const [ch] = chains('M0 0 A10 10 0 0 1 20 0')
    expect(ch!.elements).toHaveLength(1)
    const e = ch!.elements[0]!
    if (e.kind !== 'arc') throw new Error('kind')
    expect(e.centre[0]).toBeCloseTo(10, 12)
    expect(e.centre[1]).toBeCloseTo(0, 12)
    expect(arcRadius(e)).toBeCloseTo(10, 12)
  })

  it('splits a circular arc over 180° in two', () => {
    const [ch] = chains('M0 0 A10 10 0 1 1 10 10')
    expect(ch!.elements.map((e) => e.kind)).toEqual(['arc', 'arc'])
    const total = ch!.elements.reduce((s, e) => s + (e.kind === 'arc' ? arcSweep(e) : 0), 0)
    expect(Math.abs(total)).toBeCloseTo((3 * Math.PI) / 2, 9)
  })

  it('keeps lines as lines and collinear source lines apart (user vertices)', () => {
    const [ch] = chains('M0 0 L10 0 L20 0 L20 10')
    expect(ch!.elements.map((e) => e.kind)).toEqual(['line', 'line', 'line'])
  })
})

describe('ellipseCurve', () => {
  it('matches the affine ellipse under rotation, skew and reflection', () => {
    const cases = [
      { u: { x: 5, y: 0 }, v: { x: 0, y: 2 } },
      { u: { x: 3, y: 4 }, v: { x: -1, y: 2 } }, // skewed
      { u: { x: 3, y: 1 }, v: { x: 1, y: -2 } }, // reflected (det < 0)
      { u: { x: 0, y: -4 }, v: { x: 4, y: 0 } }, // a circle, reflected
    ]
    const c = { x: 7, y: -3 }
    for (const { u, v } of cases) {
      const t0 = 0.3
      const dt = -2.1
      const e = ellipseCurve(c, u, v, t0, dt)
      for (const t of [0, 0.25, 0.5, 1]) {
        const th = t0 + dt * t
        const want = {
          x: c.x + u.x * Math.cos(th) + v.x * Math.sin(th),
          y: c.y + u.y * Math.cos(th) + v.y * Math.sin(th),
        }
        expect(dist(e.p(t), want)).toBeLessThan(1e-12)
      }
      // circles come back exact, with the sweep's sense
      if (e.kind === 'arc') {
        const sense = Math.sign(u.x * v.y - u.y * v.x) * Math.sign(dt)
        expect(Math.sign(e.bulge!)).toBe(sense)
      }
    }
    expect(ellipseCurve(c, { x: 0, y: -4 }, { x: 4, y: 0 }, 0, 1).kind).toBe('arc')
    expect(ellipseCurve(c, { x: 3, y: 4 }, { x: -1, y: 2 }, 0, 1).kind).toBe('ellipse')
  })

  it('splits nothing for a cubic without inflections; finds cusps', () => {
    expect(
      cubicCurve({ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }).breaks,
    ).toEqual([])
    expect(
      cubicCurve({ x: 0, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }, { x: 30, y: 0 }).cusps,
    ).toEqual([0.5])
  })
})

describe('biarc', () => {
  it('joins two points with matching end tangents', () => {
    const b = biarc({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 10, y: 0 }, { x: 0, y: -1 })!
    expect(b).toHaveLength(2)
    expect(angle(elemTangents(b[1]!).t1, { x: 0, y: -1 })).toBeLessThan(1e-9)
    expect(angle(elemTangents(b[0]!).t1, elemTangents(b[1]!).t0)).toBeLessThan(1e-9)
  })
})
