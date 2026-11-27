// Go to preview (hardening DF128 GT2), drawn by the run layer in the setup's WCS while the Go to
// dialog is open: the planned steps as a dashed polyline from the tool tip through each step's end,
// and a target marker at the last one (a ring with a crosshair and a small chip), all in
// `--vp-selected`, the view's one accent, drawn over the part (no depth test) so a path through
// the stock stays visible. A new path fades in (`--motion-fast`; none under reduced motion);
// a changed target redraws at once. Props only.
// Doc: docs/modes/run-goto.md#preview, docs/conventions/ui.md#jog-position-and-probing-df88
import { Html, Line } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { Color, SRGBColorSpace, type Group, type Material, type Mesh } from 'three'
import type { Palette } from './colours'
import styles from './Viewport.module.css'

type P3 = readonly [number, number, number]

/** What the run layer draws for the open Go to dialog (`RunScene.goTo`), in work coordinates. */
export interface GoToOverlay {
  /** The tool tip, then each step's end (mm); the last point is the target. */
  readonly points: readonly P3[]
  /** The target chip's text ("Go to target"). */
  readonly label: string
}

/** `--motion-fast` (tokens.css), the fade-in. */
const FADE_MS = 120
/** The target ring's radii (mm). */
const RING = [3.4, 4.2] as const
const CROSS = 6

const noRaycast = (): void => {}

export function GoToPath({
  goTo,
  palette,
  reducedMotion = false,
}: {
  goTo: GoToOverlay
  palette: Palette
  reducedMotion?: boolean
}): React.JSX.Element | null {
  const invalidate = useThree((s) => s.invalidate)
  const group = useRef<Group>(null)
  const born = useRef<number | null>(null)
  const c = useMemo(() => {
    const [r, g, b] = palette.selected
    return new Color().setRGB(r, g, b, SRGBColorSpace)
  }, [palette])
  const points = useMemo(() => goTo.points.map((p): [number, number, number] => [...p]), [goTo])
  useEffect(() => invalidate(), [goTo, invalidate])
  useFrame(() => {
    const g = group.current
    if (g === null) return
    const now = performance.now()
    born.current ??= now
    const t = reducedMotion ? 1 : Math.min(1, (now - born.current) / FADE_MS)
    g.traverse((o) => {
      const m = (o as Mesh).material as Material | Material[] | undefined
      for (const mat of m === undefined ? [] : Array.isArray(m) ? m : [m]) {
        mat.transparent = true
        mat.opacity = t
      }
    })
    if (t < 1) invalidate()
  })
  const target = points[points.length - 1]
  if (points.length < 2 || target === undefined) return null
  return (
    <group ref={group} raycast={noRaycast}>
      <Line
        points={points}
        color={c}
        lineWidth={2}
        dashed
        dashSize={3}
        gapSize={2}
        depthTest={false}
        renderOrder={7}
        raycast={noRaycast}
      />
      <group position={[target[0], target[1], target[2]]}>
        <mesh raycast={noRaycast} renderOrder={7}>
          <ringGeometry args={[RING[0], RING[1], 32]} />
          <meshBasicMaterial color={c} depthTest={false} />
        </mesh>
        <Line
          points={[
            [-CROSS, 0, 0],
            [CROSS, 0, 0],
          ]}
          color={c}
          lineWidth={1.5}
          depthTest={false}
          renderOrder={7}
          raycast={noRaycast}
        />
        <Line
          points={[
            [0, -CROSS, 0],
            [0, CROSS, 0],
          ]}
          color={c}
          lineWidth={1.5}
          depthTest={false}
          renderOrder={7}
          raycast={noRaycast}
        />
        <Html zIndexRange={[18, 10]} className={styles['zSpotAnchor']}>
          <span className={styles['goToChip']} data-goto-target="" aria-hidden="true">
            {goTo.label}
          </span>
        </Html>
      </group>
    </group>
  )
}
