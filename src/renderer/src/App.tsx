import { lazy, Suspense, useEffect, useSyncExternalStore } from 'react'
import { AppShell } from './shell/AppShell'
import { useSettings } from './shell/ShellContext'
import { applySettings } from './state/settings'

// Dev-only component gallery at #gallery (docs/conventions/ui.md#inventory-v01). The DEV check is
// replaced at build time, so production bundles neither contain nor load it.
const Gallery = import.meta.env.DEV
  ? lazy(() => import('./gallery/Gallery').then((m) => ({ default: m.Gallery })))
  : null

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

/** The window: the app shell, or the dev-only gallery at #gallery. Settings apply to the root. */
export function App(): React.JSX.Element {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash)
  const settings = useSettings((s) => s.settings)
  useEffect(() => applySettings(settings), [settings])

  if (Gallery && hash === '#gallery') {
    return (
      <Suspense fallback={null}>
        <Gallery />
      </Suspense>
    )
  }
  return <AppShell />
}
