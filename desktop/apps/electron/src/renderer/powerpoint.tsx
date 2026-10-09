import { Provider as JotaiProvider, createStore, useAtomValue } from 'jotai'
import { StrictMode, useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { powerPointSessionIdOverrideAtom } from './atoms/presentation'
import { showToastAtom } from './atoms/toast'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ToastHost } from './components/amphi/ToastHost'
import { PresentationWorkbenchPanel } from './components/app/PresentationWorkbenchPanel'
import { localeAtom } from './atoms/locale'
import './index.css'
import { installApiStub } from './lib/apiStub'
import { i18n } from './lib/i18n'
import { rlog } from './lib/logger'
import { createPresentationPptx } from './lib/presentationPptx'
import { importPresentationInBackground } from './lib/presentationImport'
import { officeFiles } from './lib/office/officeFileClient'
import { createIndexedDbWorkspacePersistence } from './lib/office/workspacePersistence'
import { OfficeLaunchEmptyState } from './components/app/OfficeLaunchEmptyState'
import { useApplyTheme } from './hooks/useTheme'
import { useSettingsBridge } from './hooks/useSettingsBridge'
import { PresentationStore } from './presentation/store'
import { materializePresentationProjectSources } from './presentation/sources'

installApiStub()

const requestedSessionId = new URLSearchParams(location.search).get('sessionId')?.trim()
if (!requestedSessionId) throw new Error('PowerPoint renderer requires a sessionId')
const sessionId: string = requestedSessionId

const jotaiStore = createStore()
jotaiStore.set(powerPointSessionIdOverrideAtom, sessionId)
const presentationStore = new PresentationStore(sessionId, {
  workspacePersistence: createIndexedDbWorkspacePersistence({
    appKind: 'presentation',
    databaseName: 'bridgic-presentation-workbench-v1',
    sessionId,
    storeName: 'projects',
  }),
  encode: async (project, sources) => createPresentationPptx(await materializePresentationProjectSources(project, sources)),
  files: officeFiles(),
  importPptx: importPresentationInBackground,
  managedFiles: Boolean(window.officeFiles?.prepare),
})
let restoring = presentationStore.restore()
void restoring.catch(() => undefined)
let closing: Promise<void> | null = null

function closePowerPoint(): Promise<void> {
  if (closing) return closing
  closing = (async () => {
    await restoring
    if (await presentationStore.closeAll()) await window.api.powerpoint.requestClose(sessionId)
  })().catch((error) => {
    rlog.error('[powerpoint.close]', error)
    jotaiStore.set(showToastAtom, String(error))
  }).finally(() => { closing = null })
  return closing
}

async function openPowerPoint(): Promise<void> {
  await window.api.powerpoint.openDocument()
}

window.__bridgicPowerPoint = {
  protocolVersion: presentationStore.protocolVersion,
  sessionId,
  flush: async () => { await restoring; await presentationStore.flush() },
  close: closePowerPoint,
  mountUsage: async (mountId) => { await restoring; await presentationStore.flush(); return presentationStore.mountUsage(mountId) },
  validateMountReplacement: async (mountId, path) => { await restoring; return presentationStore.validateMountReplacement(mountId, path) },
  removeMountReferences: async (mountId) => { await restoring; await presentationStore.flush(); return presentationStore.removeMountReferences(mountId) },
  refreshSources: async () => { await restoring; await presentationStore.refreshSources() },
  dispatch: async (request) => {
    try { await restoring } catch (error) { return { ok: false, error: String(error), code: 'document_changed' } }
    return presentationStore.dispatch(request)
  },
}
window.addEventListener('pagehide', () => presentationStore.dispose())

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
  const snapshot = useSyncExternalStore(presentationStore.subscribe, presentationStore.getSnapshot, presentationStore.getSnapshot)
  const [recovery, setRecovery] = useState<'loading' | 'ready' | string>('loading')
  useEffect(() => { void restoring.then(() => setRecovery('ready'), (error) => setRecovery(String(error))) }, [])

  useEffect(() => {
    const refresh = () => { void presentationStore.refreshSources() }
    const unsubscribeFiles = window.officeFiles?.onChanged?.((id) => { if (id === sessionId) refresh() }) ?? (() => {})
    const unsubscribeFs = window.api.events.onFsChanged(refresh)
    return () => { unsubscribeFiles(); unsubscribeFs() }
  }, [])

  useEffect(() => {
    if (i18n.language !== locale.resolved) void i18n.changeLanguage(locale.resolved)
    document.documentElement.lang = locale.resolved
  }, [locale.resolved])

  useEffect(() => {
    if (recovery !== 'ready') return
    void window.api.powerpoint.reportState({ documentCount: snapshot.projects.length }).catch((error) => {
      rlog.warn('[powerpoint.state]', error)
    })
  }, [recovery, snapshot.projects.length])

  if (recovery !== 'ready') return <div className="flex h-screen flex-col items-center justify-center gap-4 text-sm">
    <span>{recovery === 'loading' ? i18n.t('office.restoring') : i18n.t('office.recoveryFailed')}</span>
    {recovery !== 'loading' ? <button onClick={() => {
      setRecovery('loading')
      restoring = presentationStore.restore()
      void restoring.then(() => setRecovery('ready'), (error) => setRecovery(String(error)))
    }}>{i18n.t('office.retry')}</button> : null}
  </div>
  if (!snapshot.projects.length) return <OfficeLaunchEmptyState kind="presentation" onCreate={() => presentationStore.createProject()} onOpen={openPowerPoint} />

  return (
    <>
      <main className="h-screen w-screen overflow-hidden bg-bg-app">
        <PresentationWorkbenchPanel
          active
          presentationStore={presentationStore}
          onClose={() => { void closePowerPoint() }}
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
      <JotaiProvider store={jotaiStore}>
        <I18nextProvider i18n={i18n}>
          <PowerPointRuntime />
        </I18nextProvider>
      </JotaiProvider>
    </ErrorBoundary>
  </StrictMode>,
)
