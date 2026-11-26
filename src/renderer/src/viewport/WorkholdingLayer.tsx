// Workholding in the plan scene (docs/modes/workholding.md#ui-summary, ui.md#workholding): each
// obstacle prism as a neutral solid (`--vp-grid-major`, outlined in `--vp-edge`; not the accent,
// not the stock colour), the open item's keep-out zone as a faint dashed halo at its top + margin,
// and the first hit of each collision finding as a `--danger` ring with a vertical tick; the solids
// of an item a collision names in `--danger`. Drawn in the setup's WCS inside the run layer's
// frame. X2-6: toe clamps drag along their edge (`clamps`): hovering a clamp's solid shows a grab
// cursor and a chip; a drag moves it by the pointer's travel along its edge on the plane it was
// pressed at and reports the new `at` (WCS), the caller snaps and commits on release; a press
// without moving selects it; Escape cancels; camera controls are off while held. Each clamp has a
// focusable anchor (`data-workholding-clamp`): Arrow keys nudge it. Nothing else is pickable.
// Doc: docs/modes/workholding.md#toe-clamp-drag-x2-6, docs/conventions/ui.md#workholding
import { Html, Line, type CameraControlsImpl } from '@react-three/drei'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Color, ExtrudeGeometry, Matrix4, Shape, SRGBColorSpace, Vector2, type Group } from 'three'
import type { Palette, Rgb } from './colours'
import styles from './Viewport.module.css'

type P = readonly [number, number]

/** What the run layer draws for the setup's workholding (`RunScene.workholding`). */
export interface WorkholdingOverlay {
  /** One solid per prism (WCS, mm); `zMin` already clamped to the table. */
  readonly solids: readonly {
    readonly itemId: string
    readonly outline: readonly P[]
    readonly zMin: number
    readonly zMax: number
    /** A collision finding names the item: drawn in `--danger`. */
    readonly colliding?: boolean
  }[]
  /** The open item's keep-out zone: outlines grown by the margin, drawn at `z`. */
  readonly halo?: { readonly outlines: readonly (readonly P[])[]; readonly z: number } | undefined
  /** The open item (its solids drawn a step stronger). */
  readonly selected?: string | undefined
  /** First hits of collision findings (WCS, mm). */
  readonly hits: readonly (readonly [number, number, number])[]
  /** Toe clamps that drag along their edge (X2-6); absent: nothing is pickable. */
  readonly clamps?: ClampDrag | undefined
}

export type ClampDragPhase = 'start' | 'move' | 'end' | 'cancel'

/** One draggable toe clamp (WCS). */
export interface ClampHandle {
  readonly itemId: string
  /** The WCS axis its edge runs along: 0 (X) or 1 (Y). */
  readonly axis: 0 | 1
  /** Its centre along the edge, WCS mm (`at` less the work zero). */
  readonly at: number
  /** The top centre of its grip, WCS mm: where its anchor sits. */
  readonly anchor: readonly [number, number, number]
  /** Name and position, shown while hovered or held. */
  readonly caption: string
  /** The anchor's accessible name. */
  readonly label: string
  readonly dragging: boolean
}

export interface ClampDrag {
  readonly handles: readonly ClampHandle[]
  onSelect(itemId: string): void
  /** `at`: the clamp's new centre along its edge (WCS mm), the pointer's travel added. */
  onDrag(phase: ClampDragPhase, itemId: string, at: number): void
  /** Arrow keys on the anchor: move by `mm` along the edge. */
  onNudge(itemId: string, mm: number): void
}

/** A press that moves less than this (px) is a click (ui.md). */
const CLICK_PX = 4

const noRaycast = (): void => {}

interface SolidEvents {
  onPointerDown(e: ThreeEvent<PointerEvent>): void
  onPointerMove(e: ThreeEvent<PointerEvent>): void
  onPointerUp(e: ThreeEvent<PointerEvent>): void
  onPointerOver(e: ThreeEvent<PointerEvent>): void
  onPointerOut(): void
  onClick(e: ThreeEvent<MouseEvent>): void
}
const colour = (c: Rgb) => new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)

function Solid({
  outline,
  zMin,
  zMax,
  fill,
  edge,
  strong,
  events,
}: {
  outline: readonly P[]
  zMin: number
  zMax: number
  fill: Color
  edge: Color
  strong: boolean
  /** Pointer handlers of a draggable clamp; without them the solid is not pickable. */
  events?: SolidEvents | undefined
}): React.JSX.Element | null {
  const depth = zMax - zMin
  const geometry = useMemo(() => {
    if (outline.length < 3 || !(depth > 0)) return null
    const shape = new Shape(outline.map((p) => new Vector2(p[0], p[1])))
    return new ExtrudeGeometry(shape, { depth, bevelEnabled: false })
  }, [outline, depth])
  useEffect(() => () => geometry?.dispose(), [geometry])
  const ring = useMemo(
    () => [...outline, outline[0]!].map((p): [number, number, number] => [p[0], p[1], zMax]),
    [outline, zMax],
  )
  if (geometry === null) return null
  return (
    <group>
      <mesh
        geometry={geometry}
        position={[0, 0, zMin]}
        {...(events === undefined ? { raycast: noRaycast } : events)}
        renderOrder={1}
      >
        <meshStandardMaterial
          color={fill}
          roughness={0.85}
          metalness={0.05}
          transparent
          opacity={strong ? 0.95 : 0.8}
        />
      </mesh>
      <Line
        points={ring}
        color={edge}
        lineWidth={strong ? 1.5 : 1}
        raycast={noRaycast}
        renderOrder={2}
      />
    </group>
  )
}

export function WorkholdingLayer({
  workholding,
  palette,
}: {
  workholding: WorkholdingOverlay
  palette: Palette
}): React.JSX.Element {
  const invalidate = useThree((s) => s.invalidate)
  const getState = useThree((s) => s.get)
  const root = useRef<Group>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const drag = useRef<{
    itemId: string
    pointerId: number
    down: [number, number]
    z: number
    from: P | null
    started: boolean
    target: Element | null
  } | null>(null)
  useEffect(() => invalidate(), [workholding, hovered, invalidate])
  const fill = useMemo(() => colour(palette.gridMajor), [palette])
  const edge = useMemo(() => colour(palette.edge), [palette])
  const halo = useMemo(() => colour(palette.edge), [palette])
  const danger = useMemo(() => colour(palette.danger), [palette])
  const clamps = workholding.clamps
  const handleOf = (id: string) => clamps?.handles.find((h) => h.itemId === id)

  const setControls = (on: boolean) => {
    const c = getState().controls as CameraControlsImpl | null
    if (c) c.enabled = on
  }
  const setCursor = (cursor: string) => {
    getState().gl.domElement.style.cursor = cursor
  }
  useEffect(() => () => setCursor(''), []) // eslint-disable-line react-hooks/exhaustive-deps
  /** The pointer ray on the horizontal plane at `z` (the layer's WCS); null when it misses. */
  const hit = (e: ThreeEvent<PointerEvent>, z: number): P | null => {
    const g = root.current
    if (!g) return null
    const ray = e.ray.clone().applyMatrix4(new Matrix4().copy(g.matrixWorld).invert())
    const dz = ray.direction.z
    if (Math.abs(dz) < 1e-9) return null
    const t = (z - ray.origin.z) / dz
    if (t < 0) return null
    return [ray.origin.x + t * ray.direction.x, ray.origin.y + t * ray.direction.y]
  }
  const moved = (h: ClampHandle, p: P | null): number => {
    const from = drag.current?.from
    if (p === null || from == null) return h.at
    return h.at + p[h.axis] - from[h.axis]
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
      setCursor(hovered === null ? '' : 'grab')
      const h = handleOf(d.itemId)
      if (d.started && h) clamps?.onDrag('cancel', d.itemId, h.at)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  const eventsOf = (h: ClampHandle): SolidEvents => ({
    onPointerDown(e) {
      if (e.button !== 0) return
      e.stopPropagation()
      const target = e.target as Element | null
      target?.setPointerCapture?.(e.pointerId)
      setControls(false)
      const z = root.current ? root.current.worldToLocal(e.point.clone()).z : 0
      drag.current = {
        itemId: h.itemId,
        pointerId: e.pointerId,
        down: [e.clientX, e.clientY],
        z,
        from: hit(e, z),
        started: false,
        target,
      }
    },
    onPointerMove(e) {
      const d = drag.current
      if (d === null || d.itemId !== h.itemId || e.pointerId !== d.pointerId) return
      e.stopPropagation()
      if (!d.started) {
        if (Math.hypot(e.clientX - d.down[0], e.clientY - d.down[1]) < CLICK_PX) return
        d.started = true
        setCursor('grabbing')
        clamps?.onDrag('start', h.itemId, h.at)
      }
      clamps?.onDrag('move', h.itemId, moved(h, hit(e, d.z)))
    },
    onPointerUp(e) {
      const d = drag.current
      if (d === null || d.itemId !== h.itemId || e.pointerId !== d.pointerId) return
      e.stopPropagation()
      const end = moved(h, hit(e, d.z))
      release()
      setCursor('grab')
      if (d.started) clamps?.onDrag('end', h.itemId, end)
      else clamps?.onSelect(h.itemId)
    },
    onPointerOver(e) {
      e.stopPropagation()
      setHovered(h.itemId)
      if (drag.current === null) setCursor('grab')
    },
    onPointerOut() {
      setHovered((x) => (x === h.itemId ? null : x))
      if (drag.current === null) setCursor('')
    },
    onClick: (e) => e.stopPropagation(),
  })
  const colliding = new Set(workholding.solids.filter((s) => s.colliding).map((s) => s.itemId))
  return (
    <group ref={root}>
      {workholding.solids.map((s, i) => {
        const h = handleOf(s.itemId)
        return (
          <Solid
            key={`${s.itemId}-${i}`}
            outline={s.outline}
            zMin={s.zMin}
            zMax={s.zMax}
            fill={s.colliding ? danger : fill}
            edge={s.colliding ? danger : edge}
            strong={
              s.itemId === workholding.selected || s.itemId === hovered || h?.dragging === true
            }
            events={h === undefined ? undefined : eventsOf(h)}
          />
        )
      })}
      {clamps?.handles.map((h) => (
        <Html
          key={`clamp-${h.itemId}`}
          position={[h.anchor[0], h.anchor[1], h.anchor[2]]}
          center
          zIndexRange={[10, 0]}
          className={styles['tabAnchor']}
        >
          <button
            type="button"
            aria-label={h.label}
            data-workholding-clamp={h.itemId}
            data-colliding={colliding.has(h.itemId) ? '' : undefined}
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
              clamps.onNudge(h.itemId, dir * (e.shiftKey ? 10 : 1))
            }}
          />
        </Html>
      ))}
      {clamps?.handles
        .filter((h) => h.dragging || h.itemId === hovered)
        .map((h) => (
          <Html
            key={`chip-${h.itemId}`}
            position={[h.anchor[0], h.anchor[1], h.anchor[2]]}
            zIndexRange={[20, 10]}
            className={styles['zSpotAnchor']}
          >
            <span className={styles['zSpotChip']} data-dragging={h.dragging ? '' : undefined}>
              {h.caption}
            </span>
          </Html>
        ))}
      {workholding.halo?.outlines.map((o, i) => (
        <Line
          key={`halo-${i}`}
          points={[...o, o[0]!].map((p): [number, number, number] => [
            p[0],
            p[1],
            workholding.halo!.z,
          ])}
          color={halo}
          lineWidth={1}
          dashed
          dashSize={1.5}
          gapSize={1}
          transparent
          opacity={0.7}
          raycast={noRaycast}
          renderOrder={3}
        />
      ))}
      {workholding.hits.map((h, i) => (
        <group key={`hit-${i}`} position={[h[0], h[1], h[2]]}>
          <mesh raycast={noRaycast} renderOrder={4}>
            <ringGeometry args={[2.2, 3, 32]} />
            <meshBasicMaterial color={danger} depthTest={false} transparent />
          </mesh>
          <Line
            points={[
              [0, 0, 0],
              [0, 0, 12],
            ]}
            color={danger}
            lineWidth={2}
            depthTest={false}
            raycast={noRaycast}
            renderOrder={4}
          />
        </group>
      ))}
    </group>
  )
}
