import { describe, expect, it } from 'bun:test'
import { completeExcelWorkbookSave, createExcelWorkspace, type ExcelWorkspaceTab } from '../excelWorkspace'

type Snapshot = { id: string; value: number }

function tab(tabId: string): ExcelWorkspaceTab<Snapshot> {
  return {
    tabId,
    documentId: null,
    fileName: `${tabId}.xlsx`,
    snapshot: { id: `native-${tabId}`, value: 0 },
    mtimeMs: null,
    dirty: false,
    changeVersion: 0,
    revision: 0,
  }
}

function setup(sessionId = 'session-a') {
  return createExcelWorkspace({ sessionId, tabs: [tab('a'), tab('b')], activeTabId: 'a' })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Excel workspace adapter', () => {
  it('reuses the same source and preserves inactive unsaved content without importing again', async () => {
    const workspace = setup()
    const source = { path: '/session/Report.xlsx', mtimeMs: 42 }
    const draft = { id: 'native-a', value: 7 }
    workspace.updateTab('a', (current) => ({ ...current, documentId: source.path, source, mtimeMs: 42, dirty: true, changeVersion: 3, snapshot: draft }))
    workspace.activate('b')
    const result = await workspace.runtime.execute({ sessionId: 'session-a', capability: 'document.open' }, (context) => workspace.openWorkbook({
      document: { documentId: source.path, source, mtimeMs: 42, fileName: 'Report.xlsx' },
      importSnapshot: async () => { throw new Error('An unchanged source must not be imported') },
      flushEditor: async () => undefined, assertCurrent: context.assertCurrent, conflictMessage: 'Source changed',
    }))
    expect(result).toEqual({ ok: true, value: { documentId: 'a', reused: true } })
    expect(workspace.getState().tabs).toHaveLength(2)
    expect(workspace.getState().activeTabId).toBe('a')
    expect(workspace.getState().tabs[0]).toMatchObject({ snapshot: draft, dirty: true, changeVersion: 3 })
    expect(workspace.getState().tabs[0]!.snapshot).toBe(draft)
  })

  it.each([false, true])('refreshes only a clean changed source in place: dirty=%s', async (dirty) => {
    const workspace = setup()
    const source = { path: '/session/Report.xlsx', mtimeMs: 42 }
    workspace.updateTab('a', (current) => ({ ...current, documentId: source.path, source, mtimeMs: 42, dirty }))
    let imports = 0
    const result = await workspace.runtime.execute({ sessionId: 'session-a', capability: 'document.open' }, (context) => workspace.openWorkbook({
      document: { documentId: source.path, source: { ...source, mtimeMs: 99 }, mtimeMs: 99, fileName: 'Report.xlsx' },
      importSnapshot: async () => { imports++; return { id: 'native-updated', value: 9 } },
      flushEditor: async () => undefined, assertCurrent: context.assertCurrent, conflictMessage: 'Source changed',
    }))
    expect(result).toMatchObject(dirty ? { ok: false, error: { code: 'source_conflict' } } : { ok: true, value: { documentId: 'a', reused: false } })
    expect(imports).toBe(dirty ? 0 : 1)
    expect(workspace.getState().tabs).toHaveLength(2)
    expect(workspace.getState().tabs[0]).toMatchObject(dirty
      ? { tabId: 'a', dirty: true, mtimeMs: 42, revision: 0 }
      : { tabId: 'a', dirty: false, mtimeMs: 99, revision: 1, snapshot: { value: 9 } })
  })

  it('rejects edits accepted during parsing and preserves the source owner', async () => {
    const workspace = setup()
    const source = { path: '/session/Report.xlsx', mtimeMs: 42 }
    workspace.updateTab('a', (current) => ({ ...current, documentId: source.path, source, mtimeMs: 42 }))
    const result = await workspace.runtime.execute({ sessionId: 'session-a', capability: 'document.open' }, (context) => workspace.openWorkbook({
      document: { documentId: source.path, source: { ...source, mtimeMs: 99 }, mtimeMs: 99, fileName: 'Report.xlsx' },
      importSnapshot: async () => {
        workspace.updateTab('a', (current) => ({ ...current, dirty: true, changeVersion: 1, snapshot: { id: 'native-a', value: 10 } }))
        return { id: 'imported', value: 9 }
      },
      flushEditor: async () => undefined, assertCurrent: context.assertCurrent, conflictMessage: 'Source changed',
    }))
    expect(result).toMatchObject({ ok: false, error: { code: 'source_conflict' } })
    expect(workspace.getState().tabs[0]).toMatchObject({ tabId: 'a', dirty: true, mtimeMs: 42, snapshot: { value: 10 } })
  })

  it('restores a completed close checkpoint before reporting a native flush failure', async () => {
    const workspace = setup()
    const approved = workspace.getState()
    let checkpoint = approved
    const result = await workspace.runtime.execute({ sessionId: 'session-a', capability: 'document.close' }, (context) => workspace.commitClose({
      tabs: [], activeTabId: null,
      persist: async (tabs, activeTabId) => { checkpoint = structuredClone({ tabs, activeTabId }) },
      flushEditor: async () => { throw new Error('Native flush failed') },
      assertCurrent: context.assertCurrent, changedMessage: 'New input',
    }))
    expect(result).toMatchObject({ ok: false, error: { message: 'Native flush failed' } })
    expect(workspace.getState()).toBe(approved)
    expect(checkpoint).toEqual(approved)
  })

  it('waits for durable recovery of input accepted during close and during checkpoint restoration', async () => {
    const workspace = setup()
    let checkpoint = workspace.getState()
    let writes = 0
    const edit = (value: number) => workspace.updateTab('a', (current) => ({ ...current, dirty: true, changeVersion: value, snapshot: { id: 'native-a', value } }))
    const result = await workspace.runtime.execute({ sessionId: 'session-a', capability: 'document.close' }, (context) => workspace.commitClose({
      tabs: [], activeTabId: null,
      persist: async (tabs, activeTabId) => {
        checkpoint = structuredClone({ tabs, activeTabId })
        writes++
        if (writes <= 2) edit(writes)
      },
      flushEditor: async () => undefined,
      assertCurrent: context.assertCurrent, changedMessage: 'New input',
    }))
    expect(result).toMatchObject({ ok: false, error: { code: 'document_changed' } })
    expect(writes).toBe(3)
    expect(checkpoint).toEqual(workspace.getState())
    expect(checkpoint.tabs[0]).toMatchObject({ dirty: true, changeVersion: 2, snapshot: { value: 2 } })
  })

  it('reports blank workbook identities without exposing file handles or native payloads', () => {
    const workspace = setup()
    const metadata = workspace.runtime.getSnapshot()
    expect(metadata.sessionId).toBe('session-a')
    expect(metadata.appKind).toBe('excel')
    expect(metadata.activeDocumentId).toBe('a')
    expect(metadata.documents).toEqual([
      { id: 'a', title: 'a.xlsx', revision: 0, dirty: false },
      { id: 'b', title: 'b.xlsx', revision: 0, dirty: false },
    ])
    expect(metadata.capabilities).toContain('document.saveAs')
    expect(metadata.capabilities).not.toContain('agent.dispatch')
    expect(workspace.runtime.getSnapshot()).toBe(metadata)
  })

  it('publishes one coherent inventory when recovery replaces the document set', () => {
    const workspace = setup()
    const projected: string[] = []
    const rendered: string[] = []
    workspace.runtime.subscribe((snapshot) => projected.push(snapshot.activeDocumentId!))
    const unsubscribe = workspace.subscribe(() => rendered.push(workspace.getState().activeTabId!))
    workspace.replace([tab('restored')], 'missing')
    expect(projected).toEqual(['restored'])
    expect(rendered).toEqual(['restored'])
    unsubscribe()
    workspace.replace([], null)
    expect(workspace.runtime.getSnapshot().documents).toEqual([])
    expect(workspace.runtime.getSnapshot().activeDocumentId).toBeNull()
    expect(rendered).toEqual(['restored'])
  })

  it('publishes native edits immediately without replacing or queuing the native payload', async () => {
    const workspace = setup()
    const gate = deferred()
    const save = workspace.runtime.execute({ sessionId: 'session-a', capability: 'document.save', documentId: 'a' }, () => gate.promise)
    const native = { id: 'native-a', value: 42 }
    workspace.updateTab('a', (current) => ({ ...current, snapshot: native, dirty: true, changeVersion: 1 }))
    expect(workspace.getState().tabs[0]!.snapshot).toBe(native)
    expect(workspace.runtime.getSnapshot().documents[0]).toEqual({ id: 'a', title: 'a.xlsx', revision: 1, dirty: true })
    gate.resolve()
    expect((await save).ok).toBe(true)
  })

  it('keeps the workspace identity and newer edits when Save as changes the source handle', () => {
    const workspace = setup()
    const native = { id: 'native-a', value: 42 }
    workspace.updateTab('a', (current) => ({ ...current, snapshot: native, dirty: true, changeVersion: 2 }))
    workspace.updateTab('a', (current) => completeExcelWorkbookSave(current, {
      changeVersion: 1,
      documentId: 'new-source-handle',
      fileName: 'Saved copy.xlsx',
      mtimeMs: 15,
      snapshot: { id: 'native-a', value: 21 },
    }))
    expect(workspace.getState().tabs[0]).toMatchObject({ tabId: 'a', documentId: 'new-source-handle', dirty: true, changeVersion: 2 })
    expect(workspace.getState().tabs[0]!.snapshot).toBe(native)
    expect(workspace.runtime.getSnapshot().documents[0]).toEqual({ id: 'a', title: 'Saved copy.xlsx', revision: 2, dirty: true })
  })

  it('acknowledges an unchanged saved version without replacing another workbook', () => {
    const workspace = setup()
    workspace.updateTab('a', (current) => ({ ...current, dirty: true, changeVersion: 1 }))
    const snapshot = { id: 'native-a', value: 12 }
    workspace.updateTab('a', (current) => completeExcelWorkbookSave(current, {
      changeVersion: 1, documentId: 'source', fileName: 'saved.xlsx', mtimeMs: 1, snapshot,
    }))
    expect(workspace.getState().tabs[0]).toMatchObject({ tabId: 'a', snapshot, dirty: false })
    expect(workspace.getState().tabs[1]).toEqual(tab('b'))
  })

  it('keeps stable document identity when explicit export updates the file binding', () => {
    const original = { path: '/session/.work/Original.xlsx', mtimeMs: 1 }
    const destination = { path: '/session/.work/Saved.xlsx', mtimeMs: 3 }
    const current = { ...tab('a'), documentId: original.path, source: original }
    const saved = completeExcelWorkbookSave(current, {
      changeVersion: 0, documentId: destination.path, source: destination, fileName: 'Saved.xlsx', mtimeMs: 3, snapshot: current.snapshot,
    })
    expect(saved).toMatchObject({ tabId: 'a', source: destination })
    const sameFile = completeExcelWorkbookSave(saved, {
      changeVersion: 0, documentId: destination.path, source: destination, fileName: 'Saved.xlsx', mtimeMs: 3, snapshot: saved.snapshot,
    })
    expect(sameFile.tabId).toBe('a')
    expect(sameFile.source).toEqual(destination)
  })

  it('orders asynchronous imports before later document activation', async () => {
    const workspace = setup()
    const gate = deferred()
    const order: string[] = []
    const open = workspace.runtime.execute({ sessionId: 'session-a', capability: 'document.open' }, async (context) => {
      await gate.promise
      context.assertCurrent()
      workspace.replace([...workspace.getState().tabs, tab('imported')], 'imported')
      order.push('imported')
    })
    const activate = workspace.runtime.execute({ sessionId: 'session-a', capability: 'document.activate', documentId: 'b' }, () => {
      workspace.activate('b')
      order.push('activated')
    })
    expect(workspace.getState().activeTabId).toBe('a')
    gate.resolve()
    expect((await open).ok).toBe(true)
    expect((await activate).ok).toBe(true)
    expect(order).toEqual(['imported', 'activated'])
    expect(workspace.getState().activeTabId).toBe('b')
  })

  it('keeps one source owner after Save as replaces an already open clean workbook', () => {
    const workspace = setup()
    workspace.updateTab('a', (current) => ({ ...current, documentId: 'source-a' }))
    workspace.updateTab('b', (current) => ({ ...current, documentId: 'source-b' }))
    workspace.activate('b')
    const snapshots: string[][] = []
    workspace.subscribe(() => snapshots.push(workspace.getState().tabs.map((tab) => tab.tabId)))
    const drafts = workspace.completeSave('b', {
      changeVersion: 0, documentId: 'source-a', fileName: 'a.xlsx', mtimeMs: 2, snapshot: { id: 'native-b', value: 10 },
    }, (name) => `Draft ${name}`)
    expect(drafts).toEqual([])
    expect(snapshots).toEqual([['b']])
    expect(workspace.getState().activeTabId).toBe('b')
    expect(workspace.getState().tabs).toEqual([expect.objectContaining({ tabId: 'b', documentId: 'source-a', fileName: 'a.xlsx', dirty: false })])
  })

  it('retains conflicting unsaved edits as an unbound draft and preserves edits made during saving', () => {
    const workspace = setup()
    const original = { id: 'native-a', value: 99 }
    const latest = { id: 'native-b', value: 42 }
    workspace.updateTab('a', (current) => ({ ...current, documentId: 'source-a', snapshot: original, dirty: true, changeVersion: 3, mtimeMs: 1 }))
    workspace.updateTab('b', (current) => ({ ...current, documentId: 'source-b', snapshot: latest, dirty: true, changeVersion: 2 }))
    workspace.activate('b')
    const drafts = workspace.completeSave('b', {
      changeVersion: 1, documentId: 'source-a', fileName: 'a.xlsx', mtimeMs: 2, snapshot: { id: 'native-b', value: 21 },
    }, (name) => `Draft ${name}`)
    expect(drafts).toEqual(['Draft a.xlsx'])
    expect(workspace.getState().tabs[0]).toMatchObject({ tabId: 'a', documentId: null, mtimeMs: null, fileName: 'Draft a.xlsx', dirty: true, changeVersion: 3 })
    expect(workspace.getState().tabs[0]!.snapshot).toBe(original)
    expect(workspace.getState().tabs[1]).toMatchObject({ tabId: 'b', documentId: 'source-a', mtimeMs: 2, dirty: true, changeVersion: 2 })
    expect(workspace.getState().tabs[1]!.snapshot).toBe(latest)
    expect(workspace.getState().activeTabId).toBe('b')
  })

  it('rejects a late import after the Session runtime is disposed', async () => {
    const workspace = setup()
    const gate = deferred()
    const opened = workspace.runtime.execute({ sessionId: 'session-a', capability: 'document.open' }, async (context) => {
      await gate.promise
      context.assertCurrent()
      workspace.replace([tab('late')], 'late')
    })
    workspace.runtime.dispose()
    gate.resolve()
    expect(await opened).toMatchObject({ ok: false, error: { code: 'runtime_disposed' } })
    expect(workspace.getState().activeTabId).toBe('a')
  })

  it('rejects cross-Session, unsupported and stale-revision operations before applying them', async () => {
    const workspace = setup()
    let applied = 0
    const apply = () => { applied += 1 }
    expect(await workspace.runtime.execute({ sessionId: 'session-b', capability: 'document.edit', documentId: 'a' }, apply))
      .toMatchObject({ ok: false, error: { code: 'session_mismatch' } })
    expect(await workspace.runtime.execute({ sessionId: 'session-a', capability: 'export.pdf', documentId: 'a' }, apply))
      .toMatchObject({ ok: false, error: { code: 'unsupported_operation' } })
    workspace.updateTab('a', (current) => ({ ...current, changeVersion: 1 }))
    expect(await workspace.runtime.execute({ sessionId: 'session-a', capability: 'document.edit', documentId: 'a', expectedDocumentRevision: 0 }, apply))
      .toMatchObject({ ok: false, error: { code: 'revision_conflict' } })
    expect(applied).toBe(0)
  })

  it('pins a queued editor action to its original document and native instance', async () => {
    const workspace = setup()
    const gate = deferred()
    let editor = { documentId: 'a' }
    const blocking = workspace.runtime.execute({ sessionId: 'session-a', capability: 'document.save', documentId: 'a' }, () => gate.promise)
    let applied = false
    const editing = workspace.executeEditor({
      capability: 'document.edit', documentId: 'a', getEditor: () => editor,
      apply: () => { applied = true },
    })
    editor = { documentId: 'a' }
    gate.resolve()
    await blocking
    expect(await editing).toMatchObject({ ok: false, error: { code: 'document_not_ready' } })
    expect(applied).toBe(false)
  })

  it('waits for an in-flight editor operation before switching or closing its document', async () => {
    const workspace = setup()
    const gate = deferred()
    const editor = { documentId: 'a', value: 0 }
    const editing = workspace.executeEditor({
      capability: 'document.edit', documentId: 'a', getEditor: () => editor,
      apply: async (target) => { await gate.promise; target.value = 7 },
    })
    const closing = workspace.runtime.execute({ sessionId: 'session-a', capability: 'document.close', documentId: 'a' }, () => {
      workspace.replace(workspace.getState().tabs.filter((item) => item.tabId !== 'a'), 'b')
    })
    expect(workspace.getState().activeTabId).toBe('a')
    gate.resolve()
    expect((await editing).ok).toBe(true)
    expect((await closing).ok).toBe(true)
    expect(editor.value).toBe(7)
    expect(workspace.getState().activeTabId).toBe('b')
  })

  it('rejects an inactive or missing native editor and continues processing later work', async () => {
    const workspace = setup()
    const editor = { documentId: 'a' }
    const rejected = await workspace.executeEditor({
      capability: 'document.edit', documentId: 'b', getEditor: () => editor,
      apply: () => { throw new Error('must not run') },
    })
    expect(rejected).toMatchObject({ ok: false, error: { code: 'document_not_ready' } })
    const failed = await workspace.executeEditor({
      capability: 'document.edit', documentId: 'a', getEditor: () => editor,
      apply: () => { throw new Error('driver failed') },
    })
    expect(failed).toMatchObject({ ok: false, error: { code: 'operation_failed', message: 'driver failed' } })
    const following = await workspace.executeEditor({
      capability: 'document.undo', documentId: 'a', getEditor: () => editor,
      apply: () => 'undone',
    })
    expect(following).toEqual({ ok: true, value: 'undone' })
  })
})
