/**
 * Spike S3 profile (report: spikes/prisms/results.md § Where the time goes). The same subtraction with the stock top and bottom split into tiles of their own face id.
 */
import Module, { type ManifoldToplevel, type Manifold } from 'manifold-3d/manifold.js'
import { it } from 'vitest'
/** manifold-3d's mutable point type. */
type Vec2 = [number, number]

/** Box 0..L × 0..W × −T..0 with top and bottom split into gx × gy tiles, each its own faceID. */
function tiledStock(
  w: ManifoldToplevel,
  L: number,
  W: number,
  T: number,
  gx: number,
  gy: number,
): Manifold {
  const pos: number[] = []
  const tris: number[] = []
  const face: number[] = []
  const id = (i: number, j: number, k: number) => k * (gx + 1) * (gy + 1) + j * (gx + 1) + i
  for (const z of [0, -T])
    for (let j = 0; j <= gy; j++)
      for (let i = 0; i <= gx; i++) pos.push((L * i) / gx, (W * j) / gy, z)
  for (let j = 0; j < gy; j++)
    for (let i = 0; i < gx; i++) {
      const f = j * gx + i
      const [a, b, c, d] = [id(i, j, 0), id(i + 1, j, 0), id(i + 1, j + 1, 0), id(i, j + 1, 0)]
      tris.push(a, b, c, a, c, d)
      face.push(f, f)
      const [e, g, h, k] = [id(i, j, 1), id(i + 1, j, 1), id(i + 1, j + 1, 1), id(i, j + 1, 1)]
      tris.push(e, h, g, e, k, h)
      face.push(100000, 100000)
    }
  // sides: boundary loop of the grid, CCW from above
  const ring: [number, number][] = []
  for (let i = 0; i < gx; i++) ring.push([i, 0])
  for (let j = 0; j < gy; j++) ring.push([gx, j])
  for (let i = gx; i > 0; i--) ring.push([i, gy])
  for (let j = gy; j > 0; j--) ring.push([0, j])
  for (let r = 0; r < ring.length; r++) {
    const [i0, j0] = ring[r]!
    const [i1, j1] = ring[(r + 1) % ring.length]!
    const [tp, tq, bp, bq] = [id(i0, j0, 0), id(i1, j1, 0), id(i0, j0, 1), id(i1, j1, 1)]
    tris.push(bp, bq, tq, bp, tq, tp)
    face.push(100001, 100001)
  }
  return new w.Manifold(
    new w.Mesh({
      numProp: 3,
      vertProperties: Float32Array.from(pos),
      triVerts: Uint32Array.from(tris),
      faceID: Uint32Array.from(face),
    }),
  )
}

it('tiles the stock top', async () => {
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
  for (const n of [1000, 3000, 6000]) {
    const pts: Vec2[] = []
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / n
      pts.push([100 + 50 * Math.cos(t), 60 + 50 * Math.sin(t)])
    }
    const ext = new w.CrossSection([pts], 'EvenOdd').extrude(9.3).translate([0, 0, -8.3])
    for (const [gx, gy] of [
      [1, 1],
      [4, 2],
      [16, 8],
      [64, 32],
    ] as const) {
      const stock = tiledStock(w, 200, 120, 30, gx, gy)
      let tri = 0
      time(`circle ${n} tiles ${gx}x${gy} subtract`, () => {
        const m = stock.subtract(ext)
        m.status()
        tri = m.numTri()
        m.delete()
      })
      console.log(`  triangles ${tri}`)
    }
  }
})
