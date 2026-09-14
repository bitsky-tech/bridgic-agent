import { afterAll, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { IDocumentData } from '@univerjs/core'
import type { WordEditorNativeEngine } from '../wordEditorAdapter'

GlobalRegistrator.register()

const { createWordDomainStore, createWordWorkspace } = await import('../wordDomain')
const { appendTextBlockToSnapshot, getUniverDocumentText } = await import('../wordUniverModel')
const { createWordEditorAdapter } = await import('../wordEditorAdapter')

afterAll(async () => { await GlobalRegistrator.unregister() })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function createFixture(options: { beforeReplace?: () => Promise<boolean>; failSubscription?: boolean; onTableActiveChange?: () => void } = {}) {
  const store = createWordDomainStore(createWordWorkspace(crypto.randomUUID(), 'Untitled'), { defaultTitle: 'Untitled' })
  const document = store.getSnapshot().documents[0]!
  let nativeSnapshot = structuredClone(document.snapshot)
  let commandListener: ((command: { id: string; params?: unknown }) => void) | null = null
  const nativeDispose = mock(() => undefined)
  const unsubscribe = mock(() => undefined)
  const appendText = mock(async (text: string) => {
    nativeSnapshot = appendTextBlockToSnapshot(nativeSnapshot, text, 'paragraph')
    commandListener?.({ id: 'doc.command.insert-text' })
    return true
  })
  const executeCommand = mock(async (id: string, params?: { snapshot?: IDocumentData }) => {
    if (id === 'doc.command-replace-snapshot') {
      if (options.beforeReplace && !await options.beforeReplace()) return false
      nativeSnapshot = structuredClone(params!.snapshot!)
    }
    return true
  })
  const native = {
    document: {
      getSnapshot: () => nativeSnapshot,
      appendText,
      insertParagraph: appendText,
      insertText: appendText,
      setSelection: mock(() => undefined),
      undo: mock(async () => true),
      redo: mock(async () => true),
    },
    univerAPI: {
      executeCommand,
      setLocale: mock(() => undefined),
      onCommandExecuted: (listener: typeof commandListener) => {
        if (options.failSubscription) throw new Error('Native subscription failed')
        commandListener = listener
        return { dispose: unsubscribe }
      },
    },
    dispose: nativeDispose,
  } as unknown as WordEditorNativeEngine
  const mount = () => createWordEditorAdapter({
    container: window.document.createElement('div'),
    documentId: document.id,
    language: 'en',
    snapshot: store.getSnapshot().documents[0]!.snapshot,
    store,
    zoom: 100,
    onTableActiveChange: options.onTableActiveChange,
    mountNative: () => native,
  })
  return {
    store,
    document,
    native,
    mount,
    nativeDispose,
    unsubscribe,
    executeCommand,
    readText: () => getUniverDocumentText(store.getSnapshot().documents[0]!.snapshot),
    type(text: string) {
      nativeSnapshot = appendTextBlockToSnapshot(nativeSnapshot, text, 'paragraph')
      commandListener?.({ id: 'doc.command.insert-text' })
    },
    emit(id: string) { commandListener?.({ id, params: {} }) },
  }
}

describe('Word editor engine binding', () => {
  it('flushes native typing into the existing Word authority without waiting for the debounce', async () => {
    const fixture = createFixture()
    const adapter = fixture.mount()
    try {
      fixture.type('Native typing')
      expect(fixture.readText()).not.toContain('Native typing')
      await adapter.flush()
      expect(fixture.readText()).toContain('Native typing')
      expect(fixture.store.api.workspace.getSnapshot().documents[0]!.revision).toBeGreaterThan(0)
    } finally { adapter.dispose(); fixture.store.dispose() }
  })

  it('reconciles an Agent change before an immediately following native command', async () => {
    const fixture = createFixture()
    const adapter = fixture.mount()
    try {
      await fixture.store.dispatch({ type: 'document.append', documentId: fixture.document.id, text: 'Agent content', block: 'paragraph' })
      const result = await fixture.store.dispatch({ type: 'editor.insert', kind: 'pageBreak' })
      expect(result.ok).toBe(true)
      expect(fixture.readText()).toContain('Agent content')
      expect(fixture.native.document.insertText).toHaveBeenCalledWith('\f')
      const replacements = fixture.executeCommand.mock.calls.filter(([id]) => id === 'doc.command-replace-snapshot')
      expect(replacements).toHaveLength(1)
      expect(replacements[0]![1]).toMatchObject({ textRanges: undefined, options: { noHistory: true } })
    } finally { adapter.dispose(); fixture.store.dispose() }
  })

  it('serializes and deduplicates React reconciliation and an explicit flush', async () => {
    const started = deferred()
    const gate = deferred()
    let replacements = 0
    const fixture = createFixture({ beforeReplace: async () => { replacements++; started.resolve(); await gate.promise; return true } })
    const adapter = fixture.mount()
    try {
      await fixture.store.dispatch({ type: 'document.append', documentId: fixture.document.id, text: 'New domain text', block: 'paragraph' })
      const snapshot = fixture.store.getSnapshot().documents[0]!.snapshot
      const first = adapter.reconcile(snapshot)
      await started.promise
      const second = adapter.reconcile(snapshot)
      const flush = adapter.flush()
      expect(replacements).toBe(1)
      gate.resolve()
      expect(await first).toBe(true)
      expect(await second).toBe(true)
      await flush
      expect(replacements).toBe(1)
      expect(fixture.readText()).toContain('New domain text')
    } finally { gate.resolve(); adapter.dispose(); fixture.store.dispose() }
  })

  it('updates references through the existing command context without reentering the domain queue', async () => {
    const fixture = createFixture()
    const adapter = fixture.mount()
    try {
      await fixture.store.dispatch({ type: 'document.footnote.add', footnote: { id: 'reference', text: 'Original source' } })
      const result = await fixture.store.dispatch({ type: 'editor.reference.update', kind: 'footnote', id: 'reference', text: 'Revised source' })
      expect(result.ok).toBe(true)
      await adapter.flush()
      expect(fixture.store.getSnapshot().documents[0]!.footnotes).toContainEqual({ id: 'reference', number: 1, text: 'Revised source' })
    } finally { adapter.dispose(); fixture.store.dispose() }
  })

  it('rejects a failed reconciliation and allows a later flush to retry without losing domain edits', async () => {
    let acceptsReplacement = false
    const fixture = createFixture({ beforeReplace: async () => acceptsReplacement })
    const adapter = fixture.mount()
    try {
      await fixture.store.dispatch({ type: 'document.append', documentId: fixture.document.id, text: 'Keep these edits', block: 'paragraph' })
      await expect(adapter.flush()).rejects.toThrow('could not synchronize')
      expect(fixture.readText()).toContain('Keep these edits')
      expect(fixture.executeCommand.mock.calls.filter(([id]) => id === 'doc.command-replace-snapshot')).toHaveLength(2)
      acceptsReplacement = true
      await adapter.flush()
      expect(getUniverDocumentText(fixture.native.document.getSnapshot())).toContain('Keep these edits')
    } finally { adapter.dispose(); fixture.store.dispose() }
  })

  it('invalidates an in-flight flush and late native notifications when its editor is disposed', async () => {
    const started = deferred()
    const gate = deferred()
    const fixture = createFixture({ beforeReplace: async () => { started.resolve(); await gate.promise; return true } })
    const adapter = fixture.mount()
    try {
      await fixture.store.dispatch({ type: 'document.append', documentId: fixture.document.id, text: 'Latest authority', block: 'paragraph' })
      const flush = adapter.flush()
      await started.promise
      adapter.dispose()
      fixture.type('Obsolete notification')
      gate.resolve()
      await expect(flush).rejects.toThrow()
      expect(fixture.readText()).toContain('Latest authority')
      expect(fixture.readText()).not.toContain('Obsolete notification')
      await Promise.resolve()
      expect(fixture.nativeDispose).toHaveBeenCalledTimes(1)
      expect(fixture.unsubscribe).toHaveBeenCalledTimes(1)
    } finally { gate.resolve(); adapter.dispose(); fixture.store.dispose() }
  })

  it('commits final native input synchronously before disposing exactly once', async () => {
    const fixture = createFixture()
    const adapter = fixture.mount()
    fixture.type('Last keystroke')
    adapter.dispose()
    expect(fixture.readText()).toContain('Last keystroke')
    adapter.dispose()
    await Promise.resolve()
    expect(fixture.nativeDispose).toHaveBeenCalledTimes(1)
    await expect(adapter.flush()).rejects.toThrow('disposed')
    fixture.store.dispose()
  })

  it('keeps locale, zoom, selection and copy changes out of the document model', async () => {
    const fixture = createFixture()
    const adapter = fixture.mount()
    try {
      const snapshot = fixture.store.getSnapshot()
      adapter.setLanguage('zh-CN')
      adapter.setZoom(75)
      fixture.emit('doc.operation.set-selections')
      fixture.emit('univer.command.copy')
      await new Promise((resolve) => setTimeout(resolve, 45))
      expect(fixture.store.getSnapshot()).toBe(snapshot)
      expect(fixture.native.univerAPI.setLocale).toHaveBeenCalledWith('zhCN')
      expect(fixture.executeCommand).toHaveBeenCalledWith('doc.command.set-zoom-ratio', { documentId: fixture.document.id, zoomRatio: 0.75 })
    } finally { adapter.dispose(); fixture.store.dispose() }
  })

  it('disposes a partially mounted native engine when subscription setup fails', async () => {
    const fixture = createFixture({ failSubscription: true })
    expect(fixture.mount).toThrow('Native subscription failed')
    await Promise.resolve()
    expect(fixture.nativeDispose).toHaveBeenCalledTimes(1)
    fixture.store.dispose()
  })

  it('releases native resources even if the final domain commit or mount notification throws', async () => {
    const failedMount = createFixture({ onTableActiveChange: () => { throw new Error('Mount notification failed') } })
    expect(failedMount.mount).toThrow('Mount notification failed')
    await Promise.resolve()
    expect(failedMount.nativeDispose).toHaveBeenCalledTimes(1)
    expect(failedMount.unsubscribe).toHaveBeenCalledTimes(1)
    failedMount.store.dispose()

    const failedCommit = createFixture()
    const adapter = failedCommit.mount()
    failedCommit.type('Final input')
    failedCommit.store.commitEditorSnapshot = () => { throw new Error('Final commit failed') }
    expect(adapter.dispose).toThrow('Final commit failed')
    await Promise.resolve()
    expect(failedCommit.nativeDispose).toHaveBeenCalledTimes(1)
    expect(failedCommit.unsubscribe).toHaveBeenCalledTimes(1)
    failedCommit.store.dispose()
  })
})
