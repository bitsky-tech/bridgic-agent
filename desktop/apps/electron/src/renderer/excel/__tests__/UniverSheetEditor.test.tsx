import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { DrawingTypeEnum, LocaleType, type IWorkbookData } from '@univerjs/core'
import type { ExcelHostConfig, ExcelHostPreloadAPI, ExcelHostRendererState, ExcelWorkbookOpenTicket } from '../../../shared/types'
import type { ExcelUniverAdapter, SheetEditorHandle } from '../excelUniverAdapter'

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
const { createEmptyWorkbook } = await import('../../lib/excelWorkbook')

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

async function mountHost(initialWorkbook: 'empty' | 'blank', recovery: string | null = null) {
  window.history.replaceState(null, '', `http://localhost/excel.html?sessionId=session&initialWorkbook=${initialWorkbook}`)
  let deliver!: (ticket: ExcelWorkbookOpenTicket) => void
  const reads: string[] = []
  const stateReports: ExcelHostRendererState[] = []
  let checkpoint: string | null = recovery
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
    getRecoveryState: async () => recovery,
    setRecoveryState: async (value) => { checkpoint = value },
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
    recovery: () => checkpoint === null ? null : JSON.parse(checkpoint) as { tabs: Array<{ tabId: string; documentId: string | null; snapshot: IWorkbookData; mtimeMs: number | null; dirty: boolean }>; activeTabId: string },
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

  it('automatically saves the managed workbook and retains failed edits until a successful retry', async () => {
    let checkpoint: string | null = null
    let fail = false
    const written: Uint8Array[] = []
    const source = { path: '/session/.work/Workbook.xlsx', mtimeMs: 42 }
    const confirm = mock(async () => 'discard' as const)
    window.officeFiles = {
      prepare: async () => source,
      inspect: async () => source,
      save: async (request) => {
        expect(request.managed).toBe(true)
        expect(request.documentId).toBeTruthy()
        expect(request.saveAs).toBe(false)
        if (fail) throw new Error('disk full')
        written.push(request.bytes)
        return { ok: true, source, fileName: 'Workbook.xlsx' }
      },
      confirmClose: confirm,
      getRecovery: async () => checkpoint,
      setRecovery: async (_kind, _id, value) => { checkpoint = value },
    }
    nativeSnapshot = createEmptyWorkbook(LocaleType.EN_US, 'New workbook')
    const app = await mountHost('blank')
    try {
      await waitFor(() => mounts.length > 0)
      await act(async () => { await window.__bridgicExcel!.flush() })
      expect(written).toHaveLength(1)
      expect(window.__bridgicExcel!.workspace.getSnapshot().documents[0]?.dirty).toBe(false)
      fail = true
      nativeSnapshot = createEmptyWorkbook(LocaleType.EN_US, 'Retained edit')
      await act(async () => mounts.at(-1)!.options.onChange(nativeSnapshot))
      await act(async () => { await expect(window.__bridgicExcel!.flush()).rejects.toThrow('disk full') })
      await act(async () => { await window.__bridgicExcel!.close() })
      expect(confirm).not.toHaveBeenCalled()
      expect(window.__bridgicExcel!.workspace.getSnapshot().documents).toHaveLength(1)
      expect(window.__bridgicExcel!.workspace.getSnapshot().documents[0]?.dirty).toBe(true)
      fail = false
      await act(async () => { await window.__bridgicExcel!.flush() })
      expect(written).toHaveLength(2)
      expect(window.__bridgicExcel!.workspace.getSnapshot().documents[0]?.dirty).toBe(false)
      expect(app.host.textContent).not.toContain('Save as')
    } finally { await app.close() }
  })

  it('reuses the latest edited workbook when the reopen request already contains stale file bytes', async () => {
    const importing = spyOn(workbookImport, 'importExcelWorkbook').mockResolvedValue(createEmptyWorkbook(LocaleType.EN_US, 'Old file'))
    let mtimeMs = 42
    let checkpoint: string | null = null
    const source = () => ({ path: '/session/.work/Report.xlsx', mtimeMs })
    const savedNames: string[] = []
    const workbook = await import('../../lib/excelWorkbook')
    window.officeFiles = {
      prepare: async () => source(), inspect: async () => source(), readBase64: async () => 'AQ==',
      save: async (request) => {
        const written = await workbook.importXlsx(request.bytes, LocaleType.EN_US)
        savedNames.push(written.name ?? '')
        mtimeMs++
        return { ok: true, source: source(), fileName: 'Report.xlsx' }
      },
      confirmClose: async () => 'cancel', getRecovery: async () => checkpoint,
      setRecovery: async (_kind, _id, value) => { checkpoint = value },
    }
    const app = await mountHost('empty')
    const read = app.api.openRequestedWorkbook
    app.api.openRequestedWorkbook = async (id) => {
      const result = await read(id)
      if (!result.canceled) result.document.source = { path: '/external/Report.xlsx', mtimeMs: 42 }
      return result
    }
    try {
      await app.open('first')
      await waitFor(() => mounts.length > 0)
      const edited = createEmptyWorkbook(LocaleType.EN_US, 'Edited workbook')
      const sheetId = edited.sheetOrder![0]!
      const sheet = edited.sheets![sheetId]!
      sheet.cellData = { 0: { 0: { v: 'Retained A1' } } }
      nativeSnapshot = edited
      await act(async () => mounts.at(-1)!.options.onChange(edited))
      await app.open('reopen-before-autosave')
      await waitFor(() => app.reads.length === 2 && mtimeMs === 43)
      await act(async () => { await window.__bridgicExcel!.flush() })
      expect(importing).toHaveBeenCalledTimes(1)
      expect(app.host.querySelectorAll('[data-testid="excel-document-tab"]')).toHaveLength(1)
      expect(JSON.parse(checkpoint!).tabs[0].snapshot.sheets[sheetId].cellData[0][0].v).toBe('Retained A1')
      expect(savedNames).toHaveLength(1)
    } finally { await app.close(); importing.mockRestore() }
  })

  it('keeps an unencodable image dirty without overwriting the file or closing its tab', async () => {
    const source = { path: '/session/.work/Workbook.xlsx', mtimeMs: 42 }
    const save = mock(async () => ({ ok: true as const, source, fileName: 'Workbook.xlsx' }))
    window.officeFiles = {
      prepare: async () => source, inspect: async () => source, save,
      confirmClose: async () => 'cancel', getRecovery: async () => null, setRecovery: async () => undefined,
    }
    nativeSnapshot = createEmptyWorkbook(LocaleType.EN_US, 'Workbook')
    const app = await mountHost('blank')
    try {
      await waitFor(() => mounts.length > 0)
      await act(async () => { await window.__bridgicExcel!.flush() })
      expect(save).toHaveBeenCalledTimes(1)
      nativeSnapshot = structuredClone(nativeSnapshot)
      nativeSnapshot.resources = [{ name: 'SHEET_DRAWING_PLUGIN', data: JSON.stringify({
        [nativeSnapshot.sheetOrder[0]!]: { image: {
          drawingType: DrawingTypeEnum.DRAWING_IMAGE, source: 'data:image/tiff;base64,AAAA',
          sheetTransform: { from: { row: 0, column: 0 }, to: { row: 1, column: 1 } },
        } },
      }) }]
      await act(async () => mounts.at(-1)!.options.onChange(nativeSnapshot))
      await act(async () => { await expect(window.__bridgicExcel!.flush()).rejects.toThrow('Use an embedded') })
      await act(async () => { await window.__bridgicExcel!.close() })
      expect(save).toHaveBeenCalledTimes(1)
      expect(window.__bridgicExcel!.workspace.getSnapshot().documents).toHaveLength(1)
      expect(window.__bridgicExcel!.workspace.getSnapshot().documents[0]?.dirty).toBe(true)
    } finally { await app.close() }
  })

  it('background saving preserves active cell input and foreground flush still commits it', async () => {
    let checkpoint: string | null = null
    let saved!: () => void
    const automaticWrite = new Promise<void>((resolve) => { saved = resolve })
    let writes = 0
    const source = { path: '/session/.work/Workbook.xlsx', mtimeMs: 42 }
    window.officeFiles = {
      prepare: async () => source, inspect: async () => source,
      save: async () => { writes++; saved(); return { ok: true, source, fileName: 'Workbook.xlsx' } },
      confirmClose: async () => 'cancel', getRecovery: async () => checkpoint,
      setRecovery: async (_kind, _id, value) => { checkpoint = value },
    }
    const app = await mountHost('blank')
    try {
      await waitFor(() => mounts.length > 0)
      const editor = mounts.at(-1)!
      let forcedCommits = 0
      editor.adapter.flush = mock(async () => { forcedCommits++ })
      await act(async () => { await automaticWrite })
      expect(writes).toBe(1)
      expect(forcedCommits).toBe(0)
      expect(app.host.querySelector('input[name="value"]')?.hasAttribute('disabled')).toBe(false)
      await act(async () => { await window.__bridgicExcel!.flush() })
      expect(forcedCommits).toBeGreaterThan(0)
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
    const app = await mountHost('empty', JSON.stringify({
      version: 1, activeTabId: 'draft', nextWorkbookOrdinal: 2,
      tabs: [{ tabId: 'draft', documentId: null, fileName: 'Draft.xlsx', snapshot: createEmptyWorkbook(LocaleType.EN_US, 'Draft'), mtimeMs: null, dirty: true, changeVersion: 1, revision: 0 }],
    }))
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
  it('creates a new workbook after the previously closed workspace checkpoint is empty', async () => {
    const app = await mountHost('blank', JSON.stringify({ version: 1, tabs: [], activeTabId: null, nextWorkbookOrdinal: 2 }))
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
          getRecovery: async () => null,
          setRecovery: async () => undefined,
        }
        app.api.save = mock(async () => ({ ok: false as const, reason: 'canceled' as const }))
        nativeSnapshot = createEmptyWorkbook(LocaleType.EN_US, 'Report')
        await act(async () => (app.host.querySelectorAll('[data-testid="excel-close-document"]')[0] as HTMLButtonElement).click())
        await waitFor(() => (window.officeFiles!.confirmClose as ReturnType<typeof mock>).mock.calls.length === 1)
        await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
        expect(app.host.querySelectorAll('[data-testid="excel-document-tab"]')).toHaveLength(decision === 'discard' ? 1 : 2)
        if (decision === 'save') expect(app.api.save).toHaveBeenCalledTimes(1)
      } finally { await app.close(); importing.mockRestore() }
    })
  }
})
