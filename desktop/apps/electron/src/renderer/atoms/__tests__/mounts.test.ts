import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { createStore } from 'jotai'

import { installSessionsApiStub } from './sessions-api-stub'

const restoreSessionsApi = installSessionsApiStub({
  listMeta: mock(async () => []),
  loadMessages: mock(async () => []),
  appendMessage: mock(async () => {}),
  saveMeta: mock(async () => {}),
  deleteSession: mock(async () => {}),
})
afterAll(restoreSessionsApi)

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

import { BackendState } from '../../../main/python-client/types'
import { backendSnapshotAtom } from '../backend'
import {
  draftSessionIdsAtom,
  newSessionAtom,
  sessionsMetaAtom,
} from '../sessions'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

type DialogResult = { canceled: boolean; filePaths: string[] }

function installDialogOpen(open: () => Promise<DialogResult>): () => void {
  const api = (globalThis.window as unknown as {
    api: { dialog?: { open: () => Promise<DialogResult> } }
  }).api
  const previousDialog = api.dialog
  api.dialog = { open }
  return () => {
    if (previousDialog) api.dialog = previousDialog
    else delete api.dialog
  }
}

function installDialogResult(result: DialogResult): () => void {
  return installDialogOpen(mock(async () => result))
}

function mount(
  id: string,
  name: string,
  path: string,
  kind: 'file' | 'folder' = 'file',
) {
  return {
    id,
    name,
    path,
    kind,
    size_bytes: kind === 'file' ? 42 : null,
    item_count: kind === 'folder' ? 3 : null,
    exists: true,
    created_at: '2026-07-28T08:00:00Z',
  }
}

describe('pasteToSessionFilesAtom', () => {
  it('materializes a draft, mounts paths and uploads bytes without using /assets', async () => {
    const {
      mountsFamily,
      pasteToSessionFilesAtom,
      pendingMentionInsertsAtom,
    } = await import('../mounts')
    const {
      SessionWorkbenchSurface,
      sessionWorkbenchSurfaceAtom,
    } = await import('../browser')
    const { filesNeedsAttentionFamily } = await import('../files-attention')
    const { rightPanelCollapsedAtom, setRightPanelCollapsedAtom } = await import('../layout')
    const store = createStore()
    store.set(backendSnapshotAtom, {
      state: BackendState.Ready,
      endpoint: {
        baseUrl: 'http://127.0.0.1:7421',
        token: 'test-token',
        version: null,
        startedAt: null,
        wsPath: null,
      },
      lastError: null,
    } as never)

    const daemonId = 'session_daemon'
    const pathMount = mount('mnt_path', 'project', '/Users/amphi/project', 'folder')
    const fileMount = mount(
      'mnt_file',
      'clipboard.png',
      '/sessions/session_daemon/attachments/clipboard.png',
    )
    const textMount = mount(
      'mnt_text',
      'snippet.txt',
      '/sessions/session_daemon/attachments/snippet.txt',
    )
    const requests: Array<{ pathname: string; method: string; body: BodyInit | null }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(String(input)).pathname
      requests.push({
        pathname,
        method: init?.method ?? 'GET',
        body: init?.body ?? null,
      })
      if (pathname === '/sessions') {
        return jsonResponse({
          id: daemonId,
          model: 'test-model',
          workspace_root: '/sessions/session_daemon',
          tokens: 0,
          last_answer: null,
          parent_session_id: null,
          subagent_mode: null,
        })
      }
      if (pathname === `/sessions/${daemonId}/mounts`) return jsonResponse(pathMount)
      if (pathname === `/sessions/${daemonId}/mounts/upload`) {
        const uploadCount = requests.filter(
          (request) => request.pathname === `/sessions/${daemonId}/mounts/upload`,
        ).length
        return jsonResponse(uploadCount === 1 ? fileMount : textMount)
      }
      return jsonResponse({ detail: 'unexpected endpoint' }, 404)
    }) as never

    const draftId = store.set(newSessionAtom)
    store.set(setRightPanelCollapsedAtom, true)
    const clipboardFile = new File(['image-bytes'], 'clipboard.png', { type: 'image/png' })
    const result = await store.set(pasteToSessionFilesAtom, {
      sessionId: draftId,
      items: [
        { kind: 'path', path: '/Users/amphi/project' },
        { kind: 'file', file: clipboardFile },
        { kind: 'text', text: 'a long pasted note' },
      ],
    })

    expect(result).toBeNull()
    expect(requests.map(({ pathname, method }) => ({ pathname, method }))).toEqual([
      { pathname: '/sessions', method: 'POST' },
      { pathname: `/sessions/${daemonId}/mounts`, method: 'POST' },
      { pathname: `/sessions/${daemonId}/mounts/upload`, method: 'POST' },
      { pathname: `/sessions/${daemonId}/mounts/upload`, method: 'POST' },
    ])
    expect(requests.every(({ pathname }) => !pathname.startsWith('/assets'))).toBe(true)
    expect(JSON.parse(String(requests[1]?.body))).toEqual({ path: '/Users/amphi/project' })

    const fileForm = requests[2]?.body as FormData
    const uploadedFile = fileForm.get('file') as File
    expect(uploadedFile.name).toBe('clipboard.png')
    expect(await uploadedFile.text()).toBe('image-bytes')

    const textForm = requests[3]?.body as FormData
    const uploadedText = textForm.get('file') as File
    expect(uploadedText.name).toMatch(/-2-snippet\.txt$/)
    expect(await uploadedText.text()).toBe('a long pasted note')

    expect(store.get(draftSessionIdsAtom).has(draftId)).toBe(false)
    expect(store.get(sessionsMetaAtom).map(({ id }) => id)).toContain(daemonId)
    expect(store.get(mountsFamily(daemonId))).toEqual([pathMount, fileMount, textMount])
    expect(store.get(pendingMentionInsertsAtom)).toEqual([
      { id: 'mnt_path', label: 'project/' },
      { id: 'mnt_file', label: 'clipboard.png' },
      { id: 'mnt_text', label: 'snippet.txt' },
    ])
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(filesNeedsAttentionFamily(daemonId))).toBe(true)
  })

  it('does not notify Files when every pasted upload fails', async () => {
    const {
      mountsFamily,
      pasteToSessionFilesAtom,
      pendingMentionInsertsAtom,
    } = await import('../mounts')
    const {
      SessionWorkbenchSurface,
      sessionWorkbenchSurfaceAtom,
      setSessionWorkbenchSurfaceAtom,
    } = await import('../browser')
    const { filesNeedsAttentionFamily } = await import('../files-attention')
    const { rightPanelCollapsedAtom, setRightPanelCollapsedAtom } = await import('../layout')
    const { activeSessionIdAtom } = await import('../sessions')
    const store = createStore()
    const sessionId = 'session_paste_failed'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Results)
    store.set(setRightPanelCollapsedAtom, true)
    store.set(backendSnapshotAtom, {
      state: BackendState.Ready,
      endpoint: {
        baseUrl: 'http://127.0.0.1:7421',
        token: 'test-token',
        version: null,
        startedAt: null,
        wsPath: null,
      },
      lastError: null,
    } as never)
    globalThis.fetch = mock(async () => jsonResponse({ detail: 'upload failed' }, 500)) as never

    await store.set(pasteToSessionFilesAtom, {
      sessionId,
      items: [{ kind: 'file', file: new File(['broken'], 'broken.txt') }],
    })

    expect(store.get(mountsFamily(sessionId))).toEqual([])
    expect(store.get(pendingMentionInsertsAtom)).toEqual([])
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Results)
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(store.get(filesNeedsAttentionFamily(sessionId))).toBe(false)
  })
})

describe('pickAndMountAtom', () => {
  it('reveals the Files workbench only after the picker mount succeeds', async () => {
    const { mountsFamily, pickAndMountAtom } = await import('../mounts')
    const {
      SessionWorkbenchSurface,
      sessionWorkbenchSurfaceAtom,
      setSessionWorkbenchSurfaceAtom,
    } = await import('../browser')
    const { filesNeedsAttentionFamily } = await import('../files-attention')
    const { rightPanelCollapsedAtom, setRightPanelCollapsedAtom } = await import('../layout')
    const { activeSessionIdAtom } = await import('../sessions')
    const store = createStore()
    store.set(activeSessionIdAtom, 'session_picker')
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Results)
    store.set(setRightPanelCollapsedAtom, true)
    store.set(backendSnapshotAtom, {
      state: BackendState.Ready,
      endpoint: {
        baseUrl: 'http://127.0.0.1:7421',
        token: 'test-token',
        version: null,
        startedAt: null,
        wsPath: null,
      },
      lastError: null,
    } as never)

    const added = mount('mnt_picker', 'brief.pdf', '/Users/amphi/brief.pdf')
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const request = new URL(String(input))
      if (request.pathname === '/sessions/session_picker/mounts') return jsonResponse(added)
      return jsonResponse({ detail: 'unexpected endpoint' }, 404)
    }) as never

    const restoreDialog = installDialogResult({
      canceled: false,
      filePaths: ['/Users/amphi/brief.pdf'],
    })

    try {
      const result = await store.set(pickAndMountAtom, {
        sessionId: 'session_picker',
        kind: 'file',
      })

      expect(result).toBe('session_picker')
      expect(store.get(mountsFamily('session_picker'))).toEqual([added])
      expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
      expect(store.get(rightPanelCollapsedAtom)).toBe(false)
      expect(store.get(filesNeedsAttentionFamily('session_picker'))).toBe(true)
    } finally {
      restoreDialog()
    }
  })

  it('marks a slow picker completion as background activity after a Session switch', async () => {
    const { pickAndMountAtom } = await import('../mounts')
    const { SessionWorkbenchSurface, sessionWorkbenchSurfaceAtom } = await import('../browser')
    const { filesNeedsAttentionFamily } = await import('../files-attention')
    const { rightPanelCollapsedAtom, setRightPanelCollapsedAtom } = await import('../layout')
    const { activeSessionIdAtom } = await import('../sessions')
    const store = createStore()
    const sourceSessionId = 'session_picker_slow'
    store.set(activeSessionIdAtom, sourceSessionId)
    store.set(setRightPanelCollapsedAtom, true)
    store.set(backendSnapshotAtom, {
      state: BackendState.Ready,
      endpoint: {
        baseUrl: 'http://127.0.0.1:7421',
        token: 'test-token',
        version: null,
        startedAt: null,
        wsPath: null,
      },
      lastError: null,
    } as never)
    globalThis.fetch = mock(async () => jsonResponse(
      mount('mnt_slow', 'slow.pdf', '/Users/amphi/slow.pdf'),
    )) as never

    let releaseDialog!: (result: DialogResult) => void
    const restoreDialog = installDialogOpen(mock(() => new Promise<DialogResult>((resolve) => {
      releaseDialog = resolve
    })))

    try {
      const pending = store.set(pickAndMountAtom, {
        sessionId: sourceSessionId,
        kind: 'file',
      })
      store.set(activeSessionIdAtom, 'session-picker-other')
      releaseDialog({ canceled: false, filePaths: ['/Users/amphi/slow.pdf'] })

      expect(await pending).toBe(sourceSessionId)
      expect(store.get(filesNeedsAttentionFamily(sourceSessionId))).toBe(true)

      store.set(activeSessionIdAtom, sourceSessionId)
      expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
      expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    } finally {
      restoreDialog()
    }
  })

  it('leaves the dock untouched when the picker is cancelled', async () => {
    const { pickAndMountAtom } = await import('../mounts')
    const {
      SessionWorkbenchSurface,
      sessionWorkbenchSurfaceAtom,
      setSessionWorkbenchSurfaceAtom,
    } = await import('../browser')
    const { filesNeedsAttentionFamily } = await import('../files-attention')
    const { rightPanelCollapsedAtom, setRightPanelCollapsedAtom } = await import('../layout')
    const { activeSessionIdAtom } = await import('../sessions')
    const store = createStore()
    store.set(activeSessionIdAtom, 'session_picker_cancelled')
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Results)
    store.set(setRightPanelCollapsedAtom, true)

    const restoreDialog = installDialogResult({ canceled: true, filePaths: [] })

    try {
      const result = await store.set(pickAndMountAtom, {
        sessionId: 'session_picker_cancelled',
        kind: 'file',
      })

      expect(result).toBeNull()
      expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Results)
      expect(store.get(rightPanelCollapsedAtom)).toBe(true)
      expect(store.get(filesNeedsAttentionFamily('session_picker_cancelled'))).toBe(false)
    } finally {
      restoreDialog()
    }
  })

  it('leaves the dock untouched when every selected path fails to mount', async () => {
    const { mountsFamily, pickAndMountAtom } = await import('../mounts')
    const {
      SessionWorkbenchSurface,
      sessionWorkbenchSurfaceAtom,
      setSessionWorkbenchSurfaceAtom,
    } = await import('../browser')
    const { filesNeedsAttentionFamily } = await import('../files-attention')
    const { rightPanelCollapsedAtom, setRightPanelCollapsedAtom } = await import('../layout')
    const { activeSessionIdAtom } = await import('../sessions')
    const store = createStore()
    store.set(activeSessionIdAtom, 'session_picker_failed')
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Results)
    store.set(setRightPanelCollapsedAtom, true)
    store.set(backendSnapshotAtom, {
      state: BackendState.Ready,
      endpoint: {
        baseUrl: 'http://127.0.0.1:7421',
        token: 'test-token',
        version: null,
        startedAt: null,
        wsPath: null,
      },
      lastError: null,
    } as never)
    globalThis.fetch = mock(async () => jsonResponse({ detail: 'mount failed' }, 500)) as never
    const restoreDialog = installDialogResult({
      canceled: false,
      filePaths: ['/Users/amphi/missing.pdf'],
    })

    try {
      const result = await store.set(pickAndMountAtom, {
        sessionId: 'session_picker_failed',
        kind: 'file',
      })

      expect(result).toBeNull()
      expect(store.get(mountsFamily('session_picker_failed'))).toEqual([])
      expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Results)
      expect(store.get(rightPanelCollapsedAtom)).toBe(true)
      expect(store.get(filesNeedsAttentionFamily('session_picker_failed'))).toBe(false)
    } finally {
      restoreDialog()
    }
  })
})
