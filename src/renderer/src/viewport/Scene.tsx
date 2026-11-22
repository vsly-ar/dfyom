// The three.js scene inside the viewport canvas: part mesh coloured per surface, feature edges,
// selection outline, stock outline, grid, axes, lights and camera controls. Everything it shows
// comes from props; it computes no geometry (ADR 0010). Doc: docs/conventions/ui.md#selection-and-picking
import { CameraControls, CameraControlsImpl, Line } from '@react-three/drei'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, type Ref } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  EdgesGeometry,
  SRGBColorSpace,
  type DirectionalLight,
} from 'three'
import { boxCenter, fitPose, FOV_DEG, presetDirection } from './camera'
import { isOutlined, vertexColours, type Palette, type Rgb, type SurfaceState } from './colours'
import {
  CREASE_ANGLE_DEG,
  expandMesh,
  surfaceAtFace,
  triangleCount,
  type Box,
  type SurfaceGlyph,
  type SurfaceTarget,
  type Vec3,
  type ViewportMesh,
} from './mesh'
import {
  AnchorMarker,
  FrameAxes,
  PickGlyphs,
  type AnchorOverlay,
  type FrameOverlay,
} from './Overlays'
import { ReferenceGhost, type ReferenceGhostView } from './ReferenceGhost'
import { RunLayer, type RunScene } from './RunLayer'

export interface SceneProps {
  mesh: ViewportMesh | null
  stock: Box | null
  bounds: Box | undefined
  palette: Palette
  surfaceState: SurfaceState
  /** Live outline of the edited operation (pending evaluation). */
  outline?: readonly (readonly Vec3[])[] | null
  /** Error marker (failed evaluation). */
  marker?: Vec3 | null
  /** Pick mode's normal glyphs and the hovered eligible surface (task F1). */
  glyphs?: readonly SurfaceGlyph[] | null
  hovered?: string | null
  /** Face-frame axes of the selected operation's face (task F1). */
  frame?: FrameOverlay | null
  /** Anchor marker of the selected feature (task F2). */
  anchor?: AnchorOverlay | null
  /** Reference model ghosts, drawn after the part, never pickable (task R3). */
  ghosts?: readonly ReferenceGhostView[] | null
  reducedMotion?: boolean
  controlsRef: Ref<CameraControlsImpl>
  /** Run mode layer (task 3.12). */
  run?: RunScene | null
  onHover: (target: SurfaceTarget | undefined) => void
  onClick: (target: SurfaceTarget, event: ThreeEvent<MouseEvent>) => void
}

const noRaycast = (): void => {}

/** sRGB token colour → three.js colour (stored linear). */
function colour(c: Rgb): Color {
  return new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)
}

export function Scene(props: SceneProps): React.JSX.Element {
  const { mesh, stock, bounds, palette, controlsRef, outline, marker, glyphs, frame, anchor } =
    props
  const span = bounds ? Math.max(...bounds.max.map((m, i) => m - bounds.min[i]!)) : 50
  return (
    <>
      <CameraControls
        ref={controlsRef}
        makeDefault
        dollyToCursor
        minDistance={1}
        maxDistance={20000}
      />
      <FrameOnce bounds={bounds} />
      <Lights bounds={bounds} />
      {mesh && triangleCount(mesh) > 0 ? <PartMesh {...props} mesh={mesh} /> : null}
      {stock ? <StockOutline box={stock} colour={palette.stock} /> : null}
      {props.ghosts?.map((g) => (
        <ReferenceGhost
          key={g.id}
          ghost={g}
          faceColour={palette.stock}
          edgeColour={palette.edge}
          reducedMotion={props.reducedMotion ?? false}
        />
      ))}
      {outline ? <LiveOutline loops={outline} colour={palette.selected} /> : null}
      {marker ? <ErrorMarker at={marker} bounds={bounds} colour={palette.danger} /> : null}
      {glyphs && glyphs.length > 0 ? (
        <PickGlyphs
          glyphs={glyphs}
          hovered={props.hovered ?? null}
          size={Math.min(30, Math.max(4, span * 0.08))}
          palette={palette}
          reducedMotion={props.reducedMotion ?? false}
        />
      ) : null}
      {frame ? <FrameAxes frame={frame} palette={palette} /> : null}
      {anchor ? (
        <AnchorMarker
          anchor={anchor}
          size={Math.min(6, Math.max(1, span * 0.015))}
          palette={palette}
        />
      ) : null}
      {bounds ? <Floor bounds={bounds} palette={palette} /> : null}
      <Axes bounds={bounds} palette={palette} />
      {props.run ? <RunLayer run={props.run} palette={palette} /> : null}
    </>
  )
}

/** Frames the first mesh or stock from Iso; later evaluations keep the user's camera. */
function FrameOnce({ bounds }: { bounds: Box | undefined }): null {
  const controls = useThree((s) => s.controls) as CameraControlsImpl | null
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height))
  const framed = useRef(false)
  useEffect(() => {
    if (framed.current || !bounds || !controls) return
    framed.current = true
    const { position: p, target: t } = fitPose(presetDirection('iso'), bounds, aspect, FOV_DEG)
    void controls.setLookAt(p[0], p[1], p[2], t[0], t[1], t[2], false)
  }, [bounds, controls, aspect])
  return null
}

function Lights({ bounds }: { bounds: Box | undefined }): React.JSX.Element {
  const light = useRef<DirectionalLight>(null)
  // A headlight slightly above the camera, so the faces the user looks at are always lit.
  useFrame(({ camera }) => {
    const l = light.current
    if (!l) return
    l.position.copy(camera.position).addScaledVector(camera.up, 0.2 * camera.position.length())
    const c = bounds ? boxCenter(bounds) : [0, 0, 0]
    l.target.position.set(c[0]!, c[1]!, c[2]!)
    l.target.updateMatrixWorld()
  })
  return (
    <>
      <hemisphereLight args={[0xffffff, 0x8a8f99, 1.6]} position={[0, 0, 1]} />
      <directionalLight ref={light} intensity={1.4} />
    </>
  )
}

function PartMesh({
  mesh,
  palette,
  surfaceState,
  onHover,
  onClick,
}: SceneProps & { mesh: ViewportMesh }): React.JSX.Element {
  const invalidate = useThree((s) => s.invalidate)
  // One BufferGeometry per evaluation (geometry.md#worker-and-renderer); replaced ones are disposed.
  const geometry = useMemo(() => {
    const b = expandMesh(mesh)
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(b.positions, 3))
    g.setAttribute('normal', new BufferAttribute(b.normals, 3))
    g.setAttribute('color', new BufferAttribute(new Float32Array(b.triangles * 9), 3))
    g.computeBoundingSphere()
    return g
  }, [mesh])
  useEffect(() => () => geometry.dispose(), [geometry])

  const edges = useMemo(() => new EdgesGeometry(geometry, CREASE_ANGLE_DEG), [geometry])
  useEffect(() => () => edges.dispose(), [edges])

  useLayoutEffect(() => {
    const attr = geometry.getAttribute('color') as BufferAttribute
    vertexColours(mesh, surfaceState, palette, attr.array as Float32Array)
    attr.needsUpdate = true
    invalidate()
  }, [geometry, mesh, surfaceState, palette, invalidate])

  // Amber outline around the selected operation (or the hovered pick candidate).
  const outlined = useMemo(
    () => mesh.surfaces.filter((s) => isOutlined(s, surfaceState)),
    [mesh, surfaceState],
  )
  const outline = useMemo(() => {
    if (outlined.length === 0) return null
    const keep = new Set(outlined.map((s) => mesh.surfaces.indexOf(s)))
    const all = geometry.getAttribute('position').array as Float32Array
    const n = triangleCount(mesh)
    const subset: number[] = []
    for (let t = 0; t < n; t++) {
      if (keep.has(mesh.triangleSurface[t]!)) subset.push(...all.subarray(9 * t, 9 * t + 9))
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(subset), 3))
    const e = new EdgesGeometry(g, CREASE_ANGLE_DEG)
    g.dispose()
    return e
  }, [outlined, mesh, geometry])
  useEffect(() => () => outline?.dispose(), [outline])

  const edgeColour = useMemo(() => colour(palette.edge), [palette])
  const selectedColour = useMemo(() => colour(palette.selected), [palette])

  return (
    <group>
      <mesh
        geometry={geometry}
        onPointerMove={(e) => {
          e.stopPropagation()
          onHover(surfaceAtFace(mesh, e.faceIndex))
        }}
        onPointerOut={() => onHover(undefined)}
        onClick={(e) => {
          e.stopPropagation()
          const target = surfaceAtFace(mesh, e.faceIndex)
          if (target) onClick(target, e)
        }}
      >
        <meshStandardMaterial
          vertexColors
          roughness={0.85}
          metalness={0}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
      </mesh>
      <lineSegments geometry={edges} raycast={noRaycast}>
        <lineBasicMaterial color={edgeColour} transparent opacity={0.55} />
      </lineSegments>
      {outline ? (
        <lineSegments geometry={outline} raycast={noRaycast} renderOrder={1}>
          <lineBasicMaterial color={selectedColour} />
        </lineSegments>
      ) : null}
    </group>
  )
}

function boxEdges(b: Box): [number, number, number][] {
  const [x0, y0, z0] = b.min
  const [x1, y1, z1] = b.max
  const c = (x: number, y: number, z: number): [number, number, number] => [x, y, z]
  const ring = (z: number): [number, number, number][] => [
    c(x0, y0, z),
    c(x1, y0, z),
    c(x1, y0, z),
    c(x1, y1, z),
    c(x1, y1, z),
    c(x0, y1, z),
    c(x0, y1, z),
    c(x0, y0, z),
  ]
  return [
    ...ring(z0),
    ...ring(z1),
    c(x0, y0, z0),
    c(x0, y0, z1),
    c(x1, y0, z0),
    c(x1, y0, z1),
    c(x1, y1, z0),
    c(x1, y1, z1),
    c(x0, y1, z0),
    c(x0, y1, z1),
  ]
}

/** The stock as a dashed outline (design system: `.s-stock`). */
function StockOutline({ box, colour: c }: { box: Box; colour: Rgb }): React.JSX.Element {
  const points = useMemo(() => boxEdges(box), [box])
  return (
    <Line
      points={points}
      segments
      color={colour(c)}
      lineWidth={1}
      dashed
      dashSize={3}
      gapSize={3}
      raycast={noRaycast}
    />
  )
}

/** The edited operation's shape while its evaluation is pending: dashed amber loops. */
function LiveOutline({
  loops,
  colour: c,
}: {
  loops: readonly (readonly Vec3[])[]
  colour: Rgb
}): React.JSX.Element {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => invalidate(), [loops, invalidate])
  return (
    <group>
      {loops
        .filter((l) => l.length >= 2)
        .map((l, i) => (
          <Line
            key={i}
            points={[...l, l[0]!].map((p) => [p[0], p[1], p[2]] as [number, number, number])}
            color={colour(c)}
            lineWidth={2}
            dashed
            dashSize={2}
            gapSize={1.5}
            depthTest={false}
            renderOrder={2}
            raycast={noRaycast}
          />
        ))}
    </group>
  )
}

/** A ring with a stem above the failing operation, in `--danger` (always on top). */
function ErrorMarker({
  at,
  bounds,
  colour: c,
}: {
  at: Vec3
  bounds: Box | undefined
  colour: Rgb
}): React.JSX.Element {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => invalidate(), [at, invalidate])
  const span = bounds ? Math.max(...bounds.max.map((m, i) => m - bounds.min[i]!)) : 50
  const r = Math.max(1.5, span * 0.03)
  const top = at[2] + 3 * r
  const ring = Array.from({ length: 33 }, (_, i): [number, number, number] => {
    const a = (i / 32) * 2 * Math.PI
    return [at[0] + r * Math.cos(a), at[1] + r * Math.sin(a), top]
  })
  return (
    <group>
      <Line
        points={ring}
        color={colour(c)}
        lineWidth={3}
        depthTest={false}
        renderOrder={3}
        raycast={noRaycast}
      />
      <Line
        points={[
          [at[0], at[1], at[2]],
          [at[0], at[1], top - r],
        ]}
        color={colour(c)}
        lineWidth={2}
        depthTest={false}
        renderOrder={3}
        raycast={noRaycast}
      />
    </group>
  )
}

/** Grid in the XY plane under the part: minor lines every 10 mm, major every 50 mm. */
function Floor({ bounds, palette }: { bounds: Box; palette: Palette }): React.JSX.Element {
  const c = boxCenter(bounds)
  const span = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1])
  const size = Math.max(100, Math.ceil((span * 1.6) / 50) * 50)
  const minor = useMemo(() => colour(palette.grid), [palette])
  const major = useMemo(() => colour(palette.gridMajor), [palette])
  const position: [number, number, number] = [
    Math.round(c[0] / 50) * 50,
    Math.round(c[1] / 50) * 50,
    bounds.min[2] - 0.05,
  ]
  return (
    <group position={position} rotation={[Math.PI / 2, 0, 0]}>
      <gridHelper
        key={`minor-${size}`}
        args={[size, size / 10, minor, minor]}
        raycast={noRaycast}
      />
      <gridHelper
        key={`major-${size}`}
        args={[size, size / 50, major, major]}
        position={[0, 0.02, 0]}
        raycast={noRaycast}
      />
    </group>
  )
}

/** Axes at the part origin (CAD colours X red, Y green, Z blue). */
function Axes({
  bounds,
  palette,
}: {
  bounds: Box | undefined
  palette: Palette
}): React.JSX.Element {
  const len = bounds
    ? Math.min(25, Math.max(5, 0.2 * Math.max(...bounds.max.map((m, i) => m - bounds.min[i]!))))
    : 20
  return (
    <group>
      <Line
        points={[
          [0, 0, 0],
          [len, 0, 0],
        ]}
        color={colour(palette.axisX)}
        lineWidth={2}
        raycast={noRaycast}
      />
      <Line
        points={[
          [0, 0, 0],
          [0, len, 0],
        ]}
        color={colour(palette.axisY)}
        lineWidth={2}
        raycast={noRaycast}
      />
      <Line
        points={[
          [0, 0, 0],
          [0, 0, len],
        ]}
        color={colour(palette.axisZ)}
        lineWidth={2}
        raycast={noRaycast}
      />
    </group>
  )
}

export { CameraControlsImpl }
