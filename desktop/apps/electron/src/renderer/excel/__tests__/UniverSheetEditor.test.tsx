import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { IWorkbookData } from '@univerjs/core'
import type { ExcelHostConfig } from '../../../shared/types'
import type { ExcelUniverAdapter, SheetEditorHandle } from '../excelUniverAdapter'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act, createRef } = await import('react')
const { createRoot } = await import('react-dom/client')
type MountOptions = Parameters<typeof import('../excelUniverAdapter')['mountExcelUniverAdapter']>[0]
const mounts: Array<{ options: MountOptions; adapter: ExcelUniverAdapter }> = []
let nativeSnapshot = { id: 'native-initial' } as IWorkbookData
let finalSnapshot: IWorkbookData | null = null
let flushFailure: Error | null = null

mock.module('../excelUniverAdapter', () => ({
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

afterEach(() => {
  mounts.length = 0
  nativeSnapshot = { id: 'native-initial' } as IWorkbookData
  finalSnapshot = null
  flushFailure = null
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
