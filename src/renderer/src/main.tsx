import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { createRendererLogger } from './logging'
import { createShell, ShellProvider } from './shell/ShellContext'
import { applySettings } from './state/settings'
import './ui/tokens.css'
import './ui/base.css'
import { UiProvider } from './ui'

const log = createRendererLogger(window.dfyom.log, import.meta.env.DEV)
log.info('renderer started')

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Renderer root element #root is missing from index.html')

const shell = createShell(window.dfyom)
// before the first render: no flash of the wrong theme
applySettings(shell.settings.getState().settings)

createRoot(rootEl).render(
  <StrictMode>
    <UiProvider>
      <ShellProvider shell={shell}>
        <App />
      </ShellProvider>
    </UiProvider>
  </StrictMode>,
)
