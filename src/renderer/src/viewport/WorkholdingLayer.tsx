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
// Design review R8 (D75): with `ghost` (an operation or an item is selected) every item but the
// open one is drawn transparent without depth write (the stock and toolpaths show through) and is
// not pickable (no handlers, no anchor: the pointer reaches what is behind); the open clamp stays
// drawn as before and draggable; a colliding ghost keeps a stronger `--danger`. R9: a surface hold
// as a thin layer under the stock, `--vp-grid-major` hatched in `--vp-edge`. DF133 RW1: in the Run
// scene, read-only, `outlined` while the scene cannot vouch for the items' place (not homed, no
// connection): no fill, dashed `--vp-edge` rims and corner edges; turning solid fades the fill in
// over `--motion-fast` (instant with reduced motion).
// Doc: docs/modes/workholding.md#toe-clamp-drag-x2-6, docs/conventions/ui.md#workholding,
// docs/modes/run-workholding.md#scene
import { Html, Line, type CameraControlsImpl } from '@react-three/drei'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  CanvasTexture,
  Color,
  ExtrudeGeometry,
  Matrix4,
  RepeatWrapping,
  Shape,
  SRGBColorSpace,
  Vector2,
  type Group,
  type MeshStandardMaterial,
} from 'three'
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
  /**
   * An operation or an item is selected (design review R8): every item but `selected` is drawn
   * transparent and is not pickable.
   */
  readonly ghost?: boolean | undefined
  /** A surface hold (tape, vacuum, glue; R9): a thin hatched layer under the stock (WCS, mm). */
  readonly surface?:
    { readonly outline: readonly P[]; readonly zMin: number; readonly zMax: number } | undefined
  /**
   * Run scene (DF133 RW1): the items' place is not vouched for (not homed, not connected): drawn
   * as dashed outlines without fill.
   */
  readonly outlined?: boolean | undefined
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

/** R8: item `id` is drawn faint and is not pickable (something else is selected). */
export const isGhost = (o: WorkholdingOverlay, id: string): boolean =>
  o.ghost === true && id !== o.selected

/** The clamps that take the pointer and have an anchor: none of the ghosts (R8). */
export const pickableClamps = (o: WorkholdingOverlay): readonly ClampHandle[] =>
  o.clamps?.handles.filter((h) => !isGhost(o, h.itemId)) ?? []

/** A press that moves less than this (px) is a click (ui.md). */
const CLICK_PX = 4

const noRaycast = (): void => {}

/** A ghost item's fill opacity (R8): there, but the stock and toolpaths read through it. */
const GHOST_OPACITY = 0.12

/** `--motion-fast` (ms): an outlined item turning solid fades its fill in this long (DF133 RW1). */
export const SOLID_FADE_MS = 120

/** Dashes of an outlined item (mm). */
const OUTLINE_DASH = { dashSize: 2, gapSize: 1.5 } as const

/**
 * The vertical edges of an outlined prism (DF133 RW1): every corner of a polygon, four points
 * around a circle (its outline has many). Pure.
 */
export function outlineCorners(outline: readonly P[]): readonly P[] {
  if (outline.length <= 8) return outline
  const step = outline.length / 4
  return [0, 1, 2, 3].map((k) => outline[Math.round(k * step) % outline.length]!)
}

/** The surface hold's hatching period (mm, R9). */
const HATCH_MM = 3

/** A tile of 45° hatching: `edge` lines on `fill` (sRGB CSS colours), repeating per `HATCH_MM`. */
function hatchTexture(fill: Rgb, edge: Rgb): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 32
  const g = canvas.getContext('2d')
  if (g === null) return null
  const css = (c: Rgb) => `rgb(${c.map((v) => Math.round(v * 255)).join(' ')})`
  g.fillStyle = css(fill)
  g.fillRect(0, 0, 32, 32)
  g.strokeStyle = css(edge)
  g.lineWidth = 4
  for (const o of [-32, 0, 32]) {
    g.beginPath()
    g.moveTo(o, 32)
    g.lineTo(o + 32, 0)
    g.stroke()
  }
  const t = new CanvasTexture(canvas)
  t.colorSpace = SRGBColorSpace
  t.wrapS = t.wrapT = RepeatWrapping
  t.repeat.set(1 / HATCH_MM, 1 / HATCH_MM)
  return t
}

/** R9: the surface hold's layer, a thin hatched slab (not pickable). */
function SurfaceLayer({
  outline,
  zMin,
  zMax,
  palette,
}: NonNullable<WorkholdingOverlay['surface']> & { palette: Palette }): React.JSX.Element | null {
  const depth = zMax - zMin
  const geometry = useMemo(() => {
    if (outline.length < 3 || !(depth > 0)) return null
    // world UVs (mm): the hatching keeps its period on the top and the thin sides
    return new ExtrudeGeometry(new Shape(outline.map((p) => new Vector2(p[0], p[1]))), {
      depth,
      bevelEnabled: false,
    })
  }, [outline, depth])
  const texture = useMemo(() => hatchTexture(palette.gridMajor, palette.edge), [palette])
  useEffect(() => () => geometry?.dispose(), [geometry])
  useEffect(() => () => texture?.dispose(), [texture])
  const ring = useMemo(
    () => [...outline, outline[0]!].map((p): [number, number, number] => [p[0], p[1], zMax]),
    [outline, zMax],
  )
  if (geometry === null) return null
  return (
    <group>
      <mesh geometry={geometry} position={[0, 0, zMin]} raycast={noRaycast}>
        <meshBasicMaterial
          {...(texture === null ? { color: colour(palette.gridMajor) } : { map: texture })}
        />
      </mesh>
      <Line points={ring} color={colour(palette.edge)} lineWidth={1} raycast={noRaycast} />
    </group>
  )
}

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
  ghost,
  events,
  outlined = false,
  reducedMotion = false,
}: {
  outline: readonly P[]
  zMin: number
  zMax: number
  fill: Color
  edge: Color
  strong: boolean
  /** DF133 RW1: dashed outlines, no fill (the Run scene cannot vouch for the place). */
  outlined?: boolean
  reducedMotion?: boolean
  /** Drawn faint, without depth write (R8); `colliding`: a stronger faint fill. */
  ghost?: 'plain' | 'colliding' | undefined
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
  const opacity =
    ghost === 'plain' ? GHOST_OPACITY : ghost === 'colliding' ? 0.35 : strong ? 0.95 : 0.8
  // DF133 RW1: outlined → solid fades the fill in (the mesh mounts with the change)
  const material = useRef<MeshStandardMaterial>(null)
  const invalidate = useThree((s) => s.invalidate)
  const was = useRef(outlined)
  const fade = useRef<{ from: number | null } | null>(null)
  useLayoutEffect(() => {
    if (was.current && !outlined && !reducedMotion) {
      fade.current = { from: null }
      if (material.current) material.current.opacity = 0
      invalidate()
    }
    was.current = outlined
  }, [outlined, reducedMotion, invalidate])
  useFrame(({ clock }) => {
    const f = fade.current
    const m = material.current
    if (f === null || m === null) return
    const now = clock.getElapsedTime() * 1000
    f.from ??= now
    const t = Math.min(1, (now - f.from) / SOLID_FADE_MS)
    m.opacity = opacity * t
    if (t < 1) invalidate()
    else fade.current = null
  })
  if (geometry === null) return null
  if (outlined) {
    const bottom = ring.map((p): [number, number, number] => [p[0], p[1], zMin])
    return (
      <group>
        {[ring, bottom].map((points, i) => (
          <Line
            key={i}
            points={points}
            color={edge}
            lineWidth={1}
            dashed
            {...OUTLINE_DASH}
            raycast={noRaycast}
            renderOrder={2}
          />
        ))}
        {outlineCorners(outline).map((p, i) => (
          <Line
            key={`v${i}`}
            points={[
              [p[0], p[1], zMin],
              [p[0], p[1], zMax],
            ]}
            color={edge}
            lineWidth={1}
            dashed
            {...OUTLINE_DASH}
            raycast={noRaycast}
            renderOrder={2}
          />
        ))}
      </group>
    )
  }
  return (
    <group>
      <mesh
        geometry={geometry}
        position={[0, 0, zMin]}
        {...(events === undefined ? { raycast: noRaycast } : events)}
        renderOrder={1}
      >
        <meshStandardMaterial
          ref={material}
          color={fill}
          roughness={0.85}
          metalness={0.05}
          transparent
          opacity={opacity}
          depthWrite={ghost === undefined}
        />
      </mesh>
      <Line
        points={ring}
        color={edge}
        lineWidth={strong ? 1.5 : 1}
        raycast={noRaycast}
        renderOrder={2}
        {...(ghost === 'plain' ? { transparent: true, opacity: 0.4, depthWrite: false } : {})}
      />
    </group>
  )
}

export function WorkholdingLayer({
  workholding,
  palette,
  reducedMotion = false,
}: {
  workholding: WorkholdingOverlay
  palette: Palette
  reducedMotion?: boolean
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
  const ghosted = (id: string) => isGhost(workholding, id)
  const handles = pickableClamps(workholding)
  const handleOf = (id: string) => handles.find((h) => h.itemId === id)
  // a hovered clamp that turns into a ghost gets no pointer-out: drop its hover (while
  // rendering, React's adjust-on-change pattern) and its grab cursor
  if (hovered !== null && ghosted(hovered)) setHovered(null)
  const ghost = workholding.ghost === true
  useEffect(() => {
    if (ghost && drag.current === null) getState().gl.domElement.style.cursor = ''
  }, [ghost, workholding.selected, getState])

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
            ghost={ghosted(s.itemId) ? (s.colliding ? 'colliding' : 'plain') : undefined}
            events={h === undefined ? undefined : eventsOf(h)}
            outlined={workholding.outlined === true}
            reducedMotion={reducedMotion}
          />
        )
      })}
      {workholding.surface === undefined ? null : (
        <SurfaceLayer {...workholding.surface} palette={palette} />
      )}
      {handles.map((h) => (
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
              clamps?.onNudge(h.itemId, dir * (e.shiftKey ? 10 : 1))
            }}
          />
        </Html>
      ))}
      {handles
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
