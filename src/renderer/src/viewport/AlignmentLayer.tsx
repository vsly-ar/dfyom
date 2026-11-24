// Alignment points of the shown setup (hardening DF78), drawn by the run layer in the setup's WCS
// on the up face (Z 0, where the pointer sights them from above): each a small diamond with a
// crosshair in the tool colour (the work zero's), `--danger` when it has an error, and its cycle
// number in a chip. The point selected in the inspector is drawn larger in `--vp-selected`. A new
// marker scales in (`--motion-base`; none under reduced motion). The points themselves are not
// pickable; while the inspector's "Pick in the viewport" is on, the valid sources are drawn as
// pick targets (`AlignmentTargets`, alignment.md S22): a hollow ring in `--aid` with a button at
// its centre (keyboard reachable, named after the source); a click adds that point. Props only.
// Doc: docs/modes/alignment.md#plan-ui, docs/conventions/ui.md#design-and-plan-controls-v02
import { Html, Line } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import { Color, SRGBColorSpace, type Group } from 'three'
import type { Palette, Rgb } from './colours'
import styles from './Viewport.module.css'

/** One alignment point as the run layer draws it (`RunScene.alignment`). */
export interface AlignmentMarker {
  readonly id: string
  /** Expected X, Y in the WCS (mm). */
  readonly at: readonly [number, number]
  /** Its number in the cycle (1 …). */
  readonly n: number
  readonly name: string
  readonly error: boolean
  readonly selected: boolean
}

/** Half the diamond's diagonal (mm). */
const SIZE = 2.2
/** `--motion-base` (tokens.css), the scale-in. */
const SCALE_IN_MS = 200

const noRaycast = (): void => {}
const colour = (c: Rgb) => new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)

const diamond = (r: number): [number, number, number][] => [
  [r, 0, 0],
  [0, r, 0],
  [-r, 0, 0],
  [0, -r, 0],
  [r, 0, 0],
]

function Marker({
  marker,
  palette,
  reducedMotion,
}: {
  marker: AlignmentMarker
  palette: Palette
  reducedMotion: boolean
}): React.JSX.Element {
  const invalidate = useThree((s) => s.invalidate)
  const group = useRef<Group>(null)
  const born = useRef<number | null>(null)
  useFrame(() => {
    const g = group.current
    if (g === null) return
    if (reducedMotion) return g.scale.setScalar(1)
    const now = performance.now()
    born.current ??= now
    const t = Math.min(1, (now - born.current) / SCALE_IN_MS)
    g.scale.setScalar(0.4 + 0.6 * (1 - (1 - t) ** 3))
    if (t < 1) invalidate()
  })
  const c = useMemo(
    () => colour(marker.error ? palette.danger : marker.selected ? palette.selected : palette.tool),
    [marker.error, marker.selected, palette],
  )
  const r = marker.selected ? SIZE * 1.5 : SIZE
  return (
    <group ref={group} position={[marker.at[0], marker.at[1], 0.05]}>
      <Line
        points={diamond(r)}
        color={c}
        lineWidth={marker.selected ? 2.25 : 1.75}
        depthTest={false}
        renderOrder={8}
        raycast={noRaycast}
      />
      <Line
        points={[
          [-r * 0.5, 0, 0],
          [r * 0.5, 0, 0],
        ]}
        color={c}
        lineWidth={1.25}
        depthTest={false}
        renderOrder={8}
        raycast={noRaycast}
      />
      <Line
        points={[
          [0, -r * 0.5, 0],
          [0, r * 0.5, 0],
        ]}
        color={c}
        lineWidth={1.25}
        depthTest={false}
        renderOrder={8}
        raycast={noRaycast}
      />
      <Html zIndexRange={[19, 10]} className={styles['zSpotAnchor']}>
        <span
          className={styles['alignChip']}
          data-align-point={marker.id}
          data-selected={marker.selected ? '' : undefined}
          data-error={marker.error ? '' : undefined}
          title={marker.name}
          aria-hidden="true"
        >
          {marker.n}
        </span>
      </Html>
    </group>
  )
}

export function AlignmentLayer({
  points,
  palette,
  reducedMotion = false,
}: {
  points: readonly AlignmentMarker[]
  palette: Palette
  reducedMotion?: boolean
}): React.JSX.Element {
  return (
    <group raycast={noRaycast}>
      {points.map((p) => (
        <Marker key={p.id} marker={p} palette={palette} reducedMotion={reducedMotion} />
      ))}
    </group>
  )
}

/** A source a point can be added from while picking (`RunScene.alignmentTargets`, S22). */
export interface AlignmentTarget {
  readonly key: string
  /** X, Y in the WCS (mm), on the up face. */
  readonly at: readonly [number, number]
  /** Accessible name: "Add Front-left corner (X 0 Y 0)". */
  readonly label: string
  readonly onPick: () => void
}

/** Ring radius of a pick target (mm). */
const TARGET_R = 1.8

function ring(r: number): [number, number, number][] {
  const out: [number, number, number][] = []
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2
    out.push([r * Math.cos(a), r * Math.sin(a), 0])
  }
  return out
}

export function AlignmentTargets({
  targets,
  palette,
}: {
  targets: readonly AlignmentTarget[]
  palette: Palette
}): React.JSX.Element {
  const c = useMemo(() => colour(palette.aid), [palette])
  const points = useMemo(() => ring(TARGET_R), [])
  return (
    <group raycast={noRaycast}>
      {targets.map((t) => (
        <group key={t.key} position={[t.at[0], t.at[1], 0.04]}>
          <Line
            points={points}
            color={c}
            lineWidth={1.5}
            dashed
            dashSize={0.6}
            gapSize={0.4}
            depthTest={false}
            renderOrder={7}
            raycast={noRaycast}
          />
          <Html zIndexRange={[20, 11]} className={styles['zSpotAnchor']}>
            <button
              type="button"
              className={styles['alignTarget']}
              data-align-source={t.key}
              aria-label={t.label}
              title={t.label}
              onClick={t.onPick}
            />
          </Html>
        </group>
      ))}
    </group>
  )
}
