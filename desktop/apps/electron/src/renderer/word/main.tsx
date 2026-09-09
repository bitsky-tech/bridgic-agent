import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { i18n } from '@/lib/i18n'
import { rlog } from '@/lib/logger'
import { WordHostApp } from './WordHostApp'
import '../index.css'

const params = new URLSearchParams(window.location.search)
const sessionId = params.get('sessionId')?.trim()
if (!sessionId) throw new Error('Word renderer requires a Session id.')

const api = window.wordHostApi
if (!api) throw new Error('Word renderer requires its Session preload capability.')
document.title = `Word · ${sessionId}`
window.addEventListener('error', (event) => rlog.error('[word-host.error]', event.error ?? event.message))
window.addEventListener('unhandledrejection', (event) => rlog.error('[word-host.unhandledrejection]', event.reason))

const root = document.getElementById('word-root')
if (!root) throw new Error('#word-root not found in word.html')

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <I18nextProvider i18n={i18n}>
        <WordHostApp api={api} sessionId={sessionId} />
      </I18nextProvider>
    </ErrorBoundary>
  </StrictMode>,
)
