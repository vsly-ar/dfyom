/**
 * Spike S3 profile (report: spikes/prisms/results.md § Where the time goes). Where the boolean time goes for one shape pocket (raw manifold-3d): cap triangulation, the stock face with the region as a hole, ofMesh, subtract (pocket / through / fully inside), CrossSection.extrude for comparison, setTolerance.
 */
import Module, { type ManifoldToplevel } from 'manifold-3d/manifold.js'
import { it } from 'vitest'
/** manifold-3d's mutable point type. */
type Vec2 = [number, number]
import { prismLabels, prismMesh } from './prism'
import { flatten, islandsRegion, starRegion, type Region } from './region'

it('profiles the boolean', async () => {
  const w: ManifoldToplevel = await (Module as () => Promise<ManifoldToplevel>)()
  w.setup()
  const tri = (p: readonly (readonly (readonly number[])[])[]) => w.triangulate(p as never, -1)
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
  const cases: [string, Region][] = [
    ['star2000', starRegion(2000)],
    ['islands2000', islandsRegion(2000)],
    ['star500', starRegion(500)],
  ]
  for (const [name, r] of cases) {
    const rings = flatten(r)
    const labels = prismLabels(r.loops.flatMap((l) => l.map((e) => e.kind)))
    const toM = (zTop: number, zBot: number) => {
      const mesh = prismMesh(rings, zTop, zBot, labels, tri)
      return new w.Manifold(
        new w.Mesh({
          numProp: 3,
          vertProperties: Float32Array.from(mesh.positions),
          triVerts: mesh.triangles,
          faceID: mesh.faces,
        }),
      )
    }
    const stock = w.Manifold.cube([200, 120, 30]).translate([0, 0, -30])
    const pocket = toM(1, -8.3)
    const through = toM(1, -31)
    const inside = toM(-2, -8.3)
    time(`${name} triangulate caps`, () => tri(rings.map((x) => x.points as unknown as Vec2[])))
    // the stock top with the region as a hole: what the boolean must re-triangulate
    const rect: Vec2[] = [
      [0, 0],
      [200, 0],
      [200, 120],
      [0, 120],
    ]
    const hole = rings[0]!.points.map((p) => [p[0], p[1]] as Vec2).reverse()
    time(`${name} triangulate stock top with hole`, () => tri([rect, hole]))
    time(`${name} ofMesh`, () => toM(1, -8.3).delete())
    time(`${name} subtract pocket`, () => {
      const m = stock.subtract(pocket)
      m.status()
      m.delete()
    })
    time(`${name} subtract through`, () => {
      const m = stock.subtract(through)
      m.status()
      m.delete()
    })
    time(`${name} subtract fully inside (no face crossing)`, () => {
      const m = stock.subtract(inside)
      m.status()
      m.delete()
    })
    const cs = new w.CrossSection(
      rings.map((x) => x.points as unknown as Vec2[]),
      'EvenOdd',
    )
    const ext = cs.extrude(9.3).translate([0, 0, -8.3])
    time(`${name} CrossSection.extrude`, () => cs.extrude(9.3).translate([0, 0, -8.3]).delete())
    time(`${name} subtract extrude`, () => {
      const m = stock.subtract(ext)
      m.status()
      m.delete()
    })
    const pocketT = pocket.setTolerance(1e-4)
    time(`${name} subtract pocket tol 1e-4`, () => {
      const m = stock.subtract(pocketT)
      m.status()
      m.delete()
    })
  }
})
