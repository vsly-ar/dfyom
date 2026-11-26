// Construction surfaces in the 3D view (DF118 V3): a referenced surface later cuts removed is drawn
// from the evaluation's patches (not the mesh) as a dashed outline at its level with a light fill,
// pickable in pick mode with a normal glyph at its centroid. Pure (three's triangulation only), so
// it is unit-tested in Node. Doc: docs/modes/construction-surfaces.md#ui,
// docs/conventions/ui.md#construction-surfaces-df118
import { ShapeUtils, Vector2 } from 'three'
import { faceFrame, toPartFrame, type StockSize } from '../../../../core/geometry/face'
import type { ConstructionSurface, Vec2 } from '../../../../core/geometry/model'
import type { ConstructionOverlay } from '../../viewport'

const signedArea = (loop: readonly Vec2[]): number => {
  let a = 0
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i]!
    const q = loop[(i + 1) % loop.length]!
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

/** True if `p` lies inside the closed loop (even-odd). */
function inside(p: Vec2, loop: readonly Vec2[]): boolean {
  let hit = false
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i]!
    const b = loop[j]!
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      hit = !hit
  }
  return hit
}

/**
 * The fill triangles of a patch in the face frame (`[u, v]` triples): loops wound like the
 * largest one are outlines, the others holes of the smallest outline around them.
 */
export function patchTriangles(loops: readonly (readonly Vec2[])[]): Vec2[] {
  const areas = loops.map(signedArea)
  const largest = areas.reduce((k, a, i) => (Math.abs(a) > Math.abs(areas[k]!) ? i : k), 0)
  const sign = Math.sign(areas[largest] ?? 1)
  const outers = loops.map((_, i) => i).filter((i) => Math.sign(areas[i]!) === sign)
  const holes = new Map<number, number[]>(outers.map((i) => [i, []]))
  loops.forEach((loop, i) => {
    if (Math.sign(areas[i]!) === sign || loop.length === 0) return
    const around = outers
      .filter((o) => inside(loop[0]!, loops[o]!))
      .sort((a, b) => Math.abs(areas[a]!) - Math.abs(areas[b]!))[0]
    if (around !== undefined) holes.get(around)!.push(i)
  })
  const out: Vec2[] = []
  for (const o of outers) {
    const contour = loops[o]!.map((p) => new Vector2(p[0], p[1]))
    const hs = holes.get(o)!.map((h) => loops[h]!.map((p) => new Vector2(p[0], p[1])))
    const all = [contour, ...hs].flat()
    for (const tri of ShapeUtils.triangulateShape(contour, hs))
      for (const k of tri) out.push([all[k]!.x, all[k]!.y])
  }
  return out
}

/**
 * The overlays of the given construction surfaces: loops and fill in the part frame, the glyph
 * point (the fill's area-weighted centroid, or the centre of its triangle nearest to it when the
 * centroid falls outside, as `surfaceGlyphs`) and the outward normal. `pickable`: pick mode offers
 * them. Surfaces with no area are left out.
 */
export function constructionOverlays(
  construction: readonly ConstructionSurface[],
  stock: StockSize,
  shown: ReadonlySet<string>,
  pickable: boolean,
): ConstructionOverlay[] {
  const out: ConstructionOverlay[] = []
  for (const c of construction) {
    if (!shown.has(c.surface)) continue
    const frame = faceFrame(c.patch.direction, stock)
    const z = c.patch.z
    const at = (p: Vec2) => toPartFrame(frame, [p[0], p[1], z])
    const tris = patchTriangles(c.patch.loops)
    if (tris.length === 0) continue
    const fill = new Float32Array(tris.length * 3)
    tris.forEach((p, i) => fill.set(at(p), 3 * i))
    let area = 0
    let cu = 0
    let cv = 0
    const centres: Vec2[] = []
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, d] = [tris[t]!, tris[t + 1]!, tris[t + 2]!]
      const w = Math.abs((b[0] - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (b[1] - a[1])) / 2
      const m: Vec2 = [(a[0] + b[0] + d[0]) / 3, (a[1] + b[1] + d[1]) / 3]
      centres.push(m)
      area += w
      cu += m[0] * w
      cv += m[1] * w
    }
    if (area <= 0) continue
    const centroid: Vec2 = [cu / area, cv / area]
    const within = c.patch.loops.filter((l) => inside(centroid, l)).length % 2 === 1
    const d2 = (p: Vec2) => (p[0] - centroid[0]) ** 2 + (p[1] - centroid[1]) ** 2
    const glyph = within ? centroid : centres.reduce((b, p) => (d2(p) < d2(b) ? p : b))
    out.push({
      surface: c.surface,
      loops: c.patch.loops.map((l) => l.map(at)),
      fill,
      at: at(glyph),
      normal: frame.n,
      pickable,
    })
  }
  return out
}
