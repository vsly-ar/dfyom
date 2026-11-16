import { useState } from 'react'
import { APP_MODES, type AppMode } from '../../core/modes'

// Placeholder shell. Mode specs: docs/modes/
export function App(): React.JSX.Element {
  const [mode, setMode] = useState<AppMode>('design')
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
