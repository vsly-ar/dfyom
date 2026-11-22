/**
 * Spike S3 profile (report: spikes/prisms/results.md § Where the time goes). Face re-triangulation cost against chords of one loop crossing the stock top (circle, wave, zigzag): quadratic.
 */
import Module, { type ManifoldToplevel } from 'manifold-3d/manifold.js'
import { it } from 'vitest'
/** manifold-3d's mutable point type. */
type Vec2 = [number, number]

it('profiles loop shapes', async () => {
  const w: ManifoldToplevel = await (Module as () => Promise<ManifoldToplevel>)()
  w.setup()
  const time = (label: string, f: () => unknown, n = 5) => {
    f()
    const ts: number[] = []
    for (let i = 0; i < n; i++) {
      const t = performance.now()
      f()
      ts.push(performance.now() - t)
    }
    ts.sort((a, b) => a - b)
    console.log(label, ts[Math.floor(n / 2)]!.toFixed(1))
  }
  const stock = w.Manifold.cube([200, 120, 30]).translate([0, 0, -30])
  for (const n of [1000, 3000, 6000]) {
    for (const name of ['circle', 'wave8', 'zigzag']) {
      const pts: Vec2[] = []
      for (let i = 0; i < n; i++) {
        const t = (2 * Math.PI * i) / n
        const r =
          name === 'zigzag'
            ? i % 2 === 0
              ? 50
              : 49.5
            : name === 'wave8'
              ? 45 + 4 * Math.sin(8 * t)
              : 50
        pts.push([100 + r * Math.cos(t), 60 + r * Math.sin(t)])
      }
      const cs = new w.CrossSection([pts], 'EvenOdd')
      const ext = cs.extrude(9.3).translate([0, 0, -8.3])
      const rect: Vec2[] = [
        [0, 0],
        [200, 0],
        [200, 120],
        [0, 120],
      ]
      time(`${name} ${n} triangulate rect-with-hole`, () =>
        w.triangulate([rect, [...pts].reverse()], -1),
      )
      time(`${name} ${n} subtract`, () => {
        const m = stock.subtract(ext)
        m.status()
        m.delete()
      })
    }
  }
})
