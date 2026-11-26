/**
 * The simulated cut's budget and spike S9's numbers (docs/modes/deviation.md#performance,
 * #implementation-s9-v2): the black-box test's 26 185-line top program (6 mm flat end mill, 26 170
 * moves, 1 893 arcs) swept at 0.5 mm cells within 2 s, and the edge-band aliasing of the cut maps
 * of both programs against the placed reference at 0.5 and 0.25 mm. Outside `npm run check`
 * (timings are flaky under load). Run: `npm run perf`.
 */
import { expect, it } from 'vitest'
import { enclosureStl } from '../design/stl.testing'
import { simulateHeightmap, type CutMap } from './simulate'
import { StockHeights } from './stock-heights'
import {
  ENCLOSURE_BOTTOM_NC,
  ENCLOSURE_STOCK,
  ENCLOSURE_TOP_NC,
  parseGcode,
  readGcode,
  type ProgramToolpath,
} from './testing/gcode'

function median(n: number, fn: () => void): number {
  fn()
  const times: number[] = []
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    fn()
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(n / 2)]!
}

const cutMap = (programs: ProgramToolpath[], cell: number): CutMap =>
  simulateHeightmap({
    stock: ENCLOSURE_STOCK,
    cell,
    setups: [{ direction: '+z', rotation: 0, toolpaths: programs }],
  }).unwrap()[0]!

it('sweeps the 26 185-line top program at 0.5 mm within 2 s', () => {
  const top = parseGcode(readGcode(ENCLOSURE_TOP_NC))
  const ms = median(5, () => cutMap(top, 0.5))
  // the production field DF64 sweeps (an upper bound per whole cell), for the S9 record
  const field = median(3, () => {
    const f = new StockHeights([250, 200], { minX: 0, minY: 0, maxX: 250, maxY: 200 })
    for (const p of top) f.cut(p.tool, undefined, p.toolpath.passes[0]!.moves, -40)
  })
  const fine = median(3, () => cutMap(top, 0.25))
  console.log(
    `simulate top: ${ms.toFixed(0)} ms at 0.5 mm, ${fine.toFixed(0)} ms at 0.25 mm; StockHeights ${field.toFixed(0)} ms`,
  )
  // measured 55 ms at 0.5 mm, 175 ms at 0.25 mm idle (M-series Mac, 2026-11-26): the target, not
  // the measurement, is the bound, so a loaded machine still passes
  expect(ms).toBeLessThan(2000)
})

/**
 * The reference's highest surface per cell centre of the top (+z) or bottom (−z) face frame:
 * the STL centred in x/y as the black-box test placed it (+125, +100), its bottom 1 mm above the
 * stock bottom; NaN = no part in the column.
 */
function referenceMap(
  face: '+z' | '-z',
  cell: number,
): { nu: number; nv: number; h: Float64Array } {
  const bytes = enclosureStl()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const n = view.getUint32(80, true)
  const nu = Math.ceil(250 / cell)
  const nv = Math.ceil(200 / cell)
  const h = new Float64Array(nu * nv).fill(NaN)
  const p = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const o = 84 + 50 * t + 12 + 12 * k
      const x = view.getFloat32(o, true) + 125
      const y = view.getFloat32(o + 4, true) + 100
      const z = view.getFloat32(o + 8, true) + 1 - 40
      // the bottom face frame (−z): u = x, v = 200 − y, w = −40 − z (its face at the stock bottom)
      p[3 * k] = x
      p[3 * k + 1] = face === '+z' ? y : 200 - y
      p[3 * k + 2] = face === '+z' ? z : -40 - z
    }
    const den = (p[4]! - p[7]!) * (p[0]! - p[6]!) + (p[6]! - p[3]!) * (p[1]! - p[7]!)
    if (Math.abs(den) < 1e-12) continue
    const i0 = Math.max(0, Math.ceil(Math.min(p[0]!, p[3]!, p[6]!) / cell - 0.5))
    const i1 = Math.min(nu - 1, Math.floor(Math.max(p[0]!, p[3]!, p[6]!) / cell - 0.5))
    const j0 = Math.max(0, Math.ceil(Math.min(p[1]!, p[4]!, p[7]!) / cell - 0.5))
    const j1 = Math.min(nv - 1, Math.floor(Math.max(p[1]!, p[4]!, p[7]!) / cell - 0.5))
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * cell
        const y = (j + 0.5) * cell
        const l0 = ((p[4]! - p[7]!) * (x - p[6]!) + (p[6]! - p[3]!) * (y - p[7]!)) / den
        const l1 = ((p[7]! - p[1]!) * (x - p[6]!) + (p[0]! - p[6]!) * (y - p[7]!)) / den
        const l2 = 1 - l0 - l1
        if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue
        const w = l0 * p[2]! + l1 * p[5]! + l2 * p[8]!
        const c = j * nu + i
        if (!(h[c]! >= w)) h[c] = w
      }
  }
  return { nu, nv, h }
}

it('measures the edge-band aliasing at 0.5 and 0.25 mm (S9)', () => {
  const programs = {
    '+z': parseGcode(readGcode(ENCLOSURE_TOP_NC)),
    '-z': parseGcode(readGcode(ENCLOSURE_BOTTOM_NC)),
  }
  for (const face of ['+z', '-z'] as const)
    for (const cell of [0.5, 0.25]) {
      const ref = referenceMap(face, cell)
      // the bottom program in its WCS is the bottom face frame (setup −z, no turn or zero)
      const cut = cutMap(programs[face], cell)
      const { nu, nv } = ref
      let inside = 0
      let band = 0
      let overBand = 0
      let overOff = 0
      const off: number[] = []
      for (let j = 0; j < nv; j++)
        for (let i = 0; i < nu; i++) {
          const k = j * nu + i
          const r = ref.h[k]!
          if (Number.isNaN(r)) continue
          inside++
          const dev = cut.h[k]! - r
          // the edge band: a reference step over 0.1 mm to a neighbour (a wall within a cell)
          let edge = false
          for (let dj = -1; dj <= 1 && !edge; dj++)
            for (let di = -1; di <= 1 && !edge; di++) {
              const ii = i + di
              const jj = j + dj
              if (ii < 0 || jj < 0 || ii >= nu || jj >= nv) continue
              const q = ref.h[jj * nu + ii]!
              if (Number.isNaN(q) || Math.abs(q - r) > 0.1) edge = true
            }
          if (edge) {
            band++
            if (Math.abs(dev) > 0.1) overBand++
          } else {
            off.push(Math.abs(dev))
            if (Math.abs(dev) > 0.1) overOff++
          }
        }
      off.sort((a, b) => a - b)
      const q = (f: number) => off[Math.min(off.length - 1, Math.floor(f * off.length))]!.toFixed(3)
      console.log(
        `S9 ${face} ${cell} mm: ${inside} cells in the part, edge band ${band} (${((band * cell * cell) / 100).toFixed(1)} cm², ${overBand} over 0.1 mm); off the band p95 ${q(0.95)} p99 ${q(0.99)} mm, ${overOff} over 0.1 mm`,
      )
      expect(inside).toBeGreaterThan(0)
    }
})
