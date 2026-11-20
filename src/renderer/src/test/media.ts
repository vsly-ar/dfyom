// `matchMedia` for jsdom with a switchable `prefers-reduced-motion`, so components' reduced-motion
// fallbacks can be tested (docs/conventions/ui.md#motion).
type Listener = (e: MediaQueryListEvent) => void

let reduced = false
const lists = new Set<{ query: string; listeners: Set<Listener> }>()

const matches = (query: string): boolean =>
  query.includes('prefers-reduced-motion: reduce') ? reduced : false

/** Switch the emulated OS reduced-motion preference and notify listeners. */
export function setReducedMotion(value: boolean): void {
  if (reduced === value) return
  reduced = value
  for (const l of lists) {
    for (const fn of l.listeners)
      fn({ matches: matches(l.query), media: l.query } as MediaQueryListEvent)
  }
}

window.matchMedia = (query: string): MediaQueryList => {
  const entry = { query, listeners: new Set<Listener>() }
  lists.add(entry)
  return {
    get matches() {
      return matches(query)
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, fn: Listener) => entry.listeners.add(fn),
    removeEventListener: (_type: string, fn: Listener) => entry.listeners.delete(fn),
    addListener: (fn: Listener) => entry.listeners.add(fn),
    removeListener: (fn: Listener) => entry.listeners.delete(fn),
    dispatchEvent: () => true,
  } as unknown as MediaQueryList
}
