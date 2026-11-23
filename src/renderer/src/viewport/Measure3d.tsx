// The 3D viewport's measure tool (task U3): while on, a click on the part, the stock or a shown
// reference picks a point (snapped to the nearest vertex of the triangle under the pointer or a
// stock corner within `SNAP_PX`, unless Alt is held or snapping is off); two points show a
// dimension line (always on top) and the distance chip with ΔX, ΔY, ΔZ on a second line. A drag
// still orbits. Nothing is stored. After the first point, holding Shift locks the line to the
// nearest part-frame axis with a dashed guide in that axis colour (DF20); a click that hits nothing
// reports `null`, so the Viewport can clear two set points (DF21). The reference ghost is not pickable for selection, so this
// raycasts the meshes tagged `userData.measure` itself.
// Doc: docs/conventions/ui.md#snap-and-measure
import { Html, Line } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Color,
  Mesh,
  Raycaster,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type BufferAttribute,
  type Intersection,
  type Object3D,
} from 'three'
import type { UnitSystem } from '../../../core/project/document'
import { snapMessages } from '../messages/snap'
import type { Palette } from './colours'
import { MeasureChip, measureBetween } from './MeasureTool'
import { AXES, closestOnAxis, lockAxis, projectOnAxis, type AxisName } from './measure-axis'
import type { Box, Vec3 } from './mesh'
import { snapPoint, type SnapKind, type SnapPoint } from './snap'
import { SnapGlyph } from './SnapGlyph'
import styles from './Viewport.module.css'

export interface MeasurePoints {
  readonly a: Vec3 | null
  readonly b: Vec3 | null
}

/** A press that moves less than this (px) is a click (ui.md). */
const CLICK_PX = 4

const noRaycast = (): void => {}

/** Corners of a box. */
function corners(b: Box): Vec3[] {
  const out: Vec3[] = []
  for (const x of [b.min[0], b.max[0]])
    for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z])
  return out
}

interface Hover {
  readonly at: Vec3
  readonly kind: SnapKind | null
  /** The axis the line is locked to (Shift after the first point, DF20). */
  readonly axis?: AxisName
}

/** What `pointAt` reads of a pointer or key event. */
interface PointerState {
  readonly clientX: number
  readonly clientY: number
  readonly altKey: boolean
  readonly shiftKey: boolean
}

export function Measure3d({
  points,
  onPick,
  stock,
  snap,
  units,
  palette,
  onHover,
  onAxis,
}: {
  points: MeasurePoints
  /** A click: the picked point, or null when it hit nothing (DF21: clears two set points). */
  onPick(p: Vec3 | null): void
  stock: Box | null
  snap: boolean
  units: UnitSystem
  palette: Palette
  /** The point under the pointer (for the live distance), or null. */
  onHover?(p: Vec3 | null): void
  /** The axis the line is locked to while Shift is held, or null. */
  onAxis?(axis: AxisName | null): void
}): React.JSX.Element {
  const gl = useThree((s) => s.gl)
  const getState = useThree((s) => s.get)
  const invalidate = useThree((s) => s.invalidate)
  const [hover, setHover] = useState<Hover | null>(null)
  const down = useRef<{ x: number; y: number } | null>(null)
  const latest = useRef({ onPick, onHover, onAxis, stock, snap, points })
  useLayoutEffect(() => {
    latest.current = { onPick, onHover, onAxis, stock, snap, points }
  })

  useEffect(() => {
    const el = gl.domElement
    const raycaster = new Raycaster()
    const pointAt = (e: PointerState): Hover | null => {
      const free = pointFree(e)
      const { a, b } = latest.current.points
      if (!e.shiftKey || a === null || b !== null) return free
      // Shift after the first point: lock to the axis nearest the pointer's direction (DF20)
      const { camera, size } = getState()
      const r = el.getBoundingClientRect()
      const px: [number, number] = [e.clientX - r.left, e.clientY - r.top]
      const toPx = (p: Vec3): [number, number] => {
        const v = new Vector3(...p).project(camera)
        return [((v.x + 1) / 2) * size.width, ((1 - v.y) / 2) * size.height]
      }
      const probe = Math.max(1e-3, camera.position.distanceTo(new Vector3(...a)) * 0.05)
      const axis = lockAxis(a, px, toPx, probe)
      if (axis === null) return free
      if (free?.kind != null) return { at: projectOnAxis(a, axis, free.at), kind: free.kind, axis }
      raycaster.setFromCamera(
        new Vector2((px[0] / size.width) * 2 - 1, -(px[1] / size.height) * 2 + 1),
        camera,
      )
      const o = raycaster.ray.origin
      const d = raycaster.ray.direction
      return { at: closestOnAxis(a, axis, [o.x, o.y, o.z], [d.x, d.y, d.z]), kind: null, axis }
    }
    const pointFree = (e: PointerState): Hover | null => {
      const { camera, scene, size } = getState()
      const r = el.getBoundingClientRect()
      const px: [number, number] = [e.clientX - r.left, e.clientY - r.top]
      raycaster.setFromCamera(
        new Vector2((px[0] / size.width) * 2 - 1, -(px[1] / size.height) * 2 + 1),
        camera,
      )
      const hits: Intersection[] = []
      scene.traverse((o: Object3D) => {
        if (o instanceof Mesh && o.userData['measure'] !== undefined && o.visible)
          Mesh.prototype.raycast.call(o, raycaster, hits)
      })
      hits.sort((p, q) => p.distance - q.distance)
      const hit = hits[0]
      const { stock: box, snap: snapOn } = latest.current
      // candidates: the hit triangle's vertices and the stock corners, compared on screen
      const candidates: { at: Vec3; kind: SnapPoint['kind'] }[] = []
      if (hit?.face && hit.object instanceof Mesh) {
        const pos = hit.object.geometry.getAttribute('position') as BufferAttribute
        for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
          const v = new Vector3().fromBufferAttribute(pos, i).applyMatrix4(hit.object.matrixWorld)
          candidates.push({ at: [v.x, v.y, v.z], kind: 'end' })
        }
      }
      if (box) for (const c of corners(box)) candidates.push({ at: c, kind: 'corner' })
      const toPx = (p: Vec3): [number, number] => {
        const v = new Vector3(...p).project(camera)
        return [((v.x + 1) / 2) * size.width, ((1 - v.y) / 2) * size.height]
      }
      if (snapOn && !e.altKey && candidates.length > 0) {
        const onScreen = candidates.map((c) => ({ kind: c.kind, at: toPx(c.at) }))
        const s = snapPoint(px, { points: onScreen, edges: [] }, { pxPerUnit: 1 })
        if (s !== null) {
          const k = onScreen.findIndex((c) => c.at === s.at)
          if (k >= 0) return { at: candidates[k]!.at, kind: s.kind }
        }
      }
      return hit ? { at: [hit.point.x, hit.point.y, hit.point.z], kind: null } : null
    }
    let last: PointerState | null = null
    const show = (e: PointerState) => {
      last = e
      const h = pointAt(e)
      setHover(h)
      latest.current.onHover?.(h?.at ?? null)
      latest.current.onAxis?.(h?.axis ?? null)
      invalidate()
    }
    const move = (e: PointerEvent) => show(e)
    // pressing or releasing Shift re-evaluates the point under the resting pointer
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Shift' || last === null) return
      show({ ...last, shiftKey: e.type === 'keydown' })
    }
    const press = (e: PointerEvent) => {
      if (e.button === 0) down.current = { x: e.clientX, y: e.clientY }
    }
    const release = (e: PointerEvent) => {
      const d = down.current
      down.current = null
      if (d === null || Math.hypot(e.clientX - d.x, e.clientY - d.y) >= CLICK_PX) return
      latest.current.onPick(pointAt(e)?.at ?? null)
    }
    const leave = () => {
      last = null
      setHover(null)
      latest.current.onHover?.(null)
      latest.current.onAxis?.(null)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerdown', press)
    el.addEventListener('pointerup', release)
    el.addEventListener('pointerleave', leave)
    window.addEventListener('keydown', key)
    window.addEventListener('keyup', key)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('keyup', key)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerdown', press)
      el.removeEventListener('pointerup', release)
      el.removeEventListener('pointerleave', leave)
    }
  }, [gl, getState, invalidate])

  const { a } = points
  const b = points.b ?? (a !== null ? (hover?.at ?? null) : null)
  const result = a !== null && b !== null ? measureBetween(a, b) : null
  const edge = useMemo(() => new Color().setRGB(...palette.edge, SRGBColorSpace), [palette.edge])
  useEffect(() => invalidate(), [points, invalidate])
  // the axis guide (DF20): a dashed line through the first point along the locked axis
  const axis = points.b === null ? hover?.axis : undefined
  const guide = useMemo(() => {
    if (a === null || axis === undefined) return null
    const d = AXES[axis]
    const span = stock ? Math.hypot(...stock.max.map((v, i) => v - stock.min[i]!)) * 1.5 : 200
    const c = palette[axis === 'x' ? 'axisX' : axis === 'y' ? 'axisY' : 'axisZ']
    return {
      points: [
        [a[0] - d[0] * span, a[1] - d[1] * span, a[2] - d[2] * span],
        [a[0] + d[0] * span, a[1] + d[1] * span, a[2] + d[2] * span],
      ] as [number, number, number][],
      colour: new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace),
    }
  }, [a, axis, stock, palette])

  return (
    <group>
      {guide ? (
        <Line
          points={guide.points}
          color={guide.colour}
          lineWidth={1}
          dashed
          dashSize={2}
          gapSize={2}
          depthTest={false}
          renderOrder={7}
          raycast={noRaycast}
        />
      ) : null}
      {a !== null && b !== null ? (
        <Line
          points={[
            [a[0], a[1], a[2]],
            [b[0], b[1], b[2]],
          ]}
          color={edge}
          lineWidth={1.5}
          depthTest={false}
          renderOrder={8}
          raycast={noRaycast}
        />
      ) : null}
      {[a, points.b].map((p, i) =>
        p === null ? null : (
          <Html key={i} position={[p[0], p[1], p[2]]} zIndexRange={[20, 10]}>
            <div className={styles['measureEnd']} />
          </Html>
        ),
      )}
      {result && a && b && result.distance > 0 ? (
        <Html
          position={[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]}
          zIndexRange={[30, 20]}
        >
          <div className={styles['snapAnchor']}>
            <MeasureChip
              at={[0, -10]}
              inline
              distance={result.distance}
              parts={[
                ['x', result.deltas[0]!],
                ['y', result.deltas[1]!],
                ['z', result.deltas[2]!],
              ]}
              units={units}
            />
          </div>
        </Html>
      ) : null}
      {hover?.kind != null ? (
        <Html position={[hover.at[0], hover.at[1], hover.at[2]]} zIndexRange={[20, 10]}>
          <div className={styles['snapAnchor']}>
            <SnapGlyph
              key={`${hover.kind}:${hover.at.join(',')}`}
              kind={hover.kind}
              x={0}
              y={0}
              label={hover.kind === 'end' ? snapMessages.vertex : snapMessages.target[hover.kind]}
            />
          </div>
        </Html>
      ) : null}
    </group>
  )
}
