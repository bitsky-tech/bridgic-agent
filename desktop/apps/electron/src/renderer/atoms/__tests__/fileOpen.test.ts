import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import { activeModalAtom, ModalKind } from '../amphi'
import {
  pendingExcelWorkbookOpenRequestsAtom,
} from '../excel'
import {
  isEmbeddedExcelWorkbook,
  requestFileOpenAtom,
} from '../fileOpen'
import { activeSessionIdAtom } from '../sessions'

describe('session file opening', () => {
  it('recognizes only supported OOXML workbook names', () => {
    expect(isEmbeddedExcelWorkbook('Report.XLSX')).toBe(true)
    expect(isEmbeddedExcelWorkbook('Report.xls')).toBe(false)
    expect(isEmbeddedExcelWorkbook('Report.xlsx.pdf')).toBe(false)
  })

  it('routes a clicked .xlsx into the current Session Excel workbench', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')

    store.set(requestFileOpenAtom, {
      path: '/Users/me/session/report.xlsx',
      name: 'report.xlsx',
    })

    expect(store.get(pendingExcelWorkbookOpenRequestsAtom)).toEqual([{
      requestId: expect.any(Number),
      sessionId: 'session-a',
      path: '/Users/me/session/report.xlsx',
    }])
    expect(store.get(activeModalAtom)).toBeNull()
  })

  it('keeps the normal confirmation path when there is no Session owner', () => {
    const store = createStore()

    store.set(requestFileOpenAtom, {
      path: '/Users/me/report.xlsx',
      name: 'report.xlsx',
    })

    expect(store.get(pendingExcelWorkbookOpenRequestsAtom)).toEqual([])
    expect(store.get(activeModalAtom)).toEqual({
      type: ModalKind.FileOpenConfirm,
      path: '/Users/me/report.xlsx',
      name: 'report.xlsx',
    })
  })
})
