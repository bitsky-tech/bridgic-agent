import { afterAll, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { DocumentDataModel, JSONX, type IDocumentData } from '@univerjs/core'
import type { WordEditorNativeEngine, WordEditorMountOptions } from '@/lib/wordEditorAdapter'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { i18n } = await import('@/lib/i18n')
const { installApiStub } = await import('@/lib/apiStub')
installApiStub()
const { WordHeaderFooterDialog } = await import('../WordHeaderFooterDialog')
const { createWordDomainStore, createWordWorkspace } = await import('@/lib/wordDomain')
const { createWordHeaderFooterDraft, mergeWordHeaderFooterDraft } = await import('@/lib/wordHeaderFooter')
afterAll(async () => GlobalRegistrator.unregister())

async function fixture(field: 'headerHtml' | 'footerHtml', options: { failMount?: boolean; failRead?: boolean; onSave?: (snapshot: IDocumentData) => Promise<void> } = {}) {
  const store = createWordDomainStore(createWordWorkspace(`native-dialog-${crypto.randomUUID()}`, 'Report'), { defaultTitle: 'Report' })
  await store.dispatch({ type: 'document.headerFooter.update', settings: { headerHtml: '<p><strong>Company</strong> website</p>', footerHtml: '<p><strong>Company</strong> website</p>' } })
  const current = store.getSnapshot().documents[0]!
  const part = field === 'headerHtml' ? 'headers' : 'footers'
  const id = current.snapshot.documentStyle[field === 'headerHtml' ? 'defaultHeaderId' : 'defaultFooterId']!
  const canonical = structuredClone(current.snapshot)
  canonical[part]![id]!.body.paragraphs![0]!.paragraphStyle = { indentStart: { v: 48 }, indentEnd: { v: 24 }, indentFirstLine: { v: 12 }, lineSpacing: 1.5, spaceAbove: { v: 12 }, spaceBelow: { v: 18 } }
  canonical[part]![id]!.body.textRuns![0]!.ts = { ...canonical[part]![id]!.body.textRuns![0]!.ts, sc: 3, sa: 80 }
  store.commitEditorSnapshot(current.id, canonical)
  const before = store.getSnapshot()
  const draft = createWordHeaderFooterDraft(before.documents[0]!.snapshot, field)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const close = mock(() => undefined)
  const nativeDispose = mock(() => undefined)
  const unsubscribe = mock(() => undefined)
  let model: DocumentDataModel | undefined
  let commandListener: ((command: { id: string }) => void) | undefined
  let readCount = 0
  const mount = mock((input: WordEditorMountOptions): WordEditorNativeEngine => {
    if (options.failMount) throw new Error('Canvas unavailable')
    model = new DocumentDataModel(input.snapshot)
    // Native mount normalization must not dirty the canonical document.
    model.setZoomRatio(0.8)
    return {
      document: {
        getSnapshot() {
          if (options.failRead && readCount++ > 0) throw new Error('Snapshot unavailable')
          return model!.getSnapshot()
        },
        setSelection: () => undefined,
        appendText: async () => true,
        insertText: async () => true,
        insertParagraph: async () => true,
        undo: async () => true,
        redo: async () => true,
      },
      univerAPI: {
        executeCommand: (async () => true) as WordEditorNativeEngine['univerAPI']['executeCommand'],
        setLocale: () => undefined,
        onCommandExecuted: ((listener: typeof commandListener) => {
          commandListener = listener
          return { dispose: unsubscribe }
        }) as WordEditorNativeEngine['univerAPI']['onCommandExecuted'],
      },
      dispose() { nativeDispose(); model?.dispose() },
    }
  })
  const save = mock(async (snapshot: IDocumentData) => {
    if (options.onSave) return options.onSave(snapshot)
    const latest = store.getSnapshot().documents[0]!
    const merged = mergeWordHeaderFooterDraft(latest.snapshot, draft, snapshot)
    store.commitEditorSnapshot(current.id, merged)
  })
  await act(async () => {
    root.render(<WordHeaderFooterDialog draft={draft} title={i18n.t(field === 'headerHtml' ? 'word.header' : 'word.footer')} onClose={close} onSave={save} mountNative={mount} />)
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
  return {
    store, before, draft, close, save, mount, nativeDispose, unsubscribe,
    read: () => model!.getSnapshot(),
    edit(text = 'Updated') {
      const body = structuredClone(model!.getSnapshot().body!)
      body.dataStream = body.dataStream.replace('Company', text)
      model!.apply(JSONX.getInstance().replaceOp(['body'], model!.getSnapshot().body, body))
      commandListener?.({ id: 'doc.mutation.rich-text-editing' })
    },
    emit(id: string) { commandListener?.({ id }) },
    confirm: async () => act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="word-header-footer-confirm"]')!.click() }),
    cancel: async () => act(async () => { document.body.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click() }),
    async dispose() {
      await act(async () => root.unmount())
      host.remove()
      store.dispose()
    },
  }
}

describe('Native Word header/footer dialog', () => {
  it.each(['headerHtml', 'footerHtml'] as const)('edits %s directly without losing indent or character properties', async (field) => {
    const f = await fixture(field)
    try {
      const part = field === 'headerHtml' ? 'headers' : 'footers'
      const originalBody = f.before.documents[0]!.snapshot[part]![f.draft.segmentId]!.body
      expect(f.mount.mock.calls[0]![0].toolbar).toBe(true)
      expect(f.read().body).toEqual(originalBody)
      f.edit()
      await f.confirm()
      expect(f.save).toHaveBeenCalledTimes(1)
      const updated = f.store.getSnapshot().documents[0]!
      expect(updated.snapshot[part]![f.draft.segmentId]!.body).toEqual({ ...originalBody, dataStream: originalBody.dataStream.replace('Company', 'Updated') })
      expect(updated.snapshot.body).toEqual(f.before.documents[0]!.snapshot.body)
      expect(updated.snapshot[field === 'headerHtml' ? 'footers' : 'headers']).toEqual(f.before.documents[0]!.snapshot[field === 'headerHtml' ? 'footers' : 'headers'])
      expect(f.close).toHaveBeenCalledTimes(1)
    } finally { await f.dispose() }
    expect(f.nativeDispose).toHaveBeenCalledTimes(1)
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it.each(['headerHtml', 'footerHtml'] as const)('cancels %s edits without publishing them', async (field) => {
    const f = await fixture(field)
    try {
      f.edit()
      await f.cancel()
      expect(f.save).not.toHaveBeenCalled()
      expect(f.close).toHaveBeenCalledTimes(1)
      expect(f.store.getSnapshot()).toBe(f.before)
    } finally { await f.dispose() }
  })

  it('keeps confirmation a no-op after mount normalization, selection, zoom or an undone edit', async () => {
    const f = await fixture('headerHtml')
    try {
      f.emit('doc.operation.set-selections')
      f.emit('doc.command.set-zoom-ratio')
      await f.confirm()
      expect(f.save).not.toHaveBeenCalled()
      expect(f.store.getSnapshot()).toBe(f.before)
      f.edit()
      const snapshot = f.read()
      snapshot.body!.dataStream = snapshot.body!.dataStream.replace('Updated', 'Company')
      f.emit('univer.command.undo')
      await f.confirm()
      expect(f.save).not.toHaveBeenCalled()
      expect(f.store.getSnapshot()).toBe(f.before)
    } finally { await f.dispose() }
  })

  it.each(['headerHtml', 'footerHtml'] as const)('keeps %s drafts when a portaled native menu consumes Escape', async (field) => {
    const f = await fixture(field)
    const menu = document.createElement('input')
    document.body.appendChild(menu)
    // Radix's native menus handle Escape on document, outside the Modal subtree.
    const closeMenu = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); menu.remove() }
    }
    document.addEventListener('keydown', closeMenu, true)
    try {
      f.edit()
      await act(async () => {
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })
      expect(menu.isConnected).toBe(false)
      expect(f.close).not.toHaveBeenCalled()
      expect(f.read().body!.dataStream).toContain('Updated')
      await f.confirm()
      expect(f.save).toHaveBeenCalledTimes(1)
      expect(f.close).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('keydown', closeMenu, true)
      menu.remove()
      await f.dispose()
    }
  })

  it('still cancels on an unconsumed Escape without publishing the draft', async () => {
    const f = await fixture('headerHtml')
    try {
      f.edit()
      await act(async () => {
        document.body.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })
      expect(f.close).toHaveBeenCalledTimes(1)
      expect(f.save).not.toHaveBeenCalled()
      expect(f.store.getSnapshot()).toBe(f.before)
    } finally { await f.dispose() }
  })

  it('retains the draft and shows errors when saving fails, then allows retry', async () => {
    let fail = true
    const f = await fixture('footerHtml', { onSave: async () => { if (fail) throw new Error('Cannot save this footer') } })
    try {
      f.edit()
      await f.confirm()
      expect(document.body.querySelector('[role="alert"]')!.textContent).toBe('Cannot save this footer')
      expect(f.close).not.toHaveBeenCalled()
      expect(f.read().body!.dataStream).toContain('Updated')
      fail = false
      await f.confirm()
      expect(f.save).toHaveBeenCalledTimes(2)
      expect(f.close).toHaveBeenCalledTimes(1)
    } finally { await f.dispose() }
  })

  it('disables confirmation and shows a usable error when the native editor fails to mount', async () => {
    const f = await fixture('headerHtml', { failMount: true })
    try {
      expect(document.body.querySelector<HTMLButtonElement>('[data-testid="word-header-footer-confirm"]')!.disabled).toBe(true)
      expect(document.body.querySelector('[role="alert"]')!.textContent).toBe(i18n.t('word.coreError'))
      await f.cancel()
      expect(f.close).toHaveBeenCalledTimes(1)
      expect(f.store.getSnapshot()).toBe(f.before)
    } finally { await f.dispose() }
  })

  it('surfaces snapshot read failures without losing the draft', async () => {
    const f = await fixture('footerHtml', { failRead: true })
    try {
      f.edit()
      await f.confirm()
      expect(document.body.querySelector('[role="alert"]')!.textContent).toBe('Snapshot unavailable')
      expect(f.close).not.toHaveBeenCalled()
      expect(f.store.getSnapshot()).toBe(f.before)
    } finally { await f.dispose() }
  })

  it('handles Cmd/Ctrl-S locally and prevents duplicate saves while one is pending', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const f = await fixture('headerHtml', { onSave: () => pending })
    try {
      f.edit()
      const dialog = document.body.querySelector('[role="dialog"]')!
      const windowSave = mock(() => undefined)
      window.addEventListener('keydown', windowSave)
      await act(async () => {
        for (let index = 0; index < 2; index++) dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }))
      })
      window.removeEventListener('keydown', windowSave)
      expect(f.save).toHaveBeenCalledTimes(1)
      expect(windowSave).not.toHaveBeenCalled()
      expect(f.close).not.toHaveBeenCalled()
      finish()
      await act(async () => { await pending })
      expect(f.close).toHaveBeenCalledTimes(1)
    } finally { finish(); await f.dispose() }
  })
})
