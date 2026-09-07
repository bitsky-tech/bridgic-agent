import { createRoot } from 'react-dom/client'
import type { ExcelHostPreloadAPI } from '../../shared/types'
import { ExcelHostApp } from './ExcelHostApp'
import '../index.css'

if (!window.excelHostApi) {
  const canceled = { ok: false as const, reason: 'canceled' as const }
  const fallback: ExcelHostPreloadAPI = {
    open: async () => ({ canceled: true as const }),
    openRequestedWorkbook: async () => ({ canceled: true as const }),
    save: async () => canceled,
    saveAs: async () => canceled,
    closeSession: async () => undefined,
    setDirty: async () => undefined,
    getRecoveryState: async () => null,
    setRecoveryState: async () => undefined,
    onConfigChanged: () => () => undefined,
    onWorkbookOpenRequested: () => () => undefined,
  }
  window.excelHostApi = fallback
}

const root = document.getElementById('excel-root')
if (!root) throw new Error('#excel-root not found in excel.html')

createRoot(root).render(
  <ExcelHostApp />,
)
