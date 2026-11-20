import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { createRendererLogger } from './logging'
import './ui/tokens.css'
import './ui/base.css'
import { UiProvider } from './ui'

const log = createRendererLogger(window.dfyom.log, import.meta.env.DEV)
log.info('renderer started')

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Renderer root element #root is missing from index.html')

createRoot(rootEl).render(
  <StrictMode>
    <UiProvider>
      <App />
    </UiProvider>
  </StrictMode>,
)
