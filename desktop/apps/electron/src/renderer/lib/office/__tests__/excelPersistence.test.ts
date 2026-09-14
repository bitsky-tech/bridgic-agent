import { describe, expect, it, mock } from 'bun:test'
import type { ExcelHostPreloadAPI, ExcelSaveResult } from '../../../../shared/types'
import { createExcelRecoveryPersistence, writeExcelWorkbookSource, type ExcelRecoveryState } from '../excelPersistence'
import { OfficeOperationError } from '../officeWorkspaceRuntime'

type Snapshot = { id: string; value: number }

function state(value: number): ExcelRecoveryState<Snapshot> {
  return {
    version: 1,
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

function recoveryApi(stored: unknown = null) {
  return {
    getRecoveryState: mock(async (): Promise<unknown | null> => stored),
    setRecoveryState: mock(async (_state: unknown): Promise<void> => undefined),
  }
}

describe('Excel recovery persistence', () => {
  it('declares Session-memory recovery and writes the unchanged recovery schema without clearing source dirty', async () => {
    const api = recoveryApi()
    const recovery = createExcelRecoveryPersistence<Snapshot>({ sessionId: 'session-a', api })
    expect(recovery.getSnapshot().policy).toEqual({
      appKind: 'excel', sessionId: 'session-a', kind: 'recovery', storage: 'session-memory', automatic: true,
    })
    const snapshot = state(1)
    expect(recovery.schedule(snapshot)).toBe(false)
    expect(await recovery.restore()).toEqual({ status: 'empty' })
    expect(recovery.schedule(snapshot)).toBe(true)
    expect(api.setRecoveryState).not.toHaveBeenCalled()
    await recovery.flush()
    expect(api.setRecoveryState).toHaveBeenCalledWith(snapshot)
    expect(snapshot.tabs[0]!.dirty).toBe(true)
    expect(snapshot.tabs[0]!.documentId).toBeNull()
    expect(recovery.getSnapshot().status).toBe('saved')
    recovery.dispose()
  })

  it('does not overwrite an unreadable checkpoint and permits a later restore retry', async () => {
    const previous = state(9)
    const api = recoveryApi(previous)
    api.getRecoveryState.mockRejectedValueOnce(new Error('read unavailable'))
    const recovery = createExcelRecoveryPersistence<Snapshot>({ sessionId: 'session-a', api })
    expect(await recovery.restore()).toMatchObject({ status: 'failed', error: { message: 'read unavailable' } })
    expect(recovery.schedule(state(0))).toBe(false)
    await expect(recovery.flush()).rejects.toMatchObject({ code: 'recovery_unavailable' })
    expect(api.setRecoveryState).not.toHaveBeenCalled()
    expect(await recovery.restore()).toEqual({ status: 'restored', value: previous })
    expect(api.setRecoveryState).not.toHaveBeenCalled()
    recovery.schedule(state(10))
    await recovery.flush()
    expect(api.setRecoveryState).toHaveBeenCalledTimes(1)
    expect(api.setRecoveryState).toHaveBeenCalledWith(state(10))
    recovery.dispose()
  })

  it('treats malformed records as restoration failures instead of empty workspaces', async () => {
    const api = recoveryApi({ version: 3, tabs: [] })
    const recovery = createExcelRecoveryPersistence<Snapshot>({ sessionId: 'session-a', api })
    expect(await recovery.restore()).toMatchObject({ status: 'failed', error: { code: 'invalid_recovery' } })
    expect(recovery.schedule(state(0))).toBe(false)
    expect(api.setRecoveryState).not.toHaveBeenCalled()
    recovery.dispose()
  })

  it('deduplicates concurrent restores and rejects their result after disposal', async () => {
    const read = deferred<unknown>()
    const api = recoveryApi()
    api.getRecoveryState.mockImplementation(() => read.promise)
    const recovery = createExcelRecoveryPersistence<Snapshot>({ sessionId: 'session-a', api })
    const first = recovery.restore()
    const second = recovery.restore()
    expect(first).toBe(second)
    expect(api.getRecoveryState).toHaveBeenCalledTimes(1)
    recovery.dispose()
    read.resolve(state(7))
    expect(await first).toMatchObject({ status: 'failed', error: { code: 'persistence_disposed' } })
    expect(recovery.schedule(state(8))).toBe(false)
    expect(api.setRecoveryState).not.toHaveBeenCalled()
  })

  it('coalesces pending checkpoints and serializes newer snapshots behind an in-flight write', async () => {
    const gate = deferred<void>()
    const api = recoveryApi()
    api.setRecoveryState.mockImplementationOnce(() => gate.promise)
    const recovery = createExcelRecoveryPersistence<Snapshot>({ sessionId: 'session-a', api })
    await recovery.restore()
    recovery.schedule(state(1))
    const firstFlush = recovery.flush()
    await Promise.resolve()
    expect(api.setRecoveryState).toHaveBeenCalledTimes(1)
    recovery.schedule(state(2))
    recovery.schedule(state(3))
    const secondFlush = recovery.flush()
    expect(api.setRecoveryState).toHaveBeenCalledTimes(1)
    gate.resolve()
    await Promise.all([firstFlush, secondFlush])
    expect(api.setRecoveryState.mock.calls.map(([snapshot]) => snapshot)).toEqual([state(1), state(3)])
    expect(recovery.getSnapshot().pendingCount).toBe(0)
    recovery.dispose()
  })

  it('retains a failed latest checkpoint for an explicit retry', async () => {
    const api = recoveryApi()
    api.setRecoveryState.mockRejectedValueOnce(new Error('write unavailable'))
    const recovery = createExcelRecoveryPersistence<Snapshot>({ sessionId: 'session-a', api })
    await recovery.restore()
    recovery.schedule(state(4))
    await expect(recovery.flush()).rejects.toThrow('write unavailable')
    expect(recovery.getSnapshot()).toMatchObject({ status: 'error', pendingCount: 1, error: { message: 'write unavailable' } })
    await recovery.flush()
    expect(api.setRecoveryState.mock.calls.map(([snapshot]) => snapshot)).toEqual([state(4), state(4)])
    expect(recovery.getSnapshot()).toMatchObject({ status: 'saved', pendingCount: 0, error: null })
    recovery.dispose()
  })

  it('flushes accepted checkpoints on disposal and rejects new ones', async () => {
    const written = deferred<void>()
    const api = recoveryApi()
    api.setRecoveryState.mockImplementation(async () => { written.resolve() })
    const recovery = createExcelRecoveryPersistence<Snapshot>({ sessionId: 'session-a', api })
    await recovery.restore()
    recovery.schedule(state(5))
    recovery.dispose()
    expect(recovery.schedule(state(6))).toBe(false)
    await written.promise
    expect(api.setRecoveryState).toHaveBeenCalledWith(state(5))
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
