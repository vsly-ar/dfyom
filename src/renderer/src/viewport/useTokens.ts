// Reads design tokens (CSS custom properties) for three.js, which cannot use CSS: one source of
// truth for the scene colours. Values are read on the element itself, so a theme scope
// (`.t-light` / `.t-dark`, the gallery) applies, and re-read when the theme changes.
// Doc: docs/conventions/ui.md#design-tokens
import { useLayoutEffect, useState, type RefObject } from 'react'

/** Current values of `names` on `el` (trimmed; '' when a token is not defined). */
export function readTokens<N extends string>(
  el: Element,
  names: readonly N[],
): Readonly<Record<N, string>> {
  const style = getComputedStyle(el)
  const out = {} as Record<N, string>
  for (const name of names) out[name] = style.getPropertyValue(name).trim()
  return out
}

/**
 * Calls `onChange` when the theme may have changed: the OS colour scheme, `data-theme` on the
 * root (the Light / Dark / System setting) or a theme class on `el` or an ancestor.
 */
export function subscribeTheme(el: Element, onChange: () => void): () => void {
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  mql.addEventListener('change', onChange)
  const observer = new MutationObserver(onChange)
  for (let node: Element | null = el; node; node = node.parentElement) {
    observer.observe(node, { attributes: true, attributeFilter: ['class', 'data-theme'] })
  }
  return () => {
    mql.removeEventListener('change', onChange)
    observer.disconnect()
  }
}

function sameValues(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

/**
 * Token values on the element behind `ref`, re-read on theme change. Empty strings until the
 * element is mounted. `names` should be a stable (module-level) array.
 */
export function useTokens<N extends string>(
  ref: RefObject<Element | null>,
  names: readonly N[],
): Readonly<Record<N, string>> {
  const [values, setValues] = useState<Readonly<Record<N, string>>>(
    () => Object.fromEntries(names.map((n) => [n, ''])) as Record<N, string>,
  )
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = (): void => {
      const next = readTokens(el, names)
      setValues((prev) => (sameValues(prev, next) ? prev : next))
    }
    read()
    return subscribeTheme(el, read)
  }, [ref, names])
  return values
}

/** One token (see `useTokens`). */
export function useToken(ref: RefObject<Element | null>, name: string): string {
  return useTokens(ref, singleList(name))[name] ?? ''
}

const singles = new Map<string, readonly string[]>()
function singleList(name: string): readonly string[] {
  let list = singles.get(name)
  if (!list) singles.set(name, (list = [name]))
  return list
}
