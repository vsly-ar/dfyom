// Reduced motion: the OS preference or the app setting (`data-motion='reduce'` on the root,
// set by the settings store in 3.3b). Doc: docs/conventions/ui.md#motion
import { useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener('change', onChange)
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] })
  return () => {
    mql.removeEventListener('change', onChange)
    observer.disconnect()
  }
}

function snapshot(): boolean {
  return document.documentElement.dataset['motion'] === 'reduce' || window.matchMedia(QUERY).matches
}

/**
 * True when motion should be reduced. CSS handles durations (tokens.css zeroes them); use this
 * where a looping animation must be replaced by a static fallback element.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}

/**
 * A motion token in ms from the root style (`--motion-fast`, …); 0 when reduced motion zeroes it,
 * it is unset (tests without tokens.css) or there is no DOM: callers then skip the motion.
 */
export function motionMs(name: string): number {
  if (typeof document === 'undefined') return 0
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const n = Number.parseFloat(v)
  return Number.isFinite(n) ? (v.endsWith('ms') ? n : n * 1000) : 0
}
