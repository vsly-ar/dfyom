// The compare overlay's colours on the part (DF60 P5): a diverging map per vertex from the signed
// distance to the reference: neutral `--vp-part` within ± threshold, then from `NEAR` to full
// `--danger` (missing material: the part surface lies inside the reference) or `--info` (extra
// material: outside it) at the largest deviation shown. Pure (no three.js), unit-tested in Node.
// Doc: docs/conventions/ui.md#reference-tools-df60, docs/modes/reference-tools.md#overlay-ui
import { FALLBACK, mix, toLinear, type Palette, type Rgb } from './colours'
import { triangleCount, type Box, type ViewportMesh } from './mesh'

/** What the viewport draws of a compare (ui-store `referenceCompare`, matched to the mesh). */
export interface DeviationView {
  /** Signed distance per vertex of the mesh drawn (mm): + extra, − missing. */
  readonly distances: Float32Array
  /** Within ± this the part keeps its colour (mm). */
  readonly threshold: number
  /** The deviation drawn at full colour, per kind (mm, ≥ the threshold). */
  readonly scale: { readonly missing: number; readonly extra: number }
  /** The missing pieces over the threshold (triangle soup, part frame), or null. */
  readonly missing: Float32Array | null
  /** The chosen region's box (part frame), drawn as lines; null without one. */
  readonly region: Box | null
}

/** Share of the hue at the threshold: a deviation just over it is already visible. */
export const NEAR = 0.35

/**
 * The sRGB colour of a vertex at signed distance `d`: the part colour within ± `threshold`,
 * then `NEAR` → 1 of the kind's colour at its `scale`.
 */
export function deviationColour(
  d: number,
  threshold: number,
  scale: DeviationView['scale'],
  palette: Pick<Palette, 'part' | 'danger' | 'info'>,
): Rgb {
  if (!Number.isFinite(d) || Math.abs(d) <= threshold) return palette.part
  const top = d < 0 ? scale.missing : scale.extra
  const span = top - threshold
  const t = span <= 0 ? 1 : Math.min(1, (Math.abs(d) - threshold) / span)
  return mix(palette.part, d < 0 ? palette.danger : palette.info, NEAR + (1 - NEAR) * t)
}

/** The largest deviation of each kind over the distances, at least `2 × threshold`. */
export function deviationScale(distances: Float32Array, threshold: number): DeviationView['scale'] {
  let missing = 0
  let extra = 0
  for (const d of distances) {
    if (!Number.isFinite(d)) continue
    if (d < -missing) missing = -d
    if (d > extra) extra = d
  }
  return { missing: Math.max(missing, 2 * threshold), extra: Math.max(extra, 2 * threshold) }
}

/**
 * Linear vertex colours for the non-indexed render geometry (9 floats per triangle), each corner
 * its vertex's map colour; `weight` 0..1 fades from `base` (the surface colours) to the map.
 */
export function deviationColours(
  mesh: ViewportMesh,
  view: Pick<DeviationView, 'distances' | 'threshold' | 'scale'>,
  palette: Pick<Palette, 'part' | 'danger' | 'info'>,
  weight: number,
  base: Float32Array,
  out: Float32Array = new Float32Array(triangleCount(mesh) * 9),
): Float32Array {
  const n = triangleCount(mesh)
  const w = Math.min(1, Math.max(0, weight))
  const cache = new Map<number, Rgb>()
  for (let t = 0; t < n; t++)
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[3 * t + k]!
      let c = cache.get(v)
      if (c === undefined) {
        const d = view.distances[v]
        c =
          d === undefined
            ? FALLBACK
            : toLinear(deviationColour(d, view.threshold, view.scale, palette))
        cache.set(v, c)
      }
      const o = 9 * t + 3 * k
      for (let i = 0; i < 3; i++) out[o + i] = base[o + i]! + (c[i]! - base[o + i]!) * w
    }
  return out
}
