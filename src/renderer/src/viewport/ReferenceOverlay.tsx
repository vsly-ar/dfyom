// The Reference panel's read-outs on the ghost (DF60 P1 follow-ups): the fitted section loops as
// `--vp-selected` lines (1.5 px) at the section plane, the sharp inside corners as small
// `--warning` rings in that plane, and the level row under the pointer as its faces in
// `--vp-hover` (drawn with the ghost's matrix). Drawn over everything, never pickable; it fades
// in like the ghost. The caller computes the geometry (ADR 0010).
// Doc: docs/conventions/ui.md#reference-tools-df60
import { Line } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Matrix4,
  SRGBColorSpace,
  type MeshBasicMaterial,
} from 'three'
import type { Palette, Rgb } from './colours'
import type { Vec3 } from './mesh'

/** The overlay as the viewport draws it. */
export interface ReferenceOverlayView {
  /** Fitted loops as segments, 6 numbers each (part frame, mm). */
  readonly lines: Float32Array
  /** Sharp inside corners (part frame, mm). */
  readonly corners: readonly Vec3[]
  /** The section plane's axes (part frame), for the corner rings. */
  readonly axes: { readonly u: Vec3; readonly v: Vec3 }
  /** The hovered level's triangles (source units) and the ghost's model matrix, or null. */
  readonly highlight: {
    readonly positions: Float32Array
    readonly matrix: readonly number[]
  } | null
}

/** Opacity of the hovered level's faces. */
export const LEVEL_HIGHLIGHT_OPACITY = 0.55
/** `--motion-fast` (tokens.css): the highlight fades in. */
const FADE_MS = 120

const noRaycast = (): void => {}
const colour = (c: Rgb) => new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)

export function ReferenceOverlay({
  overlay,
  palette,
  ringSize,
  reducedMotion,
}: {
  overlay: ReferenceOverlayView
  palette: Palette
  /** Corner ring radius (mm). */
  ringSize: number
  reducedMotion: boolean
}): React.JSX.Element {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => invalidate(), [overlay, invalidate])
  const { lines, corners, axes, highlight } = overlay
  const points = useMemo(() => {
    const out: [number, number, number][] = []
    for (let i = 0; i + 5 < lines.length; i += 6)
      out.push(
        [lines[i]!, lines[i + 1]!, lines[i + 2]!],
        [lines[i + 3]!, lines[i + 4]!, lines[i + 5]!],
      )
    return out
  }, [lines])
  const rings = useMemo(
    () =>
      corners.map((at) =>
        Array.from({ length: 25 }, (_, i) => {
          const a = (i / 24) * 2 * Math.PI
          const c = ringSize * Math.cos(a)
          const s = ringSize * Math.sin(a)
          return [0, 1, 2].map((k) => at[k]! + axes.u[k]! * c + axes.v[k]! * s) as [
            number,
            number,
            number,
          ]
        }),
      ),
    [corners, axes, ringSize],
  )
  const selected = useMemo(() => colour(palette.selected), [palette])
  const warning = useMemo(() => colour(palette.warning), [palette])
  return (
    <group>
      {points.length > 0 ? (
        <Line
          points={points}
          segments
          color={selected}
          lineWidth={1.5}
          depthTest={false}
          renderOrder={6}
          raycast={noRaycast}
        />
      ) : null}
      {rings.map((r, i) => (
        <Line
          key={i}
          points={r}
          color={warning}
          lineWidth={1.5}
          depthTest={false}
          renderOrder={7}
          raycast={noRaycast}
        />
      ))}
      {highlight ? (
        <LevelHighlight
          highlight={highlight}
          colour={palette.hover}
          reducedMotion={reducedMotion}
        />
      ) : null}
    </group>
  )
}

function LevelHighlight({
  highlight,
  colour: c,
  reducedMotion,
}: {
  highlight: NonNullable<ReferenceOverlayView['highlight']>
  colour: Rgb
  reducedMotion: boolean
}): React.JSX.Element {
  const invalidate = useThree((s) => s.invalidate)
  const geometry = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(highlight.positions, 3))
    g.computeBoundingSphere()
    return g
  }, [highlight.positions])
  useEffect(() => () => geometry.dispose(), [geometry])
  const matrix = useMemo(() => new Matrix4().fromArray([...highlight.matrix]), [highlight.matrix])
  const tint = useMemo(() => colour(c), [c])
  const material = useRef<MeshBasicMaterial>(null)
  const start = useRef<number | null>(null)
  useEffect(() => {
    start.current = null
    invalidate()
  }, [geometry, invalidate])
  useFrame(({ clock }) => {
    const now = clock.getElapsedTime() * 1000
    start.current ??= now
    const t = reducedMotion ? 1 : Math.min(1, (now - start.current) / FADE_MS)
    if (material.current) material.current.opacity = LEVEL_HIGHLIGHT_OPACITY * t
    if (t < 1) invalidate()
  })
  return (
    <group matrixAutoUpdate={false} matrix={matrix}>
      <mesh geometry={geometry} raycast={noRaycast} renderOrder={5}>
        <meshBasicMaterial
          ref={material}
          color={tint}
          transparent
          opacity={reducedMotion ? LEVEL_HIGHLIGHT_OPACITY : 0}
          depthWrite={false}
          depthTest={false}
          side={DoubleSide}
        />
      </mesh>
    </group>
  )
}
