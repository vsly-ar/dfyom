// Run scene layer (task 3.12; plan mode's toolpaths too, 3.7): the toolpath played back (feeds
// `--vp-feed`, rapids `--vp-rapid`, plunges `--vp-plunge`, the done part and outdated toolpaths
// dimmed towards the background), the tool marker at the work position (`wpos`)
// and the work zero marker at the WCS origin, all in the setup's WCS, placed on the part by the
// setup's frame (identity for an unrotated top setup; task E2). Props only.
// Doc: docs/conventions/ui.md#viewport-task-35 (run scene), #run-mode-safety-ui
import { useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo } from 'react'
import { BufferAttribute, BufferGeometry, Color, Matrix4, SRGBColorSpace } from 'three'
import type { Placement } from '../../../core/geometry/model'
import { MIX, mix, toLinear, type Palette, type Rgb } from './colours'
import { SEGMENT, type ToolpathLines } from './toolpath-lines'

/** What the run scene shows (`Viewport` prop `run`). */
export interface RunScene {
  /** The program's toolpaths in machining order; `null` while unknown. */
  readonly lines: ToolpathLines | null
  /** Segments before this index are done (dimmed). */
  readonly done: number
  /**
   * Per toolpath (as `lines.starts`): outdated (stale or waiting for Apply), drawn dimmed towards
   * the background (plan scene, task P3; apply.md#stale-derived-results). Absent: none.
   */
  readonly outdated?: readonly boolean[] | undefined
  /** Tool tip in work coordinates (mm), `null` without a connection. */
  readonly tool: readonly [number, number, number] | null
  /**
   * The setup's WCS in the part frame (`setupFrame`, docs/modes/plan-v0.2.md#implementation-task-c3):
   * the layer is drawn through it, so a bottom or side setup lands on the part. Absent = identity.
   */
  readonly frame?: Placement
}

/** The placement as a three.js matrix (columns u, v, n, origin). */
export function frameMatrix(frame: Placement): Matrix4 {
  const { u, v, n, origin: o } = frame
  return new Matrix4().set(
    u[0],
    v[0],
    n[0],
    o[0],
    u[1],
    v[1],
    n[1],
    o[1],
    u[2],
    v[2],
    n[2],
    o[2],
    0,
    0,
    0,
    1,
  )
}

/** How far done segments fade towards the background. */
export const DONE_DIM = 0.7
/** How far outdated toolpaths fade towards the background (`MIX.outdated`). */
export const OUTDATED_DIM = MIX.outdated

const noRaycast = (): void => {}

const colour = (c: Rgb) => new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)

/** Linear vertex colours of the segments (2 vertices each), done and outdated ones dimmed. Pure. */
export function segmentColours(
  lines: ToolpathLines,
  done: number,
  palette: Pick<Palette, 'feed' | 'rapid' | 'plunge' | 'background'>,
  out: Float32Array = new Float32Array(lines.segments * 6),
  outdated?: readonly boolean[],
): Float32Array {
  const base = [palette.feed, palette.rapid, palette.plunge] as const
  const live = base.map(toLinear)
  const dim = base.map((c) => toLinear(mix(c, palette.background, DONE_DIM)))
  const old = base.map((c) => toLinear(mix(c, palette.background, OUTDATED_DIM)))
  let path = -1
  let next = 0
  for (let i = 0; i < lines.segments; i++) {
    while (next < lines.starts.length && (lines.starts[next] ?? Infinity) <= i) {
      path = next
      next++
    }
    const k = lines.kind[i] ?? SEGMENT.feed
    const set = i < done ? dim : outdated?.[path] === true ? old : live
    const v = set[k] ?? live[SEGMENT.feed]!
    out.set(v, 6 * i)
    out.set(v, 6 * i + 3)
  }
  return out
}

export function RunLayer({ run, palette }: { run: RunScene; palette: Palette }): React.JSX.Element {
  const invalidate = useThree((s) => s.invalidate)
  const { lines, done, tool, frame, outdated } = run
  const matrix = useMemo(() => (frame === undefined ? undefined : frameMatrix(frame)), [frame])
  const geometry = useMemo(() => {
    if (lines === null || lines.segments === 0) return null
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(lines.positions, 3))
    g.setAttribute('color', new BufferAttribute(new Float32Array(lines.segments * 6), 3))
    g.computeBoundingSphere()
    return g
  }, [lines])
  useEffect(() => () => geometry?.dispose(), [geometry])
  useLayoutEffect(() => {
    if (geometry === null || lines === null) return
    const attr = geometry.getAttribute('color') as BufferAttribute
    segmentColours(lines, done, palette, attr.array as Float32Array, outdated)
    attr.needsUpdate = true
    invalidate()
  }, [geometry, lines, done, outdated, palette, invalidate])
  useEffect(() => invalidate(), [tool, invalidate])

  const toolColour = useMemo(() => colour(palette.tool), [palette])
  return (
    <group {...(matrix === undefined ? {} : { matrix, matrixAutoUpdate: false })}>
      {geometry ? (
        <lineSegments geometry={geometry} raycast={noRaycast} renderOrder={2}>
          <lineBasicMaterial vertexColors />
        </lineSegments>
      ) : null}
      {/* work zero: a ring with a dot at the WCS origin */}
      <group raycast={noRaycast}>
        <mesh raycast={noRaycast}>
          <ringGeometry args={[2.5, 3.2, 32]} />
          <meshBasicMaterial color={toolColour} />
        </mesh>
        <mesh raycast={noRaycast}>
          <sphereGeometry args={[0.9, 12, 8]} />
          <meshBasicMaterial color={toolColour} />
        </mesh>
      </group>
      {tool ? (
        // tool marker: a cone with its tip at the tool tip, and the shank above it
        <group position={[tool[0], tool[1], tool[2]]}>
          <mesh position={[0, 0, 3]} rotation={[-Math.PI / 2, 0, 0]} raycast={noRaycast}>
            <coneGeometry args={[3, 6, 24]} />
            <meshStandardMaterial color={toolColour} roughness={0.6} />
          </mesh>
          <mesh position={[0, 0, 16]} rotation={[Math.PI / 2, 0, 0]} raycast={noRaycast}>
            <cylinderGeometry args={[3, 3, 20, 24]} />
            <meshStandardMaterial color={toolColour} roughness={0.6} transparent opacity={0.6} />
          </mesh>
        </group>
      ) : null}
    </group>
  )
}
