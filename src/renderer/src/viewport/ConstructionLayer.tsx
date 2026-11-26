// Construction surfaces (DF118 V3): a referenced surface later cuts removed, drawn as the CAD
// datum-plane look – a dashed outline at its level in `--vp-selected` with a light fill and no depth
// write – from the evaluation's patches (the mesh has none of it). In pick mode the fill takes
// hover and clicks like an eligible face. Fades in (`DEVIATION_FADE_MS`), at once under reduced
// motion. Doc: docs/modes/construction-surfaces.md#ui, docs/conventions/ui.md#construction-surfaces-df118
import { Line } from '@react-three/drei'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  SRGBColorSpace,
  type Group,
  type Material,
} from 'three'
import type { Palette, Rgb } from './colours'
import { MIX } from './colours'
import { useFadeIn } from './DeviationLayer'
import { surfaceOwner, type SurfaceTarget, type Vec3 } from './mesh'

/** One construction surface as the viewport draws it (part frame, mm). */
export interface ConstructionOverlay {
  readonly surface: string
  /** Boundary loops (closed, the first point not repeated). */
  readonly loops: readonly (readonly Vec3[])[]
  /** Fill triangles, 9 floats each. */
  readonly fill: Float32Array
  /** The pick glyph's point (on the patch) and the outward normal. */
  readonly at: Vec3
  readonly normal: Vec3
  /** Pick mode offers it: the fill takes hover and clicks. */
  readonly pickable: boolean
}

const noRaycast = (): void => {}
const colour = (c: Rgb): Color => new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)

export function ConstructionLayer({
  overlays,
  hovered,
  palette,
  reducedMotion,
  onHover,
  onClick,
}: {
  overlays: readonly ConstructionOverlay[]
  hovered: string | null
  palette: Palette
  reducedMotion: boolean
  onHover: (target: SurfaceTarget | undefined) => void
  onClick: (target: SurfaceTarget, event: ThreeEvent<MouseEvent>) => void
}): React.JSX.Element {
  const group = useRef<Group>(null)
  const key = overlays.map((o) => o.surface).join('\n')
  // every material of the layer fades in together; each keeps its full opacity in userData
  useFadeIn(key, reducedMotion, (t) => {
    group.current?.traverse((o) => {
      const m = (o as { material?: Material }).material
      if (m === undefined) return
      const full = (m.userData['full'] as number | undefined) ?? m.opacity
      m.userData['full'] = full
      m.opacity = full * t
    })
  })
  return (
    <group ref={group}>
      {overlays.map((o) => (
        <Patch
          key={o.surface}
          overlay={o}
          hot={o.surface === hovered}
          palette={palette}
          onHover={onHover}
          onClick={onClick}
        />
      ))}
    </group>
  )
}

function Patch({
  overlay,
  hot,
  palette,
  onHover,
  onClick,
}: {
  overlay: ConstructionOverlay
  hot: boolean
  palette: Palette
  onHover: (target: SurfaceTarget | undefined) => void
  onClick: (target: SurfaceTarget, event: ThreeEvent<MouseEvent>) => void
}): React.JSX.Element {
  const invalidate = useThree((s) => s.invalidate)
  const geometry = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(overlay.fill, 3))
    g.computeBoundingSphere()
    return g
  }, [overlay.fill])
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => invalidate(), [hot, overlay, invalidate])
  const accent = useMemo(() => colour(palette.selected), [palette])
  const target: SurfaceTarget = {
    surface: overlay.surface,
    operation: surfaceOwner(overlay.surface),
  }
  // lifted a hair off its level towards the outside, so a coincident face never z-fights it
  const lift = overlay.normal.map((x) => x * 0.01) as unknown as [number, number, number]
  return (
    <group position={lift}>
      <mesh
        geometry={geometry}
        renderOrder={3}
        {...(overlay.pickable
          ? {
              onPointerMove: (e: ThreeEvent<PointerEvent>) => {
                e.stopPropagation()
                onHover(target)
              },
              onPointerOut: () => onHover(undefined),
              onClick: (e: ThreeEvent<MouseEvent>) => {
                e.stopPropagation()
                onClick(target, e)
              },
            }
          : { raycast: noRaycast })}
      >
        <meshBasicMaterial
          color={accent}
          transparent
          opacity={hot ? MIX.pickHover : MIX.pickEligible}
          depthWrite={false}
          side={DoubleSide}
          // a new material when it turns hot, so the fade's stored opacity follows
          key={hot ? 'hot' : 'rest'}
        />
      </mesh>
      {overlay.loops
        .filter((l) => l.length >= 2)
        .map((l, i) => (
          <Line
            key={i}
            points={[...l, l[0]!].map((p) => [p[0], p[1], p[2]] as [number, number, number])}
            color={accent}
            lineWidth={hot ? 2.5 : 1.5}
            dashed
            dashSize={1.2}
            gapSize={0.8}
            transparent
            opacity={1}
            depthTest={false}
            renderOrder={4}
            raycast={noRaycast}
          />
        ))}
    </group>
  )
}
