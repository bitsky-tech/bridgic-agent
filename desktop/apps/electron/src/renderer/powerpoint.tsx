import { Provider as JotaiProvider, atom, createStore, useAtomValue } from 'jotai'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import {
  currentPresentationWorkspaceAtom,
  presentationAgentChangeAtom,
  powerPointSessionIdOverrideAtom,
  presentationWorkspaceFamily,
} from './atoms/presentation'
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
import { createPresentationFileController } from './lib/presentationFileController'
import { officeFiles } from './lib/office/officeFileClient'
import { OfficeLaunchEmptyState } from './components/app/OfficeLaunchEmptyState'
import { isPresentationDirty } from './lib/presentationWorkspaceRuntime'
import type { OfficeFileSource } from '../shared/office-files'
import { useApplyTheme } from './hooks/useTheme'
import { useSettingsBridge } from './hooks/useSettingsBridge'
import { POWERPOINT_PROTOCOL_VERSION } from './lib/powerPointProtocol'
import { createPresentationWorkspaceRuntime } from './lib/presentationWorkspaceRuntime'

installApiStub()

const requestedSessionId = new URLSearchParams(location.search).get('sessionId')?.trim()
if (!requestedSessionId) throw new Error('PowerPoint renderer requires a sessionId')
const sessionId: string = requestedSessionId

const store = createStore()
const fileSaveErrorAtom = atom<string | null>(null)
store.set(powerPointSessionIdOverrideAtom, sessionId)
const workspaceAtom = presentationWorkspaceFamily(sessionId)
store.set(workspaceAtom, { activeDocumentId: '', documents: [] })
const workspaceRuntime = createPresentationWorkspaceRuntime({
  sessionId,
  read: () => store.get(workspaceAtom),
  write: (workspace) => store.set(workspaceAtom, workspace),
  beforeActivate: async () => { if (window.officeFiles?.prepare) await files.saveDirty(true) },
  beforeClose: (documentId) => files.beforeClose(documentId),
})
store.sub(workspaceAtom, () => workspaceRuntime.runtime.publish())

let activeFileName = 'Untitled.pptx'
let agentChangeId = 0
let initialDocumentId: string | null = store.get(workspaceAtom).activeDocumentId
const files = createPresentationFileController({
  automatic: Boolean(window.officeFiles?.prepare),
  onSaveStatus: (status, error) => store.set(fileSaveErrorAtom, status === 'error' ? error ?? i18n.t('office.saveFailed') : null),
  runAutoSave: async (save) => {
    const result = await workspaceRuntime.runtime.execute({ sessionId, capability: 'document.save' }, save)
    if (!result.ok) throw new Error(result.error.message)
  },
  sessionId, files: officeFiles(), encode: createPresentationPptx,
  read: () => store.get(workspaceAtom),
  write: (workspace) => { initialDocumentId = null; store.set(workspaceAtom, workspace) },
  flushEditor: workspaceRuntime.flushEditor,
  locale: () => i18n.language,
})
let restore = files.restore()
void restore.catch(() => undefined)
store.sub(workspaceAtom, () => files.schedule())
let closing: Promise<void> | null = null

async function savePresentation(documentId: string, saveAs: boolean, destination?: string): Promise<boolean> {
  await restore
  const result = await workspaceRuntime.runtime.execute({ sessionId, capability: saveAs ? 'document.saveAs' : 'document.save', documentId }, () => files.save(documentId, saveAs, destination))
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
function closePowerPoint(): Promise<void> {
  if (closing) return closing
  closing = (async () => {
    await restore
    const result = await workspaceRuntime.runtime.execute({ sessionId, capability: 'document.close' }, async () => {
      const approved = new Map<string, number>()
      for (const document of store.get(workspaceAtom).documents) {
        if (!await files.beforeClose(document.id)) return false
        approved.set(document.id, store.get(workspaceAtom).documents.find((item) => item.id === document.id)?.revision ?? document.revision)
      }
      await workspaceRuntime.flushEditor()
      if (store.get(workspaceAtom).documents.some((document) => isPresentationDirty(document) && approved.get(document.id) !== document.revision)) throw new Error(i18n.t('office.changedDuringClose'))
      store.set(workspaceAtom, { activeDocumentId: '', documents: [] })
      await files.recovery.persist(store.get(workspaceAtom))
      return true
    })
    if (!result.ok) throw new Error(result.error.message)
    if (result.value) await window.api.powerpoint.requestClose(sessionId)
  })().catch((error) => {
    rlog.error('[powerpoint.close]', error)
    store.set(showToastAtom, String(error))
  }).finally(() => { closing = null })
  return closing
}

let openingSource: OfficeFileSource | null = null
let refreshing = false
window.__bridgicPowerPoint = {
  protocolVersion: POWERPOINT_PROTOCOL_VERSION,
  sessionId,
  flush: async () => { await restore; await workspaceRuntime.runtime.whenIdle(); await workspaceRuntime.flushEditor(); await files.autoSave.flush(); await files.flush() },
  close: closePowerPoint,
  dispatch: async (request) => {
    try { await restore } catch (error) { return { ok: false, error: String(error), code: 'document_changed' } }
    if (request.method === 'save_ppt') {
      try {
        const workspace = store.get(workspaceAtom)
        const target = request.params?.target
        const documentId = typeof target === 'string' ? workspace.documents.find((item) => item.source?.path === target)?.id : workspace.activeDocumentId
        if (!documentId) return { ok: false, error: 'The requested PowerPoint draft is not open', code: 'document_changed' }
        const destination = request.params?.save_as
        if (destination !== undefined && (typeof destination !== 'string' || !destination)) return { ok: false, error: 'save_as must be an absolute PPTX path', code: 'document_changed' }
        if (!await savePresentation(documentId, Boolean(destination), destination as string | undefined)) return { ok: false, error: 'Save was canceled or newer changes remain unsaved', code: 'document_changed' }
        const document = store.get(workspaceAtom).documents.find((item) => item.id === documentId)!
        return { ok: true, value: { status: 'saved', target: document.source?.path, document_id: documentId } }
      } catch (error) { return { ok: false, error: String(error), code: 'document_changed' } }
    }
    return workspaceRuntime.dispatchProtocol(
      request,
      () => {
        const workspace = store.get(workspaceAtom)
        const document = workspace.documents.find((item) => item.id === workspace.activeDocumentId)
        return { currentTarget: refreshing ? null : document?.source?.path ?? null, fileName: activeFileName, importPptx: importPresentationInBackground }
      },
      async (dispatched) => {
        if (dispatched.target) activeFileName = dispatched.target.split(/[\\/]/).at(-1) || activeFileName
        if (dispatched.workspace) {
          let workspace = dispatched.workspace
          if (dispatched.target && openingSource) {
            const imported = workspace.documents.find((item) => item.id === workspace.activeDocumentId)!
            const existing = store.get(workspaceAtom).documents.find((item) => item.source?.path === openingSource?.path)
            const document = { ...imported, id: existing?.id ?? imported.id, source: openingSource, savedRevision: openingSource.mtimeMs === null ? undefined : imported.revision }
            workspace = { activeDocumentId: document.id, documents: [
              ...store.get(workspaceAtom).documents.filter((item) => item.id !== imported.id && item.id !== existing?.id && (item.id !== initialDocumentId || item.revision !== 1)), document,
            ] }
            initialDocumentId = null
          }
          store.set(currentPresentationWorkspaceAtom, workspace)
        }
        if (dispatched.agentChange) store.set(presentationAgentChangeAtom, { ...dispatched.agentChange, changeId: ++agentChangeId })
        if (window.officeFiles?.prepare) await files.saveDirty()
        if (openingSource && dispatched.result && typeof dispatched.result === 'object') {
          Object.assign(dispatched.result, { target: store.get(workspaceAtom).documents.find((document) => document.id === store.get(workspaceAtom).activeDocumentId)?.source?.path ?? openingSource.path })
        }
        await files.flush()
      },
      async (command) => {
        openingSource = null
        refreshing = false
        if (command.method !== 'view_ppt' || typeof command.params?.target !== 'string') return
        const target = command.params.target
        openingSource = officeFiles().prepare ? await officeFiles().prepare!('presentation', target) : await officeFiles().inspect('presentation', target)
        if (openingSource.path !== target && openingSource.mtimeMs !== null && officeFiles().readBase64) command.params.content_base64 = await officeFiles().readBase64!('presentation', openingSource.path)
        command.params.target = openingSource.path
        const workspace = store.get(workspaceAtom)
        const existing = workspace.documents.find((document) => document.source?.path === openingSource?.path)
        if (!existing) return
        refreshing = existing.source?.mtimeMs !== openingSource.mtimeMs
        if (refreshing && isPresentationDirty(existing)) throw new Error('The source file changed. Save your draft before reopening it.')
        store.set(workspaceAtom, { ...workspace, activeDocumentId: existing.id })
        command.params.target = openingSource.path
      },
    )
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
  const fileSaveError = useAtomValue(fileSaveErrorAtom)
  const [recovery, setRecovery] = useState<'loading' | 'ready' | string>('loading')
  useEffect(() => { void restore.then(() => setRecovery('ready'), (error) => setRecovery(String(error))) }, [])

  useEffect(() => {
    if (i18n.language !== locale.resolved) void i18n.changeLanguage(locale.resolved)
    document.documentElement.lang = locale.resolved
  }, [locale.resolved])

  if (recovery !== 'ready') return <div className="flex h-screen flex-col items-center justify-center gap-4 text-sm">
    <span>{recovery === 'loading' ? i18n.t('office.restoring') : i18n.t('office.recoveryFailed')}</span>
    {recovery !== 'loading' ? <button onClick={() => {
      setRecovery('loading')
      restore = files.restore()
      void restore.then(() => setRecovery('ready'), (error) => setRecovery(String(error)))
    }}>{i18n.t('office.retry')}</button> : null}
  </div>
  if (!workspace.documents.length) return <OfficeLaunchEmptyState kind="presentation" onCreate={async () => {
    const result = await workspaceRuntime.createDocument()
    if (!result.ok) throw new Error(result.error.message)
  }} />

  return (
    <>
      <main className="h-screen w-screen overflow-hidden bg-bg-app">
        <PresentationWorkbenchPanel
          active
          onSave={savePresentation}
          saveError={fileSaveError}
          workspaceRuntime={workspaceRuntime}
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
      <JotaiProvider store={store}>
        <I18nextProvider i18n={i18n}>
          <PowerPointRuntime />
        </I18nextProvider>
      </JotaiProvider>
    </ErrorBoundary>
  </StrictMode>,
)
