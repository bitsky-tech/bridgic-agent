import { describe, expect, it } from 'bun:test'
import { createExcelEditorBinding } from '../excelEditorBinding'
import { createExcelWorkspace } from '../excelWorkspace'

describe('Excel native editor binding', () => {
  it('coalesces native notifications and reads the current native workbook without keeping another model', async () => {
    let value = 1
    const changes: number[] = []
    const binding = createExcelEditorBinding({
      sessionId: 'session', documentId: 'blank-tab-id', onChange: (snapshot: number) => changes.push(snapshot),
      readSnapshot: () => value, flushNative: () => undefined, disposeNative: () => undefined,
    })
    expect(binding.capture().identity).toEqual({ appKind: 'excel', sessionId: 'session', documentId: 'blank-tab-id' })
    expect(binding.readSnapshot()).toBe(1)
    value = 2
    binding.scheduleChange()
    binding.scheduleChange()
    value = 3
    await Promise.resolve()
    expect(changes).toEqual([3])
    expect(binding.readSnapshot()).toBe(3)
    binding.dispose()
  })

  it('waits for native cell commit before completing a flush and publishes its accepted mutation', async () => {
    let value = 'old'
    let finish: (() => void) | undefined
    const committed = new Promise<void>((resolve) => { finish = resolve })
    const changes: string[] = []
    const binding = createExcelEditorBinding({
      sessionId: 'session', documentId: 'tab', onChange: (snapshot: string) => changes.push(snapshot),
      readSnapshot: () => value,
      async flushNative(lease) {
        await committed
        lease.assertCurrent()
        value = 'typed value'
        binding.scheduleChange()
      },
      disposeNative: () => undefined,
    })
    let acknowledged = false
    const flushed = binding.flush().then(() => { acknowledged = true })
    await Promise.resolve()
    expect(acknowledged).toBe(false)
    expect(changes).toEqual([])
    finish!()
    await flushed
    expect(acknowledged).toBe(true)
    expect(changes).toEqual(['typed value'])
    binding.dispose()
  })

  it('keeps the current tab and source untouched when native commit rejects, then allows retry', async () => {
    const tab = {
      tabId: 'current', documentId: 'source-handle', fileName: 'Workbook.xlsx', snapshot: 1,
      mtimeMs: 10, dirty: true, changeVersion: 1, revision: 0,
    }
    const other = { ...tab, tabId: 'other', documentId: null }
    const workspace = createExcelWorkspace({ sessionId: 'session', tabs: [tab, other], activeTabId: tab.tabId })
    let rejectCommit = true
    let writes = 0
    const binding = createExcelEditorBinding({
      sessionId: 'session', documentId: tab.tabId, onChange: () => undefined,
      readSnapshot: () => tab.snapshot,
      flushNative() { if (rejectCommit) throw new Error('Cell edit canceled') },
      disposeNative: () => undefined,
    })
    const activate = () => workspace.runtime.execute({ sessionId: 'session', capability: 'document.activate', documentId: other.tabId }, async () => {
      await binding.flush()
      workspace.activate(other.tabId)
    })
    const save = () => workspace.runtime.execute({ sessionId: 'session', capability: 'document.save', documentId: tab.tabId }, async () => {
      await binding.flush()
      writes += 1
    })
    expect((await activate()).ok).toBe(false)
    expect((await save()).ok).toBe(false)
    expect(workspace.getState().activeTabId).toBe('current')
    expect(workspace.getState().tabs[0]).toEqual(tab)
    expect(writes).toBe(0)
    rejectCommit = false
    expect((await save()).ok).toBe(true)
    expect(writes).toBe(1)
    expect((await activate()).ok).toBe(true)
    expect(workspace.getState().activeTabId).toBe('other')
    binding.dispose()
    workspace.runtime.dispose()
  })

  it('publishes pending model mutations synchronously before disposal and ignores delayed callbacks', async () => {
    const events: string[] = []
    let reads = 0
    const binding = createExcelEditorBinding({
      sessionId: 'session', documentId: 'old-tab', onChange: () => events.push('change'),
      readSnapshot: () => { reads += 1; return 'last native snapshot' },
      flushNative: () => { events.push('flush') }, disposeNative: () => events.push('dispose'),
    })
    const lease = binding.capture()
    binding.scheduleChange()
    binding.dispose()
    expect(events).toEqual(['change', 'dispose'])
    expect(lease.isCurrent()).toBe(false)
    binding.scheduleChange()
    expect(binding.publishChange('late native snapshot')).toBe(false)
    binding.dispose()
    await Promise.resolve()
    expect(events).toEqual(['change', 'dispose'])
    expect(reads).toBe(1)
    expect(binding.readSnapshot()).toBeNull()
  })

  it('does not mark an unchanged workbook dirty merely because it is flushed or unmounted', async () => {
    let dirty = false
    let disposals = 0
    const binding = createExcelEditorBinding({
      sessionId: 'session', documentId: 'blank', onChange: () => { dirty = true },
      readSnapshot: () => 'blank', flushNative: () => undefined, disposeNative: () => { disposals += 1 },
    })
    await binding.flush()
    binding.dispose()
    expect(dirty).toBe(false)
    expect(disposals).toBe(1)
  })

  it('rejects completion of an asynchronous native flush after the editor is disposed', async () => {
    let finish: (() => void) | undefined
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const changes: string[] = []
    const binding = createExcelEditorBinding({
      sessionId: 'session', documentId: 'tab', onChange: (value: string) => changes.push(value),
      readSnapshot: () => 'value', flushNative: () => pending, disposeNative: () => undefined,
    })
    const flushed = binding.flush()
    binding.dispose()
    finish!()
    await expect(flushed).rejects.toMatchObject({ code: 'editor_disposed' })
    expect(changes).toEqual([])
  })

  it('publishes direct model changes once even when a native mutation notification was already queued', async () => {
    const changes: number[] = []
    const binding = createExcelEditorBinding({
      sessionId: 'session', documentId: 'tab', onChange: (value: number) => changes.push(value),
      readSnapshot: () => 2, flushNative: () => undefined, disposeNative: () => undefined,
    })
    binding.scheduleChange()
    expect(binding.publishChange(2)).toBe(true)
    await Promise.resolve()
    expect(changes).toEqual([2])
    binding.dispose()
  })
})
