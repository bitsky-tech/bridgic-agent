import { describe, expect, it, mock } from 'bun:test'
import { createStore } from 'jotai'

const openFile = mock(async (_sessionId: string, absPath: string) => ({
  documentId: 'document-1',
  fileName: absPath.split('/').at(-1) ?? '',
  reused: false,
  slideCount: 2,
  title: 'Deck',
}))
const testGlobal = globalThis as typeof globalThis & { window?: typeof window }
testGlobal.window ??= {} as typeof window
const runtimeWindow = testGlobal.window as typeof window & { api?: Partial<typeof window.api> }
runtimeWindow.api = {
  ...runtimeWindow.api,
  powerpoint: {
    ...(runtimeWindow.api?.powerpoint ?? {} as typeof window.api.powerpoint),
    openFile,
  } as typeof window.api.powerpoint,
}

const {
  isPowerPointFileTarget,
  requestSessionFileOpenAtom,
} = await import('../fileOpen')
const { rightPanelCollapsedAtom, setRightPanelCollapsedAtom } = await import('../layout')
const { powerPointNeedsAttentionFamily } = await import('../powerpoint-attention')
const { activeSessionIdAtom } = await import('../sessions')
const { toastAtom } = await import('../toast')
const {
  SessionWorkbenchSurface,
  sessionWorkbenchSurfaceAtom,
} = await import('../workbench')

describe('Session file PowerPoint opening', () => {
  it('recognizes only real PPTX suffixes', () => {
    expect(isPowerPointFileTarget({ name: 'Deck.PPTX' })).toBe(true)
    expect(isPowerPointFileTarget({ name: 'Deck.pptx.tmp' })).toBe(false)
  })

  it('imports a PPTX into the viewed Session and reveals its in-app editor', async () => {
    openFile.mockClear()
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(setRightPanelCollapsedAtom, true)

    await store.set(requestSessionFileOpenAtom, {
      name: 'Deck.pptx',
      path: '/workspace/.work/assets/Deck.pptx',
    })

    expect(openFile).toHaveBeenCalledWith('session-a', '/workspace/.work/assets/Deck.pptx')
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Presentation)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(powerPointNeedsAttentionFamily('session-a'))).toBe(false)
    expect(store.get(toastAtom)?.message).toContain('Deck.pptx')
  })
})
