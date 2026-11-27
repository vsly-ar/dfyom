// Z reference of a tool run (hardening DF69), drawn by the run layer in the setup's WCS: the
// surface's flat patch filled with a light `--vp-selected` tint and outlined, and the touch-off
// spot as a ring of the clearance radius with a crosshair (`--vp-selected`, over the part). A new
// spot scales in (`--motion-base`; none under reduced motion). When draggable, hovering the spot
// shows a grab cursor and a chip with its coordinates; a drag hits the surface's plane under the
// pointer and reports that point (WCS x, y), the caller snaps it and commits on release. Camera
// controls are off while the spot is held; Escape cancels. Props only.
// Doc: docs/conventions/ui.md#design-and-plan-controls-v02, docs/modes/z-reference.md#implementation-notes-df69
import { Html, Line, type CameraControlsImpl } from '@react-three/drei'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Color,
  DoubleSide,
  Matrix4,
  Path,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  Vector2,
  type Group,
} from 'three'
import type { Palette, Rgb } from './colours'
import styles from './Viewport.module.css'

type P = readonly [number, number]

/** A region piece as polygons (WCS, mm). */
export interface ZRefPolygon {
  readonly outer: readonly P[]
  readonly holes: readonly (readonly P[])[]
}

export type ZRefDragPhase = 'start' | 'move' | 'end' | 'cancel'

/** What the run layer draws for a tool run's Z reference (`RunScene.zRef`). */
export interface ZRefOverlay {
  /** Changes when another run or surface is shown: the spot scales in again. */
  readonly key: string
  /** The flat patch (WCS, mm). */
  readonly patch: readonly ZRefPolygon[]
  /** The surface's z in the WCS (mm, ≤ 0). */
  readonly level: number
  /** The touch-off spot (WCS, mm). */
  readonly at: P
  /** Room for the tool or the plate around the spot (mm): the ring's radius. */
  readonly clearance: number
  /** The spot's coordinates as the chip shows them ("X 50 mm  Y 30 mm"). */
  readonly caption: string
  readonly draggable: boolean
  /** The spot is held (filled). */
  readonly dragging: boolean
  onDrag(phase: ZRefDragPhase, point: P): void
}

/** A press that moves less than this (px) is a click and commits nothing (ui.md). */
const CLICK_PX = 4
/** Lift of the outline over the surface (mm), so it does not fight the part's face. */
const LIFT = 0.02
/** `--motion-base` (tokens.css), the spot's scale-in. */
const APPEAR_MS = 180

const noRaycast = (): void => {}
const colour = (c: Rgb) => new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)

const ring = (pts: readonly P[]) => pts.map((p) => new Vector2(p[0], p[1]))

/** The patch as three.js shapes (holes as paths). */
export function patchShapes(patch: readonly ZRefPolygon[]): Shape[] {
  return patch
    .filter((p) => p.outer.length >= 3)
    .map((p) => {
      const s = new Shape(ring(p.outer))
      for (const h of p.holes) if (h.length >= 3) s.holes.push(new Path(ring(h)))
      return s
    })
}

export function ZRefLayer({
  zRef,
  palette,
  reducedMotion = false,
}: {
  zRef: ZRefOverlay
  palette: Palette
  reducedMotion?: boolean
}): React.JSX.Element {
  const getState = useThree((s) => s.get)
  const invalidate = useThree((s) => s.invalidate)
  const root = useRef<Group>(null)
  const spot = useRef<Group>(null)
  const [hovered, setHovered] = useState(false)
  const drag = useRef<{
    pointerId: number
    down: [number, number]
    started: boolean
    target: Element | null
  } | null>(null)

  const fill = useMemo(() => {
    const shapes = patchShapes(zRef.patch)
    return shapes.length === 0 ? null : new ShapeGeometry(shapes)
  }, [zRef.patch])
  useEffect(() => () => fill?.dispose(), [fill])
  const outlines = useMemo(
    () =>
      zRef.patch.flatMap((p) =>
        [p.outer, ...p.holes]
          .filter((r) => r.length >= 2)
          .map((r) =>
            [...r, r[0]!].map((q): [number, number, number] => [q[0], q[1], zRef.level + LIFT]),
          ),
      ),
    [zRef.patch, zRef.level],
  )
  const r = zRef.clearance
  const marks = useMemo(() => {
    const circle = Array.from({ length: 49 }, (_, i): [number, number, number] => {
      const t = (i / 48) * 2 * Math.PI
      return [r * Math.cos(t), r * Math.sin(t), 0]
    })
    const k = r * 1.6
    return {
      circle,
      h: [
        [-k, 0, 0],
        [k, 0, 0],
      ] as [number, number, number][],
      v: [
        [0, -k, 0],
        [0, k, 0],
      ] as [number, number, number][],
    }
  }, [r])

  // the spot scales in when another run or surface is shown
  const appear = useRef<{ key: string; start: number }>({ key: '', start: 0 })
  useFrame(() => {
    const g = spot.current
    if (g === null) return
    if (appear.current.key !== zRef.key)
      appear.current = { key: zRef.key, start: reducedMotion ? -Infinity : performance.now() }
    const t = Math.min(1, (performance.now() - appear.current.start) / APPEAR_MS)
    const s = 1 + 0.8 * (1 - t) ** 2
    g.scale.set(s, s, 1)
    if (t < 1) invalidate()
  })
  useEffect(() => invalidate(), [zRef, hovered, invalidate])

  const setControls = (on: boolean) => {
    const c = getState().controls as CameraControlsImpl | null
    if (c) c.enabled = on
  }
  const setCursor = (cursor: string) => {
    getState().gl.domElement.style.cursor = cursor
  }
  /** The pointer ray on the surface's plane, in the WCS; null when it misses. */
  const hit = (e: ThreeEvent<PointerEvent>): P | null => {
    const g = root.current
    if (g === null) return null
    const ray = e.ray.clone().applyMatrix4(new Matrix4().copy(g.matrixWorld).invert())
    const dz = ray.direction.z
    if (Math.abs(dz) < 1e-9) return null
    const t = (zRef.level - ray.origin.z) / dz
    if (t < 0) return null
    return [ray.origin.x + t * ray.direction.x, ray.origin.y + t * ray.direction.y]
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
      setCursor(hovered ? 'grab' : '')
      if (d.started) zRef.onDrag('cancel', zRef.at)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  // the cursor is the canvas's: reset it when the spot goes away
  useEffect(() => () => setCursor(''), []) // eslint-disable-line react-hooks/exhaustive-deps

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0 || !zRef.draggable) return
    e.stopPropagation()
    const target = e.target as Element | null
    target?.setPointerCapture?.(e.pointerId)
    setControls(false)
    drag.current = { pointerId: e.pointerId, down: [e.clientX, e.clientY], started: false, target }
  }
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current
    if (d === null || e.pointerId !== d.pointerId) return
    e.stopPropagation()
    if (!d.started) {
      if (Math.hypot(e.clientX - d.down[0], e.clientY - d.down[1]) < CLICK_PX) return
      d.started = true
      setCursor('grabbing')
      zRef.onDrag('start', zRef.at)
    }
    const p = hit(e)
    if (p) zRef.onDrag('move', p)
  }
  const onUp = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current
    if (d === null || e.pointerId !== d.pointerId) return
    e.stopPropagation()
    release()
    setCursor(zRef.draggable ? 'grab' : '')
    if (d.started) zRef.onDrag('end', hit(e) ?? zRef.at)
  }

  const accent = useMemo(() => colour(palette.selected), [palette])
  const lit = hovered || zRef.dragging
  return (
    <group ref={root}>
      {fill ? (
        <mesh geometry={fill} position={[0, 0, zRef.level]} raycast={noRaycast} renderOrder={3}>
          <meshBasicMaterial
            color={accent}
            transparent
            opacity={0.1}
            depthWrite={false}
            side={DoubleSide}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-4}
          />
        </mesh>
      ) : null}
      {outlines.map((pts, i) => (
        <Line
          key={i}
          points={pts}
          color={accent}
          lineWidth={1.25}
          transparent
          opacity={0.8}
          raycast={noRaycast}
          renderOrder={3}
        />
      ))}
      <group ref={spot} position={[zRef.at[0], zRef.at[1], zRef.level + LIFT]}>
        {/* the grab target: the ring's disc, invisible at rest, filled while held */}
        <mesh
          renderOrder={6}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerOver={(e) => {
            e.stopPropagation()
            setHovered(true)
            if (zRef.draggable && drag.current === null) setCursor('grab')
          }}
          onPointerOut={() => {
            setHovered(false)
            if (drag.current === null) setCursor('')
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <circleGeometry args={[Math.max(r, 1.5), 40]} />
          <meshBasicMaterial
            color={accent}
            transparent
            opacity={zRef.dragging ? 0.3 : hovered && zRef.draggable ? 0.14 : 0}
            depthTest={false}
            depthWrite={false}
            side={DoubleSide}
          />
        </mesh>
        <Line
          points={marks.circle}
          color={accent}
          lineWidth={lit ? 2.25 : 1.75}
          depthTest={false}
          renderOrder={7}
          raycast={noRaycast}
        />
        <Line
          points={marks.h}
          color={accent}
          lineWidth={1.25}
          depthTest={false}
          renderOrder={7}
          raycast={noRaycast}
        />
        <Line
          points={marks.v}
          color={accent}
          lineWidth={1.25}
          depthTest={false}
          renderOrder={7}
          raycast={noRaycast}
        />
      </group>
      {/* the spot's screen position (`data-zref-spot`, e2e) and its chip while hovered or held */}
      <Html
        position={[zRef.at[0], zRef.at[1], zRef.level]}
        zIndexRange={[20, 10]}
        className={styles['zSpotAnchor']}
      >
        <span data-zref-spot="" aria-hidden="true">
          {lit ? (
            <span className={styles['zSpotChip']} data-dragging={zRef.dragging ? '' : undefined}>
              {zRef.caption}
            </span>
          ) : null}
        </span>
      </Html>
    </group>
  )
}
