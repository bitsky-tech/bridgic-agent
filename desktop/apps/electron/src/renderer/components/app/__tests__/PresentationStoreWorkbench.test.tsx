import { afterAll, afterEach, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { OfficeFilesAPI } from '../../../../shared/office-files'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { powerPointSessionIdOverrideAtom } = await import('@/atoms/presentation')
const { settingsAtom } = await import('@/atoms/settings')
const { PresentationStore } = await import('@/presentation/store')
const { createPresentationTestDocument } = await import('@/test-fixtures/presentation')
const { PresentationWorkbenchPanel } = await import('../PresentationWorkbenchPanel')

afterEach(() => { document.body.replaceChildren() })
afterAll(async () => { await GlobalRegistrator.unregister() })

it('renders and edits the project owned by PresentationStore', async () => {
  const project = createPresentationTestDocument()
  let recovery: string | null = JSON.stringify({
    schemaVersion: 1,
    activeProjectId: project.id,
    projects: [project],
    projectMetadata: { [project.id]: { revision: 1 } },
  })
  const files: OfficeFilesAPI = {
    inspect: async (_kind, path) => ({ path, mtimeMs: 1 }),
    save: async () => ({ ok: true, fileName: 'Project.pptx', source: { path: '/Project.pptx', mtimeMs: 2 } }),
    confirmClose: async () => 'cancel',
    getRecovery: async () => recovery,
    setRecovery: async (_kind, _sessionId, value) => { recovery = value },
  }
  const presentationStore = new PresentationStore('presentation-store-workbench', {
    encode: async () => new Uint8Array(),
    files,
    importPptx: async () => { throw new Error('not used') },
    managedFiles: false,
  })
  await presentationStore.restore()
  const jotaiStore = createStore()
  jotaiStore.set(powerPointSessionIdOverrideAtom, presentationStore.sessionId)
  const settings = jotaiStore.get(settingsAtom)
  jotaiStore.set(settingsAtom, { ...settings, ui: { ...settings.ui, lastNav: 'home' } })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  try {
    await act(async () => {
      root.render(<Provider store={jotaiStore}><PresentationWorkbenchPanel active={false} presentationStore={presentationStore} /></Provider>)
    })
    const initialPageCount = project.slides.pages.length
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="presentation-compact-insert"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="presentation-add-slide"]')!.click())
    expect(presentationStore.getSnapshot().project?.slides.pages).toHaveLength(initialPageCount + 1)
    expect(presentationStore.getSnapshot().canUndo).toBe(true)

    const current = presentationStore.getSnapshot().project!
    await act(async () => { presentationStore.commitProject(current, { ...current, title: 'Store-owned title' }) })
    expect(host.textContent).toContain('Store-owned title')
  } finally {
    await act(async () => root.unmount())
    presentationStore.dispose()
  }
})
