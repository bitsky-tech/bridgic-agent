import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { resolve } from 'node:path'
import { DEFAULT_SETTINGS, type GuiSettings } from '@app/shared/types'
import type { WordHostOpenRequest, WordHostPreloadAPI, WordHostRendererState } from '@shared/types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act, StrictMode } = await import('react')
const { createRoot } = await import('react-dom/client')
const { WordHostApp, createWordHostRequestQueue } = await import('../WordHostApp')

afterEach(() => {
  window.localStorage.clear()
  delete window.__bridgicWord
  document.body.replaceChildren()
})
afterAll(async () => { await GlobalRegistrator.unregister() })

const request = (id: string, sessionId = 'word-session'): WordHostOpenRequest => ({ id, sessionId, name: `${id}.docx`, path: `/tmp/${id}.docx` })

describe('Word host request ordering', () => {
  it('processes imports once in order and flushes only after the preceding import completes', async () => {
    const calls: string[] = []
    let finishFirst!: () => void
    const queue = createWordHostRequestQueue({
      api: {
        completeOpenFile: async (id, error) => { calls.push(`open:${id}:${error ?? 'ok'}`) },
        completeFlush: async (id, success) => { calls.push(`flush:${id}:${success}`) },
      },
      flushWorkspace: async () => { calls.push('persist') },
      onError: (error) => { throw error },
      openDocument: async ({ id }) => {
        calls.push(`start:${id}`)
        if (id === 'first') await new Promise<void>((resolve) => { finishFirst = resolve })
      },
      sessionId: 'word-session',
    })
    const first = queue.open(request('first'))
    void queue.open(request('first'))
    const second = queue.open(request('second'))
    const flush = queue.flush('checkpoint')
    await Promise.resolve()
    expect(calls).toEqual(['start:first'])
    finishFirst()
    await Promise.all([first, second, flush])
    expect(calls).toEqual(['start:first', 'open:first:ok', 'start:second', 'open:second:ok', 'persist', 'flush:checkpoint:true'])
    await queue.open(request('first'))
    await queue.flush('checkpoint')
    expect(calls).toHaveLength(6)
  })

  it('rejects wrong-Session files and acknowledges failed persistence without claiming success', async () => {
    const completions: Array<{ id: string; error?: string; success?: boolean }> = []
    const imported: string[] = []
    const errors: unknown[] = []
    const queue = createWordHostRequestQueue({
      api: {
        completeOpenFile: async (id, error) => { completions.push({ id, error }) },
        completeFlush: async (id, success) => { completions.push({ id, success }) },
      },
      flushWorkspace: async () => { throw new Error('Storage full') },
      onError: (error) => { errors.push(error) },
      openDocument: async ({ id }) => { imported.push(id) },
      sessionId: 'word-session',
    })
    await queue.open(request('foreign', 'other-session'))
    await queue.flush('failed-checkpoint')
    await queue.open(request('local'))
    expect(imported).toEqual(['local'])
    expect(completions).toEqual([
      { id: 'foreign', error: 'The Word document request belongs to another Session.' },
      { id: 'failed-checkpoint', success: false },
      { id: 'local', error: undefined },
    ])
    expect(errors).toHaveLength(2)
  })
})

describe('WordHostApp', () => {
  it('accepts buffered imports before workspace initialization and checkpoints their final state', async () => {
    const fixture = resolve(import.meta.dir, '../../../../../../node_modules/mammoth/test/test-data/single-paragraph.docx')
    const bytes = new Uint8Array(await Bun.file(fixture).arrayBuffer())
    const reads: string[] = []
    const acknowledgements: string[] = []
    const api: WordHostPreloadAPI = {
      getConfig: async () => DEFAULT_SETTINGS,
      readDocument: async (path) => {
        reads.push(path)
        return { bytes, fileName: path.split('/').at(-1)!, mtimeMs: 42 }
      },
      reportState: async () => undefined,
      requestHide: async () => undefined,
      setExpanded: async () => undefined,
      onConfigChanged: () => () => undefined,
      onExpandedChanged: () => () => undefined,
      onOpenFileRequested: (callback) => {
        callback(request('first'))
        callback(request('first'))
        callback(request('second'))
        return () => undefined
      },
      completeOpenFile: async (id, error) => { acknowledgements.push(`open:${id}:${error ?? 'ok'}`) },
      onFlushRequested: (callback) => { callback('initial-checkpoint'); return () => undefined },
      completeFlush: async (id, success) => { acknowledgements.push(`flush:${id}:${success}`) },
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(<StrictMode><WordHostApp api={api} sessionId="word-session" /></StrictMode>))
      for (let attempt = 0; attempt < 100 && acknowledgements.length < 3; attempt++) {
        await act(async () => new Promise((accept) => setTimeout(accept, 10)))
      }
      expect(reads).toEqual(['/tmp/first.docx', '/tmp/second.docx'])
      expect(acknowledgements).toEqual(['open:first:ok', 'open:second:ok', 'flush:initial-checkpoint:true'])
      const workspace = await window.__bridgicWord?.dispatch({ type: 'workspace.get' })
      if (!workspace?.ok) throw new Error('Expected workspace')
      expect(workspace.state.documents.map((document) => document.title)).toEqual(['first.docx', 'second.docx'])
      const { loadPersistedWordWorkspace } = await import('@/lib/wordPersistence')
      expect(await loadPersistedWordWorkspace('word-session')).toEqual(workspace.state)
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('keeps a Session domain through settings changes and handles host controls without window.api', async () => {
    let configChanged!: (settings: GuiSettings) => void
    let expandedChanged!: Parameters<WordHostPreloadAPI['onExpandedChanged']>[0]
    let requestFlush!: (id: string) => void
    const reported: WordHostRendererState[] = []
    const flushed: Array<{ id: string; success: boolean }> = []
    const expansions: boolean[] = []
    let hides = 0
    const api: WordHostPreloadAPI = {
      getConfig: async () => ({ ...DEFAULT_SETTINGS, locale: 'en' }),
      readDocument: async () => { throw new Error('No file requested') },
      reportState: async (state) => { reported.push(state) },
      requestHide: async () => { hides += 1 },
      setExpanded: async (expanded) => { expansions.push(expanded) },
      onConfigChanged: (callback) => { configChanged = callback; return () => undefined },
      onExpandedChanged: (callback) => { expandedChanged = callback; return () => undefined },
      onOpenFileRequested: () => () => undefined,
      completeOpenFile: async () => undefined,
      onFlushRequested: (callback) => { requestFlush = callback; return () => undefined },
      completeFlush: async (id, success) => { flushed.push({ id, success }) },
    }
    const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
    Object.defineProperty(window, 'api', { configurable: true, value: undefined })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<StrictMode><WordHostApp api={api} sessionId="word-session" /></StrictMode>)
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      const domain = window.__bridgicWord!
      expect(domain.sessionId).toBe('word-session')
      expect(reported.at(-1)).toEqual({ documentCount: 0, persistenceStatus: 'saved' })
      await act(async () => { await domain.dispatch({ type: 'document.create', title: 'Keep me', html: '<p>Latest text</p>' }) })
      for (let attempt = 0; attempt < 100 && !host.querySelector('[data-testid="word-workbench"]'); attempt++) {
        await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
      }
      const workspace = await domain.dispatch({ type: 'workspace.get' })
      await act(async () => {
        configChanged({ ...DEFAULT_SETTINGS, locale: 'zh', theme: { mode: 'dark', accent: '#8844ff' } })
        expandedChanged({ sessionId: 'other-session', expanded: true })
      })
      expect(window.__bridgicWord).toBe(domain)
      expect(await domain.dispatch({ type: 'workspace.get' })).toEqual(workspace)
      expect(document.documentElement.dataset.theme).toBe('dark')
      expect(document.documentElement.lang).toBe('zh')
      expect(host.querySelector('[data-testid="word-expand-toggle"]')?.getAttribute('aria-pressed')).toBe('false')
      await act(async () => expandedChanged({ sessionId: 'word-session', expanded: true }))
      expect(host.querySelector('[data-testid="word-expand-toggle"]')?.getAttribute('aria-pressed')).toBe('true')
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-expand-toggle"]')!.click())
      expect(expansions).toEqual([false])
      await act(async () => requestFlush('shutdown'))
      expect(flushed).toEqual([{ id: 'shutdown', success: true }])
      expect(reported.at(-1)).toEqual({ documentCount: 1, persistenceStatus: 'saved' })
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-close-panel"]')!.click())
      expect(hides).toBe(1)
      expect(window.__bridgicWord).toBe(domain)
    } finally {
      await act(async () => root.unmount())
      if (originalApi) Object.defineProperty(window, 'api', originalApi)
      else Reflect.deleteProperty(window, 'api')
    }
  })

  it('acknowledges failed restoration promptly without importing over the saved workspace', async () => {
    const storageKey = 'bridgic.word.workspace.word-session'
    window.localStorage.setItem(storageKey, '{unreadable')
    const reported: WordHostRendererState[] = []
    const acknowledgements: Array<{ id: string; error?: string; success?: boolean }> = []
    let reads = 0
    const api: WordHostPreloadAPI = {
      getConfig: async () => DEFAULT_SETTINGS,
      readDocument: async () => { reads += 1; throw new Error('No import should run') },
      reportState: async (state) => { reported.push(state) },
      requestHide: async () => undefined,
      setExpanded: async () => undefined,
      onConfigChanged: () => () => undefined,
      onExpandedChanged: () => () => undefined,
      onOpenFileRequested: (callback) => { callback(request('buffered')); return () => undefined },
      completeOpenFile: async (id, error) => { acknowledgements.push({ id, error }) },
      onFlushRequested: (callback) => { callback('close-failed'); return () => undefined },
      completeFlush: async (id, success) => { acknowledgements.push({ id, success }) },
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(<StrictMode><WordHostApp api={api} sessionId="word-session" /></StrictMode>))
      for (let attempt = 0; attempt < 50 && acknowledgements.length < 2; attempt += 1) {
        await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
      }
      expect(reported.at(-1)).toEqual({ documentCount: 0, persistenceStatus: 'error' })
      expect(acknowledgements).toEqual([{ id: 'buffered', error: expect.any(String) }, { id: 'close-failed', success: false }])
      expect(reads).toBe(0)
      expect(window.localStorage.getItem(storageKey)).toBe('{unreadable')
      expect(window.__bridgicWord).toBeUndefined()
      expect(host.querySelector('[data-testid="word-recovery-error-state"]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
    }
  })

})
