import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { createRendererLogger } from './logging'

const isDev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true
const log = createRendererLogger(window.dfyom.log, isDev)
log.info('renderer started')

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Renderer root element #root is missing from index.html')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
