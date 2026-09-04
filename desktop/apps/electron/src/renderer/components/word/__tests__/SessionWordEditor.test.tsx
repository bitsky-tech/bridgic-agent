import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { resolve } from 'node:path'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
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

afterEach(() => {
  window.localStorage.clear()
  delete window.__bridgicWord
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

describe('SessionWordEditor', () => {
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
    expect(host.querySelector('[data-testid="word-launch-empty-state"]')).not.toBeNull()
    await act(async () => {
      expect((await window.__bridgicWord?.dispatch({ type: 'document.create', title: 'Session A document' }))?.ok).toBe(true)
    })

    await act(async () => {
      root.render(<SessionWordEditor defaultTitle="Untitled" expanded={false} sessionId="session-b" />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(window.__bridgicWord?.sessionId).toBe('session-b')
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

    await act(async () => {
      root.render(<SessionWordEditor defaultTitle="Untitled" expanded={false} sessionId="session-launch" />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(host.querySelector('[data-testid="word-launch-empty-state"]')).not.toBeNull()
    expect(await window.__bridgicWord?.dispatch({ type: 'workspace.get' })).toMatchObject({
      ok: true,
      state: { documents: [] },
    })

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
})
