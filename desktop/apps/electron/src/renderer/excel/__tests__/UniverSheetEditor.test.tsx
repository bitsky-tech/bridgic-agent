import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DrawingTypeEnum, LocaleType, type IWorkbookData } from '@univerjs/core'
import type { ExcelHostConfig, ExcelHostPreloadAPI, ExcelHostRendererState, ExcelWorkbookOpenTicket } from '../../../shared/types'
import type { ExcelUniverAdapter, SheetEditorHandle } from '../excelUniverAdapter'
import type { OfficeFileSaveRequest } from '../../../shared/office-files'
import type { ExcelWorkspaceState } from '../../lib/office/excelPersistence'
import { inspectOfficeFile } from '../../../main/office-files'
import { createOfficeWorkspaceFiles } from '../../../main/office-workspace-files'

GlobalRegistrator.register({ url: 'http://localhost/' })
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act, createRef, StrictMode } = await import('react')
const { createRoot } = await import('react-dom/client')
type MountOptions = Parameters<typeof import('../excelUniverAdapter')['mountExcelUniverAdapter']>[0]
const mounts: Array<{ options: MountOptions; adapter: ExcelUniverAdapter }> = []
let nativeSnapshot = { id: 'native-initial' } as IWorkbookData
let finalSnapshot: IWorkbookData | null = null
let flushFailure: Error | null = null

mock.module('../excelUniverAdapter', () => ({
  univerLocale: (config: ExcelHostConfig) => config.locale === 'zh-CN' ? LocaleType.ZH_CN : LocaleType.EN_US,
  mountExcelUniverAdapter(options: MountOptions): ExcelUniverAdapter {
    const adapter: ExcelUniverAdapter = {
      documentId: options.documentId,
      dispose: mock(() => { if (finalSnapshot) options.onChange(finalSnapshot) }),
      flush: mock(async () => { if (flushFailure) throw flushFailure }),
      snapshot: () => nativeSnapshot,
      setTheme: mock(() => undefined),
      insertContext: () => null,
      previewFormula: async () => ({ value: '1' }),
      run: mock(async () => undefined),
      selectRange: () => undefined,
      setFormulaAt: () => undefined,
      setFormulaBarValue: () => undefined,
    }
    mounts.push({ options, adapter })
    return adapter
  },
}))
const { UniverSheetEditor } = await import('../UniverSheetEditor')
const { ExcelHostApp } = await import('../ExcelHostApp')
const workbookImport = await import('../../lib/excelWorkbookImport')
const { COMPATIBILITY_CUSTOM_KEY, createEmptyWorkbook, exportXlsx, importXlsx } = await import('../../lib/excelWorkbook')
const { i18n } = await import('../../lib/i18n')

function fakeIndexedDb() {
  const records = new Map<IDBValidKey, unknown>()
  let hasStore = false
  let writeFailure: Error | null = null
  const database = {
    close: () => undefined,
    createObjectStore: () => { hasStore = true },
    objectStoreNames: { contains: () => hasStore },
    onversionchange: null,
    transaction: (store: string) => {
      expect(store).toBe('workbooks')
      const transaction = {
        error: null as Error | null,
        onabort: null as (() => void) | null,
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        objectStore: () => ({
          get: (key: IDBValidKey) => {
            const request = { error: null, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null, result: undefined as unknown }
            queueMicrotask(() => {
              request.result = records.has(key) ? structuredClone(records.get(key)) : undefined
              request.onsuccess?.()
            })
            return request
          },
          put: (value: unknown, key: IDBValidKey) => {
            const saved = structuredClone(value)
            queueMicrotask(() => {
              if (writeFailure) {
                transaction.error = writeFailure
                transaction.onabort?.()
                return
              }
              records.set(key, saved)
              transaction.oncomplete?.()
            })
          },
        }),
      }
      return transaction
    },
  }
  const factory = {
    open: (name: string) => {
      expect(name).toBe('bridgic-excel-workbench-v1')
      const request = { error: null, onerror: null as (() => void) | null, onsuccess: null as (() => void) | null, onupgradeneeded: null as (() => void) | null, result: database }
      queueMicrotask(() => {
        if (!hasStore) request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    },
  }
  return { records, factory: factory as unknown as IDBFactory, failWrites: (error: Error | null) => { writeFailure = error } }
}

const originalIndexedDb = Object.getOwnPropertyDescriptor(window, 'indexedDB')
let indexed: ReturnType<typeof fakeIndexedDb>
beforeEach(() => {
  indexed = fakeIndexedDb()
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: indexed.factory })
})
afterAll(() => {
  if (originalIndexedDb) Object.defineProperty(window, 'indexedDB', originalIndexedDb)
  else delete (window as { indexedDB?: IDBFactory }).indexedDB
})

afterEach(() => {
  mounts.length = 0
  nativeSnapshot = { id: 'native-initial' } as IWorkbookData
  finalSnapshot = null
  flushFailure = null
  delete window.officeFiles
})

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
  }
  expect(check()).toBe(true)
}

async function mountHost(initialWorkbook: 'empty' | 'blank', workspace: ExcelWorkspaceState<IWorkbookData> | null = null) {
  if (workspace) indexed.records.set('session', structuredClone(workspace))
  window.history.replaceState(null, '', `http://localhost/excel.html?sessionId=session&initialWorkbook=${initialWorkbook}`)
  let deliver!: (ticket: ExcelWorkbookOpenTicket) => void
  const reads: string[] = []
  const stateReports: ExcelHostRendererState[] = []
  const api: ExcelHostPreloadAPI = {
    open: async () => ({ canceled: true }),
    openRequestedWorkbook: async (requestId) => {
      reads.push(requestId)
      return { canceled: false, document: {
        documentId: requestId.startsWith('other') ? 'other-file' : 'report-file',
        fileName: 'Report.xlsx', bytes: new Uint8Array([1]), mtimeMs: 42,
      } }
    },
    save: async () => ({ ok: false, reason: 'canceled' }),
    saveAs: async () => ({ ok: false, reason: 'canceled' }),
    requestClose: async () => undefined,
    reportState: async (state) => { stateReports.push(state) },
    onConfigChanged: () => () => undefined,
    onWorkbookOpenRequested: (callback) => { deliver = callback; return () => undefined },
  }
  window.excelHostApi = api
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<StrictMode><ExcelHostApp /></StrictMode>))
  return {
    api, host, reads, stateReports,
    recovery: () => indexed.records.get('session') as ExcelWorkspaceState<IWorkbookData> | undefined,
    open: async (requestId: string) => { await act(async () => deliver({ requestId, replaceInitialBlank: true })) },
    close: async () => {
      await act(async () => root.unmount())
      host.remove()
      delete window.excelHostApi
      window.history.replaceState(null, '', 'http://localhost/')
    },
  }
}

describe('Excel routed workbook imports', () => {
  it('reports the authoritative empty and populated workbook inventory to the shell', async () => {
    const app = await mountHost('empty')
    try {
      await waitFor(() => app.stateReports.at(-1)?.documentCount === 0)
      await act(async () => app.host.querySelector<HTMLButtonElement>('[data-testid="excel-create-workbook"]')!.click())
      await waitFor(() => app.stateReports.at(-1)?.documentCount === 1)
      expect(app.stateReports.at(-1)).toEqual({ documentCount: 1, dirty: true })
    } finally {
      await app.close()
    }
  })

  it('loads without a blank workbook, imports repeated requests once and reactivates edited tabs by file identity', async () => {
    let finish!: (snapshot: IWorkbookData) => void
    const importing = spyOn(workbookImport, 'importExcelWorkbook')
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockImplementation(async () => createEmptyWorkbook(LocaleType.EN_US, 'Report'))
    const app = await mountHost('empty')
    try {
      await app.open('first')
      await app.open('second')
      expect(app.host.querySelectorAll('[data-testid="excel-document-tab"]')).toHaveLength(0)
      expect(mounts).toHaveLength(0)
      await act(async () => finish(createEmptyWorkbook(LocaleType.EN_US, 'Report')))
      await waitFor(() => app.reads.length === 2)
      expect(importing).toHaveBeenCalledTimes(1)
      expect(app.host.querySelectorAll('[data-testid="excel-document-tab"]')).toHaveLength(1)

      await act(async () => mounts.at(-1)!.options.onChange(createEmptyWorkbook(LocaleType.EN_US, 'User edits')))
      await app.open('other-path-same-name')
      await waitFor(() => app.host.querySelectorAll('[data-testid="excel-document-tab"]').length === 2)
      await app.open('repeat-after-other-file')
      await waitFor(() => app.host.querySelectorAll('[data-testid="excel-document-tab"]')[0]?.getAttribute('aria-selected') === 'true')
      expect(importing).toHaveBeenCalledTimes(2)
      expect(app.host.querySelectorAll('[data-testid="excel-document-tab"]')).toHaveLength(2)
      expect(mounts.at(-1)!.options.snapshot.name).toBe('User edits')
      expect(app.host.querySelector('[data-testid="excel-document-tab"] [aria-label]')).not.toBeNull()
    } finally {
      await app.close()
      importing.mockRestore()
    }
  })

  it('allows retry after a failed import without leaving a blank or duplicate tab', async () => {
    const importing = spyOn(workbookImport, 'importExcelWorkbook')
      .mockRejectedValueOnce(new Error('Broken workbook'))
      .mockResolvedValue(createEmptyWorkbook(LocaleType.EN_US, 'Report'))
    const app = await mountHost('empty')
    try {
      await app.open('failure')
      await waitFor(() => app.host.textContent!.includes('Broken workbook'))
      expect(app.host.querySelector('[data-testid="excel-launch-empty-state"]')).not.toBeNull()
      expect(app.host.querySelectorAll('[data-testid="excel-document-tab"]')).toHaveLength(0)
      await app.open('retry')
      await waitFor(() => app.host.querySelectorAll('[data-testid="excel-document-tab"]').length === 1)
      expect(importing).toHaveBeenCalledTimes(2)
    } finally {
      await app.close()
      importing.mockRestore()
    }
  })

  it('refreshes a changed clean source in place and rejects the replaced editor final snapshot', async () => {
    const importing = spyOn(workbookImport, 'importExcelWorkbook')
      .mockResolvedValueOnce(createEmptyWorkbook(LocaleType.EN_US, 'Original'))
      .mockResolvedValue(createEmptyWorkbook(LocaleType.EN_US, 'External update'))
    const app = await mountHost('empty')
    try {
      await app.open('first')
      await waitFor(() => mounts.length > 0)
      const original = mounts.at(-1)!
      const read = app.api.openRequestedWorkbook
      app.api.openRequestedWorkbook = async (id) => {
        const result = await read(id)
        if (!result.canceled) result.document.mtimeMs = 99
        return result
      }
      original.adapter.dispose = mock(() => original.options.onChange(createEmptyWorkbook(LocaleType.EN_US, 'Stale native snapshot')))
      await app.open('updated')
      await waitFor(() => mounts.at(-1)!.options.snapshot.name === 'External update')
      expect(app.host.querySelectorAll('[data-testid="excel-document-tab"]')).toHaveLength(1)
      expect(mounts.at(-1)!.options.documentId).toBe(original.options.documentId)
      await waitFor(() => app.recovery()?.tabs[0]?.mtimeMs === 99)
      expect(app.recovery()!.tabs[0]).toMatchObject({ dirty: false, snapshot: { name: 'External update' } })
      await app.open('unchanged-again')
      expect(importing).toHaveBeenCalledTimes(2)
    } finally {
      await app.close()
      importing.mockRestore()
    }
  })

  it('commits the pending cell before deciding whether an external update can replace the draft', async () => {
    const importing = spyOn(workbookImport, 'importExcelWorkbook').mockResolvedValue(createEmptyWorkbook(LocaleType.EN_US, 'Original'))
    const app = await mountHost('empty')
    try {
      await app.open('first')
      await waitFor(() => mounts.length > 0)
      const mounted = mounts.at(-1)!
      const draft = createEmptyWorkbook(LocaleType.EN_US, 'Pending cell edit')
      mounted.adapter.flush = mock(async () => { mounted.options.onChange(draft) })
      const read = app.api.openRequestedWorkbook
      app.api.openRequestedWorkbook = async (id) => {
        const result = await read(id)
        if (!result.canceled) result.document.mtimeMs = 99
        return result
      }
      await app.open('external-update')
      await waitFor(() => app.host.querySelector('[role="alert"]') !== null)
      expect(importing).toHaveBeenCalledTimes(1)
      expect(app.host.querySelectorAll('[data-testid="excel-document-tab"]')).toHaveLength(1)
      await waitFor(() => app.recovery()?.tabs[0]?.dirty === true)
      expect(app.recovery()!.tabs[0]).toMatchObject({ mtimeMs: 42, snapshot: { name: 'Pending cell edit' } })
    } finally {
      await app.close()
      importing.mockRestore()
    }
  })

  it('preserves edits accepted while a changed workbook is being parsed', async () => {
    let finish!: (snapshot: IWorkbookData) => void
    const importing = spyOn(workbookImport, 'importExcelWorkbook')
      .mockResolvedValueOnce(createEmptyWorkbook(LocaleType.EN_US, 'Original'))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const app = await mountHost('empty')
    try {
      await app.open('first')
      await waitFor(() => mounts.length > 0)
      const read = app.api.openRequestedWorkbook
      app.api.openRequestedWorkbook = async (id) => {
        const result = await read(id)
        if (!result.canceled) result.document.mtimeMs = 99
        return result
      }
      await app.open('external-update')
      await waitFor(() => importing.mock.calls.length === 2)
      await act(async () => mounts.at(-1)!.options.onChange(createEmptyWorkbook(LocaleType.EN_US, 'Typed during import')))
      await act(async () => finish(createEmptyWorkbook(LocaleType.EN_US, 'External update')))
      await waitFor(() => app.host.querySelector('[role="alert"]') !== null)
      await waitFor(() => app.recovery()?.tabs[0]?.snapshot.name === 'Typed during import')
      expect(app.recovery()!.tabs[0]).toMatchObject({ dirty: true, mtimeMs: 42 })
    } finally {
      await app.close()
      importing.mockRestore()
    }
  })

  it.each([false, true])('reconciles an overwritten open workbook and preserves its unsaved edits: %s', async (dirty) => {
    const importing = spyOn(workbookImport, 'importExcelWorkbook')
      .mockResolvedValueOnce(createEmptyWorkbook(LocaleType.EN_US, 'Original A'))
      .mockResolvedValue(createEmptyWorkbook(LocaleType.EN_US, 'Saved B'))
    const app = await mountHost('empty')
    try {
      await app.open('first')
      await waitFor(() => mounts.length > 0)
      if (dirty) await act(async () => mounts.at(-1)!.options.onChange(createEmptyWorkbook(LocaleType.EN_US, 'Unsaved A')))
      await app.open('other-file')
      await waitFor(() => app.host.querySelectorAll('[data-testid="excel-document-tab"]').length === 2)
      const savedTabId = mounts.at(-1)!.options.documentId
      nativeSnapshot = createEmptyWorkbook(LocaleType.EN_US, 'Saved B')
      app.api.saveAs = mock(async () => ({ ok: true as const, documentId: 'report-file', fileName: 'Report.xlsx', mtimeMs: 99 }))
      await act(async () => { await window.__bridgicExcel!.dispatch({ type: 'document.saveAs' }) })
      await waitFor(() => app.recovery()?.tabs.some((tab) => tab.tabId === savedTabId && tab.mtimeMs === 99) === true)
      expect(app.recovery()!.tabs.filter((tab) => tab.documentId === 'report-file')).toHaveLength(1)
      expect(app.recovery()!.tabs).toHaveLength(dirty ? 2 : 1)
      if (dirty) {
        const retained = app.recovery()!.tabs.find((tab) => tab.tabId !== savedTabId)!
        expect(retained).toMatchObject({ documentId: null, mtimeMs: null, dirty: true, snapshot: { name: 'Unsaved A' } })
        expect(app.host.textContent).toContain('unsaved edits')
        expect(Array.from(app.host.querySelectorAll('[role="status"]')).some((element) => element.textContent?.includes('different file'))).toBe(true)
        const draftTab = app.host.querySelector<HTMLButtonElement>('[data-testid="excel-document-tab"]')!
        await act(async () => draftTab.click())
        await waitFor(() => mounts.at(-1)!.options.documentId === retained.tabId)
        nativeSnapshot = createEmptyWorkbook(LocaleType.EN_US, 'Unsaved A')
        const save = mock(async () => ({ ok: false as const, reason: 'canceled' as const }))
        const saveAs = mock(async () => ({ ok: false as const, reason: 'canceled' as const }))
        app.api.save = save
        app.api.saveAs = saveAs
        await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true })))
        await waitFor(() => saveAs.mock.calls.length === 1)
        expect(save).not.toHaveBeenCalled()
      }
      const read = app.api.openRequestedWorkbook
      app.api.openRequestedWorkbook = async (id) => {
        const result = await read(id)
        if (!result.canceled) result.document.mtimeMs = 99
        return result
      }
      await app.open('reopen-saved-file')
      await waitFor(() => mounts.at(-1)!.options.documentId === savedTabId)
      expect(importing).toHaveBeenCalledTimes(2)
      expect(mounts.at(-1)!.options.snapshot.name).toBe('Saved B')
    } finally {
      await app.close()
      importing.mockRestore()
    }
  })

  it('checkpoints edits, creation, activation and flush without exporting XLSX files', async () => {
    const source = { path: '/session/Workbook.xlsx', mtimeMs: 42 }
    const save = mock(async () => ({ ok: true as const, source, fileName: 'Workbook.xlsx' }))
    window.officeFiles = {
      prepare: async () => source, inspect: async () => source, save,
      confirmClose: async () => 'cancel',
    }
    const app = await mountHost('blank')
    try {
      await waitFor(() => mounts.length > 0)
      const edited = createEmptyWorkbook(LocaleType.EN_US, 'Retained edit')
      await act(async () => mounts.at(-1)!.options.onChange(edited))
      await act(async () => app.host.querySelector<HTMLButtonElement>('[data-testid="excel-new-document"]')!.click())
      await waitFor(() => app.host.querySelectorAll('[data-testid="excel-document-tab"]').length === 2)
      await act(async () => app.host.querySelector<HTMLButtonElement>('[data-testid="excel-document-tab"]')!.click())
      await act(async () => { await window.__bridgicExcel!.flush() })
      expect(app.recovery()).toMatchObject({ schemaVersion: 1, tabs: [{ dirty: true, snapshot: { name: 'Retained edit' } }, { dirty: true }] })
      expect(window.__bridgicExcel!.workspace.getSnapshot().documents[0]?.dirty).toBe(true)
      expect(save).not.toHaveBeenCalled()
      await waitFor(() => Array.from(app.host.querySelectorAll('[role="status"]')).some((element) => element.textContent === i18n.t('office.saved')))
    } finally { await app.close() }
  })

  it('reuses one canonical edited workbook across repeated imports and renderer recreation', async () => {
    const imported = createEmptyWorkbook(LocaleType.EN_US, 'Original')
    imported.custom = { [COMPATIBILITY_CUSTOM_KEY]: ['unsupported extension'] }
    const importing = spyOn(workbookImport, 'importExcelWorkbook').mockResolvedValue(imported)
    const original = { path: '/session/Report.xlsx', mtimeMs: 42 }
    const save = mock(async () => ({ ok: true as const, source: original, fileName: 'Report.xlsx' }))
    window.officeFiles = {
      prepare: async () => original, inspect: async () => original, readBase64: async () => 'AQ==', save,
      confirmClose: async () => 'cancel',
    }
    const addSource = (app: Awaited<ReturnType<typeof mountHost>>) => {
      const read = app.api.openRequestedWorkbook
      app.api.openRequestedWorkbook = async (id) => {
        const result = await read(id)
        if (!result.canceled) result.document.source = { path: '/external/Report.xlsx', mtimeMs: 42 }
        return result
      }
    }
    let app = await mountHost('empty')
    addSource(app)
    try {
      await app.open('first')
      await waitFor(() => mounts.length > 0)
      const stableTabId = mounts.at(-1)!.options.documentId
      const edited = { ...imported, name: 'Retained edit' }
      const sheetId = edited.sheetOrder[0]!
      edited.sheets[sheetId]!.cellData = { 0: { 0: { v: 'Retained A1' } } }
      nativeSnapshot = edited
      await act(async () => mounts.at(-1)!.options.onChange(edited))
      await app.open('repeat-one')
      await app.open('repeat-two')
      await waitFor(() => app.reads.length === 3)
      await act(async () => { await window.__bridgicExcel!.flush() })
      expect(importing).toHaveBeenCalledTimes(1)
      expect(app.host.querySelectorAll('[data-testid="excel-document-tab"]')).toHaveLength(1)
      expect(app.recovery()!.tabs[0]).toMatchObject({ tabId: stableTabId, source: original, snapshot: { name: 'Retained edit' }, dirty: true })
      expect(app.recovery()!.tabs[0]!.snapshot.sheets[sheetId]!.cellData![0]![0]!.v).toBe('Retained A1')
      expect(save).not.toHaveBeenCalled()

      await app.close()
      app = await mountHost('empty')
      addSource(app)
      await waitFor(() => mounts.at(-1)!.options.snapshot.name === 'Retained edit')
      await app.open('repeat-after-reload')
      await waitFor(() => app.reads.length === 1)
      await act(async () => { await window.__bridgicExcel!.flush() })
      expect(mounts.at(-1)!.options.documentId).toBe(stableTabId)
      expect(importing).toHaveBeenCalledTimes(1)
      expect(app.host.querySelectorAll('[data-testid="excel-document-tab"]')).toHaveLength(1)
      expect(app.recovery()!.tabs[0]!.snapshot.name).toBe('Retained edit')
      expect(save).not.toHaveBeenCalled()
    } finally { await app.close(); importing.mockRestore() }
  })

  it('exports only explicitly and keeps the tab identity when Save as returns the same destination', async () => {
    const importing = spyOn(workbookImport, 'importExcelWorkbook').mockResolvedValue(createEmptyWorkbook(LocaleType.EN_US, 'Report'))
    let mtimeMs = 42
    const source = () => ({ path: '/session/Report.xlsx', mtimeMs })
    const save = mock(async (_request: OfficeFileSaveRequest) => {
      mtimeMs += 1
      return { ok: true as const, source: source(), fileName: 'Report.xlsx' }
    })
    window.officeFiles = {
      prepare: async () => source(), inspect: async () => source(), readBase64: async () => 'AQ==', save,
      confirmClose: async () => 'cancel',
    }
    const app = await mountHost('empty')
    const read = app.api.openRequestedWorkbook
    app.api.openRequestedWorkbook = async (id) => {
      const result = await read(id)
      if (!result.canceled) result.document.source = source()
      return result
    }
    try {
      await app.open('first')
      await waitFor(() => mounts.length > 0)
      const stableTabId = mounts.at(-1)!.options.documentId
      nativeSnapshot = createEmptyWorkbook(LocaleType.EN_US, 'Edited workbook')
      await act(async () => mounts.at(-1)!.options.onChange(nativeSnapshot))
      await act(async () => { expect(await window.__bridgicExcel!.dispatch({ type: 'document.save' })).toMatchObject({ ok: true }) })
      expect(save).toHaveBeenCalledTimes(1)
      expect(save.mock.calls[0]![0]).toMatchObject({ documentId: stableTabId, saveAs: false, source: { path: '/session/Report.xlsx' } })
      await act(async () => { expect(await window.__bridgicExcel!.dispatch({ type: 'document.saveAs', destination: '/session/Report.xlsx' })).toMatchObject({ ok: true }) })
      await act(async () => { await window.__bridgicExcel!.flush() })
      expect(save).toHaveBeenCalledTimes(2)
      expect(app.recovery()!.tabs).toHaveLength(1)
      expect(app.recovery()!.tabs[0]).toMatchObject({ tabId: stableTabId, source: source(), dirty: false })
      await app.open('reopen-exported')
      await waitFor(() => app.reads.length === 2)
      expect(importing).toHaveBeenCalledTimes(1)
      expect(mounts.at(-1)!.options.documentId).toBe(stableTabId)
    } finally { await app.close(); importing.mockRestore() }
  })

  it.each([
    { label: 'dirty supported workbook', protectedSource: false, editBeforeExport: true },
    { label: 'dirty protected workbook', protectedSource: true, editBeforeExport: true },
    { label: 'clean supported workbook', protectedSource: false, editBeforeExport: false },
  ])('retries a failed managed Save as registration for $label into its copy and keeps later ordinary saves there', async ({ protectedSource, editBeforeExport }) => {
    const root = await mkdtemp(join(tmpdir(), 'excel-managed-save-as-retry-'))
    const work = join(root, '.work')
    await mkdir(work)
    nativeSnapshot = createEmptyWorkbook(LocaleType.EN_US, 'Report')
    if (protectedSource) nativeSnapshot.custom = { [COMPATIBILITY_CUSTOM_KEY]: ['unsupported extension'] }
    const sheetId = nativeSnapshot.sheetOrder[0]!
    nativeSnapshot.sheets[sheetId]!.cellData = { 0: { 0: { v: 'Original A1' } } }
    const originalPath = join(work, 'Report.xlsx')
    const originalBytes = await exportXlsx(nativeSnapshot, { allowLossy: protectedSource })
    await writeFile(originalPath, originalBytes)
    const original = await inspectOfficeFile('excel', originalPath)
    const registrations: string[] = []
    const files = createOfficeWorkspaceFiles(async (_endpoint, body) => {
      if (!body) return [{ id: 'work', name: '.work', kind: 'folder', removable: false, path: work, exists: true }]
      const path = (body as { path: string }).path
      registrations.push(path)
      if (registrations.length === 1) throw new Error('Session registration unavailable')
      return { id: basename(path), name: basename(path), kind: 'file', path, exists: true }
    }, () => undefined)
    const save = mock((request: OfficeFileSaveRequest) => files.save('session', request))
    window.officeFiles = {
      prepare: (kind, path) => files.prepare('session', kind, path),
      inspect: inspectOfficeFile,
      readBase64: async (_kind, path) => (await readFile(path)).toString('base64'),
      save,
      confirmClose: async () => 'cancel',
    }
    const workspace: ExcelWorkspaceState<IWorkbookData> = { schemaVersion: 1, tabs: [{
      tabId: 'stable-tab', documentId: original.path, source: original, fileName: 'Report.xlsx',
      snapshot: nativeSnapshot, mtimeMs: original.mtimeMs, dirty: false, changeVersion: 0, revision: 0,
    }], activeTabId: 'stable-tab', nextWorkbookOrdinal: 2 }
    const confirm = spyOn(window, 'confirm').mockReturnValue(true)
    const app = await mountHost('empty', workspace)
    try {
      await waitFor(() => mounts.length > 0)
      if (editBeforeExport) {
        nativeSnapshot = structuredClone(nativeSnapshot)
        nativeSnapshot.sheets[sheetId]!.cellData![0]![0]!.v = 'Exported A1'
        await act(async () => mounts.at(-1)!.options.onChange(nativeSnapshot))
      }
      await act(async () => {
        expect(await window.__bridgicExcel!.dispatch({ type: 'document.saveAs' })).toMatchObject({
          ok: false, error: { message: expect.stringContaining('Session registration unavailable') },
        })
      })
      const copyPath = join(dirname(original.path), 'Report (2).xlsx')
      const exportedWorkbook = await importXlsx(new Uint8Array(await readFile(copyPath)), LocaleType.EN_US)
      expect(exportedWorkbook.sheets[exportedWorkbook.sheetOrder[0]!]!.cellData![0]![0]!.v).toBe(editBeforeExport ? 'Exported A1' : 'Original A1')
      expect(await readdir(work)).toHaveLength(2)
      expect(new Uint8Array(await readFile(original.path))).toEqual(new Uint8Array(originalBytes))
      expect(window.__bridgicExcel!.workspace.getSnapshot().documents[0]?.dirty).toBe(editBeforeExport)
      await act(async () => { await window.__bridgicExcel!.flush() })
      expect(app.recovery()!.tabs[0]!.snapshot.custom?.[COMPATIBILITY_CUSTOM_KEY]).toEqual(protectedSource ? ['unsupported extension'] : undefined)
      await waitFor(() => app.host.querySelector('[data-testid="excel-document-header"] [role="alert"] + button') !== null)
      await act(async () => {
        const retry = app.host.querySelector<HTMLButtonElement>('[data-testid="excel-document-header"] [role="alert"] + button')!
        retry.click()
        retry.click()
      })
      await act(async () => { await window.__bridgicExcel!.flush() })
      expect(save).toHaveBeenCalledTimes(2)
      expect(save.mock.calls[1]![0]).toMatchObject({ saveAs: true, preserveSource: protectedSource, source: original })
      expect(registrations).toEqual([copyPath, copyPath])
      expect(app.recovery()!.tabs[0]).toMatchObject({ tabId: 'stable-tab', documentId: copyPath, source: { path: copyPath }, dirty: false })
      expect(app.recovery()!.tabs[0]!.snapshot.custom?.[COMPATIBILITY_CUSTOM_KEY]).toBeUndefined()
      expect(app.host.querySelector('[data-testid="excel-document-header"] [role="alert"]')).toBeNull()
      expect(new Uint8Array(await readFile(original.path))).toEqual(new Uint8Array(originalBytes))
      expect(await readdir(work)).toHaveLength(2)

      nativeSnapshot = structuredClone(nativeSnapshot)
      nativeSnapshot.sheets[sheetId]!.cellData![0]![0]!.v = 'Later copy edit'
      await act(async () => mounts.at(-1)!.options.onChange(nativeSnapshot))
      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true })))
      await act(async () => { await window.__bridgicExcel!.flush() })
      expect(save).toHaveBeenCalledTimes(3)
      expect(save.mock.calls[2]![0]).toMatchObject({ saveAs: false, source: { path: copyPath } })
      const copiedWorkbook = await importXlsx(new Uint8Array(await readFile(copyPath)), LocaleType.EN_US)
      expect(copiedWorkbook.sheets[copiedWorkbook.sheetOrder[0]!]!.cellData![0]![0]!.v).toBe('Later copy edit')
      expect(app.recovery()!.tabs[0]).toMatchObject({ tabId: 'stable-tab', documentId: copyPath, source: { path: copyPath }, dirty: false })
      expect(new Uint8Array(await readFile(original.path))).toEqual(new Uint8Array(originalBytes))
      expect(await readdir(work)).toHaveLength(2)
    } finally { await app.close(); confirm.mockRestore(); await rm(root, { recursive: true, force: true }) }
  })

  for (const modifier of ['ctrlKey', 'metaKey'] as const) {
    it(`writes a separate managed workbook with ${modifier} Shift S and saves later edits into that copy`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'excel-managed-save-as-'))
      const work = join(root, '.work')
      await mkdir(work)
      nativeSnapshot = createEmptyWorkbook(LocaleType.EN_US, 'Report')
      const originalPath = join(work, 'Report.xlsx')
      const originalBytes = await exportXlsx(nativeSnapshot)
      await writeFile(originalPath, originalBytes)
      const original = await inspectOfficeFile('excel', originalPath)
      const files = createOfficeWorkspaceFiles(async (_endpoint, body) => {
        if (!body) return [{ id: 'work', name: '.work', kind: 'folder', removable: false, path: work, exists: true }]
        const path = (body as { path: string }).path
        return { id: basename(path), name: basename(path), kind: 'file', path, exists: true }
      }, () => undefined)
      window.officeFiles = {
        prepare: (kind, path) => files.prepare('session', kind, path),
        inspect: inspectOfficeFile,
        readBase64: async (_kind, path) => (await readFile(path)).toString('base64'),
        save: (request) => files.save('session', request),
        confirmClose: async () => 'cancel',
      }
      const workspace: ExcelWorkspaceState<IWorkbookData> = { schemaVersion: 1, tabs: [{
        tabId: 'stable-tab', documentId: original.path, source: original, fileName: 'Report.xlsx',
        snapshot: nativeSnapshot, mtimeMs: original.mtimeMs, dirty: false, changeVersion: 0, revision: 0,
      }], activeTabId: 'stable-tab', nextWorkbookOrdinal: 2 }
      const app = await mountHost('empty', workspace)
      try {
        await waitFor(() => mounts.length > 0)
        // Save as must create a different file even for a clean workbook.
        await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', [modifier]: true, shiftKey: true })))
        await act(async () => { await window.__bridgicExcel!.flush() })
        const copy = app.recovery()!.tabs[0]!.source!
        expect(copy.path).not.toBe(original.path)
        expect(await readdir(work)).toHaveLength(2)
        expect(new Uint8Array(await readFile(original.path))).toEqual(new Uint8Array(originalBytes))
        expect(app.recovery()!.tabs[0]).toMatchObject({ tabId: 'stable-tab', dirty: false, documentId: copy.path })

        nativeSnapshot = structuredClone(nativeSnapshot)
        const sheetId = nativeSnapshot.sheetOrder[0]!
        nativeSnapshot.sheets[sheetId]!.cellData = { 0: { 0: { v: 'Edited copy' } } }
        await act(async () => mounts.at(-1)!.options.onChange(nativeSnapshot))
        await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', [modifier]: true })))
        await act(async () => { await window.__bridgicExcel!.flush() })
        const copiedWorkbook = await importXlsx(new Uint8Array(await readFile(copy.path)), LocaleType.EN_US)
        expect(copiedWorkbook.sheets[copiedWorkbook.sheetOrder[0]!]!.cellData![0]![0]!.v).toBe('Edited copy')
        expect(new Uint8Array(await readFile(original.path))).toEqual(new Uint8Array(originalBytes))
        expect(await readdir(work)).toHaveLength(2)

        app.api.openRequestedWorkbook = async () => ({ canceled: false, document: {
          documentId: copy.path, fileName: basename(copy.path), bytes: new Uint8Array(await readFile(copy.path)),
          source: await inspectOfficeFile('excel', copy.path), mtimeMs: (await inspectOfficeFile('excel', copy.path)).mtimeMs!,
        } })
        await app.open('reopen-managed-copy')
        await act(async () => { await window.__bridgicExcel!.flush() })
        expect(app.recovery()!.tabs).toHaveLength(1)
        expect(app.recovery()!.activeTabId).toBe('stable-tab')

        await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', [modifier]: true, shiftKey: true })))
        await act(async () => { await window.__bridgicExcel!.flush() })
        expect(await readdir(work)).toHaveLength(3)
        expect(app.recovery()!.tabs[0]!.source!.path).not.toBe(copy.path)
        expect(app.recovery()!.tabs[0]).toMatchObject({ tabId: 'stable-tab', dirty: false })
      } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
    })

    it(`exports an incompatible workbook with ${modifier} Shift S and saves subsequent native edits without replacing its editor`, async () => {
      const original = { path: '/session/Original.xlsx', mtimeMs: 42 }
      const exported = { path: '/session/Original (2).xlsx', mtimeMs: 44 }
      nativeSnapshot = createEmptyWorkbook(LocaleType.EN_US, 'Original')
      nativeSnapshot.custom = { [COMPATIBILITY_CUSTOM_KEY]: ['unsupported extension'] }
      const save = mock(async (_request: OfficeFileSaveRequest) => ({ ok: true as const, source: exported, fileName: 'Original (2).xlsx' }))
      const confirm = spyOn(window, 'confirm').mockReturnValue(true)
      const workspace: ExcelWorkspaceState<IWorkbookData> = { schemaVersion: 1, tabs: [{
        tabId: 'stable-tab', documentId: original.path, source: original, fileName: 'Original.xlsx',
        snapshot: nativeSnapshot, mtimeMs: 42, dirty: true, changeVersion: 1, revision: 0,
      }], activeTabId: 'stable-tab', nextWorkbookOrdinal: 2 }
      window.officeFiles = {
        prepare: async () => original, inspect: async () => original, save,
        confirmClose: async () => 'cancel',
      }
      const app = await mountHost('empty', workspace)
      try {
        await waitFor(() => mounts.length > 0)
        const mounted = mounts.at(-1)!
        const mountCount = mounts.length
        await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', [modifier]: true, shiftKey: true })))
        await waitFor(() => save.mock.calls.length === 1)
        await act(async () => { await window.__bridgicExcel!.flush() })
        expect(save.mock.calls[0]![0]).toMatchObject({ saveAs: true, preserveSource: true, source: original })
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(app.recovery()!.tabs[0]!.snapshot.custom?.[COMPATIBILITY_CUSTOM_KEY]).toBeUndefined()
        expect(mounts.length).toBe(mountCount)
        nativeSnapshot = { ...nativeSnapshot, name: 'Edited exported copy' }
        await act(async () => mounted.options.onChange(nativeSnapshot))
        await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', [modifier]: true })))
        await waitFor(() => save.mock.calls.length === 2)
        await act(async () => { await window.__bridgicExcel!.flush() })
        expect(save.mock.calls[1]![0]).toMatchObject({ saveAs: false, preserveSource: false, source: exported })
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(app.recovery()!.tabs[0]).toMatchObject({ tabId: 'stable-tab', dirty: false, snapshot: { name: 'Edited exported copy' } })
        expect(app.recovery()!.tabs[0]!.snapshot.custom?.[COMPATIBILITY_CUSTOM_KEY]).toBeUndefined()
        expect(mounts.length).toBe(mountCount)
      } finally { await app.close(); confirm.mockRestore() }
    })
  }

  it('keeps importer warnings and the original source when keyboard Save as is canceled', async () => {
    const original = { path: '/session/Original.xlsx', mtimeMs: 42 }
    nativeSnapshot = createEmptyWorkbook(LocaleType.EN_US, 'Original')
    nativeSnapshot.custom = { [COMPATIBILITY_CUSTOM_KEY]: ['unsupported extension'] }
    const save = mock(async (_request: OfficeFileSaveRequest) => ({ ok: true as const, source: original, fileName: 'Original.xlsx' }))
    const confirm = spyOn(window, 'confirm').mockReturnValue(false)
    const workspace: ExcelWorkspaceState<IWorkbookData> = { schemaVersion: 1, tabs: [{
      tabId: 'stable-tab', documentId: original.path, source: original, fileName: 'Original.xlsx',
      snapshot: nativeSnapshot, mtimeMs: 42, dirty: true, changeVersion: 1, revision: 0,
    }], activeTabId: 'stable-tab', nextWorkbookOrdinal: 2 }
    window.officeFiles = {
      prepare: async () => original, inspect: async () => original, save,
      confirmClose: async () => 'cancel',
    }
    const app = await mountHost('empty', workspace)
    try {
      await waitFor(() => mounts.length > 0)
      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, shiftKey: true })))
      await waitFor(() => confirm.mock.calls.length === 1)
      await act(async () => { await window.__bridgicExcel!.flush() })
      expect(save).not.toHaveBeenCalled()
      expect(app.recovery()!.tabs[0]).toMatchObject({ source: original, dirty: true })
      expect(app.recovery()!.tabs[0]!.snapshot.custom?.[COMPATIBILITY_CUSTOM_KEY]).toEqual(['unsupported extension'])
      await act(async () => { expect(await window.__bridgicExcel!.dispatch({ type: 'document.save' })).toMatchObject({ ok: false, error: { code: 'unsupported_format' } }) })
      expect(save).not.toHaveBeenCalled()
    } finally { await app.close(); confirm.mockRestore() }
  })

  it('acknowledges a lossy export without discarding native edits made while its file write is pending', async () => {
    const original = { path: '/session/Original.xlsx', mtimeMs: 42 }
    const exported = { path: '/session/Original (2).xlsx', mtimeMs: 44 }
    nativeSnapshot = createEmptyWorkbook(LocaleType.EN_US, 'Original')
    nativeSnapshot.custom = { [COMPATIBILITY_CUSTOM_KEY]: ['unsupported extension'] }
    let finishExport!: () => void
    const pendingExport = new Promise<void>((resolve) => { finishExport = resolve })
    const save = mock(async (_request: OfficeFileSaveRequest) => {
      if (save.mock.calls.length === 1) await pendingExport
      return { ok: true as const, source: exported, fileName: 'Original (2).xlsx' }
    })
    const confirm = spyOn(window, 'confirm').mockReturnValue(true)
    const workspace: ExcelWorkspaceState<IWorkbookData> = { schemaVersion: 1, tabs: [{
      tabId: 'stable-tab', documentId: original.path, source: original, fileName: 'Original.xlsx',
      snapshot: nativeSnapshot, mtimeMs: 42, dirty: true, changeVersion: 1, revision: 0,
    }], activeTabId: 'stable-tab', nextWorkbookOrdinal: 2 }
    window.officeFiles = {
      prepare: async () => original, inspect: async () => original, save,
      confirmClose: async () => 'cancel',
    }
    const app = await mountHost('empty', workspace)
    try {
      await waitFor(() => mounts.length > 0)
      const mounted = mounts.at(-1)!
      const mountCount = mounts.length
      const exporting = window.__bridgicExcel!.dispatch({ type: 'document.saveAs' })
      await waitFor(() => save.mock.calls.length === 1)
      nativeSnapshot = structuredClone(nativeSnapshot)
      nativeSnapshot.name = 'Edited during export'
      const sheetId = nativeSnapshot.sheetOrder[0]!
      nativeSnapshot.sheets[sheetId]!.cellData = { 0: { 0: { v: 'Newer A1' } } }
      await act(async () => mounted.options.onChange(nativeSnapshot))
      await act(async () => { finishExport(); expect(await exporting).toMatchObject({ ok: false, error: { code: 'save_incomplete' } }) })
      expect(app.recovery()!.tabs[0]).toMatchObject({ dirty: true, snapshot: { name: 'Edited during export' } })
      expect(app.recovery()!.tabs[0]!.snapshot.sheets[sheetId]!.cellData![0]![0]!.v).toBe('Newer A1')
      expect(app.recovery()!.tabs[0]!.snapshot.custom?.[COMPATIBILITY_CUSTOM_KEY]).toBeUndefined()
      await act(async () => { expect(await window.__bridgicExcel!.dispatch({ type: 'document.save' })).toMatchObject({ ok: true }) })
      expect(save).toHaveBeenCalledTimes(2)
      expect(save.mock.calls[1]![0]).toMatchObject({ saveAs: false, preserveSource: false, source: exported })
      const saved = await importXlsx(save.mock.calls[1]![0].bytes, LocaleType.EN_US)
      expect(saved.sheets[saved.sheetOrder[0]!]!.cellData![0]![0]!.v).toBe('Newer A1')
      expect(app.recovery()!.tabs[0]).toMatchObject({ dirty: false, snapshot: { name: 'Edited during export' } })
      expect(mounts.length).toBe(mountCount)
    } finally { finishExport(); await app.close(); confirm.mockRestore() }
  })

  it('retains failed explicit exports and retries without coupling workspace flush to file writes', async () => {
    const source = { path: '/session/Workbook.xlsx', mtimeMs: 42 }
    const save = mock(async (_request: OfficeFileSaveRequest) => ({ ok: true as const, source, fileName: 'Workbook.xlsx' }))
      .mockRejectedValueOnce(new Error('disk full'))
    window.officeFiles = {
      prepare: async () => source, inspect: async () => source, save,
      confirmClose: async () => 'cancel',
    }
    const app = await mountHost('blank')
    try {
      await waitFor(() => mounts.length > 0)
      nativeSnapshot = createEmptyWorkbook(LocaleType.EN_US, 'Retained after export failure')
      await act(async () => mounts.at(-1)!.options.onChange(nativeSnapshot))
      await act(async () => { expect(await window.__bridgicExcel!.dispatch({ type: 'document.save' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('disk full') } }) })
      await act(async () => { await window.__bridgicExcel!.flush() })
      expect(save).toHaveBeenCalledTimes(1)
      expect(app.recovery()!.tabs[0]).toMatchObject({ dirty: true, snapshot: { name: 'Retained after export failure' } })
      await act(async () => { expect(await window.__bridgicExcel!.dispatch({ type: 'document.save' })).toMatchObject({ ok: true }) })
      expect(save).toHaveBeenCalledTimes(2)
      expect(app.recovery()!.tabs[0]!.dirty).toBe(false)
    } finally { await app.close() }
  })

  it('retries storage after a successful XLSX export without retaining a file export error or writing the file twice', async () => {
    const source = { path: '/session/Workbook.xlsx', mtimeMs: 42 }
    const save = mock(async () => ({ ok: true as const, source, fileName: 'Workbook.xlsx' }))
    window.officeFiles = {
      prepare: async () => source, inspect: async () => source, save,
      confirmClose: async () => 'cancel',
    }
    const app = await mountHost('blank')
    try {
      await waitFor(() => mounts.length > 0)
      await act(async () => { await window.__bridgicExcel!.flush() })
      nativeSnapshot = createEmptyWorkbook(LocaleType.EN_US, 'Exported workbook')
      await act(async () => mounts.at(-1)!.options.onChange(nativeSnapshot))
      indexed.failWrites(new Error('workspace disk full'))
      await act(async () => {
        expect(await window.__bridgicExcel!.dispatch({ type: 'document.save' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('workspace disk full') } })
      })
      expect(save).toHaveBeenCalledTimes(1)
      expect(window.__bridgicExcel!.workspace.getSnapshot().documents[0]?.dirty).toBe(false)
      indexed.failWrites(null)
      await act(async () => { await window.__bridgicExcel!.flush() })
      await waitFor(() => app.host.querySelector('[data-testid="excel-document-header"] [role="status"]')?.textContent === i18n.t('office.saved'))
      expect(app.host.querySelector('[data-testid="excel-document-header"] [role="alert"]')).toBeNull()
      expect(app.recovery()!.tabs[0]).toMatchObject({ source, dirty: false, snapshot: { name: 'Exported workbook' } })
      expect(save).toHaveBeenCalledTimes(1)
    } finally { indexed.failWrites(null); await app.close() }
  })

  it('checkpoints an unencodable image but retains its tab when explicit XLSX export fails', async () => {
    const source = { path: '/session/Workbook.xlsx', mtimeMs: 42 }
    const save = mock(async () => ({ ok: true as const, source, fileName: 'Workbook.xlsx' }))
    window.officeFiles = {
      prepare: async () => source, inspect: async () => source, save,
      confirmClose: async () => 'save',
    }
    nativeSnapshot = createEmptyWorkbook(LocaleType.EN_US, 'Workbook')
    const app = await mountHost('blank')
    try {
      await waitFor(() => mounts.length > 0)
      nativeSnapshot.resources = [{ name: 'SHEET_DRAWING_PLUGIN', data: JSON.stringify({
        [nativeSnapshot.sheetOrder[0]!]: { image: {
          drawingType: DrawingTypeEnum.DRAWING_IMAGE, source: 'data:image/tiff;base64,AAAA',
          sheetTransform: { from: { row: 0, column: 0 }, to: { row: 1, column: 1 } },
        } },
      }) }]
      await act(async () => mounts.at(-1)!.options.onChange(nativeSnapshot))
      await act(async () => { await window.__bridgicExcel!.flush() })
      expect(app.recovery()!.tabs[0]!.snapshot.resources).toEqual(nativeSnapshot.resources)
      await act(async () => { expect(await window.__bridgicExcel!.dispatch({ type: 'document.save' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('Use an embedded') } }) })
      await act(async () => { await window.__bridgicExcel!.close() })
      expect(save).not.toHaveBeenCalled()
      expect(window.__bridgicExcel!.workspace.getSnapshot().documents).toHaveLength(1)
      expect(window.__bridgicExcel!.workspace.getSnapshot().documents[0]?.dirty).toBe(true)
    } finally { await app.close() }
  })

  it('background workspace checkpoints preserve active cell input and foreground flush commits it', async () => {
    const app = await mountHost('blank')
    try {
      await waitFor(() => mounts.length > 0)
      const editor = mounts.at(-1)!
      let forcedCommits = 0
      editor.adapter.flush = mock(async () => { forcedCommits++ })
      const edited = createEmptyWorkbook(LocaleType.EN_US, 'Accepted cell edit')
      await act(async () => editor.options.onChange(edited))
      await waitFor(() => app.recovery()?.tabs[0]?.snapshot.name === 'Accepted cell edit')
      expect(forcedCommits).toBe(0)
      expect(app.host.querySelector('input[name="value"]')?.hasAttribute('disabled')).toBe(false)
      await act(async () => { await window.__bridgicExcel!.flush() })
      expect(forcedCommits).toBeGreaterThan(0)
      expect(app.recovery()!.tabs[0]!.dirty).toBe(true)
    } finally { await app.close() }
  })

  it('flushes a pending structured checkpoint on pagehide without exporting a workbook', async () => {
    const source = { path: '/session/Workbook.xlsx', mtimeMs: 42 }
    const save = mock(async () => ({ ok: true as const, source, fileName: 'Workbook.xlsx' }))
    window.officeFiles = {
      prepare: async () => source, inspect: async () => source, save,
      confirmClose: async () => 'cancel',
    }
    const app = await mountHost('blank')
    try {
      await waitFor(() => mounts.length > 0)
      await act(async () => { await window.__bridgicExcel!.flush() })
      const latest = createEmptyWorkbook(LocaleType.EN_US, 'Edit accepted just before reload')
      await act(async () => mounts.at(-1)!.options.onChange(latest))
      expect(app.recovery()!.tabs[0]!.snapshot.name).not.toBe(latest.name)
      await act(async () => window.dispatchEvent(new Event('pagehide')))
      await waitFor(() => app.recovery()?.tabs[0]?.snapshot.name === latest.name)
      expect(app.recovery()!.tabs[0]!.dirty).toBe(true)
      expect(save).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it('still creates a workbook for an explicit new-workbook launch', async () => {
    const app = await mountHost('blank')
    try {
      expect(app.host.querySelectorAll('[data-testid="excel-document-tab"]')).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  it('preserves a recovered edited workbook while opening another file', async () => {
    const importing = spyOn(workbookImport, 'importExcelWorkbook').mockResolvedValue(createEmptyWorkbook(LocaleType.EN_US, 'Report'))
    const app = await mountHost('empty', {
      schemaVersion: 1, activeTabId: 'draft', nextWorkbookOrdinal: 2,
      tabs: [{ tabId: 'draft', documentId: null, fileName: 'Draft.xlsx', snapshot: createEmptyWorkbook(LocaleType.EN_US, 'Draft'), mtimeMs: null, dirty: true, changeVersion: 1, revision: 0 }],
    })
    try {
      await app.open('report')
      await waitFor(() => app.host.querySelectorAll('[data-testid="excel-document-tab"]').length === 2)
      expect(app.host.querySelector('[data-testid="excel-document-tab"]')?.textContent).toBe('Draft.xlsx')
    } finally {
      await app.close()
      importing.mockRestore()
    }
  })
})
afterAll(async () => { await GlobalRegistrator.unregister() })

describe('Excel native editor React lifecycle', () => {
  it('keeps the mounted native driver and handle during snapshot and theme updates', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const ref = createRef<SheetEditorHandle>()
    const onChange = mock(() => undefined)
    const onActionFailure = mock(() => undefined)
    const onSelectionChange = mock(() => undefined)
    const onViewStateChange = mock(() => undefined)
    const config: ExcelHostConfig = { sessionId: 'session', locale: 'en-US', theme: 'light' }
    const props = { config, documentId: 'blank-tab', snapshot: nativeSnapshot, viewPreferences: { highlightMode: 'none' as const }, onChange, onActionFailure, onSelectionChange, onViewStateChange }
    try {
      await act(async () => root.render(<UniverSheetEditor {...props} ref={ref} />))
      const handle = ref.current
      nativeSnapshot = { id: 'native-current' } as IWorkbookData
      await act(async () => root.render(<UniverSheetEditor {...props} config={{ ...config, theme: 'dark' }} snapshot={{ id: 'workspace-checkpoint' } as IWorkbookData} ref={ref} />))
      expect(mounts.length).toBe(1)
      expect(mounts[0]!.adapter.dispose).not.toHaveBeenCalled()
      expect(mounts[0]!.adapter.setTheme).toHaveBeenCalledWith('dark')
      expect(ref.current).toBe(handle)
      expect(ref.current!.snapshot()).toBe(nativeSnapshot)
      await ref.current!.run('undo')
      expect(mounts[0]!.adapter.run).toHaveBeenCalledWith('undo', undefined)
      flushFailure = new Error('Native commit rejected')
      await expect(ref.current!.flush()).rejects.toThrow('Native commit rejected')
      expect(mounts.length).toBe(1)
      flushFailure = null
      await ref.current!.flush()
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
    expect(mounts[0]!.adapter.dispose).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('passes the final accepted native snapshot to a replacement locale driver before mounting it', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const onChange = mock(() => undefined)
    const onActionFailure = mock(() => undefined)
    const onSelectionChange = mock(() => undefined)
    const onViewStateChange = mock(() => undefined)
    const config: ExcelHostConfig = { sessionId: 'session', locale: 'en-US', theme: 'light' }
    const props = { config, documentId: 'tab-id', snapshot: nativeSnapshot, viewPreferences: { highlightMode: 'none' as const }, onChange, onActionFailure, onSelectionChange, onViewStateChange }
    try {
      await act(async () => root.render(<UniverSheetEditor {...props} />))
      finalSnapshot = { id: 'last-native-edit' } as IWorkbookData
      await act(async () => root.render(<UniverSheetEditor {...props} config={{ ...config, locale: 'zh-CN' }} />))
      expect(mounts.length).toBe(2)
      expect(mounts[0]!.adapter.dispose).toHaveBeenCalledTimes(1)
      expect(mounts[1]!.options.snapshot).toBe(finalSnapshot)
      expect(mounts[1]!.options.config.locale).toBe('zh-CN')
      expect(mounts[1]!.options.documentId).toBe('tab-id')
      expect(onChange).toHaveBeenCalledWith(finalSnapshot)
    } finally {
      finalSnapshot = null
      await act(async () => root.unmount())
      host.remove()
    }
  })
})


describe('Excel close protection', () => {
  for (const closeTarget of ['last-tab', 'workspace'] as const) {
    it(`retains live tabs and their checkpoint when storage fails while closing ${closeTarget}`, async () => {
      const source = { path: '/session/Workbook.xlsx', mtimeMs: 42 }
      const save = mock(async () => ({ ok: true as const, source, fileName: 'Workbook.xlsx' }))
      window.officeFiles = {
        prepare: async () => source, inspect: async () => source, save,
        confirmClose: async () => 'discard',
      }
      const app = await mountHost('blank')
      const requestClose = mock(async () => undefined)
      app.api.requestClose = requestClose
      try {
        await waitFor(() => mounts.length > 0)
        const edited = createEmptyWorkbook(LocaleType.EN_US, 'Draft kept on failed close')
        await act(async () => mounts.at(-1)!.options.onChange(edited))
        await act(async () => { await window.__bridgicExcel!.flush() })
        const originalTabId = app.recovery()!.tabs[0]!.tabId
        indexed.failWrites(new Error('workspace disk full'))
        if (closeTarget === 'last-tab') {
          await act(async () => app.host.querySelector<HTMLButtonElement>('[data-testid="excel-close-document"]')!.click())
        } else {
          await act(async () => { await window.__bridgicExcel!.close() })
        }
        await waitFor(() => app.host.textContent?.includes('workspace disk full') === true)
        expect(app.host.querySelectorAll('[data-testid="excel-document-tab"]')).toHaveLength(1)
        expect(window.__bridgicExcel!.workspace.getSnapshot().documents[0]).toMatchObject({ id: originalTabId, dirty: true })
        expect(app.recovery()!.tabs[0]).toMatchObject({ tabId: originalTabId, snapshot: { name: 'Draft kept on failed close' } })
        expect(requestClose).not.toHaveBeenCalled()
        expect(save).not.toHaveBeenCalled()
        const showsSaved = () => Array.from(app.host.querySelectorAll('[data-testid="excel-document-header"] [role="status"]'))
          .some((element) => element.textContent === i18n.t('office.saved'))
        expect(showsSaved()).toBe(false)
        indexed.failWrites(null)
        await act(async () => { await window.__bridgicExcel!.flush() })
        expect(app.recovery()!.tabs).toHaveLength(1)
        expect(app.recovery()!.tabs[0]!.tabId).toBe(originalTabId)
        await waitFor(showsSaved)
      } finally { indexed.failWrites(null); await app.close() }
    })
  }

  it('creates a new workbook after the previously closed workspace checkpoint is empty', async () => {
    const app = await mountHost('blank', { schemaVersion: 1, tabs: [], activeTabId: null, nextWorkbookOrdinal: 2 })
    try {
      await waitFor(() => app.host.querySelectorAll('[data-testid="excel-document-tab"]').length === 1)
      expect(app.host.querySelector('[data-testid="excel-document-tab"] [aria-label]')).not.toBeNull()
    } finally { await app.close() }
  })
  for (const decision of ['cancel', 'save', 'discard'] as const) {
    it(`handles ${decision} when closing an edited workbook tab`, async () => {
      const importing = spyOn(workbookImport, 'importExcelWorkbook').mockResolvedValue(createEmptyWorkbook(LocaleType.EN_US, 'Report'))
      const app = await mountHost('empty')
      try {
        await app.open('first')
        await waitFor(() => mounts.length > 0)
        await act(async () => mounts.at(-1)!.options.onChange(createEmptyWorkbook(LocaleType.EN_US, 'Unsaved input')))
        await app.open('other-second')
        await waitFor(() => app.host.querySelectorAll('[data-testid="excel-document-tab"]').length === 2)
        window.officeFiles = {
          confirmClose: mock(async () => decision),
          inspect: async (_kind, path) => ({ path, mtimeMs: 42 }),
          save: async () => ({ ok: false, reason: 'canceled' }),
        }
        app.api.save = mock(async () => ({ ok: false as const, reason: 'canceled' as const }))
        nativeSnapshot = createEmptyWorkbook(LocaleType.EN_US, 'Report')
        await act(async () => (app.host.querySelectorAll('[data-testid="excel-close-document"]')[0] as HTMLButtonElement).click())
        await waitFor(() => (window.officeFiles!.confirmClose as ReturnType<typeof mock>).mock.calls.length === 1)
        if (decision === 'discard') await waitFor(() => app.host.querySelectorAll('[data-testid="excel-document-tab"]').length === 1)
        else await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
        expect(app.host.querySelectorAll('[data-testid="excel-document-tab"]')).toHaveLength(decision === 'discard' ? 1 : 2)
        if (decision === 'save') expect(app.api.save).toHaveBeenCalledTimes(1)
      } finally { await app.close(); importing.mockRestore() }
    })
  }
})
