// Scene overlays of v0.2's face picking and placement (tasks F1, F2): the normal glyphs of pick
// mode (a short arrow along each eligible face's outward normal, amber on the hovered one, growing
// in when pick mode starts), the face-frame axes of the selected operation's face (`u`, `v`,
// labelled, at the frame origin) and the anchor marker (an amber ring with ticks in the face
// plane). They draw what they are given; positions come from the pure modules (mesh.ts) and the
// caller. Doc: docs/conventions/ui.md#design-and-plan-controls-v02
import { Html, Line } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Color, Quaternion, SRGBColorSpace, Vector3 } from 'three'
import type { Palette, Rgb } from './colours'
import type { SurfaceGlyph, Vec3 } from './mesh'
import styles from './Viewport.module.css'

const noRaycast = (): void => {}

/** `--motion-base` (tokens.css): the glyphs grow in over this long. */
const GROW_MS = 180

function colour(c: Rgb): Color {
  return new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)
}

const add = (a: Vec3, b: Vec3, k = 1): [number, number, number] => [
  a[0] + b[0] * k,
  a[1] + b[1] * k,
  a[2] + b[2] * k,
]

/** Face-frame axes to draw (task F1): origin, unit `u` and `v`, their length and labels. */
export interface FrameOverlay {
  readonly origin: Vec3
  readonly u: Vec3
  readonly v: Vec3
  readonly length: number
  readonly labels: { readonly u: string; readonly v: string }
}

/** The anchor marker (task F2): the point the position fields give, in its face plane. */
export interface AnchorOverlay {
  readonly at: Vec3
  readonly u: Vec3
  readonly v: Vec3
}

/** 0 → 1 over `GROW_MS` after mount, invalidating the demand frameloop meanwhile; 1 when reduced. */
function useGrow(reduced: boolean): number {
  const invalidate = useThree((s) => s.invalidate)
  const start = useRef<number | null>(null)
  const [t, setT] = useState(reduced ? 1 : 0)
  useFrame(() => {
    if (reduced || t >= 1) return
    const now = performance.now()
    start.current ??= now
    const next = Math.min(1, (now - start.current) / GROW_MS)
    setT(next)
    if (next < 1) invalidate()
  })
  useEffect(() => invalidate(), [invalidate])
  return reduced ? 1 : 1 - (1 - t) ** 3 // ease out
}

/** Head proportions: a glyph's stubby head, and the slim head of the face-frame axes (CAD style). */
const GLYPH_HEAD = { length: 0.28, radius: 0.38 } as const
const AXIS_HEAD = { length: 0.14, radius: 0.24 } as const

/** One arrow: a shaft from `at` along `dir` and a cone head (`shape`: head length as a fraction of
 * the arrow, radius as a fraction of the head). */
function Arrow({
  at,
  dir,
  length,
  colour: c,
  width,
  onTop = false,
  shape = GLYPH_HEAD,
}: {
  at: Vec3
  dir: Vec3
  length: number
  colour: Color
  width: number
  onTop?: boolean
  shape?: { readonly length: number; readonly radius: number }
}): React.JSX.Element {
  const head = length * shape.length
  const radius = head * shape.radius
  const base = add(at, dir, length - head)
  const quaternion = useMemo(
    () => new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...dir)),
    [dir],
  )
  const centre = add(base, dir, head / 2)
  return (
    <group>
      <Line
        points={[[...at], base]}
        color={c}
        lineWidth={width}
        depthTest={!onTop}
        renderOrder={onTop ? 2 : 0}
        raycast={noRaycast}
      />
      <mesh
        position={centre}
        quaternion={quaternion}
        raycast={noRaycast}
        renderOrder={onTop ? 2 : 0}
      >
        <coneGeometry args={[radius, head, 16]} />
        <meshBasicMaterial color={c} depthTest={!onTop} />
      </mesh>
    </group>
  )
}

/** Normal glyphs of the eligible faces in pick mode; the hovered face's glyph is amber and longer. */
export function PickGlyphs({
  glyphs,
  hovered,
  size,
  palette,
  reducedMotion,
}: {
  glyphs: readonly SurfaceGlyph[]
  hovered: string | null
  /** Glyph length (mm) at rest. */
  size: number
  palette: Palette
  reducedMotion: boolean
}): React.JSX.Element {
  const grow = useGrow(reducedMotion)
  const rest = useMemo(() => colour(palette.edge), [palette])
  const hot = useMemo(() => colour(palette.selected), [palette])
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => invalidate(), [hovered, glyphs, invalidate])
  return (
    <group>
      {glyphs.map((g) => {
        const on = g.surface === hovered
        return (
          <Arrow
            key={g.surface}
            // lifted off the face so the shaft never z-fights with it
            at={add(g.at, g.normal, size * 0.04)}
            dir={g.normal}
            length={Math.max(1e-3, size * grow * (on ? 1.25 : 1))}
            colour={on ? hot : rest}
            width={on ? 2.5 : 1.5}
          />
        )
      })}
    </group>
  )
}

/** The selected operation's face frame: slim `u` and `v` arrows from the origin (thin shafts,
 * small heads), each labelled just past its tip on a chip that reads on any surface. */
export function FrameAxes({
  frame,
  palette,
}: {
  frame: FrameOverlay
  palette: Palette
}): React.JSX.Element {
  const c = useMemo(() => colour(palette.edge), [palette])
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => invalidate(), [frame, invalidate])
  const label = (axis: 'u' | 'v') => (
    <Html
      position={add(frame.origin, frame[axis], frame.length * 1.16)}
      center
      zIndexRange={[10, 0]}
      className={styles['axisLabel']}
    >
      <span aria-hidden="true">{frame.labels[axis]}</span>
    </Html>
  )
  return (
    <group>
      {(['u', 'v'] as const).map((axis) => (
        <Arrow
          key={axis}
          at={frame.origin}
          dir={frame[axis]}
          length={frame.length}
          colour={c}
          width={1.5}
          shape={AXIS_HEAD}
          onTop
        />
      ))}
      {label('u')}
      {label('v')}
    </group>
  )
}

/** The anchor point: an amber ring with four ticks along `u` and `v`, in the face plane, on top. */
export function AnchorMarker({
  anchor,
  size,
  palette,
}: {
  anchor: AnchorOverlay
  /** Ring radius (mm). */
  size: number
  palette: Palette
}): React.JSX.Element {
  const c = useMemo(() => colour(palette.selected), [palette])
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => invalidate(), [anchor, invalidate])
  const { at, u, v } = anchor
  const ring = useMemo(
    () =>
      Array.from({ length: 33 }, (_, i) => {
        const a = (i / 32) * 2 * Math.PI
        return add(add(at, u, size * Math.cos(a)), v, size * Math.sin(a))
      }),
    [at, u, v, size],
  )
  const ticks = useMemo(
    () =>
      [u, v, [-u[0], -u[1], -u[2]] as Vec3, [-v[0], -v[1], -v[2]] as Vec3].flatMap((d) => [
        add(at, d, size * 0.45),
        add(at, d, size * 1.6),
      ]),
    [at, u, v, size],
  )
  return (
    <group>
      <Line
        points={ring}
        color={c}
        lineWidth={2}
        depthTest={false}
        renderOrder={3}
        raycast={noRaycast}
      />
      <Line
        points={ticks}
        segments
        color={c}
        lineWidth={2}
        depthTest={false}
        renderOrder={3}
        raycast={noRaycast}
      />
    </group>
  )
}
