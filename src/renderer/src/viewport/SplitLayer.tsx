// The exploded preview of a split (split parts 4a polish), drawn in place of the part while the
// Split section is open: the part's mesh clipped to each grid cell of the lines and levels and
// pulled apart along the cut normals (from together to apart over `--motion-slow` with
// `--ease-emphasized` when it appears; at once under reduced motion), in the neutral part colour
// with the cut faces capped flat; each line and level as a plane handle in the gap, neutral, and
// in the accent only while focused (the Split section's field), hovered or held. A plane drags
// along its normal by the pointer's travel; the caller snaps the value and commits; Escape cancels.
// Camera controls are off while one is held. Props only.
// Doc: docs/conventions/ui.md#split-part-split-parts-4a, docs/modes/split-parts.md#implementation-4a-polish
import { Html, Line, type CameraControlsImpl } from '@react-three/drei'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  EdgesGeometry,
  FrontSide,
  Matrix4,
  Plane,
  SRGBColorSpace,
  Vector3,
  type Group,
} from 'three'
import type { Palette, Rgb } from './colours'
import { CREASE_ANGLE_DEG, expandMesh, triangleCount, type Box, type ViewportMesh } from './mesh'
import styles from './Viewport.module.css'

type V3 = readonly [number, number, number]

export type SplitDragPhase = 'start' | 'move' | 'end' | 'cancel'

/** A line or level as the preview draws it. */
export interface SplitCutHandle {
  readonly key: string
  readonly axis: 'x' | 'y' | 'z'
  /** Its value in the part frame (mm). */
  readonly at: number
  /** Where it sits in the gap at full explode, along its axis (mm, added to `at`). */
  readonly shift: number
  /** "Line at X 125 mm", shown while hovered, held or focused. */
  readonly caption: string
  readonly focused: boolean
  readonly dragging: boolean
}

/** What the design scene passes for the preview (`SceneProps.split`). */
export interface SplitOverlay {
  /** Grid cells: their box in the part frame and their pull at full explode. */
  readonly cells: readonly {
    readonly key: string
    readonly min: V3
    readonly max: V3
    readonly offset: V3
  }[]
  readonly cuts: readonly SplitCutHandle[]
  /** The stock box (part frame): the planes span it. */
  readonly stock: Box
  /** `value`: where the cut goes (part frame, mm), the pointer's travel added to it. */
  onDrag(phase: SplitDragPhase, key: string, value: number, modifiers: { alt: boolean }): void
  onHover(key: string | null): void
}

/** `--motion-slow` (tokens.css): the pieces part. */
export const EXPLODE_MS = 280
/** A press that moves less than this (px) is a click (ui.md). */
const CLICK_PX = 4

const noRaycast = (): void => {}
const colour = (c: Rgb) => new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)
const AXIS = { x: 0, y: 1, z: 2 } as const

/** `--ease-emphasized`, cubic-bezier(0.2, 0.8, 0.2, 1), at time `t` (0…1). */
export function easeEmphasized(t: number): number {
  const [x1, y1, x2, y2] = [0.2, 0.8, 0.2, 1]
  const bez = (u: number, a: number, b: number) =>
    3 * a * u * (1 - u) ** 2 + 3 * b * u ** 2 * (1 - u) + u ** 3
  // solve x(u) = t by bisection (monotone in u for these control points)
  let lo = 0
  let hi = 1
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (bez(mid, x1, x2) < t) lo = mid
    else hi = mid
  }
  return bez((lo + hi) / 2, y1, y2)
}

/** 0 → 1 over EXPLODE_MS from mount (1 at once under reduced motion), eased. */
function useExplode(reducedMotion: boolean): number {
  const invalidate = useThree((s) => s.invalidate)
  const [t, setT] = useState(reducedMotion ? 1 : 0)
  const start = useRef<number | null>(null)
  useEffect(() => invalidate(), [invalidate])
  useFrame(({ clock }) => {
    if (t >= 1) return
    if (reducedMotion) return setT(1)
    const now = clock.getElapsedTime() * 1000
    start.current ??= now
    const raw = Math.min(1, (now - start.current) / EXPLODE_MS)
    setT(raw >= 1 ? 1 : easeEmphasized(raw))
    invalidate()
  })
  return t
}

export function SplitLayer({
  split,
  mesh,
  palette,
  reducedMotion,
}: {
  split: SplitOverlay
  mesh: ViewportMesh | null
  palette: Palette
  reducedMotion: boolean
}): React.JSX.Element {
  const getState = useThree((s) => s.get)
  // the pieces clip the one mesh to their cells (three's local clipping, off again after)
  useEffect(() => {
    const { gl } = getState()
    gl.localClippingEnabled = true
    return () => void (gl.localClippingEnabled = false)
  }, [getState])
  const t = useExplode(reducedMotion)
  const geometry = useMemo(() => {
    if (mesh === null || triangleCount(mesh) === 0) return null
    const b = expandMesh(mesh)
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(b.positions, 3))
    g.setAttribute('normal', new BufferAttribute(b.normals, 3))
    g.computeBoundingSphere()
    return g
  }, [mesh])
  useEffect(() => () => geometry?.dispose(), [geometry])
  const edges = useMemo(
    () => (geometry === null ? null : new EdgesGeometry(geometry, CREASE_ANGLE_DEG)),
    [geometry],
  )
  useEffect(() => () => edges?.dispose(), [edges])
  const face = useMemo(() => colour(palette.part), [palette])
  // the cut faces: back faces seen through the clipped opening, flat and a step darker
  const cap = useMemo(() => colour(palette.part).lerp(colour(palette.edge), 0.35), [palette])
  const edge = useMemo(() => colour(palette.edge), [palette])
  return (
    <group>
      {geometry !== null && edges !== null
        ? split.cells.map((c) => (
            <Piece
              key={c.key}
              cell={c}
              t={t}
              geometry={geometry}
              edges={edges}
              face={face}
              cap={cap}
              edge={edge}
            />
          ))
        : null}
      {split.cuts.map((cut) => (
        <CutPlane key={cut.key} cut={cut} split={split} t={t} palette={palette} />
      ))}
    </group>
  )
}

function Piece({
  cell,
  t,
  geometry,
  edges,
  face,
  cap,
  edge,
}: {
  cell: SplitOverlay['cells'][number]
  t: number
  geometry: BufferGeometry
  edges: EdgesGeometry
  face: Color
  cap: Color
  edge: Color
}): React.JSX.Element {
  const o = cell.offset.map((v) => v * t) as [number, number, number]
  // clipping planes are in world space: the cell's box moved by the pull
  const planes = useMemo(() => {
    const e = 1e-4
    return [0, 1, 2].flatMap((i) => {
      const n = [0, 0, 0]
      n[i] = 1
      const lo = new Plane(new Vector3(n[0], n[1], n[2]), -(cell.min[i]! + o[i]!) + e)
      const hi = new Plane(new Vector3(-n[0]!, -n[1]!, -n[2]!), cell.max[i]! + o[i]! + e)
      return [lo, hi]
    })
  }, [cell, o[0], o[1], o[2]]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <group position={o}>
      <mesh geometry={geometry} raycast={noRaycast}>
        <meshStandardMaterial
          color={face}
          side={FrontSide}
          clippingPlanes={planes}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
      </mesh>
      <mesh geometry={geometry} raycast={noRaycast}>
        <meshBasicMaterial color={cap} side={BackSide} clippingPlanes={planes} />
      </mesh>
      <lineSegments geometry={edges} raycast={noRaycast}>
        <lineBasicMaterial color={edge} clippingPlanes={planes} />
      </lineSegments>
    </group>
  )
}

/** The closest point's parameter on the line `p0 + s·a` (unit `a`) to the ray `o + t·d`. */
function closestOnAxis(p0: Vector3, a: Vector3, o: Vector3, d: Vector3): number | null {
  const w = p0.clone().sub(o)
  const b = a.dot(d)
  const c = d.dot(d)
  const den = c - b * b
  if (Math.abs(den) < 1e-6) return null // looking along the axis
  return (b * d.dot(w) - c * a.dot(w)) / den
}

function CutPlane({
  cut,
  split,
  t,
  palette,
}: {
  cut: SplitCutHandle
  split: SplitOverlay
  t: number
  palette: Palette
}): React.JSX.Element {
  const getState = useThree((s) => s.get)
  const invalidate = useThree((s) => s.invalidate)
  const root = useRef<Group>(null)
  const [hovered, setHovered] = useState(false)
  const drag = useRef<{
    pointerId: number
    down: [number, number]
    /** The pointer's axis value minus the cut's at the press. */
    grab: number | null
    started: boolean
    target: Element | null
  } | null>(null)
  useEffect(() => invalidate(), [cut, hovered, invalidate])

  const ax = AXIS[cut.axis]
  const { min, max } = split.stock
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  const pad = Math.max(...size) * 0.04
  const centre = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  const pos = [...centre] as [number, number, number]
  pos[ax] = cut.at + cut.shift * t
  // the plane's two in-plane axes (u, v) and their half extents
  const [ua, va] = ([0, 1, 2] as const).filter((i) => i !== ax) as [number, number]
  const hu = size[ua]! / 2 + pad
  const hv = size[va]! / 2 + pad
  const corner = (su: number, sv: number): [number, number, number] => {
    const p: [number, number, number] = [0, 0, 0]
    p[ua] = su * hu
    p[va] = sv * hv
    return p
  }
  const loop = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), corner(-1, -1)]
  // planeGeometry lies in XY: turn it so its normal is the cut's axis
  const rotation: [number, number, number] =
    cut.axis === 'x' ? [0, Math.PI / 2, 0] : cut.axis === 'y' ? [Math.PI / 2, 0, 0] : [0, 0, 0]
  const [pw, ph] = cut.axis === 'x' ? [2 * hv, 2 * hu] : [2 * hu, 2 * hv]

  const setControls = (on: boolean) => {
    const c = getState().controls as CameraControlsImpl | null
    if (c) c.enabled = on
  }
  const setCursor = (cursor: string) => {
    getState().gl.domElement.style.cursor = cursor
  }
  useEffect(() => () => setCursor(''), []) // eslint-disable-line react-hooks/exhaustive-deps
  /** The pointer's value along the cut's axis (part frame, the gap's shift removed). */
  const valueAt = (e: ThreeEvent<PointerEvent>): number | null => {
    const g = root.current?.parent
    if (!g) return null
    const ray = e.ray.clone().applyMatrix4(new Matrix4().copy(g.matrixWorld).invert())
    const a = new Vector3(
      cut.axis === 'x' ? 1 : 0,
      cut.axis === 'y' ? 1 : 0,
      cut.axis === 'z' ? 1 : 0,
    )
    const p0 = new Vector3(...pos)
    const s = closestOnAxis(p0, a, ray.origin, ray.direction)
    return s === null ? null : pos[ax]! + s - cut.shift * t
  }
  const moved = (e: ThreeEvent<PointerEvent>): number => {
    const v = valueAt(e)
    const g = drag.current?.grab
    return v === null || g == null ? cut.at : v - g
  }
  const release = () => {
    const d = drag.current
    drag.current = null
    setControls(true)
    if (d?.target && 'releasePointerCapture' in d.target)
      (d.target as Element).releasePointerCapture?.(d.pointerId)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = drag.current
      if (e.key !== 'Escape' || d === null) return
      e.preventDefault()
      e.stopPropagation()
      release()
      setCursor(hovered ? 'grab' : '')
      if (d.started) split.onDrag('cancel', cut.key, cut.at, { alt: false })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const target = e.target as Element | null
    target?.setPointerCapture?.(e.pointerId)
    setControls(false)
    const v = valueAt(e)
    drag.current = {
      pointerId: e.pointerId,
      down: [e.clientX, e.clientY],
      grab: v === null ? null : v - cut.at,
      started: false,
      target,
    }
  }
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current
    if (d === null || e.pointerId !== d.pointerId) return
    e.stopPropagation()
    if (!d.started) {
      if (Math.hypot(e.clientX - d.down[0], e.clientY - d.down[1]) < CLICK_PX) return
      d.started = true
      setCursor('grabbing')
      split.onDrag('start', cut.key, cut.at, { alt: e.altKey })
    }
    split.onDrag('move', cut.key, moved(e), { alt: e.altKey })
  }
  const onUp = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current
    if (d === null || e.pointerId !== d.pointerId) return
    e.stopPropagation()
    const end = moved(e)
    release()
    setCursor('grab')
    if (d.started) split.onDrag('end', cut.key, end, { alt: e.altKey })
  }

  const lit = hovered || cut.dragging || cut.focused
  const c = useMemo(() => colour(lit ? palette.selected : palette.edge), [lit, palette])
  return (
    <group ref={root} position={pos}>
      <mesh
        rotation={rotation}
        renderOrder={6}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerOver={(e) => {
          e.stopPropagation()
          setHovered(true)
          split.onHover(cut.key)
          if (drag.current === null) setCursor('grab')
        }}
        onPointerOut={() => {
          setHovered(false)
          split.onHover(null)
          if (drag.current === null) setCursor('')
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <planeGeometry args={[pw, ph]} />
        <meshBasicMaterial
          color={c}
          transparent
          opacity={cut.dragging ? 0.1 : lit ? 0.06 : 0.03}
          depthWrite={false}
          side={DoubleSide}
        />
      </mesh>
      <Line
        points={loop}
        color={c}
        lineWidth={lit ? 2 : 1}
        dashed={!lit}
        dashSize={4}
        gapSize={3}
        renderOrder={7}
        raycast={noRaycast}
      />
      {/* off the plane's middle (where two planes cross), so its grab point is its own */}
      <Html position={corner(0.8, -0.8)} zIndexRange={[20, 10]} className={styles['zSpotAnchor']}>
        <span data-split-cut={cut.key} aria-hidden="true">
          {lit ? (
            <span className={styles['zSpotChip']} data-dragging={cut.dragging ? '' : undefined}>
              {cut.caption}
            </span>
          ) : null}
        </span>
      </Html>
    </group>
  )
}
