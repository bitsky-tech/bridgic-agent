import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  claimExcelWorkbookOpenRequestAtom,
  consumeExcelWorkbookOpenRequestAtom,
  pendingExcelWorkbookOpenRequestsAtom,
  queueExcelWorkbookOpenAtom,
} from '../excel'

describe('Excel file-open requests', () => {
  it('coalesces repeated clicks and claims a request only once across panel lifetimes', () => {
    const store = createStore()
    const file = { sessionId: 'session-a', path: '/tmp/report.xlsx' }
    store.set(queueExcelWorkbookOpenAtom, file)
    store.set(queueExcelWorkbookOpenAtom, file)
    const request = store.get(pendingExcelWorkbookOpenRequestsAtom)[0]!
    expect(store.get(pendingExcelWorkbookOpenRequestsAtom)).toHaveLength(1)
    expect(store.set(claimExcelWorkbookOpenRequestAtom, request.requestId)).toEqual(request)
    store.set(queueExcelWorkbookOpenAtom, file)
    expect(store.set(claimExcelWorkbookOpenRequestAtom, request.requestId)).toBeNull()
    expect(store.get(pendingExcelWorkbookOpenRequestsAtom)).toHaveLength(1)
    store.set(queueExcelWorkbookOpenAtom, { ...file, sessionId: 'session-b' })
    store.set(queueExcelWorkbookOpenAtom, { ...file, path: '/tmp/other.xlsx' })
    expect(store.get(pendingExcelWorkbookOpenRequestsAtom)).toHaveLength(3)
    store.set(consumeExcelWorkbookOpenRequestAtom, request.requestId)
    expect(store.set(claimExcelWorkbookOpenRequestAtom, request.requestId)).toBeNull()
    store.set(queueExcelWorkbookOpenAtom, file)
    expect(store.get(pendingExcelWorkbookOpenRequestsAtom)).toHaveLength(3)
  })
})
