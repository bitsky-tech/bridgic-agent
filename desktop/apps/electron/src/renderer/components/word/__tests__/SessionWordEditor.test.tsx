import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { installWordImportWorker } from '../../../test-fixtures/wordImportWorker'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { resolve } from 'node:path'
import type { OfficeFilesAPI } from '../../../../shared/office-files'
import type { WordDocumentReadResult } from '../../../../shared/types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { i18n } = await import('@/lib/i18n')
const { installApiStub } = await import('@/lib/apiStub')
installApiStub()
const { SessionWordEditor } = await import('../SessionWordEditor')
const { replaceUniverSnapshotWithRetry, shouldCommitUniverCommand } = await import('../StructuredWordEditor')

async function waitForElement<T extends Element>(host: HTMLElement, selector: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const element = host.querySelector<T>(selector)
    if (element) return element
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
  }
  throw new Error(`Timed out waiting for ${selector}`)
}

let restoreWorker: () => void
beforeEach(() => { restoreWorker = installWordImportWorker() })
afterEach(() => {
  restoreWorker()
  window.localStorage.clear()
  delete window.__bridgicWord
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

describe('SessionWordEditor', () => {
  it('checkpoints a closed final tab as empty and removes only the selected non-final tab', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const onClose = mock(() => {})
    try {
      await act(async () => {
        root.render(<SessionWordEditor defaultTitle="Untitled" expanded={false} sessionId="session-close" onClose={onClose} />)
      })
      await act(async () => {
        await window.__bridgicWord!.dispatch({ type: 'document.create', title: 'Retained' })
      })
      await waitForElement(host, '[data-testid="word-close-document"]')
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-close-document"]')!.click())
      expect(onClose).toHaveBeenCalledTimes(1)
      const after = await window.__bridgicWord!.dispatch({ type: 'workspace.get' })
      expect(after).toMatchObject({ ok: true, state: { documents: [], activeDocumentId: '' } })
      expect(host.querySelector('[data-testid="word-launch-empty-state"]')).not.toBeNull()
      await act(async () => {
        await window.__bridgicWord!.dispatch({ type: 'document.create', title: 'Retained' })
        await window.__bridgicWord!.dispatch({ type: 'document.create', title: 'Second' })
      })
      await act(async () => host.querySelectorAll<HTMLButtonElement>('[data-testid="word-close-document"]')[1]!.click())
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(host.querySelectorAll('[data-testid="word-document-tab"]')).toHaveLength(1)
      expect(host.textContent).toContain('Retained.docx')
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })

  it('retries external snapshot replacement and excludes view-only commands from persistence', async () => {
    const executeCommand = mock(async (_id: string, _params?: object) => false)
    executeCommand.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    expect(await replaceUniverSnapshotWithRetry({ executeCommand }, 'word-1', { id: 'word-1' } as never)).toBe(true)
    expect(executeCommand).toHaveBeenCalledTimes(2)
    expect(executeCommand.mock.calls[0]?.[1]).toMatchObject({ textRanges: undefined, options: { noHistory: true } })
    expect(shouldCommitUniverCommand('doc.operation.set-selections')).toBe(false)
    expect(shouldCommitUniverCommand('doc.command.set-zoom-ratio')).toBe(false)
    expect(shouldCommitUniverCommand('doc.command-replace-snapshot')).toBe(false)
    expect(shouldCommitUniverCommand('doc.command.insert-text')).toBe(true)
  })

  it('replaces the renderer domain and workspace when the viewed Session changes', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(<SessionWordEditor defaultTitle="Untitled" expanded={false} sessionId="session-a" />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(window.__bridgicWord?.sessionId).toBe('session-a')
    const previousApi = window.__bridgicWord!
    expect(previousApi.workspace.getSnapshot()).toMatchObject({ appKind: 'word', sessionId: 'session-a', documents: [] })
    expect(host.querySelector('[data-testid="word-launch-empty-state"]')).not.toBeNull()
    await act(async () => {
      expect((await window.__bridgicWord?.dispatch({ type: 'document.create', title: 'Session A document' }))?.ok).toBe(true)
    })

    await act(async () => {
      root.render(<SessionWordEditor defaultTitle="Untitled" expanded={false} sessionId="session-b" />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(window.__bridgicWord?.sessionId).toBe('session-b')
    expect(await previousApi.dispatch({ type: 'document.create', title: 'Obsolete' })).toMatchObject({ ok: false, error: { code: 'runtime_disposed' } })
    const result = await window.__bridgicWord?.dispatch({ type: 'workspace.get' })
    expect(result?.ok).toBe(true)
    if (result?.ok) expect(result.state.documents).toEqual([])
    expect(host.querySelector('[data-testid="word-launch-empty-state"]')).not.toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('creates the first blank document only after the launch action is clicked', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const onOpenDocument = mock(async () => undefined)

    await act(async () => {
      root.render(<SessionWordEditor defaultTitle="Untitled" expanded={false} onOpenDocument={onOpenDocument} sessionId="session-launch" />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(host.querySelector('[data-testid="word-launch-empty-state"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="word-open-file"]')).not.toBeNull()
    expect(await window.__bridgicWord?.dispatch({ type: 'workspace.get' })).toMatchObject({
      ok: true,
      state: { documents: [] },
    })
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-open-file"]')!.click())
    expect(onOpenDocument).toHaveBeenCalledTimes(1)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="word-create-document"]')?.click()
    })
    await waitForElement(host, '[data-testid="word-workbench"]')
    const result = await window.__bridgicWord?.dispatch({ type: 'workspace.get' })
    expect(result?.ok).toBe(true)
    if (result?.ok) expect(result.state.documents).toHaveLength(1)
    expect(host.querySelector('[data-testid="word-launch-empty-state"]')).toBeNull()
    expect(host.querySelector('[data-testid="word-document-header"] input')).toBeNull()
    expect(host.querySelector<HTMLButtonElement>('[data-zoom-mode]')?.textContent).toBe('75%')
    expect(host.querySelector('[data-testid="word-ruler"]')).not.toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-tab-view"]')?.click())
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-toggle-ruler"]')?.click())
    expect(host.querySelector('[data-testid="word-ruler"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps an import failure visible after the opening state is dismissed', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const request = {
      id: 'failed-open',
      name: 'Broken.docx',
      path: '/tmp/Broken.docx',
      sessionId: 'session-open-failure',
    }
    function Harness() {
      const [openFileRequest, setOpenFileRequest] = useState<typeof request | null>(null)
      return <SessionWordEditor
        defaultTitle="Untitled"
        expanded={false}
        onOpenDocument={() => setOpenFileRequest(request)}
        onOpenFileRequestHandled={() => setOpenFileRequest(null)}
        openFileRequest={openFileRequest}
        readDocument={async () => { throw new Error('Broken document') }}
        sessionId="session-open-failure"
      />
    }
    try {
      await act(async () => {
        root.render(<Harness />)
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-open-file"]')!.click())
      await waitForElement(host, '[data-testid="word-launch-empty-state"] [role="alert"]')
      expect(host.querySelector('[data-testid="word-launch-empty-state"]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })

  it('imports a clicked DOCX into the Session workspace and completes its request', async () => {
    const fixture = resolve(import.meta.dir, '../../../../../../../node_modules/mammoth/test/test-data/single-paragraph.docx')
    const bytes = new Uint8Array(await Bun.file(fixture).arrayBuffer())
    const readDocument = mock(async () => ({ bytes, fileName: 'Agent Report.docx', mtimeMs: 42 }))
    const originalWord = window.api.word
    window.api.word = { readDocument }
    const handled: string[] = []
    const failures: string[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    try {
      await act(async () => {
        root.render(
          <SessionWordEditor
            defaultTitle="Untitled"
            expanded={false}
            onOpenFileError={(name) => failures.push(name)}
            onOpenFileRequestHandled={(requestId) => handled.push(requestId)}
            openFileRequest={{
              id: 'request-docx',
              name: 'Agent Report.docx',
              path: '/tmp/Agent Report.docx',
              sessionId: 'session-import',
            }}
            sessionId="session-import"
          />,
        )
      })
      await waitForElement(host, '[data-testid="word-workbench"]')
      const result = await window.__bridgicWord?.dispatch({ type: 'workspace.get' })
      expect(result?.ok).toBe(true)
      if (result?.ok) {
        expect(result.state.documents).toHaveLength(1)
        expect(result.state.documents[0]).toMatchObject({
          title: 'Agent Report.docx',
          sourcePath: '/tmp/Agent Report.docx',
          sourceMtimeMs: 42,
        })
      }
      expect(readDocument).toHaveBeenCalledWith('/tmp/Agent Report.docx')
      expect(handled).toEqual(['request-docx'])
      expect(failures).toEqual([])
    } finally {
      if (originalWord) window.api.word = originalWord
      else delete (window.api as { word?: typeof window.api.word }).word
      await act(async () => root.unmount())
      host.remove()
    }
  })

  it('reuses the live Word tab when an edit is saved while a reopen is reading older bytes', async () => {
    const fixture = resolve(import.meta.dir, '../../../../../../../node_modules/mammoth/test/test-data/single-paragraph.docx')
    const bytes = new Uint8Array(await Bun.file(fixture).arrayBuffer())
    const previousFiles = window.officeFiles
    let mtimeMs = 1
    let delayed = false
    let finishRead: (() => void) | undefined
    const readDocument = async (): Promise<WordDocumentReadResult> => {
      const file = { bytes: bytes.slice(), path: '/work/Report.docx', fileName: 'Report.docx', mtimeMs }
      if (!delayed) return file
      return new Promise((resolve) => { finishRead = () => resolve(file) })
    }
    window.officeFiles = {
      prepare: async () => ({ path: '/work/Report.docx', mtimeMs }),
      inspect: async () => ({ path: '/work/Report.docx', mtimeMs }),
      save: async () => ({ ok: true, source: { path: '/work/Report.docx', mtimeMs: ++mtimeMs }, fileName: 'Report.docx' }),
      confirmClose: async () => 'cancel', getRecovery: async () => null, setRecovery: async () => undefined,
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const handled: string[] = []
    const complete = (id: string, error?: string) => { expect(error).toBeUndefined(); handled.push(id) }
    const render = (id: string) => <SessionWordEditor defaultTitle="Report" expanded={false} sessionId="reopen-race" readDocument={readDocument} onOpenFileRequestHandled={complete} openFileRequest={{ id, path: '/work/Report.docx', name: 'Report.docx', sessionId: 'reopen-race' }} />
    const waitUntil = async (check: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !check(); attempt++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
      expect(check()).toBe(true)
    }
    try {
      await act(async () => root.render(render('first')))
      await waitUntil(() => handled.includes('first'))
      const documentId = window.__bridgicWord!.workspace.getSnapshot().activeDocumentId
      delayed = true
      await act(async () => root.render(render('reopen')))
      await waitUntil(() => Boolean(finishRead))
      await act(async () => {
        expect((await window.__bridgicWord!.dispatch({ type: 'document.append', text: 'Saved during file loading' })).ok).toBe(true)
      })
      const savedMtime = mtimeMs
      await act(async () => finishRead!())
      await waitUntil(() => handled.includes('reopen'))
      const result = await window.__bridgicWord!.dispatch({ type: 'workspace.get' })
      if (!result.ok) throw new Error(result.error.message)
      expect(result.state.documents).toHaveLength(1)
      expect(result.state.documents[0]).toMatchObject({ id: documentId, sourceMtimeMs: savedMtime })
      expect(result.state.documents[0]!.snapshot.body!.dataStream).toContain('Saved during file loading')
    } finally {
      await act(async () => root.unmount())
      host.remove()
      window.officeFiles = previousFiles
    }
  })

  it('retries a failed Word recovery checkpoint without rewriting an already saved document', async () => {
    const originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage')
    const originalIndexed = Object.getOwnPropertyDescriptor(window, 'indexedDB')
    const previousFiles = window.officeFiles
    const memory = new Map<string, string>()
    let fail = true
    let attempts = 0
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined })
    Object.defineProperty(window, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => memory.get(key) ?? null,
      removeItem: (key: string) => memory.delete(key),
      setItem: (key: string, value: string) => {
        if (key.startsWith('bridgic.word.workspace.')) {
          attempts++
          if (fail) throw new Error('Temporary recovery storage failure')
        }
        memory.set(key, value)
      },
    } })
    const save = mock(async (): ReturnType<OfficeFilesAPI['save']> => ({ ok: true, fileName: 'Report.docx', source: { path: '/work/Report.docx', mtimeMs: 1 } }))
    window.officeFiles = { save, prepare: async () => ({ path: '/work/Report.docx', mtimeMs: 1 }), inspect: async () => ({ path: '/work/Report.docx', mtimeMs: 1 }), confirmClose: async () => 'cancel', getRecovery: async () => null, setRecovery: async () => undefined }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(<SessionWordEditor defaultTitle="Report" expanded={false} sessionId="retry-checkpoint" />))
      await waitForElement(host, '[data-testid="word-create-document"]')
      await act(async () => { await window.__bridgicWord!.dispatch({ type: 'document.create', html: '<p>Saved content</p>' }) })
      await waitForElement(host, '[data-testid="word-document-header"] [role="alert"]')
      const before = attempts
      const writes = save.mock.calls.length
      const retry = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === i18n.t('word.retry'))!
      expect(retry).toBeDefined()
      // A still-failing retry must remain visibly failed.
      await act(async () => { retry.click(); await new Promise((resolve) => setTimeout(resolve, 10)) })
      expect(attempts).toBeGreaterThan(before)
      expect(host.querySelector('[data-testid="word-document-header"] [role="alert"]')).not.toBeNull()
      fail = false
      await act(async () => { retry.click(); await new Promise((resolve) => setTimeout(resolve, 10)) })
      expect(memory.get('bridgic.word.workspace.retry-checkpoint')).toContain('Saved content')
      expect(host.querySelector('[data-testid="word-document-header"] [role="alert"]')).toBeNull()
      expect(save).toHaveBeenCalledTimes(writes)
    } finally {
      await act(async () => root.unmount())
      host.remove()
      window.officeFiles = previousFiles
      if (originalStorage) Object.defineProperty(window, 'localStorage', originalStorage)
      else Reflect.deleteProperty(window, 'localStorage')
      if (originalIndexed) Object.defineProperty(window, 'indexedDB', originalIndexed)
      else Reflect.deleteProperty(window, 'indexedDB')
    }
  })

  it('keeps the domain and unsaved content when its localized default title changes', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let flush: (() => Promise<void>) | null = null
    const onFlushHandlerChange = (handler: (() => Promise<void>) | null) => { flush = handler }
    const states: Array<{ documentCount: number; persistenceStatus: string }> = []
    const onStateChange = (state: { documentCount: number; persistenceStatus: string }) => states.push(state)
    const render = (defaultTitle: string) => <SessionWordEditor defaultTitle={defaultTitle} expanded={false} onFlushHandlerChange={onFlushHandlerChange} onStateChange={onStateChange} sessionId="session-language" />
    try {
      await act(async () => {
        root.render(render('Untitled'))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      const domain = window.__bridgicWord!
      expect(states.at(-1)).toEqual({ documentCount: 0, persistenceStatus: 'saved' })
      await act(async () => { await domain.dispatch({ type: 'document.create', title: 'Keep this text', html: '<p>Recent input</p>' }) })
      const before = await domain.dispatch({ type: 'workspace.get' })
      await act(async () => root.render(render('未命名文档')))
      expect(window.__bridgicWord).toBe(domain)
      expect(await domain.dispatch({ type: 'workspace.get' })).toEqual(before)
      expect(flush).not.toBeNull()
      await act(async () => { await (flush as unknown as () => Promise<void>)() })
      expect(states.at(-1)).toEqual({ documentCount: 1, persistenceStatus: 'saved' })
      await act(async () => { await domain.dispatch({ type: 'document.create' }) })
      const after = await domain.dispatch({ type: 'workspace.get' })
      if (!after.ok) throw new Error('Expected workspace')
      expect(after.state.documents.at(-1)?.title).toBe('未命名文档')
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })

  it('rejects foreign-Session imports before calling the file capability', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const readDocument = mock(async () => ({ bytes: new Uint8Array(), fileName: 'foreign.docx', mtimeMs: 1 }))
    const completions: Array<{ id: string; error?: string }> = []
    const complete = (id: string, error?: string) => { completions.push({ id, error }) }
    try {
      await act(async () => {
        root.render(<SessionWordEditor defaultTitle="Untitled" expanded={false} onOpenFileRequestHandled={complete} readDocument={readDocument} openFileRequest={{ id: 'foreign', name: 'foreign.docx', path: '/tmp/foreign.docx', sessionId: 'other-session' }} sessionId="session-owner" />)
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(readDocument).not.toHaveBeenCalled()
      expect(completions).toEqual([{ id: 'foreign', error: 'The Word document request belongs to another Session.' }])
      expect(await window.__bridgicWord?.dispatch({ type: 'workspace.get' })).toMatchObject({ ok: true, state: { documents: [] } })
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })
})
