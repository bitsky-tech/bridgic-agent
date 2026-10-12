import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createWordIndexedDbMemory } from '../../../test-fixtures/wordIndexedDb'
import type { WordDomainStore } from '@/lib/wordDomain'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act, useEffect } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createWordWorkspace } = await import('@/lib/wordDomain')
const { appendTextBlockToSnapshot, getUniverDocumentText } = await import('@/lib/wordUniverModel')
const { loadPersistedWordWorkspace } = await import('@/lib/wordPersistence')
const originalWordEditor = (await import('../WordEditor')).WordEditor
let commitOnCleanup = false

mock.module('../WordEditor', () => ({
  WordEditor: ({ store }: { store: WordDomainStore }) => {
    useEffect(() => () => {
      if (!commitOnCleanup) return
      const current = store.getSnapshot().documents[0]
      if (current) store.commitEditorSnapshot(current.id, appendTextBlockToSnapshot(current.snapshot, 'Final native input', 'paragraph'))
    }, [store])
    return <div data-testid="recovered-word-editor" />
  },
}))

// Earlier suites may have resolved this module's React.lazy editor already.
// A separate module instance lets this suite exercise its own editor mock.
const recoveryModulePath = '../SessionWordEditor.tsx?word-recovery-test'
const { SessionWordEditor } = await import(recoveryModulePath) as typeof import('../SessionWordEditor')

async function waitForElement(host: HTMLElement, selector: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (host.querySelector(selector)) return
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
  }
  throw new Error(`Missing ${selector}`)
}

const originalIndexedDb = Object.getOwnPropertyDescriptor(window, 'indexedDB')
let indexed: ReturnType<typeof createWordIndexedDbMemory>
beforeEach(() => {
  indexed = createWordIndexedDbMemory()
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: indexed.factory })
})
afterEach(() => {
  commitOnCleanup = false
  window.localStorage.clear()
  delete window.__bridgicWord
})
afterAll(async () => {
  mock.module('../WordEditor', () => ({ WordEditor: originalWordEditor }))
  if (originalIndexedDb) Object.defineProperty(window, 'indexedDB', originalIndexedDb)
  else Reflect.deleteProperty(window, 'indexedDB')
  await GlobalRegistrator.unregister()
})

describe('Word recovery lifecycle', () => {
  it('preserves unreadable storage, rejects flush, and restores the existing documents after retry', async () => {
    const key = 'session-recovery-retry'
    const original = '{incomplete json'
    indexed.records.set(key, original)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let flush: (() => Promise<void>) | null = null
    const states: Array<{ documentCount: number; persistenceStatus: string }> = []
    const receiveFlush = (handler: (() => Promise<void>) | null) => { flush = handler }
    const receiveState = (state: { documentCount: number; persistenceStatus: string }) => states.push(state)
    try {
      await act(async () => {
        root.render(<SessionWordEditor defaultTitle="Untitled" expanded={false} sessionId="session-recovery-retry" onFlushHandlerChange={receiveFlush} onStateChange={receiveState} />)
      })
      await waitForElement(host, '[data-testid="word-recovery-error-state"]')
      expect(indexed.records.get(key)).toBe(original)
      expect(window.__bridgicWord).toBeUndefined()
      expect(host.querySelector('[data-testid="word-launch-empty-state"]')).toBeNull()
      expect(states.at(-1)).toEqual({ documentCount: 0, persistenceStatus: 'error' })
      expect(flush).not.toBeNull()
      await expect((flush as unknown as () => Promise<void>)()).rejects.toThrow()

      const recovered = createWordWorkspace('session-recovery-retry', 'Existing document')
      indexed.records.set(key, recovered)
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-retry-recovery"]')!.click())
      await waitForElement(host, '[data-testid="recovered-word-editor"]')
      expect(window.__bridgicWord?.workspace.getSnapshot().documents[0]?.title).toBe('Existing document')
      await act(async () => { await (flush as unknown as () => Promise<void>)() })
      expect(states.at(-1)).toEqual({ documentCount: 1, persistenceStatus: 'saved' })
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })

  it('rejects an import while recovery has failed instead of replacing saved data with an empty workspace', async () => {
    const key = 'session-recovery-import'
    const original = '{corrupt'
    indexed.records.set(key, original)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const readDocument = mock(async () => ({ bytes: new Uint8Array(), fileName: 'request.docx', mtimeMs: 1 }))
    const completed: Array<{ id: string; error?: string }> = []
    const receiveCompletion = (id: string, error?: string) => completed.push({ id, error })
    try {
      await act(async () => {
        root.render(<SessionWordEditor defaultTitle="Untitled" expanded={false} sessionId="session-recovery-import" readDocument={readDocument} openFileRequest={{ id: 'open-failed', name: 'request.docx', path: '/tmp/request.docx', sessionId: 'session-recovery-import' }} onOpenFileRequestHandled={receiveCompletion} />)
      })
      await waitForElement(host, '[data-testid="word-recovery-error-state"]')
      expect(completed).toEqual([{ id: 'open-failed', error: expect.any(String) }])
      expect(readDocument).not.toHaveBeenCalled()
      expect(indexed.records.get(key)).toBe(original)
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })

  it('accepts the child editor final native snapshot before disposing the shared persistence scheduler', async () => {
    const state = createWordWorkspace('session-cleanup-save', 'Original')
    const key = 'session-cleanup-save'
    indexed.records.set(key, state)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    commitOnCleanup = true
    try {
      await act(async () => root.render(<SessionWordEditor defaultTitle="Untitled" expanded={false} sessionId={state.sessionId} />))
      await waitForElement(host, '[data-testid="recovered-word-editor"]')
      await act(async () => {
        root.unmount()
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      const persisted = await loadPersistedWordWorkspace(state.sessionId) as typeof state
      expect(getUniverDocumentText(persisted.documents[0]!.snapshot)).toContain('Final native input')
    } finally {
      host.remove()
    }
  })
})
