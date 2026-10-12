import { afterAll, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { FOCUSING_DOC, IContextService, ICommandService, IUndoRedoService, IUniverInstanceService, Univer, UniverInstanceType, type DocumentDataModel, type IDocumentData } from '@univerjs/core'
import { DocSelectionManagerService, DocStateEmitService, RichTextEditingMutation } from '@univerjs/docs'
import { UniverDocsHyperLinkPlugin } from '@univerjs/docs-hyper-link'
import { DocStateChangeManagerService, ReplaceSnapshotCommand, SetDocZoomRatioCommand, SetDocZoomRatioOperation } from '@univerjs/docs-ui'
import { IRenderManagerService } from '@univerjs/engine-render'
import JSZip from 'jszip'
import type { WordEditorNativeEngine } from '../wordEditorAdapter'

GlobalRegistrator.register()

const { createWordDomainStore, createWordWorkspace } = await import('../wordDomain')
const { appendTextBlockToSnapshot, getSnapshotShowPageNumbers, getUniverDocumentText } = await import('../wordUniverModel')
const { exportWordDocx } = await import('../wordDocxExport')
const { createWordEditorAdapter } = await import('../wordEditorAdapter')

afterAll(async () => { await GlobalRegistrator.unregister() })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function createFixture(options: { beforeReplace?: () => Promise<boolean>; failSubscription?: boolean; onTableActiveChange?: () => void; retainNativeInput?: boolean } = {}) {
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
      nativeSnapshot = options.retainNativeInput ? params!.snapshot! : structuredClone(params!.snapshot!)
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
    mountNative: (input) => {
      if (options.retainNativeInput) nativeSnapshot = input.snapshot
      return native
    },
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
    emit(id: string, params: unknown = {}) { commandListener?.({ id, params }) },
  }
}

describe('Word editor engine binding', () => {
  it('restores a valid body caret after a retained document receives shorter HTML', async () => {
    const fixture = createFixture({ retainNativeInput: true })
    await fixture.store.dispatch({ type: 'document.update', html: `<p>${'Long body '.repeat(12)}</p>` })
    const adapter = fixture.mount()
    try {
      await Promise.resolve()
      fixture.emit('doc.operation.set-selections', { segmentId: '', ranges: [{ startOffset: 80, endOffset: 90, isActive: true }] })
      await fixture.store.dispatch({ type: 'document.create', title: 'Other document' })
      adapter.setActive(false)
      expect((await fixture.store.dispatch({ type: 'document.update', documentId: fixture.document.id, html: '<p>x</p>' })).ok).toBe(true)
      expect(await adapter.reconcile(fixture.store.getSnapshot().documents.find((document) => document.id === fixture.document.id)!.snapshot)).toBe(true)
      expect(fixture.native.document.getSnapshot().body?.dataStream).toBe('x\r\n')
      expect((await fixture.store.dispatch({ type: 'document.activate', documentId: fixture.document.id })).ok).toBe(true)
      expect(fixture.store.getSnapshot().activeDocumentId).toBe(fixture.document.id)
      adapter.setActive(true)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fixture.native.document.setSelection).toHaveBeenLastCalledWith(1, 1)
    } finally { adapter.dispose(); fixture.store.dispose() }
  })

  it('keeps the active document editable after replacing a body shorter than its selection', async () => {
    const fixture = createFixture({ retainNativeInput: true })
    await fixture.store.dispatch({ type: 'document.update', html: `<p>${'Long body '.repeat(12)}</p>` })
    const adapter = fixture.mount()
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      fixture.emit('doc.operation.set-selections', { segmentId: '', ranges: [{ startOffset: 80, endOffset: 90, isActive: true }] })
      expect((await fixture.store.dispatch({ type: 'document.update', html: '<p>x</p>' })).ok).toBe(true)
      expect(await adapter.reconcile(fixture.store.getSnapshot().documents[0]!.snapshot)).toBe(true)
      expect(fixture.native.document.setSelection).toHaveBeenLastCalledWith(1, 1)
      fixture.type('Still editable')
      await adapter.flush()
      expect(fixture.readText()).toContain('Still editable')
    } finally { adapter.dispose(); fixture.store.dispose() }
  })

  it('retains real Univer mutation undo and redo histories while another document is active', async () => {
    // Only rendering geometry is headless. Document mutation, history recording,
    // undo and redo all use the installed Univer implementations.
    const store = createWordDomainStore(createWordWorkspace(crypto.randomUUID(), 'First'), { defaultTitle: 'Untitled' })
    const firstId = store.getSnapshot().activeDocumentId
    await store.dispatch({ type: 'document.update', documentId: firstId, html: '<p><strong>Formatted original</strong></p>' })
    await store.dispatch({ type: 'document.create', title: 'Second' })
    const secondId = store.getSnapshot().activeDocumentId
    const natives: Array<{ model: DocumentDataModel; history: IUndoRedoService; disposed: boolean }> = []
    const mount = (documentId: string, active: boolean) => createWordEditorAdapter({
      active, container: document.createElement('div'), documentId, language: 'en',
      snapshot: store.getSnapshot().documents.find((item) => item.id === documentId)!.snapshot, store, zoom: 100,
      mountNative: ({ snapshot }) => {
        const rendering = { getRenderById: () => ({ with: () => ({ getViewModel: () => ({ reset() {} }) }) }) }
        const univer = new Univer()
        const injector = univer.__getInjector()
        injector.add([IRenderManagerService, { useValue: rendering as unknown as IRenderManagerService }])
        injector.add([DocSelectionManagerService])
        injector.add([DocStateEmitService])
        const model = univer.createUnit<IDocumentData, DocumentDataModel>(UniverInstanceType.UNIVER_DOC, snapshot)
        const commands = injector.get(ICommandService)
        const history = injector.get(IUndoRedoService)
        const instances = injector.get(IUniverInstanceService)
        const context = injector.get(IContextService)
        const stateChanges = new DocStateChangeManagerService(history, commands, instances, injector.get(DocStateEmitService), rendering as never)
        commands.registerCommand(RichTextEditingMutation)
        commands.registerCommand(ReplaceSnapshotCommand)
        commands.registerCommand(SetDocZoomRatioOperation)
        commands.registerCommand(SetDocZoomRatioCommand)
        const native = { model, history, disposed: false }
        natives.push(native)
        return {
          document: {
            getSnapshot: () => model.getSnapshot(),
            setSelection() {},
            appendText: async () => false,
            insertParagraph: async () => false,
            insertText: async () => false,
            undo: () => commands.executeCommand('univer.command.undo'),
            redo: () => commands.executeCommand('univer.command.redo'),
          },
          univerAPI: {
            executeCommand: (id, params) => commands.executeCommand(id, params),
            setLocale() {},
            onCommandExecuted: (listener) => commands.onCommandExecuted(listener),
          },
          setActive(next) { instances.focusUnit(next ? documentId : null); context.setContextValue(FOCUSING_DOC, next) },
          dispose() { native.disposed = true; stateChanges.dispose(); univer.dispose() },
        }
      },
    })
    const first = mount(firstId, false)
    const second = mount(secondId, true)
    try {
      second.setActive(false)
      await store.dispatch({ type: 'document.activate', documentId: firstId })
      first.setActive(true)
      first.setZoom(75)
      await Promise.resolve()
      expect(natives[0]!.model.getSnapshot().settings?.zoomRatio).toBe(0.75)
      expect(natives[0]!.history.pitchTopUndoElement()).toBeNull()
      expect(natives[1]!.history.pitchTopUndoElement()).toBeNull()
      const original = structuredClone(natives[0]!.model.getSnapshot().body)
      await store.dispatch({ type: 'document.append', documentId: firstId, text: 'First edit' })
      await first.flush()
      expect(natives[0]!.history.pitchTopUndoElement()).not.toBeNull()
      expect((await store.dispatch({ type: 'editor.format', action: 'undo' })).ok).toBe(true)
      expect(natives[0]!.model.getSnapshot().body).toEqual(original)

      expect(natives[0]!.history.pitchTopRedoElement()).not.toBeNull()
      const redoBeforeActivation = natives[0]!.history.pitchTopRedoElement()

      first.setActive(false)
      await store.dispatch({ type: 'document.activate', documentId: secondId })
      second.setActive(true)
      await store.dispatch({ type: 'document.append', documentId: secondId, text: 'Second edit' })
      await second.flush()
      second.setActive(false)
      await store.dispatch({ type: 'document.activate', documentId: firstId })
      first.setActive(true)
      await Promise.resolve()
      expect(natives[0]!.history.pitchTopUndoElement()).toBeNull()
      expect(natives[0]!.history.pitchTopRedoElement()).toBe(redoBeforeActivation)

      expect(natives).toHaveLength(2)
      expect(natives.every((native) => !native.disposed)).toBe(true)
      expect((await store.dispatch({ type: 'editor.format', action: 'redo' })).ok).toBe(true)
      expect(getUniverDocumentText(natives[0]!.model.getSnapshot())).toContain('First edit')
      expect(natives[0]!.model.getSnapshot().body?.textRuns).toEqual(original?.textRuns)
      expect(getUniverDocumentText(natives[1]!.model.getSnapshot())).toContain('Second edit')
      expect((await store.dispatch({ type: 'editor.format', action: 'undo' })).ok).toBe(true)
      expect(natives[0]!.model.getSnapshot().body).toEqual(original)

      await store.dispatch({ type: 'document.page.update', documentId: firstId, page: { orientation: 'landscape' } })
      await first.flush()
      expect(natives[0]!.model.getSnapshot().documentStyle.pageOrient).toBe(1)
      expect((await store.dispatch({ type: 'editor.format', action: 'undo' })).ok).toBe(true)
      expect(store.getSnapshot().documents.find((item) => item.id === firstId)!.page.orientation).toBe('portrait')
      expect((await store.dispatch({ type: 'editor.format', action: 'redo' })).ok).toBe(true)
      expect(store.getSnapshot().documents.find((item) => item.id === firstId)!.page.orientation).toBe('landscape')

      await store.dispatch({ type: 'document.headerFooter.update', documentId: firstId, settings: { headerHtml: '<p>First header</p>' } })
      await first.flush()
      expect(store.getSnapshot().documents.find((item) => item.id === firstId)!.headerFooter.headerHtml).toContain('First header')
      expect((await store.dispatch({ type: 'editor.format', action: 'undo' })).ok).toBe(true)
      const undone = store.getSnapshot().documents.find((item) => item.id === firstId)!
      expect(undone.headerFooter.headerHtml).toBe('')
      expect(undone.snapshot.documentStyle.defaultHeaderId).toBe('')
      expect((await store.dispatch({ type: 'editor.format', action: 'redo' })).ok).toBe(true)
      expect(store.getSnapshot().documents.find((item) => item.id === firstId)!.headerFooter.headerHtml).toContain('First header')

      const exportFooterXml = async () => {
        const current = store.getSnapshot().documents.find((item) => item.id === firstId)!
        const archive = await JSZip.loadAsync(await exportWordDocx(current))
        return (await Promise.all(archive.file(/^word\/footer.*\.xml$/).map((part) => part.async('string')))).join('')
      }
      expect((await store.dispatch({ type: 'document.headerFooter.update', documentId: firstId, settings: { showPageNumbers: true } })).ok).toBe(true)
      await first.flush()
      expect(getSnapshotShowPageNumbers(natives[0]!.model.getSnapshot())).toBe(true)
      expect(await exportFooterXml()).toContain('w:instr="PAGE"')
      expect((await store.dispatch({ type: 'editor.format', action: 'undo' })).ok).toBe(true)
      const numberingUndone = store.getSnapshot().documents.find((item) => item.id === firstId)!
      expect(getSnapshotShowPageNumbers(natives[0]!.model.getSnapshot())).toBe(false)
      expect(getSnapshotShowPageNumbers(numberingUndone.snapshot)).toBe(false)
      expect(numberingUndone.headerFooter.showPageNumbers).toBe(false)
      expect(await exportFooterXml()).not.toContain('w:instr="PAGE"')
      expect((await store.dispatch({ type: 'editor.format', action: 'redo' })).ok).toBe(true)
      const numberingRedone = store.getSnapshot().documents.find((item) => item.id === firstId)!
      expect(getSnapshotShowPageNumbers(natives[0]!.model.getSnapshot())).toBe(true)
      expect(getSnapshotShowPageNumbers(numberingRedone.snapshot)).toBe(true)
      expect(numberingRedone.headerFooter.showPageNumbers).toBe(true)
      expect(await exportFooterXml()).toContain('w:instr="PAGE"')
    } finally {
      first.dispose(); second.dispose(); store.dispose()
      await Promise.resolve()
      expect(natives.every((native) => native.disposed)).toBe(true)
    }
  })
  it('reopens canonical hyperlink URLs without letting a stale native resource replace them', async () => {
    const fixture = createFixture()
    await fixture.store.dispatch({ type: 'document.headerFooter.update', settings: { headerHtml: '<p><a href="https://example.com/new">Website</a></p>' } })
    const snapshot = structuredClone(fixture.store.getSnapshot().documents[0]!.snapshot)
    const header = snapshot.headers![snapshot.documentStyle.defaultHeaderId!]!.body
    snapshot.resources = [
      { name: 'DOC_HYPER_LINK_PLUGIN', data: JSON.stringify({ links: [{ id: header.customRanges![0]!.rangeId, payload: 'https://example.com/old' }] }) },
      { name: 'OTHER_PLUGIN', data: '{}' },
    ]
    fixture.store.commitEditorSnapshot(fixture.document.id, snapshot)
    const before = fixture.store.getSnapshot()
    const univer = new Univer()
    univer.registerPlugin(UniverDocsHyperLinkPlugin)
    let loaded!: DocumentDataModel
    const adapter = createWordEditorAdapter({
      container: window.document.createElement('div'), documentId: fixture.document.id,
      language: 'en', snapshot: before.documents[0]!.snapshot, store: fixture.store, zoom: 100,
      mountNative: (input) => {
        expect(input.snapshot.resources).toEqual([{ name: 'OTHER_PLUGIN', data: '{}' }])
        loaded = univer.createUnit(UniverInstanceType.UNIVER_DOC, input.snapshot)
        fixture.native.document.getSnapshot = () => loaded.getSnapshot()
        return fixture.native
      },
    })
    try {
      expect(loaded.getSnapshot().headers![snapshot.documentStyle.defaultHeaderId!]!.body.customRanges![0]!.properties?.url).toBe('https://example.com/new')
      await adapter.flush()
      expect(fixture.store.getSnapshot()).toBe(before)
      expect(before.documents[0]!.snapshot.resources).toEqual(snapshot.resources)
    } finally { adapter.dispose(); fixture.store.dispose(); univer.dispose() }
  })

  it('does not publish renderer normalization as an edit on open, flush or close', async () => {
    const fixture = createFixture()
    const adapter = fixture.mount()
    const before = fixture.store.getSnapshot().documents[0]!
    fixture.native.document.getSnapshot().settings = { zoomRatio: 0.5 }
    fixture.native.document.getSnapshot().drawings!['layout-only'] = { drawingId: 'layout-only' } as NonNullable<IDocumentData['drawings']>[string]
    fixture.emit('drawing.operation.set-drawing-selected')
    fixture.emit('doc.operation.set-selections')
    await adapter.flush()
    adapter.dispose()
    expect(fixture.store.getSnapshot().documents[0]!.snapshot).toEqual(before.snapshot)
    expect(fixture.store.getSnapshot().documents[0]!.contentVersion).toBe(before.contentVersion)
    fixture.store.dispose()
  })
  it('commits in-place native image changes without aliasing mounted or replaced domain snapshots', async () => {
    const fixture = createFixture({ retainNativeInput: true })
    const adapter = fixture.mount()
    try {
      for (const id of ['mounted-image', 'replaced-image']) {
        if (id === 'replaced-image') {
          await fixture.store.dispatch({ type: 'document.append', text: 'Agent edit' })
          expect(await adapter.reconcile(fixture.store.getSnapshot().documents[0]!.snapshot)).toBe(true)
        }
        const before = fixture.store.getSnapshot().documents[0]!.snapshot
        const native = fixture.native.document.getSnapshot()
        native.drawings![id] = { drawingId: id, unitId: fixture.document.id, subUnitId: fixture.document.id } as NonNullable<IDocumentData['drawings']>[string]
        fixture.emit('doc.command.insert-doc-image')
        expect(before.drawings?.[id]).toBeUndefined()
        await adapter.flush()
        expect(fixture.store.getSnapshot().documents[0]!.snapshot.drawings?.[id]?.drawingId).toBe(id)
        expect(before.drawings?.[id]).toBeUndefined()
      }
    } finally { adapter.dispose(); fixture.store.dispose() }
  })

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
      expect(replacements[0]![1]).toMatchObject({ textRanges: undefined })
      expect(replacements[0]![1]).not.toHaveProperty('options')
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
      expect(fixture.executeCommand).toHaveBeenCalledWith('doc.operation.set-zoom-ratio', { unitId: fixture.document.id, zoomRatio: 0.75 })
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
