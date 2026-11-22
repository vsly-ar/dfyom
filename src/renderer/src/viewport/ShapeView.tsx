// The Shape Editor's flat view (task U1): the shape drawn flat and orthographic as a CAD drawing
// in SVG over the viewport – grid and frame axes, the resolved loops (1.5 px edge lines, a quiet
// removal tint with islands untinted), the selected item dashed amber, "Show items" outlines,
// the handles of the selected item with the value chip, and an invalid state's red segment with
// its error marker over the last valid outline. Pan (drag on empty space, trackpad scroll) and
// zoom (wheel or pinch, to the cursor); no orbit. Props-driven: the design mode owns the data
// and the gesture (one drag = one gesture, commits ≤ every 100 ms, Escape cancels).
// Task U3: handle drags snap (grid, shape points, stock corners and edges, the reference section,
// `snap.ts`; Alt places freely, the "Snap" toggle turns it off), the reference section is drawn
// with its depth field, and the measure tool (`M`) measures between two snapped points.
// Doc: docs/conventions/ui.md#shape-editor, #shapes-v03, #accessibility-shape-ui, #snap-and-measure
import { Eye, Magnet, Maximize, Ruler, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { itemChain } from '../../../core/design/shape-items'
import type { ShapeItem } from '../../../core/design/shape.dto'
import type { Bounds2, Element as Element2 } from '../../../core/geometry/2d/model'
import type { Vec2 } from '../../../core/geometry/model'
import type { UnitSystem } from '../../../core/project/document'
import type { Quantity } from '../../../core/quantity/quantity'
import { shapeMessages } from '../messages/shape'
import { snapMessages } from '../messages/snap'
import { QuantityInput, Toolbar, ToolbarButton, ToolbarSeparator, useReducedMotion } from '../ui'
import {
  chainPath,
  dragStepMm,
  fitView,
  gridSteps,
  panBy,
  placedBounds,
  placeElements,
  placePoint,
  toScreen,
  toShape,
  unplacePoint,
  zoomAt,
  type FlatView,
  type ShapePlacement,
} from './flat-view'
import {
  dragHandle,
  handleReadout,
  itemHandles,
  nudgeStep,
  segmentEnds,
  type BadMark,
  type ShapeHandle,
} from './shape-handles'
import { classifyWheel, type WheelHistory } from './wheel'
import { Dimension2d, MeasureChip, measureBetween } from './MeasureTool'
import { SnapGlyph } from './SnapGlyph'
import {
  isExactSnap,
  shapePoints,
  snapPoint,
  stockTargets,
  type Snap,
  type SnapTargets,
} from './snap'
import styles from './ShapeView.module.css'

const sm = snapMessages
/** The rounding of a value written from an exact snap (grid, stock, shape point): 0.1 µm. */
export const SNAP_STEP_MM = 1e-4

const m = shapeMessages.view
type Item = ShapeItem<number>

/** One loop or open path of the resolved shape (mm). */
export interface FlatLoop {
  readonly elements: readonly Element2[]
  readonly closed: boolean
  readonly hole: boolean
}

export interface FlatDrawing {
  readonly loops: readonly FlatLoop[]
  readonly bounds: Bounds2 | undefined
}

/** One step of a handle gesture (pointer drag or a run of arrow keys). */
export interface ShapeDragEvent {
  readonly phase: 'start' | 'move' | 'end' | 'cancel'
  readonly index: number
  readonly handle: string
  /** The item at the drag's start (`start`) or as dragged (`move`). */
  readonly item: Item
  /**
   * The rounding of the written value (mm): about one pixel at this zoom, or `SNAP_STEP_MM` when
   * the point snapped to an exact target, so a grid or stock value is written as it is.
   */
  readonly stepMm: number
}

/** Snapping in the editor (task U3). */
export interface SnapSettings {
  /** Grid step (mm) in the view's frame: the face frame, or the shape frame without a face. */
  readonly grid: number
  /** The "Snap" toolbar toggle (per window). */
  readonly on: boolean
  onToggle(on: boolean): void
}

/** The reference section on the face (task U3) and its depth field. */
export interface SectionView {
  /** Segments `[u0, v0, u1, v1, …]` in the face frame (mm); null while it is cut. */
  readonly segments: Float32Array | null
  readonly depth: Quantity | undefined
  readonly defaultUnit: 'mm' | 'in'
  onDepth(depth: Quantity): void
}

export interface ShapeViewProps {
  readonly name: string
  /** The face the shape is seen on ("Top face"), or null: its own frame. */
  readonly face: string | null
  /** The last valid outline, or null before the shape resolved once. */
  readonly drawing: FlatDrawing | null
  /** The items as numbers (undefined: a value that does not load). */
  readonly items: readonly (Item | undefined)[]
  readonly selected: number | null
  /** The selected segment row of a path item: its end handle highlights. */
  readonly segment: number | null
  readonly showItems: boolean
  onShowItems(show: boolean): void
  /** Whether a handle edits a formula (drawn disabled, tooltip "Remove the formula to drag."). */
  isLocked(index: number, handle: ShapeHandle): boolean
  /** The invalid state: the offending item and where on it, or null. */
  readonly bad: { readonly item: number; readonly mark: BadMark } | null
  readonly units: UnitSystem
  onDrag(e: ShapeDragEvent): void
  /** Escape outside a drag, or the close button: back to the part. */
  onExit(): void
  /** Accessible summary ("Shape 1: 1 loop, 6 elements, in its own frame. Selected: …"). */
  readonly summary: string
  /** Px of the right edge covered by the inspector overlay: the toolbar and the fit move beside it. */
  readonly insetRight?: number
  readonly className?: string | undefined
  /**
   * Face-on context (task U2): the shape as the first operation using it places it on its face
   * (rotation, mirror, position), with that face's stock rectangle and axis names. Handles still
   * edit the shape's own frame; the placement is frozen while a drag runs.
   */
  readonly context?: FaceContext | null
  /** Snapping of handle drags and measure points (task U3); absent: none. */
  readonly snap?: SnapSettings | null
  /** The reference section while a reference is shown on a face (task U3). */
  readonly section?: SectionView | null
}

/** The face an operation places the shape on (face frame, mm). */
export interface FaceContext {
  readonly placement: ShapePlacement
  /** The stock face seen in the face frame: [0, 0] to [length, width]. */
  readonly stock: { readonly length: number; readonly width: number }
  /** The face frame's axis names ("x", "y" on the top face). */
  readonly axes: readonly [string, string]
}

/** A press that moves less than this (px) is a click and commits nothing (ui.md). */
const CLICK_PX = 4
/** A run of arrow keys ends this long after the last key (one gesture per run). */
const KEY_RUN_MS = 500
const DEFAULT_SIZE = { width: 800, height: 600 }

interface Drag {
  readonly index: number
  readonly handle: ShapeHandle
  readonly base: Item
  readonly down: Vec2
  /** Handle position minus the pointer's shape point at the press, so the handle does not jump. */
  readonly offset: Vec2
  started: boolean
  cancelled: boolean
  last: Item
  pointer: Vec2
  /** Snap targets frozen at the press (the outline as it was), and the handle's start (view frame). */
  readonly targets: SnapTargets | null
  readonly startView: Vec2
  snapped: boolean
}

interface Measure {
  /** Picked points in the view frame (mm). */
  readonly a: Vec2 | null
  readonly b: Vec2 | null
}

function useSize(ref: React.RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState(DEFAULT_SIZE)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0)
        setSize((s) =>
          s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height },
        )
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

const handleName = (h: ShapeHandle): string => {
  const r = h.role
  switch (r.kind) {
    case 'centre':
      return m.handle.centre
    case 'start':
      return m.handle.start
    case 'end':
      return m.handle.end(r.segment + 1)
    case 'radius':
      return m.handle.radius(r.segment + 1)
    case 'size':
      return m.handle.size[r.field]
  }
}

function readoutText(item: Item, h: ShapeHandle, units: UnitSystem, chip: boolean): string {
  const r = handleReadout(item, h)
  if (r.kind === 'point') return chip ? m.chipPoint(r.x, r.y, units) : m.point(r.x, r.y, units)
  return m.chipLength(r.field, r.mm, units)
}

/** The chain of one item for its outline (dashed when selected, thin under "Show items"). */
function itemElements(
  item: Item | undefined,
  n: number,
): { elements: Element2[]; closed: boolean } | undefined {
  if (item === undefined) return undefined
  const chain = itemChain(item, n, [])
  return chain === undefined
    ? undefined
    : { elements: [...chain.loop.elements], closed: chain.closed }
}

export function ShapeView(props: ShapeViewProps): React.JSX.Element {
  const { items, selected, drawing, units, onDrag, bad } = props
  const rootRef = useRef<HTMLDivElement>(null)
  const size = useSize(rootRef)
  const reduced = useReducedMotion()
  const summaryId = useId()
  const [view, setView] = useState<FlatView | null>(null)
  const touched = useRef(false) // panned or zoomed by the user: keep the view on resize
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const pan = useRef<{ x: number; y: number } | null>(null)
  const wheelHistory = useRef<WheelHistory | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const handleRefs = useRef(new Map<string, SVGGElement>())
  const keyRun = useRef<{ drag: Drag; timer: ReturnType<typeof setTimeout> } | null>(null)
  // the arrow-key run's drag for rendering (the value chip); `keyRun` holds it for the handlers
  const [keyDrag, setKeyDrag] = useState<Drag | null>(null)
  // the snap shown (view frame) while dragging or measuring
  const [snapShown, setSnapShown] = useState<Snap | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [measure, setMeasure] = useState<Measure>({ a: null, b: null })
  const [measureHover, setMeasureHover] = useState<Vec2 | null>(null)
  const measurePress = useRef<{ at: Vec2; last: Vec2; panned: boolean } | null>(null)

  const inset = props.insetRight ?? 0
  // the face-on placement, frozen while a drag or a key run edits the shape
  const [frozen, setFrozen] = useState<FaceContext | null>(props.context ?? null)
  const editing = (drag?.started ?? false) || keyDrag !== null
  if (!editing && frozen !== (props.context ?? null)) setFrozen(props.context ?? null)
  const fc = editing ? frozen : (props.context ?? null)
  const viewBounds = useMemo((): Bounds2 | undefined => {
    if (fc === null) return drawing?.bounds
    const placed = placedBounds(fc.placement, drawing?.loops.flatMap((l) => l.elements) ?? [])
    const lo: Vec2 = [0, 0]
    const hi: Vec2 = [fc.stock.length, fc.stock.width]
    return placed === undefined
      ? { min: lo, max: hi }
      : {
          min: [Math.min(lo[0], placed.min[0]), Math.min(lo[1], placed.min[1])],
          max: [Math.max(hi[0], placed.max[0]), Math.max(hi[1], placed.max[1])],
        }
  }, [fc, drawing])
  const fitted = (w: number, h: number): FlatView => {
    const f = fitView(viewBounds, Math.max(w - inset, w / 3), h)
    return f
  }
  const fit = useCallback(() => {
    touched.current = false
    setView(fitted(size.width, size.height))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewBounds, size, inset])
  // fit on the first outline and on resize until the user pans or zooms
  const hasDrawing = drawing !== null
  useEffect(() => {
    if (!touched.current && hasDrawing) fit()
    // refit on size changes and when the first outline arrives, not on every edit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, hasDrawing, inset])
  const v = view ?? fitted(size.width, size.height)
  // shape frame ↔ screen through the placement (the face frame is the view's frame)
  const scr = (p: readonly [number, number]): Vec2 =>
    toScreen(v, fc === null ? p : placePoint(fc.placement, p))
  const toItem = (at: Vec2): Vec2 => {
    const q = toShape(v, at)
    return fc === null ? q : unplacePoint(fc.placement, q)
  }
  const path = (elements: readonly Element2[], closed: boolean): string =>
    chainPath(v, fc === null ? elements : placeElements(fc.placement, elements), closed)

  // ── snapping (task U3) ───────────────────────────────────────────────────────────────────
  const snap = props.snap ?? null
  const segments = props.section?.segments ?? null
  /** What a point can snap to now, in the view frame: the outline as drawn, stock, section, grid. */
  const targets = useMemo((): SnapTargets | null => {
    if (snap === null) return null
    const loops = (drawing?.loops ?? []).map((l) =>
      fc === null ? l.elements : placeElements(fc.placement, l.elements),
    )
    const stock = fc === null ? null : stockTargets(fc.stock.length, fc.stock.width)
    return {
      points: [...shapePoints(loops), ...(stock?.points ?? [])],
      edges: stock?.edges ?? [],
      reference: segments,
      grid: snap.grid,
    }
  }, [snap, drawing, fc, segments])
  const snapActive = snap !== null && snap.on
  /** The snap for a view-frame point, unless snapping is off or Alt is held. */
  const snapAt = (q: Vec2, e: { altKey: boolean }, t: SnapTargets | null, exclude?: Vec2) =>
    snapActive && !e.altKey && t !== null
      ? snapPoint(q, t, { pxPerUnit: v.scale, ...(exclude ? { exclude } : {}) })
      : null
  const toView = (p: Vec2): Vec2 => (fc === null ? p : placePoint(fc.placement, p))
  const fromView = (q: Vec2): Vec2 => (fc === null ? q : unplacePoint(fc.placement, q))

  const item =
    selected === null ? undefined : drag?.index === selected ? drag.last : items[selected]
  const handles = useMemo(() => (item === undefined ? [] : itemHandles(item)), [item])

  // ── pointer ──────────────────────────────────────────────────────────────────────────────
  const local = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = rootRef.current?.getBoundingClientRect()
    return [e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0)]
  }
  const finish = (phase: 'end' | 'cancel') => {
    const d = dragRef.current
    dragRef.current = null
    setDrag(null)
    setSnapShown(null)
    if (d?.started && !d.cancelled)
      onDrag({
        phase,
        index: d.index,
        handle: d.handle.id,
        item: d.last,
        stepMm: d.snapped ? SNAP_STEP_MM : dragStepMm(v.scale),
      })
  }
  const onHandleDown = (e: PointerEvent, index: number, h: ShapeHandle) => {
    if (e.button !== 0 || item === undefined || props.isLocked(index, h) || measuring) return
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    const at = local(e)
    const p = toItem(at)
    const d: Drag = {
      index,
      handle: h,
      base: item,
      down: at,
      offset: [h.at[0] - p[0], h.at[1] - p[1]],
      started: false,
      cancelled: false,
      last: item,
      pointer: at,
      targets,
      startView: toView(h.at),
      snapped: false,
    }
    dragRef.current = d
    setDrag(d)
    rootRef.current?.focus({ preventScroll: true })
  }
  const onPointerMove = (e: PointerEvent) => {
    const d = dragRef.current
    if (d !== null) {
      if (d.cancelled) return
      const at = local(e)
      if (!d.started) {
        if (Math.hypot(at[0] - d.down[0], at[1] - d.down[1]) < CLICK_PX) return
        d.started = true
        onDrag({
          phase: 'start',
          index: d.index,
          handle: d.handle.id,
          item: d.base,
          stepMm: dragStepMm(v.scale),
        })
      }
      const p = toItem(at)
      let target: Vec2 = [p[0] + d.offset[0], p[1] + d.offset[1]]
      // snapping (U3): the handle's point snaps in the view frame; Shift's 15° steps win over it
      const s = e.shiftKey ? null : snapAt(toView(target), e, d.targets, d.startView)
      if (s !== null) target = fromView(s.at)
      d.snapped = s !== null && isExactSnap(s.kind)
      setSnapShown(s)
      const next = dragHandle(d.base, d.handle.id, target, {
        shift: e.shiftKey,
        from: d.handle.at,
      })
      d.last = next
      d.pointer = at
      setDrag({ ...d })
      onDrag({
        phase: 'move',
        index: d.index,
        handle: d.handle.id,
        item: next,
        stepMm: d.snapped ? SNAP_STEP_MM : dragStepMm(v.scale),
      })
      return
    }
    const p = pan.current
    if (p !== null) {
      const at = local(e)
      touched.current = true
      setView(panBy(v, at[0] - p.x, at[1] - p.y))
      pan.current = { x: at[0], y: at[1] }
    }
  }
  const onPointerUp = () => {
    if (dragRef.current !== null) finish('end')
    pan.current = null
  }
  const onBackgroundDown = (e: PointerEvent) => {
    const at = local(e)
    pan.current = { x: at[0], y: at[1] }
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  // ── measure (task U3) ────────────────────────────────────────────────────────────────────
  const endMeasure = () => {
    setMeasuring(false)
    setMeasure({ a: null, b: null })
    setMeasureHover(null)
    setSnapShown(null)
    measurePress.current = null
  }
  const toggleMeasure = () => (measuring ? endMeasure() : setMeasuring(true))
  /** The measured point under the pointer: snapped, or where it is. */
  const measurePoint = (at: Vec2, e: { altKey: boolean }): { at: Vec2; snap: Snap | null } => {
    const q = toShape(v, at)
    const s = snapAt(q, e, targets)
    return { at: s?.at ?? q, snap: s }
  }
  const onMeasureDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    const at = local(e)
    measurePress.current = { at, last: at, panned: false }
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }
  const onMeasureMove = (e: PointerEvent) => {
    const at = local(e)
    const press = measurePress.current
    if (press !== null) {
      if (press.panned || Math.hypot(at[0] - press.at[0], at[1] - press.at[1]) >= CLICK_PX) {
        press.panned = true
        touched.current = true
        setView(panBy(v, at[0] - press.last[0], at[1] - press.last[1]))
        press.last = at
        return
      }
    }
    const p = measurePoint(at, e)
    setSnapShown(p.snap)
    setMeasureHover(p.at)
  }
  const onMeasureUp = (e: PointerEvent) => {
    const press = measurePress.current
    measurePress.current = null
    if (press === null || press.panned) return
    const p = measurePoint(local(e), e).at
    setMeasure((m0) => (m0.a === null || m0.b !== null ? { a: p, b: null } : { a: m0.a, b: p }))
  }

  // wheel: zoom to the cursor, a trackpad scroll pans (wheel.ts); not passive, so it can prevent scrolling
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const gesture = classifyWheel(e, wheelHistory.current, e.timeStamp)
      wheelHistory.current = { gesture, time: e.timeStamp }
      touched.current = true
      const r = el.getBoundingClientRect()
      setView((prev) => {
        const cur =
          prev ??
          fitView(viewBounds, r.width || DEFAULT_SIZE.width, r.height || DEFAULT_SIZE.height)
        if (gesture === 'pan') return panBy(cur, -e.deltaX, -e.deltaY)
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
        return zoomAt(cur, Math.exp((-e.deltaY * unit) / 300), [
          e.clientX - r.left,
          e.clientY - r.top,
        ])
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [viewBounds])

  // ── keyboard ─────────────────────────────────────────────────────────────────────────────
  const endKeyRun = useCallback(() => {
    const run = keyRun.current
    if (run === null) return
    clearTimeout(run.timer)
    keyRun.current = null
    setKeyDrag(null)
    onDrag({
      phase: 'end',
      index: run.drag.index,
      handle: run.drag.handle.id,
      item: run.drag.last,
      stepMm: 0.1,
    })
  }, [onDrag])
  useEffect(() => endKeyRun, [endKeyRun])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (dragRef.current?.started) {
        dragRef.current.cancelled = true
        const d = dragRef.current
        dragRef.current = null
        setDrag(null)
        onDrag({ phase: 'cancel', index: d.index, handle: d.handle.id, item: d.base, stepMm: 0 })
        return
      }
      if (dragRef.current !== null) {
        dragRef.current = null
        setDrag(null)
        return
      }
      if (measuring) {
        endMeasure()
        return
      }
      props.onExit()
      return
    }
    if (
      (e.key === 'm' || e.key === 'M') &&
      e.target === e.currentTarget &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      e.preventDefault()
      toggleMeasure()
      return
    }
    if (
      (e.key === 'f' || e.key === 'F') &&
      e.target === e.currentTarget &&
      !e.metaKey &&
      !e.ctrlKey
    ) {
      e.preventDefault()
      fit()
      return
    }
    if (e.key === 'Tab' && handles.length > 0 && selected !== null) {
      const ids = handles.map((h) => h.id)
      const at = focused === null ? -1 : ids.indexOf(focused)
      const next = at + (e.shiftKey ? -1 : 1)
      if (next >= 0 && next < ids.length) {
        e.preventDefault()
        handleRefs.current.get(ids[next]!)?.focus()
      } else if (at >= 0 && e.shiftKey) {
        e.preventDefault()
        rootRef.current?.focus()
      }
      return
    }
    const arrows: Record<string, Vec2> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, 1],
      ArrowDown: [0, -1],
    }
    const screenDir = arrows[e.key]
    // arrows move along the view's axes: back through the placement's rotation and mirror
    const dir: Vec2 | undefined =
      screenDir === undefined || fc === null
        ? screenDir
        : (() => {
            const o = unplacePoint(fc.placement, [0, 0])
            const q = unplacePoint(fc.placement, screenDir)
            return [q[0] - o[0], q[1] - o[1]]
          })()
    const h = handles.find((x) => x.id === focused)
    if (dir && h && item !== undefined && selected !== null) {
      e.preventDefault()
      if (props.isLocked(selected, h)) return
      const step = nudgeStep(e)
      let run = keyRun.current
      if (run === null || run.drag.handle.id !== h.id) {
        endKeyRun()
        run = null
      }
      if (run === null) {
        const d: Drag = {
          index: selected,
          handle: h,
          base: item,
          down: [0, 0],
          offset: [0, 0],
          started: true,
          cancelled: false,
          last: item,
          pointer: scr(h.at),
          targets: null,
          startView: toView(h.at),
          snapped: false,
        }
        run = { drag: d, timer: setTimeout(endKeyRun, KEY_RUN_MS) }
        onDrag({ phase: 'start', index: selected, handle: h.id, item, stepMm: 0.1 })
      }
      clearTimeout(run.timer)
      const cur = itemHandles(run.drag.last).find((x) => x.id === h.id) ?? h
      const next = dragHandle(run.drag.last, h.id, [
        cur.at[0] + dir[0] * step,
        cur.at[1] + dir[1] * step,
      ])
      const nextDrag: Drag = { ...run.drag, last: next }
      keyRun.current = { drag: nextDrag, timer: setTimeout(endKeyRun, KEY_RUN_MS) }
      setKeyDrag(nextDrag)
      onDrag({
        phase: 'move',
        index: selected,
        handle: h.id,
        item: next,
        stepMm: Math.min(step, 0.1),
      })
    }
  }

  // ── drawing ──────────────────────────────────────────────────────────────────────────────
  const grid = useMemo(() => {
    const { minor, major } = gridSteps(v.scale, units)
    const lo = toShape(v, [0, size.height])
    const hi = toShape(v, [size.width, 0])
    const lines: { d: string; major: boolean }[] = []
    const count = (hi[0] - lo[0]) / minor + (hi[1] - lo[1]) / minor
    if (count > 600) return lines
    for (let x = Math.ceil(lo[0] / minor) * minor; x <= hi[0]; x += minor) {
      const sx = v.ox + x * v.scale
      lines.push({
        d: `M${sx} 0V${size.height}`,
        major: Math.abs(x / major - Math.round(x / major)) < 1e-6,
      })
    }
    for (let y = Math.ceil(lo[1] / minor) * minor; y <= hi[1]; y += minor) {
      const sy = v.oy - y * v.scale
      lines.push({
        d: `M0 ${sy}H${size.width}`,
        major: Math.abs(y / major - Math.round(y / major)) < 1e-6,
      })
    }
    return lines
  }, [v, size, units])

  const fillPath = drawing?.loops
    .filter((l) => l.closed)
    .map((l) => path(l.elements, true))
    .join('')
  const others = props.showItems
    ? items.flatMap((it, n) => {
        if (n === selected) return []
        const ch = itemElements(it, n)
        return ch ? [{ n, d: path(ch.elements, ch.closed) }] : []
      })
    : []
  const selectedChain = selected === null ? undefined : itemElements(item, selected)

  const badDraw = useMemo(() => {
    if (bad === null) return null
    const it = drag?.index === bad.item ? drag.last : items[bad.item]
    if (it === undefined) return null
    if (it.kind === 'path' && bad.mark.kind !== 'item') {
      const ends = segmentEnds(it, bad.mark)
      if (ends === undefined) return null
      const a = scr(ends[0])
      const b = scr(ends[1])
      return {
        d: `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`,
        at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Vec2,
      }
    }
    const ch = itemElements(it, bad.item)
    if (ch !== undefined && ch.elements.length > 0) {
      const first = ch.elements[0]!
      return { d: path(ch.elements, ch.closed), at: scr(first.a) }
    }
    const h = itemHandles(it)[0]
    return h ? { d: '', at: scr(h.at) } : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bad, drag, items, v, fc])

  // the reference section in screen space (one path; thousands of short segments)
  const sectionPath = useMemo(() => {
    if (segments === null || segments.length === 0) return ''
    const parts: string[] = []
    for (let i = 0; i + 3 < segments.length; i += 4) {
      const a = toScreen(v, [segments[i]!, segments[i + 1]!])
      const b = toScreen(v, [segments[i + 2]!, segments[i + 3]!])
      parts.push(`M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`)
    }
    return parts.join('')
  }, [segments, v])

  // the measurement: picked points, or the first and the point under the pointer
  const mA = measure.a
  const mB = measure.b ?? (measuring && mA !== null ? measureHover : null)
  const measured = mA !== null && mB !== null ? measureBetween(mA, mB) : null
  const axisPair = fc?.axes ?? (['x', 'y'] as const)
  const measureParts = measured
    ? ([
        [axisPair[0], measured.deltas[0]!],
        [axisPair[1], measured.deltas[1]!],
      ] as const)
    : []
  const measureSummary =
    measure.a !== null && measure.b !== null && measured
      ? sm.measure.summary(measured.distance, measureParts, units)
      : ''

  const origin = toScreen(v, [0, 0])
  // the axis triad sits in the lower-left corner, off the drawing (U1 review: it covered a path's
  // start corner at the origin); the origin keeps a small cross
  const axisLen = 28
  const triad: Vec2 = [20, size.height - 20]
  const axisNames = fc?.axes ?? (['x', 'y'] as const)
  const chipHandle = drag?.started ? drag.handle : keyDrag !== null ? keyDrag.handle : null
  const chipAt = drag?.started
    ? drag.pointer
    : chipHandle && item
      ? scr(itemHandles(item).find((h) => h.id === chipHandle.id)?.at ?? [0, 0])
      : null

  return (
    <div
      ref={rootRef}
      role="region"
      aria-label={m.region}
      aria-describedby={summaryId}
      tabIndex={0}
      className={[styles['view'], props.className].filter(Boolean).join(' ')}
      data-reduced={reduced ? '' : undefined}
      data-dragging={drag?.started ? '' : undefined}
      data-measuring={measuring ? '' : undefined}
      data-shape-editor=""
      onKeyDown={onKeyDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => finish('cancel')}
    >
      <svg
        className={styles['svg']}
        width={size.width}
        height={size.height}
        aria-hidden="true"
        data-testid="shape-view"
      >
        <rect
          className={styles['background']}
          width={size.width}
          height={size.height}
          onPointerDown={onBackgroundDown}
        />
        <g className={styles['grid']}>
          {grid.map((l, i) => (
            <path key={i} d={l.d} data-major={l.major ? '' : undefined} />
          ))}
        </g>
        {fc !== null ? (
          <path
            className={styles['stockFace']}
            d={(() => {
              const a = toScreen(v, [0, 0])
              const b = toScreen(v, [fc.stock.length, fc.stock.width])
              return `M${a[0]} ${a[1]}H${b[0]}V${b[1]}H${a[0]}Z`
            })()}
            data-testid="shape-stock-face"
          />
        ) : null}
        {sectionPath ? (
          <path className={styles['section']} d={sectionPath} data-testid="shape-section" />
        ) : null}
        <path
          className={styles['origin']}
          d={`M${origin[0] - 5} ${origin[1]}h10M${origin[0]} ${origin[1] - 5}v10`}
        />
        <g className={styles['axes']} data-testid="shape-axes">
          <path
            className={styles['axisX']}
            d={`M${triad[0]} ${triad[1]}h${axisLen}m-5 -3.5l5 3.5l-5 3.5`}
          />
          <path
            className={styles['axisY']}
            d={`M${triad[0]} ${triad[1]}v${-axisLen}m-3.5 5l3.5 -5l3.5 5`}
          />
          <text className={styles['axisLabel']} x={triad[0] + axisLen + 4} y={triad[1] + 4}>
            {axisNames[0]}
          </text>
          <text className={styles['axisLabel']} x={triad[0] - 3} y={triad[1] - axisLen - 5}>
            {axisNames[1]}
          </text>
        </g>
        <g className={styles['drawing']} data-testid="shape-outline">
          {fillPath ? <path className={styles['fill']} d={fillPath} fillRule="evenodd" /> : null}
          {drawing?.loops.map((l, i) => (
            <path
              key={i}
              className={styles['edge']}
              d={path(l.elements, l.closed)}
              data-hole={l.hole ? '' : undefined}
            />
          ))}
        </g>
        {others.map((o) => (
          <path key={o.n} className={styles['itemOutline']} d={o.d} />
        ))}
        {selectedChain ? (
          <path
            className={styles['selectedOutline']}
            d={path(selectedChain.elements, selectedChain.closed)}
            data-testid="shape-selected-item"
          />
        ) : null}
        {badDraw ? (
          <g className={styles['bad']} data-testid="shape-invalid">
            {badDraw.d ? <path d={badDraw.d} /> : null}
            <g
              transform={`translate(${badDraw.at[0]} ${badDraw.at[1]})`}
              className={styles['marker']}
            >
              <circle r="7" />
              <path d="M0 -3.5V0.8M0 3.2V3.3" />
            </g>
          </g>
        ) : null}
        {selected !== null && item !== undefined ? (
          <g className={styles['handles']} key={selected}>
            {handles.map((h) => {
              const at = scr(h.at)
              const locked = props.isLocked(selected, h)
              const active = drag?.handle.id === h.id && drag.started
              const segmentHit =
                props.segment !== null &&
                ((h.role.kind === 'end' && h.role.segment === props.segment) ||
                  (h.role.kind === 'radius' && h.role.segment === props.segment))
              const name = m.handleName(handleName(h), readoutText(item, h, units, false))
              return (
                <g
                  key={h.id}
                  ref={(el) => {
                    if (el) handleRefs.current.set(h.id, el)
                    else handleRefs.current.delete(h.id)
                  }}
                  className={styles['handle']}
                  transform={`translate(${at[0]} ${at[1]})`}
                  data-kind={h.kind}
                  data-handle={h.id}
                  data-state={active ? 'dragged' : hovered === h.id ? 'hovered' : undefined}
                  data-locked={locked ? '' : undefined}
                  data-related={segmentHit ? '' : undefined}
                  tabIndex={-1}
                  role="button"
                  aria-label={locked ? `${name}. ${m.locked}` : name}
                  aria-disabled={locked || undefined}
                  onFocus={() => setFocused(h.id)}
                  onBlur={() => {
                    setFocused((f) => (f === h.id ? null : f))
                    endKeyRun()
                  }}
                  onPointerEnter={() => setHovered(h.id)}
                  onPointerLeave={() => setHovered((x) => (x === h.id ? null : x))}
                  onPointerDown={(e) => onHandleDown(e, selected, h)}
                >
                  {locked ? <title>{m.locked}</title> : null}
                  <rect className={styles['hit']} x={-12} y={-12} width={24} height={24} />
                  {h.kind === 'point' ? (
                    <rect className={styles['mark']} x={-3.5} y={-3.5} width={7} height={7} />
                  ) : h.kind === 'size' ? (
                    <path className={styles['mark']} d="M0 -4.5L4.5 0L0 4.5L-4.5 0Z" />
                  ) : (
                    <path className={styles['cross']} d="M-5 0H5M0 -5V5" />
                  )}
                </g>
              )
            })}
          </g>
        ) : null}
        {measuring ? (
          <rect
            className={styles['measureCatcher']}
            width={size.width}
            height={size.height}
            data-testid="measure-catcher"
            onPointerDown={onMeasureDown}
            onPointerMove={onMeasureMove}
            onPointerUp={onMeasureUp}
            onPointerLeave={() => {
              if (measurePress.current === null) setSnapShown(null)
            }}
          />
        ) : null}
        {mA !== null ? <Dimension2d a={toScreen(v, mA)} b={mB ? toScreen(v, mB) : null} /> : null}
      </svg>
      {measured && mA && mB && measured.distance > 0 ? (
        <MeasureChip
          at={(() => {
            const a = toScreen(v, mA)
            const b = toScreen(v, mB)
            const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
            // beside the line's middle, on its upper side
            const side = (b[0] - a[0]) / len >= 0 ? -1 : 1
            return [
              (a[0] + b[0]) / 2 + side * ((b[1] - a[1]) / len) * -16,
              (a[1] + b[1]) / 2 + side * ((b[0] - a[0]) / len) * 16,
            ] as const
          })()}
          distance={measured.distance}
          parts={measureParts}
          units={units}
        />
      ) : null}
      {snapShown !== null ? (
        <SnapGlyph
          key={
            snapShown.kind === 'edge' || snapShown.kind === 'reference'
              ? snapShown.kind
              : `${snapShown.kind}:${snapShown.at[0]}:${snapShown.at[1]}`
          }
          kind={snapShown.kind}
          x={toScreen(v, snapShown.at)[0]}
          y={toScreen(v, snapShown.at)[1]}
          label={sm.target[snapShown.kind]}
        />
      ) : null}
      {measuring ? (
        <p className={styles['measurePrompt']} role="status">
          {mA !== null && measure.b === null ? sm.measure.second : sm.measure.prompt}
        </p>
      ) : null}
      <div className={styles['chip']} aria-hidden="true">
        {props.face === null ? m.chip(null) : m.chip(props.face)}
      </div>
      <div
        className={styles['toolbar']}
        style={inset > 0 ? { transform: `translateX(${-inset}px)` } : undefined}
      >
        <Toolbar label={m.region} floating>
          {snap !== null ? (
            <ToolbarButton
              label={sm.toggle}
              icon={<Magnet aria-hidden="true" />}
              pressed={snap.on}
              tooltipSide="bottom"
              onClick={() => snap.onToggle(!snap.on)}
            />
          ) : null}
          <ToolbarButton
            label={sm.measure.tool}
            shortcut="M"
            icon={<Ruler aria-hidden="true" />}
            pressed={measuring}
            tooltipSide="bottom"
            onClick={toggleMeasure}
          />
          <ToolbarSeparator />
          <ToolbarButton
            label={m.showItems}
            icon={<Eye aria-hidden="true" />}
            pressed={props.showItems}
            tooltipSide="bottom"
            onClick={() => props.onShowItems(!props.showItems)}
          />
          <ToolbarButton
            label={m.fit}
            shortcut="F"
            icon={<Maximize aria-hidden="true" />}
            tooltipSide="bottom"
            onClick={fit}
          />
          <ToolbarButton
            label={m.close}
            shortcut="Esc"
            icon={<X aria-hidden="true" />}
            tooltipSide="bottom"
            onClick={props.onExit}
          />
        </Toolbar>
        {props.section ? (
          <div className={styles['sectionPanel']}>
            <QuantityInput
              label={sm.sectionDepth}
              kind="length"
              defaultUnit={props.section.defaultUnit}
              value={props.section.depth}
              onCommit={props.section.onDepth}
            />
          </div>
        ) : null}
      </div>
      {chipHandle && chipAt && item ? (
        <div
          className={styles['valueChip']}
          style={{ left: chipAt[0] + 14, top: chipAt[1] + 14 }}
          data-testid="shape-value-chip"
        >
          {readoutText(drag?.last ?? keyDrag?.last ?? item, chipHandle, units, true)}
        </div>
      ) : null}
      {drawing === null ? <p className={styles['empty']}>{m.noOutline}</p> : null}
      {bad !== null ? (
        <p className={styles['invalidNote']} role="status">
          {m.invalid}
        </p>
      ) : null}
      <p id={summaryId} className={styles['srOnly']}>
        {props.summary} {m.keys}
      </p>
      <p className={styles['srOnly']} aria-live="polite">
        {props.summary}
        {measureSummary ? ` ${measureSummary}` : ''}
      </p>
    </div>
  )
}
