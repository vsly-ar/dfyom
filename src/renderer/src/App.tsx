import { lazy, Suspense, useState, useSyncExternalStore } from 'react'
import { APP_MODES, type AppMode } from '../../core/modes'

// Dev-only component gallery at #gallery (docs/conventions/ui.md#inventory-v01). The DEV check is
// replaced at build time, so production bundles neither contain nor load it.
const Gallery = import.meta.env.DEV
  ? lazy(() => import('./gallery/Gallery').then((m) => ({ default: m.Gallery })))
  : null

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

// Placeholder shell (window layout: task 3.3b). Mode specs: docs/modes/
export function App(): React.JSX.Element {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash)
  const [mode, setMode] = useState<AppMode>('design')

  if (Gallery && hash === '#gallery') {
    return (
      <Suspense fallback={null}>
        <Gallery />
      </Suspense>
    )
  }

  const { electron, chrome, node } = window.dfyom.versions
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>DFYOM</h1>
      <nav style={{ display: 'flex', gap: 8 }}>
        {APP_MODES.map((m) => (
          <button key={m} onClick={() => setMode(m)} aria-pressed={m === mode}>
            {m}
          </button>
        ))}
      </nav>
      <p>
        Current mode: <strong>{mode}</strong>
      </p>
      <footer style={{ opacity: 0.6, fontSize: 12 }}>
        Electron {electron} · Chromium {chrome} · Node {node}
      </footer>
    </main>
  )
}
