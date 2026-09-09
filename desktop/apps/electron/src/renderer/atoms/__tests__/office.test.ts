import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import { currentOfficeSurfaceStatusesAtom } from '../office'
import { activeSessionIdAtom } from '../sessions'
import { wordHostSnapshotAtom, purgeWordStateAtom } from '../word'
import { embeddedPowerPointSnapshotAtom } from '../powerpoint'
import { excelHostSnapshotAtom } from '../excel'
import { setPowerPointNeedsAttentionAtom } from '../powerpoint-attention'

describe('Session-scoped Office status projection', () => {
  it('retains known empty Word state, isolates Sessions and forgets purged projections', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    expect(store.get(currentOfficeSurfaceStatusesAtom).word.documentCount).toBeNull()
    const word = { sessionId: 'session-a', targetId: 'word-a', webContentsId: 3, loading: false, crashed: false, documentCount: 0, persistenceStatus: 'saved' as const, expanded: false }
    store.set(wordHostSnapshotAtom, { sessions: [word] })
    expect(store.get(currentOfficeSurfaceStatusesAtom).word.documentCount).toBe(0)
    store.set(wordHostSnapshotAtom, { sessions: [{ ...word, documentCount: 1 }] })
    store.set(activeSessionIdAtom, 'session-b')
    expect(store.get(currentOfficeSurfaceStatusesAtom).word.documentCount).toBeNull()
    store.set(wordHostSnapshotAtom, { sessions: [{ ...word, documentCount: 1 }, { ...word, sessionId: 'session-b', documentCount: 3 }] })
    store.set(activeSessionIdAtom, 'session-a')
    expect(store.get(currentOfficeSurfaceStatusesAtom).word.documentCount).toBe(1)
    store.set(purgeWordStateAtom, 'session-a')
    expect(store.get(currentOfficeSurfaceStatusesAtom).word.documentCount).toBeNull()
    store.set(activeSessionIdAtom, 'session-b')
    expect(store.get(currentOfficeSurfaceStatusesAtom).word.documentCount).toBe(3)
  })

  it('joins native targets and PPT attention only for the viewed Session without consuming attention', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(embeddedPowerPointSnapshotAtom, { sessions: [{
      sessionId: 'session-a', targetId: 'ppt-a', webContentsId: 1, loading: false, crashed: false,
    }] })
    store.set(excelHostSnapshotAtom, { sessions: [{
      sessionId: 'session-b', targetId: 'excel-b', webContentsId: 2, ready: true, crashed: false, dirty: true,
    }] })
    store.set(setPowerPointNeedsAttentionAtom, { sessionId: 'session-a', needsAttention: true })
    let status = store.get(currentOfficeSurfaceStatusesAtom)
    expect(status.presentation.hasNativeTarget).toBe(true)
    expect(status.presentation.needsAttention).toBe(true)
    expect(status.excel.hasNativeTarget).toBe(false)
    expect(status.excel.dirty).toBeNull()
    store.set(activeSessionIdAtom, 'session-b')
    status = store.get(currentOfficeSurfaceStatusesAtom)
    expect(status.presentation.hasNativeTarget).toBe(false)
    expect(status.presentation.needsAttention).toBe(false)
    expect(status.excel.hasNativeTarget).toBe(true)
    expect(status.excel.dirty).toBe(true)
    store.set(activeSessionIdAtom, 'session-a')
    expect(store.get(currentOfficeSurfaceStatusesAtom).presentation.needsAttention).toBe(true)
  })
})
