// Drag to reorder (D45): `useReorder` (native pointer events, no dependency) lifts a row by its
// grip, shows the drop indicator line, refuses a drop it knows is invalid, glides rows to their new
// places after a move (pointer or Alt+↑/↓, FLIP) and shakes a refused row; `DragGrip` is the dotted
// grip, `ReorderStatus` the polite announcement and the visible refusal under the list.
// Doc: docs/conventions/ui.md#reordering-lists-d45
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Icon } from '../icons/Icon'
import { useReducedMotion } from '../motion'
import { dropGap, dropIndex, movedFrom } from './drop'
import styles from './Reorder.module.css'

/** Pointer travel (px) before a press on the grip becomes a drag. */
export const DRAG_THRESHOLD_PX = 3
/** How long a row waits at its drop spot for the new order before it goes back (ms). */
const SETTLE_MS = 2000
const SHAKE_MS = 300

export interface ReorderOptions {
  /** How many rows the list has (its direct `[data-reorder-item]` children, in order). */
  readonly count: number
  /** Changes whenever the order changes: the rows' ids, or the rows themselves. */
  readonly order: string
  /** Why moving row `from` to index `to` is refused, when known before the drop. */
  refusal?(from: number, to: number): string | undefined
  /** Moves row `from` to `to`; resolves false when refused (the row goes back and shakes). */
  onMove(from: number, to: number): Promise<boolean> | boolean
  /** A drop `refusal` refused (the caller shows the reason). */
  onRefused?(reason: string): void
}

interface DragState {
  readonly from: number
  readonly gap: number
  readonly dy: number
  readonly refused: string | undefined
  /** `drag` while the pointer is down; `drop` while the row waits for the new order. */
  readonly phase: 'drag' | 'drop'
  readonly order: string
}

/** Old rows' tops, to glide from once the order changes (`order`) or on the next render. */
interface Glide {
  readonly tops: readonly number[]
  readonly from: number
  readonly to: number
  readonly order: string
  readonly when: 'order' | 'next'
}

export interface ReorderItemProps {
  'data-reorder-item': ''
  'data-dragging'?: ''
  'data-drop'?: 'before' | 'after'
  'data-drop-refused'?: ''
  'data-shake'?: ''
  style?: CSSProperties
}

export interface Reorder {
  /** The list's class (merge with its own) and ref. */
  readonly listClass: string
  attachList(el: HTMLElement | null): void
  /** Data attributes of the list while a row is dragged. */
  readonly listProps: { 'data-dragging'?: ''; 'data-refused'?: '' }
  /** Props of row `i` (its `<li>`). */
  itemProps(i: number): ReorderItemProps
  /** Props of row `i`'s grip. */
  gripProps(i: number): { onPointerDown(e: ReactPointerEvent): void }
  /** While dragging over a refused spot: why. */
  readonly refusal: string | undefined
  /** Glide the rows after a move made another way (Alt+↑/↓): call just before it. */
  glide(from: number, to: number): void
  /** Shake row `i` (a move made another way was refused). */
  shake(i: number): void
}

const now = (el: Element): number => el.getBoundingClientRect().top

export function useReorder(options: ReorderOptions): Reorder {
  const opts = useRef(options)
  opts.current = options
  const list = useRef<HTMLElement | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [shaking, setShaking] = useState<number | null>(null)
  const glideRef = useRef<Glide | null>(null)
  const reduced = useReducedMotion()
  const { order, count } = options

  const items = useCallback(
    (): HTMLElement[] =>
      list.current === null
        ? []
        : [...list.current.children].filter(
            (e): e is HTMLElement =>
              e instanceof HTMLElement && e.hasAttribute('data-reorder-item'),
          ),
    [],
  )
  const tops = useCallback(() => items().map(now), [items])

  const shake = useCallback((i: number) => {
    setShaking(i)
    window.setTimeout(() => setShaking((s) => (s === i ? null : s)), SHAKE_MS)
  }, [])

  // a waiting row is shown only while the order it was dropped in is still the list's
  const view = drag !== null && (drag.phase === 'drag' || drag.order === order) ? drag : null

  useLayoutEffect(() => {
    const g = glideRef.current
    if (g === null || (g.when === 'order' && g.order === order)) return
    glideRef.current = null
    if (reduced) return
    for (const [j, el] of items().entries()) {
      const old = g.tops[movedFrom(j, g.from, g.to)]
      if (old === undefined) continue
      el.style.transition = 'none'
      el.style.transform = ''
      const d = old - now(el)
      if (Math.abs(d) < 0.5) {
        el.style.transition = ''
        continue
      }
      el.style.transform = `translateY(${d}px)`
      void el.offsetHeight
      el.style.transition = 'transform var(--motion-base) var(--ease-standard)'
      el.style.transform = ''
      const done = () => {
        el.style.transition = ''
      }
      el.addEventListener('transitionend', done, { once: true })
      window.setTimeout(done, 400)
    }
  })

  // a waiting row is done once the order changed; one waiting for an order that never comes goes back
  useEffect(() => {
    if (drag?.phase !== 'drop') return
    const moved = drag.order !== order
    const t = window.setTimeout(
      () => {
        if (!moved)
          glideRef.current = { tops: tops(), from: drag.from, to: drag.from, order, when: 'next' }
        setDrag(null)
      },
      moved ? 0 : SETTLE_MS,
    )
    return () => window.clearTimeout(t)
  }, [drag, order, tops])

  const glide = useCallback(
    (from: number, to: number) => {
      glideRef.current = { tops: tops(), from, to, order: opts.current.order, when: 'order' }
    },
    [tops],
  )

  const finish = (state: DragState, commit: boolean) => {
    const { from } = state
    const to = dropIndex(from, state.gap)
    const back = () => {
      glideRef.current = { tops: tops(), from, to: from, order: opts.current.order, when: 'next' }
      setDrag(null)
    }
    if (!commit || to === from) return back()
    if (state.refused !== undefined) {
      opts.current.onRefused?.(state.refused)
      shake(from)
      return back()
    }
    const at = opts.current.order
    glideRef.current = { tops: tops(), from, to, order: at, when: 'order' }
    setDrag({ ...state, phase: 'drop' })
    void Promise.resolve(opts.current.onMove(from, to)).then((ok) => {
      if (ok) return
      // refused by the command: back from where it waits, with a shake
      if (opts.current.order === at) {
        shake(from)
        back()
      }
    })
  }

  const gripProps = (i: number) => ({
    onPointerDown(e: ReactPointerEvent) {
      if (e.button !== 0 || view !== null) return
      e.preventDefault()
      const mids = items().map((el) => {
        const r = el.getBoundingClientRect()
        return r.top + r.height / 2
      })
      const startY = e.clientY
      let last: DragState | null = null
      const move = (ev: PointerEvent) => {
        const dy = ev.clientY - startY
        if (last === null && Math.abs(dy) < DRAG_THRESHOLD_PX) return
        const gap = dropGap(mids, ev.clientY)
        const to = dropIndex(i, gap)
        const refused = to === i ? undefined : opts.current.refusal?.(i, to)
        last = { from: i, gap, dy, refused, phase: 'drag', order: opts.current.order }
        setDrag(last)
      }
      const stop = (commit: boolean) => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', cancel)
        window.removeEventListener('keydown', key, true)
        if (last === null) return
        finish(last, commit)
      }
      const up = () => stop(true)
      const cancel = () => stop(false)
      const key = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape') return
        ev.preventDefault()
        ev.stopPropagation()
        stop(false)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', cancel)
      window.addEventListener('keydown', key, true)
    },
  })

  const to = view === null ? undefined : dropIndex(view.from, view.gap)
  const indicating = view !== null && view.phase === 'drag' && to !== view.from
  const itemProps = (i: number): ReorderItemProps => {
    const p: ReorderItemProps = { 'data-reorder-item': '' }
    if (view !== null && view.from === i) {
      p['data-dragging'] = ''
      p.style = { transform: `translateY(${view.dy}px)` }
    }
    if (indicating) {
      const where =
        view.gap === i ? 'before' : view.gap === count && i === count - 1 ? 'after' : undefined
      if (where !== undefined) {
        p['data-drop'] = where
        if (view.refused !== undefined) p['data-drop-refused'] = ''
      }
    }
    if (shaking === i && !reduced) p['data-shake'] = ''
    return p
  }

  const listProps: Reorder['listProps'] = {}
  if (view?.phase === 'drag') listProps['data-dragging'] = ''
  if (indicating && view.refused !== undefined) listProps['data-refused'] = ''

  return {
    listClass: styles['list'] ?? '',
    attachList: useCallback((el: HTMLElement | null) => {
      list.current = el
    }, []),
    listProps,
    itemProps,
    gripProps,
    refusal: indicating ? view.refused : undefined,
    glide,
    shake,
  }
}

/** The dotted grip: a pointer convenience, not a tab stop (the row's Alt+↑/↓ is the keyboard path). */
export function DragGrip({
  title,
  onPointerDown,
  className,
}: {
  /** Tooltip: "Drag to reorder (Alt+↑/↓)". */
  title: string
  onPointerDown(e: ReactPointerEvent): void
  /** Layout only (the navigator places it before the row icon, DF24); appended to its class. */
  className?: string | undefined
}): React.JSX.Element {
  return (
    <span
      className={[styles['grip'], className].filter(Boolean).join(' ')}
      title={title}
      aria-hidden="true"
      data-reorder-grip=""
      onPointerDown={onPointerDown}
    />
  )
}

/**
 * Under a reorderable list: the refusal (visible, while dragging over a refused spot or after a
 * refused move) and the polite live region announcing the last move or refusal (screen readers).
 */
export function ReorderStatus({
  refusal,
  announcement,
}: {
  refusal: string | undefined
  announcement: string
}): React.JSX.Element {
  return (
    <>
      {refusal !== undefined ? (
        <p className={styles['status']}>
          <Icon name="warning" />
          <span>{refusal}</span>
        </p>
      ) : null}
      <p className={styles['srOnly']} aria-live="polite">
        {announcement}
      </p>
    </>
  )
}
