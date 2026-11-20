// Run scene layer (task 3.12): the toolpath played back (feeds `--vp-feed`, rapids `--vp-rapid`,
// the done part dimmed towards the background), the tool marker at the work position (`wpos`)
// and the work zero marker at the WCS origin (= the part origin). Props only.
// Doc: docs/conventions/ui.md#viewport-task-35 (run scene), #run-mode-safety-ui
import { useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo } from 'react'
import { BufferAttribute, BufferGeometry, Color, SRGBColorSpace } from 'three'
import { mix, toLinear, type Palette, type Rgb } from './colours'
import type { ToolpathLines } from './toolpath-lines'

/** What the run scene shows (`Viewport` prop `run`). */
export interface RunScene {
  /** The program's toolpaths in machining order; `null` while unknown. */
  readonly lines: ToolpathLines | null
  /** Segments before this index are done (dimmed). */
  readonly done: number
  /** Tool tip in work coordinates (mm), `null` without a connection. */
  readonly tool: readonly [number, number, number] | null
}

/** How far done segments fade towards the background. */
export const DONE_DIM = 0.7

const noRaycast = (): void => {}

const colour = (c: Rgb) => new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)

/** Linear vertex colours of the segments (2 vertices each), done ones dimmed. Pure. */
export function segmentColours(
  lines: ToolpathLines,
  done: number,
  palette: Pick<Palette, 'feed' | 'rapid' | 'background'>,
  out: Float32Array = new Float32Array(lines.segments * 6),
): Float32Array {
  const c = {
    feed: toLinear(palette.feed),
    rapid: toLinear(palette.rapid),
    feedDone: toLinear(mix(palette.feed, palette.background, DONE_DIM)),
    rapidDone: toLinear(mix(palette.rapid, palette.background, DONE_DIM)),
  }
  for (let i = 0; i < lines.segments; i++) {
    const rapid = lines.rapid[i] === 1
    const v = i < done ? (rapid ? c.rapidDone : c.feedDone) : rapid ? c.rapid : c.feed
    out.set(v, 6 * i)
    out.set(v, 6 * i + 3)
  }
  return out
}

export function RunLayer({ run, palette }: { run: RunScene; palette: Palette }): React.JSX.Element {
  const invalidate = useThree((s) => s.invalidate)
  const { lines, done, tool } = run
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
    segmentColours(lines, done, palette, attr.array as Float32Array)
    attr.needsUpdate = true
    invalidate()
  }, [geometry, lines, done, palette, invalidate])
  useEffect(() => invalidate(), [tool, invalidate])

  const toolColour = useMemo(() => colour(palette.tool), [palette])
  return (
    <group>
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
