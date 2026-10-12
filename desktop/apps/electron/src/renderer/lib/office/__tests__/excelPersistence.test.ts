import { describe, expect, it, mock } from 'bun:test'
import type { ExcelHostPreloadAPI, ExcelSaveResult } from '../../../../shared/types'
import { createExcelWorkspacePersistence, writeExcelWorkbookSource, type ExcelWorkspaceState } from '../excelPersistence'
import { OfficeOperationError } from '../officeWorkspaceRuntime'
import { createOfficePersistenceScheduler } from '../officePersistence'
import type { WorkspacePersistence } from '../workspacePersistence'

type Snapshot = { id: string; value: number }

function state(value: number): ExcelWorkspaceState<Snapshot> {
  return {
    schemaVersion: 1,
    tabs: [{
      tabId: 'tab-a', documentId: null, fileName: 'Workbook.xlsx',
      snapshot: { id: 'native-a', value }, mtimeMs: null, dirty: true,
      changeVersion: value, revision: 0,
    }],
    activeTabId: 'tab-a',
    nextWorkbookOrdinal: 2,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function workspaceMemory(stored: unknown = null) {
  let value = stored
  const write = mock(async (_workspace: ExcelWorkspaceState<Snapshot>): Promise<void> => undefined)
  const load = mock(async () => value)
  const scheduler = createOfficePersistenceScheduler<ExcelWorkspaceState<Snapshot>>({
    policy: { appKind: 'excel', sessionId: 'session-a', kind: 'workspace', storage: 'browser-storage', automatic: true },
    delayMs: 250,
    write: async (workspace) => { await write(workspace); value = structuredClone(workspace) },
  })
  const persistence: WorkspacePersistence<ExcelWorkspaceState<Snapshot>> = { ...scheduler, load }
  return { persistence, write, load }
}

describe('Excel structured workspace persistence', () => {
  it('stores structured snapshots without exporting XLSX or clearing source dirty', async () => {
    const memory = workspaceMemory()
    const recovery = createExcelWorkspacePersistence<Snapshot>({ sessionId: 'session-a', workspacePersistence: memory.persistence })
    expect(recovery.getSnapshot().policy).toEqual({
      appKind: 'excel', sessionId: 'session-a', kind: 'workspace', storage: 'browser-storage', automatic: true,
    })
    const snapshot = state(1)
    expect(recovery.schedule(snapshot)).toBe(false)
    expect(await recovery.restore()).toEqual({ status: 'empty' })
    expect(recovery.schedule(snapshot)).toBe(true)
    expect(memory.write).not.toHaveBeenCalled()
    await recovery.flush()
    expect(memory.write).toHaveBeenCalledWith(snapshot)
    expect(snapshot.tabs[0]!.dirty).toBe(true)
    expect(snapshot.tabs[0]!.documentId).toBeNull()
    expect(recovery.getSnapshot().status).toBe('saved')
    recovery.dispose()
  })

  it('rejects a malformed structured checkpoint without overwriting it', async () => {
    const memory = workspaceMemory({ ...state(1), tabs: [{ tabId: 'tab-a' }] })
    const recovery = createExcelWorkspacePersistence<Snapshot>({ sessionId: 'session-a', workspacePersistence: memory.persistence })
    expect(await recovery.restore()).toMatchObject({ status: 'failed' })
    expect(recovery.schedule(state(0))).toBe(false)
    expect(memory.write).not.toHaveBeenCalled()
    recovery.dispose()
  })

  it('does not overwrite an unreadable checkpoint and permits a later restore retry', async () => {
    const previous = state(9)
    const memory = workspaceMemory(previous)
    memory.load.mockRejectedValueOnce(new Error('read unavailable'))
    const recovery = createExcelWorkspacePersistence<Snapshot>({ sessionId: 'session-a', workspacePersistence: memory.persistence })
    expect(await recovery.restore()).toMatchObject({ status: 'failed', error: { message: 'read unavailable' } })
    expect(recovery.schedule(state(0))).toBe(false)
    await expect(recovery.flush()).rejects.toMatchObject({ code: 'recovery_unavailable' })
    expect(memory.write).not.toHaveBeenCalled()
    expect(await recovery.restore()).toEqual({ status: 'restored', value: previous })
    expect(memory.write).not.toHaveBeenCalled()
    recovery.schedule(state(10))
    await recovery.flush()
    expect(memory.write).toHaveBeenCalledTimes(1)
    expect(memory.write).toHaveBeenLastCalledWith(state(10))
    recovery.dispose()
  })

  it('treats malformed records as restoration failures instead of empty workspaces', async () => {
    const memory = workspaceMemory({ schemaVersion: 3, tabs: [] })
    const recovery = createExcelWorkspacePersistence<Snapshot>({ sessionId: 'session-a', workspacePersistence: memory.persistence })
    expect(await recovery.restore()).toMatchObject({ status: 'failed', error: { code: 'invalid_recovery' } })
    expect(recovery.schedule(state(0))).toBe(false)
    expect(memory.write).not.toHaveBeenCalled()
    recovery.dispose()
  })

  it('deduplicates concurrent restores and rejects their result after disposal', async () => {
    const memory = workspaceMemory()
    const read = deferred<ExcelWorkspaceState<Snapshot>>()
    memory.load.mockImplementation(() => read.promise)
    const recovery = createExcelWorkspacePersistence<Snapshot>({ sessionId: 'session-a', workspacePersistence: memory.persistence })
    const first = recovery.restore()
    const second = recovery.restore()
    expect(first).toBe(second)
    await Promise.resolve()
    expect(memory.load).toHaveBeenCalledTimes(1)
    recovery.dispose()
    read.resolve(state(7))
    expect(await first).toMatchObject({ status: 'failed', error: { code: 'persistence_disposed' } })
    expect(recovery.schedule(state(8))).toBe(false)
    expect(memory.write).not.toHaveBeenCalled()
  })

  it('coalesces pending checkpoints and serializes newer snapshots behind an in-flight write', async () => {
    const memory = workspaceMemory()
    const gate = deferred<void>()
    memory.write.mockImplementationOnce(() => gate.promise)
    const recovery = createExcelWorkspacePersistence<Snapshot>({ sessionId: 'session-a', workspacePersistence: memory.persistence })
    await recovery.restore()
    recovery.schedule(state(1))
    const firstFlush = recovery.flush()
    await Promise.resolve()
    expect(memory.write).toHaveBeenCalledTimes(1)
    recovery.schedule(state(2))
    recovery.schedule(state(3))
    const secondFlush = recovery.flush()
    expect(memory.write).toHaveBeenCalledTimes(1)
    gate.resolve()
    await Promise.all([firstFlush, secondFlush])
    expect(memory.write.mock.calls.map(([snapshot]) => snapshot)).toEqual([state(1), state(3)])
    expect(recovery.getSnapshot().pendingCount).toBe(0)
    recovery.dispose()
  })

  it('retains a failed latest checkpoint for an explicit retry', async () => {
    const memory = workspaceMemory()
    memory.write.mockRejectedValueOnce(new Error('write unavailable'))
    const recovery = createExcelWorkspacePersistence<Snapshot>({ sessionId: 'session-a', workspacePersistence: memory.persistence })
    await recovery.restore()
    recovery.schedule(state(4))
    await expect(recovery.flush()).rejects.toThrow('write unavailable')
    expect(recovery.getSnapshot()).toMatchObject({ status: 'error', pendingCount: 1, error: { message: 'write unavailable' } })
    await recovery.flush()
    expect(memory.write.mock.calls.map(([snapshot]) => snapshot)).toEqual([state(4), state(4)])
    expect(recovery.getSnapshot()).toMatchObject({ status: 'saved', pendingCount: 0, error: null })
    recovery.dispose()
  })

  it('flushes accepted checkpoints on disposal and rejects new ones', async () => {
    const memory = workspaceMemory()
    const written = deferred<void>()
    memory.write.mockImplementation(async () => { written.resolve() })
    const recovery = createExcelWorkspacePersistence<Snapshot>({ sessionId: 'session-a', workspacePersistence: memory.persistence })
    await recovery.restore()
    recovery.schedule(state(5))
    recovery.dispose()
    expect(recovery.schedule(state(6))).toBe(false)
    await written.promise
    expect(memory.write).toHaveBeenCalledWith(state(5))
  })

  it('awaits explicit workspace persistence and refuses it before restore or after disposal', async () => {
    const memory = workspaceMemory()
    const recovery = createExcelWorkspacePersistence<Snapshot>({ sessionId: 'session-a', workspacePersistence: memory.persistence })
    await expect(recovery.persist(state(1))).rejects.toMatchObject({ code: 'recovery_unavailable' })
    await recovery.restore()
    const gate = deferred<void>()
    memory.write.mockImplementationOnce(() => gate.promise)
    let settled = false
    const writing = recovery.persist(state(2)).then(() => { settled = true })
    await Promise.resolve()
    expect(memory.write).toHaveBeenCalledWith(state(2))
    expect(settled).toBe(false)
    gate.resolve()
    await writing
    expect(await memory.persistence.load()).toEqual(state(2))
    recovery.dispose()
    await expect(recovery.persist(state(3))).rejects.toMatchObject({ code: 'recovery_unavailable' })
  })
})

function sourceApi() {
  const saved: ExcelSaveResult = { ok: true, documentId: 'source-a', fileName: 'Workbook.xlsx', mtimeMs: 11 }
  return {
    save: mock(async (_request: Parameters<ExcelHostPreloadAPI['save']>[0]): Promise<ExcelSaveResult> => saved),
    saveAs: mock(async (_request: Parameters<ExcelHostPreloadAPI['saveAs']>[0]): Promise<ExcelSaveResult> => saved),
  }
}

describe('Excel explicit source persistence', () => {
  const tab = { documentId: 'source-a', fileName: 'Workbook.xlsx', mtimeMs: 10 }
  const bytes = new Uint8Array([1, 2, 3])

  it('waits for the real write receipt and keeps the existing mtime conflict check', async () => {
    const gate = deferred<ExcelSaveResult>()
    const api = sourceApi()
    api.save.mockImplementationOnce(() => gate.promise)
    let settled = false
    const writing = writeExcelWorkbookSource({
      api, tab, saveAs: false, conflictMessage: 'disk changed',
      prepare: async () => bytes, assertCurrent: () => undefined,
    }).then((result) => { settled = true; return result })
    await Promise.resolve()
    expect(api.save).toHaveBeenCalledWith({ documentId: 'source-a', bytes, expectedMtimeMs: 10 })
    expect(api.saveAs).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    gate.resolve({ ok: true, documentId: 'source-a', fileName: 'Workbook.xlsx', mtimeMs: 12 })
    expect(await writing).toMatchObject({ status: 'written', value: { mtimeMs: 12 } })
  })

  it('uses Save as for an unassociated blank workbook and preserves cancellation', async () => {
    const api = sourceApi()
    api.saveAs.mockResolvedValueOnce({ ok: false, reason: 'canceled' })
    const outcome = await writeExcelWorkbookSource({
      api, tab: { ...tab, documentId: null, mtimeMs: null }, saveAs: false, conflictMessage: 'disk changed',
      prepare: async () => bytes, assertCurrent: () => undefined,
    })
    expect(outcome).toEqual({ status: 'canceled' })
    expect(api.save).not.toHaveBeenCalled()
    expect(api.saveAs).toHaveBeenCalledWith({ bytes, suggestedName: 'Workbook.xlsx' })
  })

  it('keeps the source association captured before asynchronous encoding', async () => {
    const api = sourceApi()
    const encoded = deferred<Uint8Array>()
    const target = { ...tab }
    const writing = writeExcelWorkbookSource({
      api, tab: target, saveAs: false, conflictMessage: 'disk changed',
      prepare: () => encoded.promise, assertCurrent: () => undefined,
    })
    target.documentId = 'other-source'
    target.mtimeMs = 999
    encoded.resolve(bytes)
    expect((await writing).status).toBe('written')
    expect(api.save).toHaveBeenCalledWith({ documentId: 'source-a', bytes, expectedMtimeMs: 10 })
  })

  it('keeps source conflicts separate from successful or canceled saves', async () => {
    const api = sourceApi()
    api.save.mockResolvedValueOnce({ ok: false, reason: 'conflict' })
    expect(await writeExcelWorkbookSource({
      api, tab, saveAs: false, conflictMessage: 'disk changed',
      prepare: async () => bytes, assertCurrent: () => undefined,
    })).toEqual({ status: 'conflict', message: 'disk changed' })
    expect(api.saveAs).not.toHaveBeenCalled()
  })

  it('does not call either write API when simplified-copy confirmation is canceled', async () => {
    const api = sourceApi()
    expect(await writeExcelWorkbookSource({
      api, tab, saveAs: true, conflictMessage: 'disk changed',
      prepare: async () => null, assertCurrent: () => undefined,
    })).toEqual({ status: 'canceled' })
    expect(api.save).not.toHaveBeenCalled()
    expect(api.saveAs).not.toHaveBeenCalled()
  })

  it('preserves format rejection codes and refuses writes after the document becomes stale', async () => {
    const api = sourceApi()
    const rejected = await writeExcelWorkbookSource({
      api, tab, saveAs: false, conflictMessage: 'disk changed',
      prepare: async () => { throw new OfficeOperationError('unsupported_format', 'cannot reproduce objects') },
      assertCurrent: () => undefined,
    })
    expect(rejected).toEqual({ status: 'failed', error: { code: 'unsupported_format', message: 'cannot reproduce objects' } })
    const stale = await writeExcelWorkbookSource({
      api, tab, saveAs: false, conflictMessage: 'disk changed', prepare: async () => bytes,
      assertCurrent: () => { throw new OfficeOperationError('runtime_disposed', 'Session closed') },
    })
    expect(stale).toEqual({ status: 'failed', error: { code: 'runtime_disposed', message: 'Session closed' } })
    expect(api.save).not.toHaveBeenCalled()
    expect(api.saveAs).not.toHaveBeenCalled()
  })

  it('converts write errors to failed outcomes without mutating the existing source association', async () => {
    const api = sourceApi()
    api.save.mockRejectedValueOnce(new Error('disk full'))
    const existing = { ...tab }
    expect(await writeExcelWorkbookSource({
      api, tab: existing, saveAs: false, conflictMessage: 'disk changed', prepare: async () => bytes,
      assertCurrent: () => undefined,
    })).toEqual({ status: 'failed', error: { code: 'persistence_failed', message: 'disk full' } })
    expect(existing).toEqual(tab)
  })

  it('rejects an acknowledgement that arrives after its Session has closed', async () => {
    const api = sourceApi()
    const acknowledgement = deferred<ExcelSaveResult>()
    let current = true
    api.save.mockImplementationOnce(() => acknowledgement.promise)
    const writing = writeExcelWorkbookSource({
      api, tab, saveAs: false, conflictMessage: 'disk changed', prepare: async () => bytes,
      assertCurrent: () => {
        if (!current) throw new OfficeOperationError('runtime_disposed', 'Session closed')
      },
    })
    await Promise.resolve()
    expect(api.save).toHaveBeenCalledTimes(1)
    current = false
    acknowledgement.resolve({ ok: true, documentId: 'source-a', fileName: 'Workbook.xlsx', mtimeMs: 12 })
    expect(await writing).toEqual({ status: 'failed', error: { code: 'runtime_disposed', message: 'Session closed' } })
  })
})
