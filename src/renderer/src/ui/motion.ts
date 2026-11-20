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
