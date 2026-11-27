// The holder ghost (hardening DF132 H5), drawn by the run layer in the setup's WCS: the shown
// operation's tool (up to its stickout), collet nut and spindle body (broken off) as translucent
// neutral cylinders (`--vp-edge`, no depth write, so the clamps and toolpaths read through) with
// their rims outlined, the tip at the move that decides the minimum stickout; `--danger` when that
// move is a `holder` collision. A chip beside the nut face gives "Stickout 25 mm · needs 36 mm".
// Never pickable. Props only.
// Doc: docs/modes/tool-holder.md#implementation-h5, docs/conventions/ui.md#workholding
import { Html, Line } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { Color, SRGBColorSpace } from 'three'
import type { Palette } from './colours'
import styles from './Viewport.module.css'

/** What the run layer draws for the shown operation's holder (`RunScene.holder`). */
export interface HolderGhostOverlay {
  /** Changes when the ghost moves (operation and tip). */
  readonly key: string
  /** The tool tip (WCS, mm). */
  readonly tip: readonly [number, number, number]
  /** Tool, nut and body: radius and Z band above the tip (mm), the body cut to a finite length. */
  readonly parts: readonly {
    readonly part: 'tool' | 'nut' | 'body'
    readonly radius: number
    readonly zFrom: number
    readonly zTo: number
  }[]
  /** The ghost stands at a `holder` collision's first hit: drawn in `--danger`. */
  readonly colliding: boolean
  /** The dimension chip's text. */
  readonly label: string
}

/** Fill opacity per part: the tool a step stronger than the nut, the body the faintest. */
export const GHOST_FILL = { tool: 0.38, nut: 0.26, body: 0.14 } as const
/** Rim outline opacity. */
export const GHOST_RIM = 0.75

const noRaycast = (): void => {}
const SEGMENTS = 40

/** A part's two rims (bottom, top) as closed rings at the part's Z band (tip frame, mm). Pure. */
export function ghostRims(
  radius: number,
  zFrom: number,
  zTo: number,
  n = SEGMENTS,
): [number, number, number][][] {
  const ring = (z: number) =>
    Array.from({ length: n + 1 }, (_, i): [number, number, number] => {
      const a = (2 * Math.PI * i) / n
      return [radius * Math.cos(a), radius * Math.sin(a), z]
    })
  return [ring(zFrom), ring(zTo)]
}

export function HolderGhost({
  ghost,
  palette,
}: {
  ghost: HolderGhostOverlay
  palette: Palette
}): React.JSX.Element {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => invalidate(), [ghost, invalidate])
  const tint = useMemo(() => {
    const c = ghost.colliding ? palette.danger : palette.edge
    return new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)
  }, [ghost.colliding, palette])
  const nut = ghost.parts.find((p) => p.part === 'nut')
  const chipAt: [number, number, number] = [(nut?.radius ?? 3) + 2, 0, nut?.zFrom ?? 0]
  return (
    <group position={[ghost.tip[0], ghost.tip[1], ghost.tip[2]]} raycast={noRaycast}>
      {ghost.parts.map((p) => {
        const h = p.zTo - p.zFrom
        if (!(h > 0) || !(p.radius > 0)) return null
        const [bottom, top] = ghostRims(p.radius, p.zFrom, p.zTo)
        return (
          <group key={p.part}>
            <mesh
              position={[0, 0, p.zFrom + h / 2]}
              rotation={[Math.PI / 2, 0, 0]}
              raycast={noRaycast}
              renderOrder={5}
            >
              <cylinderGeometry args={[p.radius, p.radius, h, SEGMENTS, 1, p.part === 'body']} />
              <meshStandardMaterial
                color={tint}
                roughness={0.7}
                metalness={0.1}
                transparent
                opacity={GHOST_FILL[p.part]}
                depthWrite={false}
              />
            </mesh>
            <Line
              points={bottom!}
              color={tint}
              lineWidth={1}
              transparent
              opacity={GHOST_RIM}
              raycast={noRaycast}
              renderOrder={5}
            />
            <Line
              points={top!}
              color={tint}
              lineWidth={1}
              transparent
              opacity={p.part === 'body' ? GHOST_RIM / 2 : GHOST_RIM}
              // the body is broken off: its top rim dashed
              {...(p.part === 'body' ? { dashed: true, dashSize: 2, gapSize: 1.5 } : {})}
              raycast={noRaycast}
              renderOrder={5}
            />
          </group>
        )
      })}
      <Html position={chipAt} zIndexRange={[20, 10]} className={styles['zSpotAnchor']}>
        <span
          className={styles['zSpotChip']}
          data-holder-ghost=""
          data-colliding={ghost.colliding ? '' : undefined}
        >
          {ghost.label}
        </span>
      </Html>
    </group>
  )
}
