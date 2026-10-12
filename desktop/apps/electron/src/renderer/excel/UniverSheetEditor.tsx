import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import type { IWorkbookData } from '@univerjs/core'
import type { ExcelHostConfig } from '../../shared/types'
import { OfficeOperationError } from '../lib/office/officeWorkspaceRuntime'
import type { ExcelViewState } from './ExcelRibbon'
import {
  mountExcelUniverAdapter,
  type ExcelUniverAdapter,
  type ExcelViewPreferences,
  type SheetEditorHandle,
  type SheetSelectionState,
} from './excelUniverAdapter'

export const UniverSheetEditor = forwardRef<SheetEditorHandle, {
  active?: boolean
  config: ExcelHostConfig
  documentId: string
  onActionFailure: (cause: unknown) => void
  onChange: (snapshot: IWorkbookData) => void
  onSelectionChange: (selection: SheetSelectionState) => void
  onViewStateChange: (state: ExcelViewState) => void
  snapshot: IWorkbookData
  viewPreferences: ExcelViewPreferences
}>(function UniverSheetEditor({ active = true, config, documentId, onActionFailure, onChange, onSelectionChange, onViewStateChange, snapshot, viewPreferences }, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const adapterRef = useRef<ExcelUniverAdapter | null>(null)
  const snapshotRef = useRef(snapshot)
  const viewPreferencesRef = useRef(viewPreferences)
  const configRef = useRef(config)
  const activeRef = useRef(active)
  const callbacksRef = useRef({ onActionFailure, onChange, onSelectionChange, onViewStateChange })

  useLayoutEffect(() => { configRef.current = config }, [config])
  useLayoutEffect(() => { snapshotRef.current = snapshot }, [snapshot])
  useLayoutEffect(() => { viewPreferencesRef.current = viewPreferences }, [viewPreferences])
  useLayoutEffect(() => { callbacksRef.current = { onActionFailure, onChange, onSelectionChange, onViewStateChange } }, [onActionFailure, onChange, onSelectionChange, onViewStateChange])
  useLayoutEffect(() => {
    activeRef.current = active
    adapterRef.current?.setActive(active)
  }, [active])
  useEffect(() => { adapterRef.current?.setTheme(config.theme) }, [config.theme])

  useImperativeHandle(ref, () => {
    const current = () => {
      const adapter = adapterRef.current
      if (!adapter) throw new OfficeOperationError('document_not_ready', 'The workbook editor is not ready.')
      if (!activeRef.current) throw new OfficeOperationError('document_not_ready', 'The workbook editor is not active.')
      return adapter
    }
    return {
      documentId,
      insertContext: (expandDataRegion) => current().insertContext(expandDataRegion),
      previewFormula: (sheetId, address, formula) => (activeRef.current ? adapterRef.current?.previewFormula(sheetId, address, formula) : undefined)
        ?? Promise.resolve({ errorCode: '#ERROR!' }),
      run: async (action, value) => current().run(action, value),
      selectRange: (address) => current().selectRange(address),
      setFormulaAt: (sheetId, address, formula) => current().setFormulaAt(sheetId, address, formula),
      setFormulaBarValue: (value) => current().setFormulaBarValue(value),
      flush: async () => {
        const adapter = adapterRef.current
        if (!adapter) throw new OfficeOperationError('document_not_ready', 'The workbook editor is not ready.')
        await adapter.flush()
      },
      snapshot: () => adapterRef.current?.snapshot() ?? snapshotRef.current,
    }
  }, [documentId])

  // Changing visibility retains the native unit and its undo history. A locale or
  // document replacement still disposes the old driver before mounting the next.
  useEffect(() => () => {
    const adapter = adapterRef.current
    if (!adapter) return
    try { adapter.dispose() } finally {
      if (adapterRef.current === adapter) adapterRef.current = null
    }
  }, [config.locale, documentId])

  useEffect(() => {
    if (!active || adapterRef.current) return
    const container = hostRef.current
    if (!container) return
    const adapter = mountExcelUniverAdapter({
      container,
      config: configRef.current,
      documentId,
      active: activeRef.current,
      snapshot: snapshotRef.current,
      viewPreferences: viewPreferencesRef.current,
      onActionFailure: (cause) => { if (activeRef.current) callbacksRef.current.onActionFailure(cause) },
      onChange: (current) => {
        snapshotRef.current = current
        callbacksRef.current.onChange(current)
      },
      onSelectionChange: (selection) => { if (activeRef.current) callbacksRef.current.onSelectionChange(selection) },
      onViewStateChange: (state) => { if (activeRef.current) callbacksRef.current.onViewStateChange(state) },
    })
    adapterRef.current = adapter
  }, [active, config.locale, documentId])

  return <div className="min-h-0 min-w-0 flex-1 overflow-hidden" ref={hostRef} data-testid="excel-univer-host" />
})
