import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import { closeOfficeSurfaceAtom, currentOfficeSurfaceStatusesAtom } from '../office'
import { activeSessionIdAtom } from '../sessions'
import { wordHostSnapshotAtom, purgeWordStateAtom } from '../word'
import { embeddedPowerPointSnapshotAtom } from '../powerpoint'
import { excelExpandedAtom, excelHostSnapshotAtom } from '../excel'
import { presentationExpandedAtom } from '../presentation'
import { rightPanelCollapsedAtom, setRightPanelCollapsedAtom } from '../layout'
import { settingsAtom } from '../settings'
import { SessionWorkbenchSurface, setSessionWorkbenchSurfaceAtom } from '../workbench'
import { SessionFocusPaneKind, setSessionFocusPaneAtom } from '../session-focus-pane'
import { setPowerPointNeedsAttentionAtom } from '../powerpoint-attention'

describe('Session-scoped Office status projection', () => {
  for (const surface of [SessionWorkbenchSurface.Excel, SessionWorkbenchSurface.Word, SessionWorkbenchSurface.Presentation]) {
    it(`remembers a background ${surface} close without changing the foreground Session or fallback`, () => {
      const store = createStore()
      for (const id of ['session-a', 'session-b']) {
        store.set(activeSessionIdAtom, id)
        store.set(setSessionWorkbenchSurfaceAtom, surface)
        store.set(setRightPanelCollapsedAtom, false)
        store.set(excelExpandedAtom, true)
        store.set(presentationExpandedAtom, true)
      }
      const fallback = store.get(settingsAtom).layout.rightPanelCollapsed
      store.set(closeOfficeSurfaceAtom, { sessionId: 'session-a', surface })
      expect(store.get(rightPanelCollapsedAtom)).toBe(false)
      expect(store.get(settingsAtom).layout.rightPanelCollapsed).toBe(fallback)
      expect(store.get(excelExpandedAtom)).toBe(true)
      expect(store.get(presentationExpandedAtom)).toBe(true)
      store.set(activeSessionIdAtom, 'session-a')
      expect(store.get(rightPanelCollapsedAtom)).toBe(true)
      expect(store.get(excelExpandedAtom)).toBe(surface !== SessionWorkbenchSurface.Excel)
      expect(store.get(presentationExpandedAtom)).toBe(surface !== SessionWorkbenchSurface.Presentation)
    })

    it(`preserves a newer tool or Agent pane when ${surface} finishes closing`, () => {
      const store = createStore()
      store.set(activeSessionIdAtom, 'session-a')
      store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Files)
      store.set(setRightPanelCollapsedAtom, false)
      store.set(closeOfficeSurfaceAtom, { sessionId: 'session-a', surface })
      expect(store.get(rightPanelCollapsedAtom)).toBe(false)
      store.set(setSessionWorkbenchSurfaceAtom, surface)
      store.set(setSessionFocusPaneAtom, { kind: SessionFocusPaneKind.TaskSpec })
      store.set(activeSessionIdAtom, 'session-b')
      store.set(closeOfficeSurfaceAtom, { sessionId: 'session-a', surface })
      store.set(activeSessionIdAtom, 'session-a')
      expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    })
  }

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
      documentCount: 0,
    }] })
    store.set(excelHostSnapshotAtom, { sessions: [{
      sessionId: 'session-b', targetId: 'excel-b', webContentsId: 2, ready: true, crashed: false, dirty: true, documentCount: 1,
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
