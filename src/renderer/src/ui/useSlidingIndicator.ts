// Positions a sliding indicator (segmented thumb, mode underline) under the selected item; the
// CSS transition does the slide (--motion-slow / --motion-emphasis). Doc: docs/conventions/ui.md#motion
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

/**
 * Measures the element matching `selector` inside `root` whenever `key` changes or the root
 * resizes, and returns the indicator's style. `inset` shrinks it on both sides (px). Hidden
 * until the first measurement; the first placement and resizes jump, selection changes slide.
 */
export function useSlidingIndicator(
  root: RefObject<HTMLElement | null>,
  selector: string,
  key: unknown,
  inset = 0,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' })
  const placed = useRef(false)

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const measure = (jump: boolean): void => {
      const target = el.querySelector<HTMLElement>(selector)
      if (!target) {
        setStyle({ visibility: 'hidden' })
        placed.current = false
        return
      }
      setStyle({
        width: `${Math.max(0, target.offsetWidth - 2 * inset)}px`,
        transform: `translateX(${target.offsetLeft + inset}px)`,
        ...(jump ? { transition: 'none' } : {}),
      })
      placed.current = true
    }
    measure(!placed.current)
    const ro = new ResizeObserver(() => measure(true))
    ro.observe(el)
    return () => ro.disconnect()
  }, [root, selector, key, inset])

  // after a jump, re-enable the transition for the next selection change
  useLayoutEffect(() => {
    if (style.transition !== 'none') return
    const id = requestAnimationFrame(() => setStyle(({ transition: _t, ...rest }) => rest))
    return () => cancelAnimationFrame(id)
  }, [style])

  return style
}
