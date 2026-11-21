// Layout changes that wait for the pointer: a field's support area that would shrink on blur
// waits until the click that caused the blur has landed, so the click hits what was under the
// pointer at pointerdown. Doc: docs/conventions/ui.md#field (support area collapse)

let pressed = false
let installed = false
const waiting = new Set<() => void>()

function install(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  // capture: seen before any handler can stop it, and before mousedown moves focus (the blur)
  window.addEventListener('pointerdown', () => (pressed = true), true)
  const release = (): void => {
    pressed = false
    if (waiting.size === 0) return
    const run = [...waiting]
    waiting.clear()
    // the click follows pointerup in the same task; a timeout runs after it
    setTimeout(() => {
      for (const cb of run) cb()
    }, 0)
  }
  window.addEventListener('pointerup', release, true)
  window.addEventListener('pointercancel', release, true)
  window.addEventListener('blur', release)
}

/** Start tracking presses (idempotent); call before the first press matters (Field mount). */
export function trackPointer(): void {
  install()
}

/**
 * Run `cb` now if no pointer is pressed, else after the pointer is released and its click has
 * been dispatched. Returns a cancel function.
 */
export function afterPointerRelease(cb: () => void): () => void {
  install()
  if (!pressed) {
    cb()
    return () => {}
  }
  let live = true
  const once = (): void => {
    if (live) cb()
  }
  waiting.add(once)
  return () => {
    live = false
    waiting.delete(once)
  }
}
