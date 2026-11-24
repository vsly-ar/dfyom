// Alignment aids of the shown setup as drag handles (hardening DF83), drawn by the run layer in the
// setup's WCS on the up face (Z 0): a registration hole as a ring of its Ø, a spot mark as a ring
// of its width, a line mark as its centre line with end ticks, all in `--aid` (`--vp-selected`
// for the aid selected in the inspector). When draggable, hovering one shows a grab cursor and a
// chip (its name and position, and for a hole how far it is off the flip axis); a press without
// moving selects it; a drag moves it on the face plane by the pointer's travel and reports the
// anchor's new place (WCS x, y), the caller snaps it and commits on release. Camera controls are
// off while one is held; Escape cancels. The ring of a held aid fills lightly. Props only.
// Doc: docs/modes/alignment.md#implementation-df83, docs/conventions/ui.md#design-and-plan-controls-v02
import { Html, Line, type CameraControlsImpl } from '@react-three/drei'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Color, DoubleSide, Matrix4, SRGBColorSpace, type Group } from 'three'
import type { Palette, Rgb } from './colours'
import styles from './Viewport.module.css'

type P = readonly [number, number]

export type AidDragPhase = 'start' | 'move' | 'end' | 'cancel'

/** One aid as the run layer draws it (`RunScene.aids`), in the WCS. */
export interface AidHandle {
  readonly id: string
  readonly kind: 'hole' | 'spot' | 'line'
  /** The point a drag moves (a hole's centre, a spot, a line's start), WCS mm. */
  readonly at: P
  /** A line mark's end, WCS mm. */
  readonly to?: P | undefined
  /** Ring radius (mm): half the hole Ø or the mark width. */
  readonly radius: number
  /** Name and position, shown while hovered or held. */
  readonly caption: string
  readonly selected: boolean
  readonly dragging: boolean
}

/** What the run layer draws for the aids (`RunScene.aids`). */
export interface AidOverlay {
  readonly handles: readonly AidHandle[]
  readonly draggable: boolean
  onSelect(id: string): void
  /** `point`: where the anchor goes (WCS), the pointer's travel added to it. */
  onDrag(phase: AidDragPhase, id: string, point: P): void
}

/** A press that moves less than this (px) is a click (ui.md). */
const CLICK_PX = 4
const LIFT = 0.04
/** The grab target is at least this wide (mm), so a 1 mm mark can be held. */
const MIN_GRAB = 2.5

const noRaycast = (): void => {}
const colour = (c: Rgb) => new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)

function circle(r: number): [number, number, number][] {
  return Array.from({ length: 49 }, (_, i): [number, number, number] => {
    const t = (i / 48) * 2 * Math.PI
    return [r * Math.cos(t), r * Math.sin(t), 0]
  })
}

function Handle({
  handle,
  overlay,
  palette,
}: {
  handle: AidHandle
  overlay: AidOverlay
  palette: Palette
}): React.JSX.Element {
  const getState = useThree((s) => s.get)
  const invalidate = useThree((s) => s.invalidate)
  const root = useRef<Group>(null)
  const [hovered, setHovered] = useState(false)
  const drag = useRef<{
    pointerId: number
    down: [number, number]
    from: P | null
    started: boolean
    target: Element | null
  } | null>(null)
  useEffect(() => invalidate(), [handle, hovered, invalidate])

  const setControls = (on: boolean) => {
    const c = getState().controls as CameraControlsImpl | null
    if (c) c.enabled = on
  }
  const setCursor = (cursor: string) => {
    getState().gl.domElement.style.cursor = cursor
  }
  useEffect(() => () => setCursor(''), []) // eslint-disable-line react-hooks/exhaustive-deps
  /** The pointer ray on the face plane (Z 0), in the WCS; null when it misses. */
  const hit = (e: ThreeEvent<PointerEvent>): P | null => {
    const g = root.current?.parent
    if (!g) return null
    const ray = e.ray.clone().applyMatrix4(new Matrix4().copy(g.matrixWorld).invert())
    const dz = ray.direction.z
    if (Math.abs(dz) < 1e-9) return null
    const t = -ray.origin.z / dz
    if (t < 0) return null
    return [ray.origin.x + t * ray.direction.x, ray.origin.y + t * ray.direction.y]
  }
  const moved = (p: P | null): P => {
    const from = drag.current?.from
    if (p === null || from == null) return handle.at
    return [handle.at[0] + p[0] - from[0], handle.at[1] + p[1] - from[1]]
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
      if (d.started) overlay.onDrag('cancel', handle.id, handle.at)
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
    drag.current = {
      pointerId: e.pointerId,
      down: [e.clientX, e.clientY],
      from: hit(e),
      started: false,
      target,
    }
  }
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current
    if (d === null || e.pointerId !== d.pointerId || !overlay.draggable) return
    e.stopPropagation()
    if (!d.started) {
      if (Math.hypot(e.clientX - d.down[0], e.clientY - d.down[1]) < CLICK_PX) return
      d.started = true
      setCursor('grabbing')
      overlay.onDrag('start', handle.id, handle.at)
    }
    overlay.onDrag('move', handle.id, moved(hit(e)))
  }
  const onUp = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current
    if (d === null || e.pointerId !== d.pointerId) return
    e.stopPropagation()
    const end = moved(hit(e))
    release()
    setCursor(overlay.draggable ? 'grab' : '')
    if (d.started) overlay.onDrag('end', handle.id, end)
    else overlay.onSelect(handle.id)
  }

  const c = useMemo(
    () => colour(handle.selected || handle.dragging ? palette.selected : palette.aid),
    [handle.selected, handle.dragging, palette],
  )
  const lit = hovered || handle.dragging
  const r = handle.radius
  const grab = Math.max(r, MIN_GRAB)
  const to: P | undefined = handle.to
  const d: P = to === undefined ? [0, 0] : [to[0] - handle.at[0], to[1] - handle.at[1]]
  const len = Math.hypot(d[0], d[1])
  const angle = Math.atan2(d[1], d[0])
  const ring = useMemo(() => circle(r), [r])
  const width = lit || handle.selected ? 2.25 : 1.5
  const fill = (
    <meshBasicMaterial
      color={c}
      transparent
      opacity={handle.dragging ? 0.3 : hovered && overlay.draggable ? 0.14 : 0}
      depthTest={false}
      depthWrite={false}
      side={DoubleSide}
    />
  )
  const events = {
    onPointerDown: onDown,
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerOver: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation()
      setHovered(true)
      if (overlay.draggable && drag.current === null) setCursor('grab')
    },
    onPointerOut: () => {
      setHovered(false)
      if (drag.current === null) setCursor('')
    },
    onClick: (e: ThreeEvent<MouseEvent>) => e.stopPropagation(),
  }
  return (
    <group ref={root} position={[handle.at[0], handle.at[1], LIFT]}>
      {to === undefined ? (
        <>
          <mesh renderOrder={6} {...events}>
            <circleGeometry args={[grab, 40]} />
            {fill}
          </mesh>
          <Line
            points={ring}
            color={c}
            lineWidth={width}
            depthTest={false}
            renderOrder={7}
            raycast={noRaycast}
          />
        </>
      ) : (
        <>
          <mesh
            renderOrder={6}
            position={[d[0] / 2, d[1] / 2, 0]}
            rotation={[0, 0, angle]}
            {...events}
          >
            <planeGeometry args={[len + 2 * grab, 2 * grab]} />
            {fill}
          </mesh>
          <Line
            points={[
              [0, 0, 0],
              [d[0], d[1], 0],
            ]}
            color={c}
            lineWidth={width + 0.5}
            depthTest={false}
            renderOrder={7}
            raycast={noRaycast}
          />
          {[0, 1].map((k) => {
            const n: P = len === 0 ? [0, 1] : [-d[1] / len, d[0] / len]
            const at: P = k === 0 ? [0, 0] : d
            const h = Math.max(r, 1)
            return (
              <Line
                key={k}
                points={[
                  [at[0] - n[0] * h, at[1] - n[1] * h, 0],
                  [at[0] + n[0] * h, at[1] + n[1] * h, 0],
                ]}
                color={c}
                lineWidth={1.25}
                depthTest={false}
                renderOrder={7}
                raycast={noRaycast}
              />
            )
          })}
        </>
      )}
      <Html zIndexRange={[20, 10]} className={styles['zSpotAnchor']}>
        <span data-aid-handle={handle.id} aria-hidden="true">
          {lit ? (
            <span className={styles['zSpotChip']} data-dragging={handle.dragging ? '' : undefined}>
              {handle.caption}
            </span>
          ) : null}
        </span>
      </Html>
    </group>
  )
}

export function AidHandles({
  aids,
  palette,
}: {
  aids: AidOverlay
  palette: Palette
}): React.JSX.Element {
  return (
    <group>
      {aids.handles.map((h) => (
        <Handle key={h.id} handle={h} overlay={aids} palette={palette} />
      ))}
    </group>
  )
}
