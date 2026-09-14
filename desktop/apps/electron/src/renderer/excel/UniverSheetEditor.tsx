import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
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
  config: ExcelHostConfig
  documentId: string
  onActionFailure: (cause: unknown) => void
  onChange: (snapshot: IWorkbookData) => void
  onSelectionChange: (selection: SheetSelectionState) => void
  onViewStateChange: (state: ExcelViewState) => void
  snapshot: IWorkbookData
  viewPreferences: ExcelViewPreferences
}>(function UniverSheetEditor({ config, documentId, onActionFailure, onChange, onSelectionChange, onViewStateChange, snapshot, viewPreferences }, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const adapterRef = useRef<ExcelUniverAdapter | null>(null)
  const snapshotRef = useRef(snapshot)
  const viewPreferencesRef = useRef(viewPreferences)
  const configRef = useRef(config)

  useEffect(() => { configRef.current = config }, [config])
  useEffect(() => { snapshotRef.current = snapshot }, [snapshot])
  useEffect(() => { viewPreferencesRef.current = viewPreferences }, [viewPreferences])
  useEffect(() => { adapterRef.current?.setTheme(config.theme) }, [config.theme])

  useImperativeHandle(ref, () => {
    const current = () => {
      const adapter = adapterRef.current
      if (!adapter) throw new OfficeOperationError('document_not_ready', 'The workbook editor is not ready.')
      return adapter
    }
    return {
      documentId,
      insertContext: (expandDataRegion) => current().insertContext(expandDataRegion),
      previewFormula: (sheetId, address, formula) => adapterRef.current?.previewFormula(sheetId, address, formula)
        ?? Promise.resolve({ errorCode: '#ERROR!' }),
      run: async (action, value) => current().run(action, value),
      selectRange: (address) => current().selectRange(address),
      setFormulaAt: (sheetId, address, formula) => current().setFormulaAt(sheetId, address, formula),
      setFormulaBarValue: (value) => current().setFormulaBarValue(value),
      flush: async () => current().flush(),
      snapshot: () => adapterRef.current?.snapshot() ?? snapshotRef.current,
    }
  }, [documentId])

  useEffect(() => {
    const container = hostRef.current
    if (!container) return
    const adapter = mountExcelUniverAdapter({
      container,
      config: configRef.current,
      documentId,
      snapshot: snapshotRef.current,
      viewPreferences: viewPreferencesRef.current,
      onActionFailure,
      onChange: (current) => {
        snapshotRef.current = current
        onChange(current)
      },
      onSelectionChange,
      onViewStateChange,
    })
    adapterRef.current = adapter
    return () => {
      try { adapter.dispose() } finally {
        if (adapterRef.current === adapter) adapterRef.current = null
      }
    }
  }, [config.locale, documentId, onActionFailure, onChange, onSelectionChange, onViewStateChange])

  return <div className="min-h-0 min-w-0 flex-1 overflow-hidden" ref={hostRef} data-testid="excel-univer-host" />
})
