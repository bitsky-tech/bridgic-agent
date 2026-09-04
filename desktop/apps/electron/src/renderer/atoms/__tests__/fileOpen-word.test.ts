import { describe, expect, it, mock } from 'bun:test'
import { createStore } from 'jotai'
import { DEFAULT_SETTINGS, type GuiSettings } from '@app/shared/types'

const g = globalThis as { window?: unknown }
g.window ??= {}
const w = g.window as { api?: Record<string, unknown>; addEventListener?: () => void }
w.api = {
  ...w.api,
  settings: {
    get: mock(async () => DEFAULT_SETTINGS),
    set: mock(async (_next: GuiSettings) => {}),
  },
}
w.addEventListener ??= () => {}

const { requestFileOpenAtom } = await import('../fileOpen')
const { rightPanelCollapsedAtom, setRightPanelCollapsedAtom } = await import('../layout')
const { activeSessionIdAtom } = await import('../sessions')
const { SessionWorkbenchSurface, sessionWorkbenchSurfaceAtom } = await import('../workbench')
const { completeWordFileOpenAtom, wordFileOpenRequestAtom } = await import('../word')

describe('DOCX file-open routing', () => {
  it('opens a clicked DOCX inside the viewed Session Word surface', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-docx')
    store.set(setRightPanelCollapsedAtom, true)

    store.set(requestFileOpenAtom, { name: 'Agent Report.DOCX', path: '/tmp/Agent Report.DOCX' })

    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Word)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(wordFileOpenRequestAtom)).toMatchObject({
      name: 'Agent Report.DOCX',
      path: '/tmp/Agent Report.DOCX',
      sessionId: 'session-docx',
    })
  })

  it('deduplicates an in-flight path and clears only its matching request', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-docx')
    const target = { name: 'report.docx', path: '/tmp/report.docx' }

    store.set(requestFileOpenAtom, target)
    const first = store.get(wordFileOpenRequestAtom)
    store.set(requestFileOpenAtom, target)
    expect(store.get(wordFileOpenRequestAtom)?.id).toBe(first?.id)

    store.set(completeWordFileOpenAtom, 'different-request')
    expect(store.get(wordFileOpenRequestAtom)?.id).toBe(first?.id)
    store.set(completeWordFileOpenAtom, first!.id)
    expect(store.get(wordFileOpenRequestAtom)).toBeNull()
  })
})
