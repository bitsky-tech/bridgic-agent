import { Provider as JotaiProvider, createStore, useAtomValue } from 'jotai'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import {
  currentPresentationWorkspaceAtom,
  powerPointSessionIdOverrideAtom,
  type PresentationWorkspace,
} from './atoms/presentation'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ToastHost } from './components/amphi/ToastHost'
import { PresentationWorkbenchPanel } from './components/app/PresentationWorkbenchPanel'
import { localeAtom } from './atoms/locale'
import './index.css'
import { installApiStub } from './lib/apiStub'
import { i18n } from './lib/i18n'
import { rlog } from './lib/logger'
import { createPresentationPptx } from './lib/presentationPptx'
import { useApplyTheme } from './hooks/useTheme'
import { useSettingsBridge } from './hooks/useSettingsBridge'
import {
  POWERPOINT_PROTOCOL_VERSION,
  PowerPointProtocolError,
  executePowerPointRequest,
  type PowerPointRequest,
} from './lib/powerPointProtocol'

installApiStub()

const requestedSessionId = new URLSearchParams(location.search).get('sessionId')?.trim()
if (!requestedSessionId) throw new Error('PowerPoint renderer requires a sessionId')
const sessionId: string = requestedSessionId

const store = createStore()
store.set(powerPointSessionIdOverrideAtom, sessionId)

let activeTarget: string | null = null
let activeFileName = 'Untitled.pptx'
let persistenceQueue = Promise.resolve()
let lastPersistenceKey: string | null = null

function persistenceKey(workspace: PresentationWorkspace): string | null {
  const document = workspace.documents.find((item) => item.id === workspace.activeDocumentId)
  return activeTarget && document ? `${activeTarget}\u0000${document.id}\u0000${document.version}` : null
}

async function persistWorkspace(workspace: PresentationWorkspace) {
  const target = activeTarget
  const document = workspace.documents.find((item) => item.id === workspace.activeDocumentId)
  if (!target || !document) return
  const key = persistenceKey(workspace)
  if (!key || key === lastPersistenceKey) return
  lastPersistenceKey = key
  const persist = async () => {
    await window.api.fs.writePresentation(target, await createPresentationPptx(document))
  }
  persistenceQueue = persistenceQueue.then(persist, persist)
  try {
    await persistenceQueue
  } catch (error) {
    if (lastPersistenceKey === key) lastPersistenceKey = null
    throw error
  }
}

window.__bridgicPowerPoint = {
  protocolVersion: POWERPOINT_PROTOCOL_VERSION,
  sessionId,
  async dispatch(request: PowerPointRequest) {
    try {
      const dispatched = await executePowerPointRequest(
        store.get(currentPresentationWorkspaceAtom),
        request,
        { currentTarget: activeTarget, fileName: activeFileName },
      )
      if (dispatched.target) {
        activeTarget = dispatched.target
        activeFileName = dispatched.target.split(/[\\/]/).at(-1) || activeFileName
      }
      if (dispatched.workspace && dispatched.target && !dispatched.persist) {
        lastPersistenceKey = persistenceKey(dispatched.workspace)
      }
      if (dispatched.workspace) store.set(currentPresentationWorkspaceAtom, dispatched.workspace)
      if (dispatched.persist) await persistWorkspace(dispatched.workspace ?? store.get(currentPresentationWorkspaceAtom))
      return { ok: true, value: dispatched.result }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof PowerPointProtocolError ? { code: error.code } : {}),
      }
    }
  },
}

window.addEventListener('error', (event) => {
  rlog.error('[powerpoint.error]', event.error ?? event.message)
})
window.addEventListener('unhandledrejection', (event) => {
  rlog.error('[powerpoint.unhandledrejection]', event.reason)
})

function PowerPointRuntime() {
  useSettingsBridge()
  useApplyTheme()
  const locale = useAtomValue(localeAtom)
  const workspace = useAtomValue(currentPresentationWorkspaceAtom)
  const documentVersion = workspace.documents.find((item) => item.id === workspace.activeDocumentId)?.version

  useEffect(() => {
    if (i18n.language !== locale.resolved) void i18n.changeLanguage(locale.resolved)
    document.documentElement.lang = locale.resolved
  }, [locale.resolved])

  useEffect(() => {
    if (!activeTarget || documentVersion === undefined) return
    void persistWorkspace(workspace).catch((error) => rlog.error('[powerpoint.autosave]', error))
  }, [documentVersion, workspace])

  return (
    <>
      <main className="h-screen w-screen overflow-hidden bg-bg-app">
        <PresentationWorkbenchPanel
          active
          onClose={() => {
            void window.api.powerpoint.requestClose(sessionId)
          }}
          onExpandedChange={(expanded) => {
            void window.api.powerpoint.setExpanded(expanded)
          }}
        />
      </main>
      <ToastHost />
    </>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('#root not found in powerpoint.html')

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <JotaiProvider store={store}>
        <I18nextProvider i18n={i18n}>
          <PowerPointRuntime />
        </I18nextProvider>
      </JotaiProvider>
    </ErrorBoundary>
  </StrictMode>,
)
