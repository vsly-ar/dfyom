// The compare overlay's 3D parts besides the part's colours (DF60 P5): the missing pieces as
// translucent `--danger` volumes (no depth writes, never pickable), fading in over `--motion-base`
// (instant with reduced motion), and the chosen region's box as `--vp-selected` lines over
// everything. The part's diverging map is drawn by `PartMesh` (`deviation.ts`). The Plan deviation
// panel's chosen region is `RegionMarker` (U4 follow-up).
// Doc: docs/conventions/ui.md#reference-tools-df60, docs/conventions/ui.md#deviation-panel
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  SRGBColorSpace,
  type LineBasicMaterial,
  type MeshBasicMaterial,
} from 'three'
import type { Palette, Rgb } from './colours'
import type { DeviationView } from './deviation'
import type { Box } from './mesh'

/** The missing volumes' opacity. */
export const MISSING_OPACITY = 0.3
/** `--motion-base`: the map and the volumes fade in this long (ms). */
export const DEVIATION_FADE_MS = 180

const noRaycast = (): void => {}
const colour = (c: Rgb): Color => new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)

/** 0 → 1 over `DEVIATION_FADE_MS` from each change of `key` (1 at once with reduced motion). */
export function useFadeIn(key: unknown, reducedMotion: boolean, apply: (t: number) => void): void {
  const invalidate = useThree((s) => s.invalidate)
  const start = useRef<number | null>(null)
  useEffect(() => {
    start.current = null
    invalidate()
  }, [key, invalidate])
  useFrame(({ clock }) => {
    if (start.current === -1) return
    const now = clock.getElapsedTime() * 1000
    start.current ??= now
    const t = reducedMotion ? 1 : Math.min(1, (now - start.current) / DEVIATION_FADE_MS)
    apply(t)
    if (t < 1) invalidate()
    else start.current = -1
  })
}

export function DeviationLayer({
  deviation,
  palette,
  reducedMotion,
}: {
  deviation: DeviationView
  palette: Palette
  reducedMotion: boolean
}): React.JSX.Element {
  return (
    <group>
      {deviation.missing !== null && deviation.missing.length > 0 ? (
        <MissingVolumes soup={deviation.missing} palette={palette} reducedMotion={reducedMotion} />
      ) : null}
      {deviation.region !== null ? <RegionBox box={deviation.region} palette={palette} /> : null}
    </group>
  )
}

function MissingVolumes({
  soup,
  palette,
  reducedMotion,
}: {
  soup: Float32Array
  palette: Palette
  reducedMotion: boolean
}) {
  const geometry = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(soup, 3))
    g.computeVertexNormals()
    g.computeBoundingSphere()
    return g
  }, [soup])
  useEffect(() => () => geometry.dispose(), [geometry])
  const tint = useMemo(() => colour(palette.danger), [palette])
  const material = useRef<MeshBasicMaterial>(null)
  useFadeIn(geometry, reducedMotion, (t) => {
    if (material.current) material.current.opacity = MISSING_OPACITY * t
  })
  return (
    <mesh geometry={geometry} raycast={noRaycast} renderOrder={3} userData={{ compare: 'missing' }}>
      <meshBasicMaterial
        ref={material}
        color={tint}
        transparent
        opacity={reducedMotion ? MISSING_OPACITY : 0}
        depthWrite={false}
        side={DoubleSide}
      />
    </mesh>
  )
}

/** The 12 edges of a box as line segments. */
export function boxEdges(b: Box): Float32Array {
  const c = (i: number): [number, number, number] => [
    i & 1 ? b.max[0] : b.min[0],
    i & 2 ? b.max[1] : b.min[1],
    i & 4 ? b.max[2] : b.min[2],
  ]
  const out: number[] = []
  for (let i = 0; i < 8; i++)
    for (const bit of [1, 2, 4]) if (!(i & bit)) out.push(...c(i), ...c(i | bit))
  return new Float32Array(out)
}

function RegionBox({ box, palette }: { box: Box; palette: Palette }) {
  const geometry = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(boxEdges(box), 3))
    return g
  }, [box])
  useEffect(() => () => geometry.dispose(), [geometry])
  const tint = useMemo(() => colour(palette.selected), [palette])
  return (
    <lineSegments geometry={geometry} raycast={noRaycast} renderOrder={6}>
      <lineBasicMaterial color={tint} depthTest={false} transparent />
    </lineSegments>
  )
}

/** The deviation panel's chosen region (Plan, U4 follow-up): its box (part frame) and sign. */
export interface RegionMarkerView {
  readonly box: Box
  readonly sign: 'overcut' | 'undercut'
  /** Added to the viewport's text summary ("Marked: Over-cut 0.5 mm, top."). */
  readonly label?: string
}

/**
 * The chosen region of the plan's comparison (docs/modes/deviation.md#region-marker-u4-follow-up):
 * its box's edges over everything in the row's swatch colour (`--danger` over-cut, `--info`
 * under-cut), fading in over `--motion-base`; never pickable.
 */
export function RegionMarker({
  marker,
  palette,
  reducedMotion,
}: {
  marker: RegionMarkerView
  palette: Palette
  reducedMotion: boolean
}): React.JSX.Element {
  const geometry = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(boxEdges(marker.box), 3))
    return g
  }, [marker.box])
  useEffect(() => () => geometry.dispose(), [geometry])
  const tint = useMemo(
    () => colour(marker.sign === 'overcut' ? palette.danger : palette.info),
    [palette, marker.sign],
  )
  const material = useRef<LineBasicMaterial>(null)
  useFadeIn(geometry, reducedMotion, (t) => {
    if (material.current) material.current.opacity = t
  })
  return (
    <lineSegments
      geometry={geometry}
      raycast={noRaycast}
      renderOrder={6}
      userData={{ deviationRegion: marker.sign }}
    >
      <lineBasicMaterial
        ref={material}
        color={tint}
        depthTest={false}
        transparent
        opacity={reducedMotion ? 1 : 0}
      />
    </lineSegments>
  )
}
