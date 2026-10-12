import { afterAll, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { OfficeFileSaveResult } from '../../../../shared/office-files'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { i18n } = await import('@/lib/i18n')
const { installApiStub } = await import('@/lib/apiStub')
const { createWordDomainStore, createWordWorkspace } = await import('@/lib/wordDomain')
const { StructuredWordEditor } = await import('../StructuredWordEditor')
installApiStub()

afterAll(async () => { await GlobalRegistrator.unregister() })

const saved: OfficeFileSaveResult = { ok: true, fileName: 'Saved.docx', source: { path: '/drafts/Saved.docx', mtimeMs: 1 } }

async function mountEditor(store: ReturnType<typeof createWordDomainStore>, onSaveRequested = async () => {}) {
  await i18n.changeLanguage('en')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<StructuredWordEditor expanded={false} onSaveRequested={onSaveRequested} onToggleExpanded={() => {}} persistenceStatus="saved" store={store} />))
  return {
    host,
    async dispose() { await act(async () => root.unmount()); host.remove(); store.dispose() },
    retry() {
      const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((element) => element.textContent === i18n.t('office.retry'))
      if (!button) throw new Error('Expected a retry action')
      button.click()
    },
  }
}

describe('Word explicit export controls', () => {
  it('retries the failed Save as for its original document after another tab becomes active', async () => {
    const attempts: Array<{ documentId: string; saveAs: boolean }> = []
    const store = createWordDomainStore(createWordWorkspace(crypto.randomUUID(), 'First'), {
      defaultTitle: 'Untitled',
      saveDocument: async (document, saveAs) => {
        attempts.push({ documentId: document.id, saveAs })
        if (attempts.length === 1) throw new Error('DOCX export failed')
        return saved
      },
    })
    const firstId = store.getSnapshot().activeDocumentId
    const checkpoint = mock(async () => {})
    const editor = await mountEditor(store, checkpoint)
    try {
      await act(async () => editor.host.querySelector<HTMLButtonElement>('[data-testid="word-save-as"]')!.click())
      expect(editor.host.textContent).toContain('DOCX export failed')
      await act(async () => { await store.dispatch({ type: 'document.create', title: 'Second' }) })
      const secondId = store.getSnapshot().activeDocumentId
      await act(async () => editor.retry())
      expect(attempts).toEqual([{ documentId: firstId, saveAs: true }, { documentId: firstId, saveAs: true }])
      expect(store.getSnapshot().activeDocumentId).toBe(secondId)
      expect(checkpoint).toHaveBeenCalledTimes(1)
      expect(editor.host.textContent).not.toContain('DOCX export failed')
    } finally { await editor.dispose() }
  })

  it('guards simultaneous Save as clicks before React publishes the disabled state', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const write = mock(async () => { await gate; return saved })
    const store = createWordDomainStore(createWordWorkspace(crypto.randomUUID(), 'First'), { defaultTitle: 'Untitled', saveDocument: write })
    const editor = await mountEditor(store)
    try {
      await act(async () => {
        const button = editor.host.querySelector<HTMLButtonElement>('[data-testid="word-save-as"]')!
        button.click()
        button.click()
      })
      expect(write).toHaveBeenCalledTimes(1)
      expect(editor.host.querySelector<HTMLButtonElement>('[data-testid="word-save-as"]')!.disabled).toBe(true)
      await act(async () => { finish(); await store.whenIdle() })
      expect(write).toHaveBeenCalledTimes(1)
    } finally { finish(); await editor.dispose() }
  })

  it('retries only the workspace checkpoint when an already successful export could not be checkpointed', async () => {
    const write = mock(async () => saved)
    let checkpoints = 0
    const checkpoint = mock(async () => { if (++checkpoints === 1) throw new Error('Workspace checkpoint failed') })
    const store = createWordDomainStore(createWordWorkspace(crypto.randomUUID(), 'First'), { defaultTitle: 'Untitled', saveDocument: write })
    const editor = await mountEditor(store, checkpoint)
    try {
      await act(async () => editor.host.querySelector<HTMLButtonElement>('[data-testid="word-save-as"]')!.click())
      expect(editor.host.textContent).toContain('Workspace checkpoint failed')
      expect(write).toHaveBeenCalledTimes(1)
      await act(async () => editor.retry())
      expect(checkpoint).toHaveBeenCalledTimes(2)
      expect(write).toHaveBeenCalledTimes(1)
      expect(editor.host.textContent).not.toContain('Workspace checkpoint failed')
    } finally { await editor.dispose() }
  })

  it('reports a saved workspace while its draft remains unexported and routes Shift+Save to Save as', async () => {
    const write = mock(async (_document: unknown, _saveAs: boolean) => saved)
    const store = createWordDomainStore(createWordWorkspace(crypto.randomUUID(), 'First'), { defaultTitle: 'Untitled', saveDocument: write })
    const editor = await mountEditor(store)
    try {
      const status = Array.from(editor.host.querySelectorAll('[role="status"]')).find((element) => element.textContent === i18n.t('office.saved'))
      expect(status).toBeDefined()
      expect(write).not.toHaveBeenCalled()
      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, shiftKey: true, cancelable: true })))
      expect(write).toHaveBeenCalledTimes(1)
      expect(write.mock.calls[0]?.[1]).toBe(true)
    } finally { await editor.dispose() }
  })
})
