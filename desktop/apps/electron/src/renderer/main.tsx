import { Provider as JotaiProvider } from 'jotai'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'
import { installApiStub } from './lib/apiStub'
import { i18n } from './lib/i18n'
import { rlog } from './lib/logger'

// In Electron, the preload script installs `window.api` before this script
// runs. In plain browser (Vite dev / Playwright), there is no preload — the
// stub provides safe no-ops so the renderer still boots.
installApiStub()

// Catch anything that escaped React's render tree: setTimeout throws,
// Promise rejections in event handlers, etc. Without these, the renderer
// just goes silent and the only trace is in DevTools console — which is
// not open in production.
window.addEventListener('error', (ev) => {
  rlog.error('[window.error]', ev.error ?? ev.message, `at ${ev.filename}:${ev.lineno}:${ev.colno}`)
})

window.addEventListener('unhandledrejection', (ev) => {
  rlog.error('[window.unhandledrejection]', ev.reason)
})

const root = document.getElementById('root')
if (!root) throw new Error('#root not found in index.html')

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <JotaiProvider>
        <I18nextProvider i18n={i18n}>
          <App />
        </I18nextProvider>
      </JotaiProvider>
    </ErrorBoundary>
  </StrictMode>,
)
