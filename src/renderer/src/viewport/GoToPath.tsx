// Go to preview (hardening DF128 GT2), drawn by the run layer in the setup's WCS while the Go to
// dialog is open: the planned steps as a dashed polyline from the tool tip through each step's end,
// and a target marker at the last one (a ring with a crosshair and a small chip), all in
// `--vp-selected`, the view's one accent, drawn over the part (no depth test) so a path through
// the stock stays visible. A new path fades in (`--motion-fast`; none under reduced motion);
// a changed target redraws at once. DF133 RW4: with the workholding guard's contact (`hit`) the path
// turns `--danger` from the contact on, the target marker too. Props only.
// Doc: docs/modes/run-goto.md#preview, docs/conventions/ui.md#jog-position-and-probing-df88,
// docs/modes/run-workholding.md#scene
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
  /**
   * DF133 RW4: the workholding guard's first contact, on the move to `points[step + 1]`, at `at`:
   * drawn in `--danger` from there on.
   */
  readonly hit?: { readonly step: number; readonly at: P3 } | undefined
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
  const danger = useMemo(() => {
    const [r, g, b] = palette.danger
    return new Color().setRGB(r, g, b, SRGBColorSpace)
  }, [palette])
  const points = useMemo(() => goTo.points.map((p): [number, number, number] => [...p]), [goTo])
  // DF133 RW4: accent up to the contact, `--danger` from it to the target
  const [clear, blocked] = useMemo((): [[number, number, number][], [number, number, number][]] => {
    const h = goTo.hit
    if (h === undefined) return [points, []]
    const at: [number, number, number] = [...h.at]
    return [
      [...points.slice(0, h.step + 1), at],
      [at, ...points.slice(h.step + 1)],
    ]
  }, [points, goTo.hit])
  const markColour = goTo.hit === undefined ? c : danger
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
        points={clear}
        color={c}
        lineWidth={2}
        dashed
        dashSize={3}
        gapSize={2}
        depthTest={false}
        renderOrder={7}
        raycast={noRaycast}
      />
      {blocked.length < 2 ? null : (
        <Line
          points={blocked}
          color={danger}
          lineWidth={2}
          dashed
          dashSize={3}
          gapSize={2}
          depthTest={false}
          renderOrder={7}
          raycast={noRaycast}
        />
      )}
      <group position={[target[0], target[1], target[2]]}>
        <mesh raycast={noRaycast} renderOrder={7}>
          <ringGeometry args={[RING[0], RING[1], 32]} />
          <meshBasicMaterial color={markColour} depthTest={false} />
        </mesh>
        <Line
          points={[
            [-CROSS, 0, 0],
            [CROSS, 0, 0],
          ]}
          color={markColour}
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
          color={markColour}
          lineWidth={1.5}
          depthTest={false}
          renderOrder={7}
          raycast={noRaycast}
        />
        <Html zIndexRange={[18, 10]} className={styles['zSpotAnchor']}>
          <span
            className={styles['goToChip']}
            data-goto-target=""
            data-hit={goTo.hit ? '' : undefined}
            aria-hidden="true"
          >
            {goTo.label}
          </span>
        </Html>
      </group>
    </group>
  )
}
