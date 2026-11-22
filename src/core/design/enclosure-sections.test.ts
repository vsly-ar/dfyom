// The v0.3 exit-criteria SVG fixture (docs/plans/v0.3.md#exit-criteria, Q27;
// docs/conventions/testing.md#fixtures): committed file = generator output, and its paths lie
// within the exit criteria's 0.2 mm of the STL's section at mid-wall height.
import { describe, expect, it } from 'vitest'
import {
  ENCLOSURE_SECTIONS_SVG,
  enclosureSections,
  fromPage,
  generateEnclosureSections,
  pointAt,
  type Pt,
  type Segment,
} from './enclosure-sections.testing'
import { enclosureStl } from './stl.testing'

interface NodeProcess {
  getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL, encoding: 'utf8'): string }
}
const fs = (globalThis as unknown as { process: NodeProcess }).process.getBuiltinModule('node:fs')

/** Deviation allowed by the exit criteria (mm). */
const EXIT_TOLERANCE = 0.2

/** Absolute `M`, `L`, `C`, `Z` path data (what the generator writes) → segments in the STL frame. */
function parsePath(d: string): Segment[] {
  const tokens = d.match(/[MLCZ]|-?\d+(?:\.\d+)?/g) ?? []
  expect(tokens.join('')).toBe(d.replace(/[\s,]/g, ''))
  const out: Segment[] = []
  let i = 0
  const point = (): Pt => fromPage({ x: Number(tokens[i++]), y: Number(tokens[i++]) })
  let start: Pt | undefined
  let cur: Pt | undefined
  while (i < tokens.length) {
    const cmd = tokens[i++]
    if (cmd === 'M') start = cur = point()
    else if (cmd === 'L') {
      const p3 = point()
      out.push({ p0: cur!, p3 })
      cur = p3
    } else if (cmd === 'C') {
      const c1 = point()
      const c2 = point()
      const p3 = point()
      out.push({ p0: cur!, c1, c2, p3 })
      cur = p3
    } else if (cmd === 'Z') {
      if (cur!.x !== start!.x || cur!.y !== start!.y) out.push({ p0: cur!, p3: start! })
      cur = start
    } else throw new Error(`unexpected path command ${cmd}`)
  }
  return out
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const l2 = vx * vx + vy * vy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2))
  return Math.hypot(p.x - a.x - t * vx, p.y - a.y - t * vy)
}

/** Max distance of `points` from the closed polygon `poly`. */
function oneSided(points: readonly Pt[], poly: readonly Pt[]): number {
  let worst = 0
  for (const p of points) {
    let best = Infinity
    for (let i = 0; i < poly.length; i++)
      best = Math.min(best, distToSegment(p, poly[i]!, poly[(i + 1) % poly.length]!))
    worst = Math.max(worst, best)
  }
  return worst
}

const flatten = (segments: readonly Segment[], perSegment = 64): Pt[] =>
  segments.flatMap((s) => Array.from({ length: perSegment }, (_, k) => pointAt(s, k / perSegment)))

const svg = fs.readFileSync(ENCLOSURE_SECTIONS_SVG, 'utf8')
const paths = new Map(
  [...svg.matchAll(/<path id="(\w+)"[^>]*\sd="([^"]+)"/g)].map((m) => [m[1]!, parsePath(m[2]!)]),
)

describe('enclosure-sections.svg', () => {
  it('is the generator output for the enclosure STL, byte for byte', () => {
    expect(svg).toBe(generateEnclosureSections(enclosureStl()))
  })

  it('is in mm: width and height in mm, viewBox in the same numbers', () => {
    expect(svg).toMatch(/<svg [^>]*width="250mm" height="178mm" viewBox="0 0 250 178"/)
  })

  it('has the two sections as top-level paths of a modest number of lines and cubics', () => {
    expect([...paths.keys()]).toEqual(['outline', 'cavity'])
    for (const segments of paths.values()) expect(segments.length).toBeLessThanOrEqual(20)
    expect(svg).not.toMatch(/<g\b/)
  })

  it('lies within 0.2 mm of the STL section at mid-wall height (both ways)', () => {
    for (const { id, loop } of enclosureSections(enclosureStl())) {
      const curve = flatten(paths.get(id)!)
      const deviation = Math.max(oneSided(loop, curve), oneSided(curve, loop))
      expect(deviation, id).toBeLessThanOrEqual(EXIT_TOLERANCE)
      // the fit itself (0.05 mm at the vertices, plus the facets' chords and µm rounding)
      expect(deviation, id).toBeLessThan(0.1)
    }
  })

  it('has the measured sizes: outline 249.5 × 177, cavity 235 × 159.4 mm', () => {
    const size = (id: string): [number, number] => {
      const pts = flatten(paths.get(id)!, 256)
      const xs = pts.map((p) => p.x)
      const ys = pts.map((p) => p.y)
      return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
    }
    const [ow, oh] = size('outline')
    const [cw, ch] = size('cavity')
    expect(ow).toBeCloseTo(249.5, 0)
    expect(oh).toBeCloseTo(177, 0)
    expect(cw).toBeCloseTo(235, 0)
    expect(ch).toBeCloseTo(159.4, 0)
  })

  it('is tangent-continuous where two cubics meet (corners only at lines)', () => {
    for (const [id, segments] of paths) {
      segments.forEach((s, i) => {
        const next = segments[(i + 1) % segments.length]!
        if (!s.c2 || !next.c1) return
        const a = { x: s.p3.x - s.c2.x, y: s.p3.y - s.c2.y }
        const b = { x: next.c1.x - next.p0.x, y: next.c1.y - next.p0.y }
        const sin = (a.x * b.y - a.y * b.x) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y))
        expect(Math.abs(sin), `${id} join ${i}`).toBeLessThan(1e-3)
        expect(a.x * b.x + a.y * b.y).toBeGreaterThan(0)
      })
    }
  })
})
