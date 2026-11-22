// Tab markers of a selected profile (task U2): each tab a bar across the slot as long as the tab is
// wide (viewport-background fill, `--vp-edge` outline, `--vp-hover` fill when hovered,
// `--vp-selected` while dragged), and the loop's start point as a small open circle with a tick in
// its counter-clockwise direction. A drag hits the face plane under the pointer and reports that
// point; the caller turns it into a distance along the loop (one gesture). Camera controls are off
// while a marker is held; Escape cancels the drag. Each marker also has a focusable anchor at its
// centre (an Html overlay that lets the pointer through): arrow keys move it 1 mm along the loop
// (0.1 mm with Alt, 10 mm with Shift), and its name says where it is. Positions come from the
// design side.
// Doc: docs/conventions/ui.md#tab-markers
import { Html, Line, type CameraControlsImpl } from '@react-three/drei'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Plane,
  SRGBColorSpace,
  Vector3,
} from 'three'
import type { Palette, Rgb } from './colours'
import type { Vec3 } from './mesh'
import { nudgeStep } from './shape-handles'
import styles from './Viewport.module.css'

/** One tab: its quad on the face (part frame, counter-clockwise) and its accessible name. */
export interface TabMarkerView {
  readonly corners: readonly [Vec3, Vec3, Vec3, Vec3]
  readonly label: string
}

export type TabDragPhase = 'start' | 'move' | 'end' | 'cancel'

export interface TabOverlay {
  readonly markers: readonly TabMarkerView[]
  /** The loop's start point, its direction of travel and the circle's radius (mm). */
  readonly start: { readonly at: Vec3; readonly along: Vec3; readonly radius: number } | null
  /** The face plane drags move in (part frame). */
  readonly plane: { readonly origin: Vec3; readonly normal: Vec3; readonly u: Vec3 }
  /** The dragged tab (amber), or null. */
  readonly dragging: number | null
  /** Markers cannot be dragged (a formula, a plan copy). */
  readonly locked: boolean
  onDrag(phase: TabDragPhase, index: number, point: Vec3): void
  /** Keyboard path: move tab `index` by `delta` mm along the loop (a run of keys is one gesture). */
  onNudge(index: number, delta: number): void
}

const noRaycast = (): void => {}

const centre = (c: readonly Vec3[]): [number, number, number] => {
  const n = c.length || 1
  const sum = c.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0])
  return [sum[0] / n, sum[1] / n, sum[2] / n]
}
/** A press that moves less than this (px) is a click and commits nothing (ui.md). */
const CLICK_PX = 4

function colour(c: Rgb): Color {
  return new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)
}

function quadGeometry(c: readonly Vec3[]): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(Float32Array.from(c.flat()), 3))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return g
}

function Marker({
  view,
  index,
  state,
  palette,
  onDown,
  onMove,
  onUp,
  onHover,
}: {
  view: TabMarkerView
  index: number
  state: 'rest' | 'hovered' | 'dragged'
  palette: Palette
  onDown(e: ThreeEvent<PointerEvent>, index: number): void
  onMove(e: ThreeEvent<PointerEvent>): void
  onUp(e: ThreeEvent<PointerEvent>): void
  onHover(index: number | null): void
}): React.JSX.Element {
  const geometry = useMemo(() => quadGeometry(view.corners), [view.corners])
  useEffect(() => () => geometry.dispose(), [geometry])
  const fill =
    state === 'dragged'
      ? palette.selected
      : state === 'hovered'
        ? palette.hover
        : palette.background
  const edge = state === 'dragged' ? palette.selected : palette.edge
  return (
    <group>
      <mesh
        geometry={geometry}
        renderOrder={4}
        onPointerDown={(e) => onDown(e, index)}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerOver={(e) => {
          e.stopPropagation()
          onHover(index)
        }}
        onPointerOut={() => onHover(null)}
        onClick={(e) => e.stopPropagation()}
      >
        <meshBasicMaterial
          color={colour(fill)}
          depthTest={false}
          side={DoubleSide}
          transparent
          opacity={0.92}
        />
      </mesh>
      <Line
        points={[...view.corners, view.corners[0]].map(
          (p) => [p[0], p[1], p[2]] as [number, number, number],
        )}
        color={colour(edge)}
        lineWidth={1.5}
        depthTest={false}
        renderOrder={5}
        raycast={noRaycast}
      />
    </group>
  )
}

export function TabMarkers({
  tabs,
  palette,
}: {
  tabs: TabOverlay
  palette: Palette
}): React.JSX.Element {
  const getState = useThree((s) => s.get)
  /** Camera controls on or off (read at the event: the controls are made after this mounts). */
  const setControls = (on: boolean) => {
    const c = getState().controls as CameraControlsImpl | null
    if (c) c.enabled = on
  }
  const invalidate = useThree((s) => s.invalidate)
  const [hovered, setHovered] = useState<number | null>(null)
  const drag = useRef<{
    index: number
    pointerId: number
    down: [number, number]
    started: boolean
    target: Element | null
  } | null>(null)
  const plane = useMemo(
    () =>
      new Plane().setFromNormalAndCoplanarPoint(
        new Vector3(...tabs.plane.normal),
        new Vector3(...tabs.plane.origin),
      ),
    [tabs.plane],
  )
  useEffect(() => invalidate(), [tabs, hovered, invalidate])

  const hit = (e: ThreeEvent<PointerEvent>): Vec3 | null => {
    const v = e.ray.intersectPlane(plane, new Vector3())
    return v === null ? null : [v.x, v.y, v.z]
  }
  const release = () => {
    const d = drag.current
    drag.current = null
    setControls(true)
    if (d?.target && 'releasePointerCapture' in d.target)
      (d.target as Element).releasePointerCapture?.(d.pointerId)
  }

  // Escape cancels a drag wherever focus is, before the viewport's own Escape (clear selection)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = drag.current
      if (e.key !== 'Escape' || d === null) return
      e.preventDefault()
      e.stopPropagation()
      release()
      if (d.started) tabs.onDrag('cancel', d.index, tabs.plane.origin)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const onDown = (e: ThreeEvent<PointerEvent>, index: number) => {
    if (e.button !== 0 || tabs.locked) return
    e.stopPropagation()
    const target = e.target as Element | null
    target?.setPointerCapture?.(e.pointerId)
    setControls(false)
    drag.current = {
      index,
      pointerId: e.pointerId,
      down: [e.clientX, e.clientY],
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
      const p = hit(e)
      if (p) tabs.onDrag('start', d.index, p)
    }
    const p = hit(e)
    if (p) tabs.onDrag('move', d.index, p)
  }
  const onUp = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current
    if (d === null || e.pointerId !== d.pointerId) return
    e.stopPropagation()
    release()
    if (d.started) tabs.onDrag('end', d.index, hit(e) ?? tabs.plane.origin)
  }

  const start = tabs.start
  const ring = useMemo(() => {
    if (start === null) return null
    const n = tabs.plane.normal
    const a = start.along
    // the in-plane perpendicular of the direction of travel
    const b: Vec3 = [
      n[1] * a[2] - n[2] * a[1],
      n[2] * a[0] - n[0] * a[2],
      n[0] * a[1] - n[1] * a[0],
    ]
    const r = start.radius
    const circle = Array.from({ length: 33 }, (_, i): [number, number, number] => {
      const t = (i / 32) * 2 * Math.PI
      return [
        start.at[0] + r * (Math.cos(t) * a[0] + Math.sin(t) * b[0]),
        start.at[1] + r * (Math.cos(t) * a[1] + Math.sin(t) * b[1]),
        start.at[2] + r * (Math.cos(t) * a[2] + Math.sin(t) * b[2]),
      ]
    })
    const tip = (k: number): [number, number, number] => [
      start.at[0] + a[0] * r * k,
      start.at[1] + a[1] * r * k,
      start.at[2] + a[2] * r * k,
    ]
    return { circle, tick: [tip(1), tip(2.6)] }
  }, [start, tabs.plane.normal])

  const edge = useMemo(() => colour(palette.edge), [palette])
  return (
    <group>
      {ring ? (
        <>
          <Line
            points={ring.circle}
            color={edge}
            lineWidth={1.5}
            depthTest={false}
            renderOrder={5}
            raycast={noRaycast}
          />
          <Line
            points={ring.tick}
            color={edge}
            lineWidth={1.5}
            depthTest={false}
            renderOrder={5}
            raycast={noRaycast}
          />
        </>
      ) : null}
      {tabs.markers.map((m, i) => (
        <Html
          key={`key-${i}`}
          position={centre(m.corners)}
          center
          zIndexRange={[10, 0]}
          className={styles['tabAnchor']}
        >
          <button
            type="button"
            aria-label={m.label}
            data-tab-marker={i}
            disabled={tabs.locked}
            onKeyDown={(e) => {
              const dir =
                e.key === 'ArrowRight' || e.key === 'ArrowUp'
                  ? 1
                  : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
                    ? -1
                    : 0
              if (dir === 0) return
              e.preventDefault()
              e.stopPropagation()
              tabs.onNudge(i, dir * nudgeStep(e))
            }}
          />
        </Html>
      ))}
      {tabs.markers.map((m, i) => (
        <Marker
          key={i}
          view={m}
          index={i}
          state={tabs.dragging === i ? 'dragged' : hovered === i ? 'hovered' : 'rest'}
          palette={palette}
          onDown={onDown}
          onMove={onMove}
          onUp={onUp}
          onHover={setHovered}
        />
      ))}
    </group>
  )
}
