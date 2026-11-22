// The Shape Editor's flat view (task U1): the shape drawn flat and orthographic as a CAD drawing
// in SVG over the viewport – grid and frame axes, the resolved loops (1.5 px edge lines, a quiet
// removal tint with islands untinted), the selected item dashed amber, "Show items" outlines,
// the handles of the selected item with the value chip, and an invalid state's red segment with
// its error marker over the last valid outline. Pan (drag on empty space, trackpad scroll) and
// zoom (wheel or pinch, to the cursor); no orbit. Props-driven: the design mode owns the data
// and the gesture (one drag = one gesture, commits ≤ every 100 ms, Escape cancels).
// Doc: docs/conventions/ui.md#shape-editor, #shapes-v03, #accessibility-shape-ui
import { Eye, Maximize, X } from 'lucide-react'
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
import { shapeMessages } from '../messages/shape'
import { Toolbar, ToolbarButton, useReducedMotion } from '../ui'
import {
  chainPath,
  dragStepMm,
  fitView,
  gridSteps,
  panBy,
  toScreen,
  toShape,
  zoomAt,
  type FlatView,
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
import styles from './ShapeView.module.css'

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
  /** The rounding of the written value at this zoom (mm). */
  readonly stepMm: number
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
}

function useSize(ref: React.RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState(DEFAULT_SIZE)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0)
        setSize((s) => (s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }))
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
function itemElements(item: Item | undefined, n: number): { elements: Element2[]; closed: boolean } | undefined {
  if (item === undefined) return undefined
  const chain = itemChain(item, n, [])
  return chain === undefined ? undefined : { elements: [...chain.loop.elements], closed: chain.closed }
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

  const inset = props.insetRight ?? 0
  const fitted = (w: number, h: number): FlatView => {
    const f = fitView(drawing?.bounds, Math.max(w - inset, w / 3), h)
    return f
  }
  const fit = useCallback(() => {
    touched.current = false
    setView(fitted(size.width, size.height))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, size, inset])
  // fit on the first outline and on resize until the user pans or zooms
  const hasDrawing = drawing !== null
  useEffect(() => {
    if (!touched.current && hasDrawing) fit()
    // refit on size changes and when the first outline arrives, not on every edit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, hasDrawing, inset])
  const v = view ?? fitted(size.width, size.height)

  const item = selected === null ? undefined : (drag?.index === selected ? drag.last : items[selected])
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
    if (d?.started && !d.cancelled)
      onDrag({ phase, index: d.index, handle: d.handle.id, item: d.last, stepMm: dragStepMm(v.scale) })
  }
  const onHandleDown = (e: PointerEvent, index: number, h: ShapeHandle) => {
    if (e.button !== 0 || item === undefined || props.isLocked(index, h)) return
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    const at = local(e)
    const p = toShape(v, at)
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
        onDrag({ phase: 'start', index: d.index, handle: d.handle.id, item: d.base, stepMm: dragStepMm(v.scale) })
      }
      const p = toShape(v, at)
      const next = dragHandle(d.base, d.handle.id, [p[0] + d.offset[0], p[1] + d.offset[1]], {
        shift: e.shiftKey,
        from: d.handle.at,
      })
      d.last = next
      d.pointer = at
      setDrag({ ...d })
      onDrag({ phase: 'move', index: d.index, handle: d.handle.id, item: next, stepMm: dragStepMm(v.scale) })
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
        const cur = prev ?? fitView(drawing?.bounds, r.width || DEFAULT_SIZE.width, r.height || DEFAULT_SIZE.height)
        if (gesture === 'pan') return panBy(cur, -e.deltaX, -e.deltaY)
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
        return zoomAt(cur, Math.exp((-e.deltaY * unit) / 300), [e.clientX - r.left, e.clientY - r.top])
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [drawing])

  // ── keyboard ─────────────────────────────────────────────────────────────────────────────
  const endKeyRun = useCallback(() => {
    const run = keyRun.current
    if (run === null) return
    clearTimeout(run.timer)
    keyRun.current = null
    onDrag({ phase: 'end', index: run.drag.index, handle: run.drag.handle.id, item: run.drag.last, stepMm: 0.1 })
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
      props.onExit()
      return
    }
    if ((e.key === 'f' || e.key === 'F') && e.target === e.currentTarget && !e.metaKey && !e.ctrlKey) {
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
    const dir = arrows[e.key]
    const h = handles.find((x) => x.id === focused)
    if (dir && h && item !== undefined && selected !== null) {
      e.preventDefault()
      if (props.isLocked(selected, h)) return
      const step = nudgeStep(e)
      let run = keyRun.current
      if (run === null || run.drag.handle.id !== h.id) {
        endKeyRun()
        const d: Drag = {
          index: selected,
          handle: h,
          base: item,
          down: [0, 0],
          offset: [0, 0],
          started: true,
          cancelled: false,
          last: item,
          pointer: toScreen(v, h.at),
        }
        run = { drag: d, timer: setTimeout(endKeyRun, KEY_RUN_MS) }
        keyRun.current = run
        onDrag({ phase: 'start', index: selected, handle: h.id, item, stepMm: 0.1 })
      }
      clearTimeout(run.timer)
      run.timer = setTimeout(endKeyRun, KEY_RUN_MS)
      const cur = itemHandles(run.drag.last).find((x) => x.id === h.id) ?? h
      const next = dragHandle(run.drag.last, h.id, [cur.at[0] + dir[0] * step, cur.at[1] + dir[1] * step])
      run.drag.last = next
      onDrag({ phase: 'move', index: selected, handle: h.id, item: next, stepMm: Math.min(step, 0.1) })
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
      lines.push({ d: `M${sx} 0V${size.height}`, major: Math.abs(x / major - Math.round(x / major)) < 1e-6 })
    }
    for (let y = Math.ceil(lo[1] / minor) * minor; y <= hi[1]; y += minor) {
      const sy = v.oy - y * v.scale
      lines.push({ d: `M0 ${sy}H${size.width}`, major: Math.abs(y / major - Math.round(y / major)) < 1e-6 })
    }
    return lines
  }, [v, size, units])

  const fillPath = drawing?.loops
    .filter((l) => l.closed)
    .map((l) => chainPath(v, l.elements, true))
    .join('')
  const others = props.showItems
    ? items.flatMap((it, n) => {
        if (n === selected) return []
        const ch = itemElements(it, n)
        return ch ? [{ n, d: chainPath(v, ch.elements, ch.closed) }] : []
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
      const a = toScreen(v, ends[0])
      const b = toScreen(v, ends[1])
      return { d: `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`, at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Vec2 }
    }
    const ch = itemElements(it, bad.item)
    if (ch !== undefined && ch.elements.length > 0) {
      const first = ch.elements[0]!
      return { d: chainPath(v, ch.elements, ch.closed), at: toScreen(v, first.a) }
    }
    const h = itemHandles(it)[0]
    return h ? { d: '', at: toScreen(v, h.at) } : null
  }, [bad, drag, items, v])

  const origin = toScreen(v, [0, 0])
  const axisLen = 36
  const chipHandle = drag?.started
    ? drag.handle
    : keyRun.current !== null
      ? keyRun.current.drag.handle
      : null
  const chipAt = drag?.started ? drag.pointer : chipHandle && item ? toScreen(v, itemHandles(item).find((h) => h.id === chipHandle.id)?.at ?? [0, 0]) : null

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
        <g className={styles['axes']}>
          <path className={styles['axisX']} d={`M${origin[0]} ${origin[1]}h${axisLen}m-5 -3.5l5 3.5l-5 3.5`} />
          <path className={styles['axisY']} d={`M${origin[0]} ${origin[1]}v${-axisLen}m-3.5 5l3.5 -5l3.5 5`} />
          <text className={styles['axisLabel']} x={origin[0] + axisLen + 4} y={origin[1] + 4}>
            x
          </text>
          <text className={styles['axisLabel']} x={origin[0] - 3} y={origin[1] - axisLen - 5}>
            y
          </text>
        </g>
        <g className={styles['drawing']} data-testid="shape-outline">
          {fillPath ? <path className={styles['fill']} d={fillPath} fillRule="evenodd" /> : null}
          {drawing?.loops.map((l, i) => (
            <path
              key={i}
              className={styles['edge']}
              d={chainPath(v, l.elements, l.closed)}
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
            d={chainPath(v, selectedChain.elements, selectedChain.closed)}
            data-testid="shape-selected-item"
          />
        ) : null}
        {badDraw ? (
          <g className={styles['bad']} data-testid="shape-invalid">
            {badDraw.d ? <path d={badDraw.d} /> : null}
            <g transform={`translate(${badDraw.at[0]} ${badDraw.at[1]})`} className={styles['marker']}>
              <circle r="7" />
              <path d="M0 -3.5V0.8M0 3.2V3.3" />
            </g>
          </g>
        ) : null}
        {selected !== null && item !== undefined ? (
          <g className={styles['handles']} key={selected}>
            {handles.map((h) => {
              const at = toScreen(v, h.at)
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
      </svg>
      <div className={styles['chip']} aria-hidden="true">
        {props.face === null ? m.chip(null) : m.chip(props.face)}
      </div>
      <div
        className={styles['toolbar']}
        style={inset > 0 ? { transform: `translateX(${-inset}px)` } : undefined}
      >
        <Toolbar label={m.region} floating>
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
      </div>
      {chipHandle && chipAt && item ? (
        <div
          className={styles['valueChip']}
          style={{ left: chipAt[0] + 14, top: chipAt[1] + 14 }}
          data-testid="shape-value-chip"
        >
          {readoutText(drag?.last ?? keyRun.current?.drag.last ?? item, chipHandle, units, true)}
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
      </p>
    </div>
  )
}
