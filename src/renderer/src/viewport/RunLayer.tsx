// Run scene layer (task 3.12; plan mode's toolpaths too, 3.7): the toolpath played back (feeds
// `--vp-feed`, rapids `--vp-rapid`, plunges `--vp-plunge`, the done part and outdated toolpaths
// dimmed towards the background), the tool marker at the work position (`wpos`)
// and the work zero marker at the WCS origin, all in the setup's WCS, placed on the part by the
// setup's frame (identity for an unrotated top setup; task E2); in the plan scene a tool run's Z
// reference and touch-off spot (DF69, ZRefLayer.tsx) and the setup's workholding
// (WorkholdingLayer.tsx, workholding.md; in the run scene too, outlined until the place is
// known, DF133 RW1); an operation's rest after its roughing (DF122,
// RestLayer.tsx); the shown operation's holder ghost (DF132 H5, HolderGhost.tsx); the open Go to dialog's path and target (DF128 GT2, GoToPath.tsx); an interrupted
// run's last seen tool position as a translucent ghost tool (DF129 RC6; `--danger` when it was
// inside an item, DF133 RW5). Props only.
// Doc: docs/conventions/ui.md#viewport-task-35 (run scene), #run-mode-safety-ui
import { useThree } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import { useEffect, useLayoutEffect, useMemo } from 'react'
import { BufferAttribute, BufferGeometry, Color, Matrix4, SRGBColorSpace } from 'three'
import type { Placement } from '../../../core/geometry/model'
import { MIX, mix, toLinear, type Palette, type Rgb } from './colours'
import { SEGMENT, type ToolpathLines } from './toolpath-lines'
import {
  AlignmentLayer,
  AlignmentTargets,
  FlipAxes,
  type AlignmentMarker,
  type AlignmentTarget,
  type FlipAxisLine,
} from './AlignmentLayer'
import { AidHandles, type AidOverlay } from './AidHandles'
import { WorkholdingLayer, type WorkholdingOverlay } from './WorkholdingLayer'
import { ZRefLayer, type ZRefOverlay } from './ZRefLayer'
import { RestLayer, type RestOverlay } from './RestLayer'
import { GoToPath, type GoToOverlay } from './GoToPath'
import { HolderGhost, type HolderGhostOverlay } from './HolderGhost'
import { InProcessStockLayer, type InProcessStockView } from './InProcessStockLayer'

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
  /**
   * The machine travel in work coordinates (`[−travel, 0] − G54`, DF33) with the home position,
   * drawn as a box outline and a ring; absent without a connection or a reported envelope.
   */
  readonly envelope?: RunEnvelope | undefined
  /**
   * A tool run's Z reference surface and touch-off spot (plan scene, DF69), in work coordinates;
   * absent: none.
   */
  readonly zRef?: ZRefOverlay | undefined
  /** The setup's alignment points (plan scene, DF78), in work coordinates; absent: none. */
  readonly alignment?: readonly AlignmentMarker[] | undefined
  /** Sources a point can be added from while picking (plan scene, DF78 S22); absent: not picking. */
  readonly alignmentTargets?: readonly AlignmentTarget[] | undefined
  /** Flip axes of registration holes (plan scene, Q106), in work coordinates; absent: none. */
  readonly flipAxes?: readonly FlipAxisLine[] | undefined
  /** The setup's alignment aids as drag handles (plan scene, DF83), in work coordinates. */
  readonly aids?: AidOverlay | undefined
  /**
   * The setup's workholding items, the open item's keep-out zone and collision hits (plan scene,
   * workholding.md#ui-summary; the run scene's read-only and maybe outlined, DF133 RW1), in work
   * coordinates; absent: none.
   */
  readonly workholding?: WorkholdingOverlay | undefined
  /**
   * The selected operation's rest region after its roughing (plan scene, DF122), in work
   * coordinates; absent: none (docs/modes/roughing.md#plan-viewport-rest-shading).
   */
  readonly rest?: RestOverlay | undefined
  /**
   * The shown operation's tool, collet nut and spindle body at the move that decides its minimum
   * stickout (plan scene, DF132 H5), or the spindle's tool at the tool marker (run scene, DF133
   * RW1), in work coordinates; absent: none
   * (docs/modes/tool-holder.md#implementation-h5).
   */
  readonly holder?: HolderGhostOverlay | undefined
  /**
   * The open Go to dialog's planned steps (run scene, DF128 GT2), in work coordinates: a dashed
   * path from the tool to a target marker; absent: none (docs/modes/run-goto.md#preview).
   */
  readonly goTo?: GoToOverlay | undefined
  /**
   * DF129 RC6: an interrupted run's last seen tool tip, in work coordinates: a translucent ghost
   * tool (docs/modes/run-recovery.md#implementation-rc6); absent: none.
   */
  readonly ghost?: readonly [number, number, number] | undefined
  /** DF133 RW5: the ghost tool was inside an item (what probably happened): drawn in `--danger`. */
  readonly ghostColliding?: boolean | undefined
  /**
   * DF135 C5: the material left after the plan's already-cut operations, in the **part frame**
   * (not the setup's WCS): a translucent solid around the part
   * (docs/modes/cut-state.md#in-process-stock-display-c5); absent: none.
   */
  readonly inProcessStock?: InProcessStockView | undefined
}

/** The travel box and home position in work coordinates (mm). */
export interface RunEnvelope {
  readonly min: readonly [number, number, number]
  readonly max: readonly [number, number, number]
  readonly home: readonly [number, number, number]
  /**
   * v0.5 RV7: the work area's bound (the margin in) in work coordinates, drawn dashed in the
   * info colour inside the travel; absent: none marked (docs/modes/run.md#work-area-rv7).
   */
  readonly workArea?:
    | {
        readonly min: readonly [number, number, number]
        readonly max: readonly [number, number, number]
      }
    | undefined
}

/** The 12 edges of the box as line-segment vertices (24 × xyz). Pure. */
export function boxEdges(min: readonly number[], max: readonly number[]): Float32Array {
  const c = (i: number) => [
    i & 1 ? max[0]! : min[0]!,
    i & 2 ? max[1]! : min[1]!,
    i & 4 ? max[2]! : min[2]!,
  ]
  const out: number[] = []
  for (let i = 0; i < 8; i++)
    for (const bit of [1, 2, 4]) if ((i & bit) === 0) out.push(...c(i), ...c(i | bit))
  return Float32Array.from(out)
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

export function RunLayer({
  run,
  palette,
  reducedMotion = false,
}: {
  run: RunScene
  palette: Palette
  reducedMotion?: boolean
}): React.JSX.Element {
  const invalidate = useThree((s) => s.invalidate)
  const { lines, done, tool, frame, outdated, envelope } = run
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
  useEffect(() => invalidate(), [tool, run.ghost, run.ghostColliding, invalidate])
  const travel = useMemo(() => {
    if (envelope === undefined) return null
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(boxEdges(envelope.min, envelope.max), 3))
    return g
  }, [envelope])
  useEffect(() => () => travel?.dispose(), [travel])
  const travelColour = useMemo(() => colour(palette.gridMajor), [palette])
  const area = envelope?.workArea
  const areaPoints = useMemo(() => {
    if (area === undefined) return null
    const e = boxEdges(area.min, area.max)
    const pts: [number, number, number][] = []
    for (let i = 0; i < e.length; i += 3) pts.push([e[i]!, e[i + 1]!, e[i + 2]!])
    return pts
  }, [area])
  const areaColour = useMemo(() => colour(palette.info), [palette])

  const toolColour = useMemo(() => colour(palette.tool), [palette])
  const ghostColour = useMemo(
    () => colour(run.ghostColliding === true ? palette.danger : palette.tool),
    [palette, run.ghostColliding],
  )
  return (
    <>
      {run.inProcessStock ? (
        <InProcessStockLayer stock={run.inProcessStock} palette={palette} />
      ) : null}
      <group {...(matrix === undefined ? {} : { matrix, matrixAutoUpdate: false })}>
        {geometry ? (
          <lineSegments geometry={geometry} raycast={noRaycast} renderOrder={2}>
            <lineBasicMaterial vertexColors />
          </lineSegments>
        ) : null}
        {travel && envelope ? (
          // machine travel (box outline) and the home position (a small ring), DF33
          <group raycast={noRaycast}>
            <lineSegments geometry={travel} raycast={noRaycast}>
              <lineBasicMaterial color={travelColour} />
            </lineSegments>
            <mesh
              position={[envelope.home[0], envelope.home[1], envelope.home[2]]}
              raycast={noRaycast}
            >
              <ringGeometry args={[4, 5, 32]} />
              <meshBasicMaterial color={travelColour} />
            </mesh>
            {areaPoints ? (
              <Line
                points={areaPoints}
                segments
                color={areaColour}
                lineWidth={1}
                dashed
                dashSize={4}
                gapSize={3}
                raycast={noRaycast}
              />
            ) : null}
          </group>
        ) : null}
        {run.workholding ? (
          <WorkholdingLayer
            workholding={run.workholding}
            palette={palette}
            reducedMotion={reducedMotion}
          />
        ) : null}
        {run.rest ? <RestLayer rest={run.rest} palette={palette} /> : null}
        {run.holder ? <HolderGhost ghost={run.holder} palette={palette} /> : null}
        {run.zRef ? (
          <ZRefLayer zRef={run.zRef} palette={palette} reducedMotion={reducedMotion} />
        ) : null}
        {run.flipAxes && run.flipAxes.length > 0 ? (
          <FlipAxes axes={run.flipAxes} palette={palette} reducedMotion={reducedMotion} />
        ) : null}
        {run.aids && run.aids.handles.length > 0 ? (
          <AidHandles aids={run.aids} palette={palette} />
        ) : null}
        {run.alignment && run.alignment.length > 0 ? (
          <AlignmentLayer points={run.alignment} palette={palette} reducedMotion={reducedMotion} />
        ) : null}
        {run.goTo ? (
          <GoToPath goTo={run.goTo} palette={palette} reducedMotion={reducedMotion} />
        ) : null}
        {run.alignmentTargets && run.alignmentTargets.length > 0 ? (
          <AlignmentTargets targets={run.alignmentTargets} palette={palette} />
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
        {run.ghost ? (
          // RC6: where the interrupted run was last seen, a see-through copy of the tool marker
          <group position={[run.ghost[0], run.ghost[1], run.ghost[2]]}>
            <mesh position={[0, 0, 3]} rotation={[-Math.PI / 2, 0, 0]} raycast={noRaycast}>
              <coneGeometry args={[3, 6, 24]} />
              <meshBasicMaterial color={ghostColour} transparent opacity={0.3} depthWrite={false} />
            </mesh>
            <mesh position={[0, 0, 16]} rotation={[Math.PI / 2, 0, 0]} raycast={noRaycast}>
              <cylinderGeometry args={[3, 3, 20, 24]} />
              <meshBasicMaterial
                color={ghostColour}
                transparent
                opacity={0.18}
                depthWrite={false}
              />
            </mesh>
            <mesh raycast={noRaycast}>
              <ringGeometry args={[4, 4.8, 32]} />
              <meshBasicMaterial color={ghostColour} transparent opacity={0.6} depthWrite={false} />
            </mesh>
          </group>
        ) : null}
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
    </>
  )
}
