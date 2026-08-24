import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ElectronAPI, EmbeddedBrowserTabInfo } from '@shared/types'
import { DEFAULT_SETTINGS } from '@app/shared/types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const browserCalls: string[] = []
let nativeWindowForeground = true
let onWindowForegroundChanged: ((foreground: boolean) => void) | null = null
const emptyTab: EmbeddedBrowserTabInfo = {
  tabId: 'tab-created',
  targetId: 'target-created',
  webContentsId: 12,
  title: '新标签页',
  url: 'about:blank',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  faviconUrl: null,
  crashed: false,
}
const defaultSetVisible: ElectronAPI['browser']['setVisible'] = async () => undefined
const browserApi: ElectronAPI['browser'] = {
  snapshot: async () => ({ sessions: [] }),
  closeSession: async () => undefined,
  activateSession: async () => undefined,
  createTab: async (sessionId) => {
    browserCalls.push(sessionId)
    return emptyTab
  },
  activateTab: async () => undefined,
  closeTab: async () => undefined,
  navigateTab: async () => undefined,
  goBack: async () => undefined,
  goForward: async () => undefined,
  reload: async () => undefined,
  hasHorizontalOverflow: async () => false,
  setBounds: async () => undefined,
  setVisible: defaultSetVisible,
}
;(window as typeof window & { api: ElectronAPI }).api = {
  browser: browserApi,
  events: {
    onWindowForegroundChanged: (callback: (foreground: boolean) => void) => {
      onWindowForegroundChanged = callback
      return () => { onWindowForegroundChanged = null }
    },
  },
  settings: {
    get: async () => DEFAULT_SETTINGS,
    set: async () => undefined,
  },
  window: {
    isForeground: async () => nativeWindowForeground,
  },
} as unknown as ElectronAPI

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const {
  applyAgentEventAtom,
  streamingFamily,
  thinkingModeFamily,
  workflowRunFamily,
} = await import('@/atoms/agent')
const { briefFamily, openSpecPreviewAtom } = await import('@/atoms/build')
const {
  browserSurfaceBlockedAtom,
  embeddedBrowserSnapshotAtom,
  SessionWorkbenchSurface,
  sessionWorkbenchSurfaceAtom,
  setBrowserSurfaceBlockerAtom,
  setEmbeddedBrowserSnapshotAtom,
  setSessionWorkbenchSurfaceAtom,
} = await import('@/atoms/browser')
const { notifySessionWorkbenchActivityAtom } = await import('@/atoms/workbench')
const {
  filesNeedsAttentionFamily,
  setFilesNeedsAttentionAtom,
} = await import('@/atoms/files-attention')
const { browserNeedsAttentionFamily } = await import('@/atoms/browser-attention')
const {
  requestRightPanelCollapseAtom,
  rightPanelCollapseRequestAtom,
  rightPanelCollapsedAtom,
  setRightPanelCollapsedAtom,
} = await import('@/atoms/layout')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { i18n } = await import('@/lib/i18n')
const {
  BrowserAttentionAnnouncer,
  FilesAttentionAnnouncer,
  SessionResourcePanel,
} = await import('../SessionResourcePanel')

beforeEach(async () => {
  nativeWindowForeground = true
  await i18n.changeLanguage('zh')
})

afterEach(() => {
  browserCalls.length = 0
  browserApi.setVisible = defaultSetVisible
  onWindowForegroundChanged = null
  document.body.replaceChildren()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function browserSnapshot(sessionId: string, tab: EmbeddedBrowserTabInfo = emptyTab) {
  return {
    sessions: [{ sessionId, activeTabId: tab.tabId, tabs: [tab] }],
  }
}

function startBrowserTool(
  store: ReturnType<typeof createStore>,
  sessionId: string,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown> = {},
): void {
  const messageId = `stream-${toolUseId}`
  store.set(applyAgentEventAtom, {
    sessionId,
    event: { type: 'message_start', messageId, role: 'assistant' },
  })
  store.set(applyAgentEventAtom, {
    sessionId,
    event: { type: 'tool_call', messageId, toolUseId, toolName, input },
  })
}

function finishBrowserTool(
  store: ReturnType<typeof createStore>,
  sessionId: string,
  toolUseId: string,
  output: string,
  durationMs = 20,
): void {
  store.set(applyAgentEventAtom, {
    sessionId,
    event: { type: 'tool_result', toolUseId, output, isError: false, durationMs },
  })
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function deferredFailure() {
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((_resolve, rejectPromise) => {
    reject = rejectPromise
  })
  return { promise, reject }
}

async function mountPanel(store: ReturnType<typeof createStore>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <Provider store={store}>
        <BrowserAttentionAnnouncer />
        <FilesAttentionAnnouncer />
        <SessionResourcePanel />
      </Provider>,
    )
    await Promise.resolve()
  })
  return { host, root }
}

describe('SessionResourcePanel', () => {
  it('keeps one permanent Bridgic launcher above five undivided independent tools', async () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-tools')
    const { host, root } = await mountPanel(store)

    const launcher = host.querySelector<HTMLButtonElement>('[data-testid="session-agent-launcher"]')
    expect(launcher).not.toBeNull()
    expect(launcher?.textContent).toContain('Bridgic')
    expect(host.querySelectorAll('[data-testid="session-agent-divider"]')).toHaveLength(1)
    const agentDivider = host.querySelector<HTMLElement>('[data-testid="session-agent-divider"]')!
    expect(agentDivider.className).toContain('bg-border-strong')
    expect(agentDivider.className).toContain('my-1')

    const toolIds = Array.from(
      host.querySelectorAll('[data-testid="session-surface-rail"] [role="tab"]'),
    ).map((tab) => tab.getAttribute('data-testid'))
    expect(toolIds).toEqual([
      'session-workbench-files',
      'session-workbench-workflows',
      'session-workbench-results',
      'session-workbench-presentation',
      'session-workbench-browser',
    ])
    const toolList = host.querySelector('[data-testid="session-workbench-files"]')?.parentElement
    expect(toolList?.querySelectorAll(':scope > [role="tab"]')).toHaveLength(5)
    expect(toolList?.children).toHaveLength(5)

    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    const files = host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-files"]')!
    const filesStatus = files.querySelector<HTMLElement>(
      '[data-testid="session-workbench-files-status-indicator"]',
    )
    expect(files.className).toContain('bg-bg-selected')
    expect(filesStatus?.dataset.state).toBe('active')
    expect(filesStatus?.className).toContain('-right-[3px]')
    expect(filesStatus?.className).toContain('h-5')
    expect(filesStatus?.className).toContain('bg-text-secondary/65')
    expect(files.querySelector('.left-0')).toBeNull()
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden')).toBe('false')
    expect(host.querySelector('[data-testid="session-workbench-workflows-content"]')?.getAttribute('aria-hidden')).toBe('true')
    expect(host.querySelector('[data-testid="session-files-panel"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="workflow-library-panel"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="workflow-results-tool"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="schedule-workbench-tool"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="presentation-workbench-panel"]')).not.toBeNull()

    const workflows = host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-workflows"]')!
    await act(async () => workflows.click())
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Workflows)
    expect(workflows.className).toContain('bg-bg-selected')
    expect(workflows.querySelector('[data-testid="session-workbench-workflows-status-indicator"]')?.getAttribute('data-state')).toBe('active')
    expect(files.querySelector('[data-testid="session-workbench-files-status-indicator"]')).toBeNull()
    expect(host.querySelector('[data-testid="session-workbench-workflows-content"]')?.getAttribute('aria-hidden')).toBe('false')

    await act(async () => workflows.click())
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(host.querySelector('[data-testid="session-surface-rail"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="session-workbench-workflows-content"]')?.getAttribute('aria-hidden')).toBe('true')

    await act(async () => root.unmount())
  })

  it('consumes a global collapse request for an ordinary renderer surface', async () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-global-collapse')
    const { host, root } = await mountPanel(store)

    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden'))
      .toBe('false')

    await act(async () => store.set(requestRightPanelCollapseAtom))

    expect(store.get(rightPanelCollapseRequestAtom)).toBe(false)
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden'))
      .toBe('true')

    await act(async () => root.unmount())
  })

  it('keeps Files attention when an attachment completion races a panel collapse', async () => {
    const store = createStore()
    const sessionId = 'session-attachment-collapse-race'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setRightPanelCollapsedAtom, true)
    const { host, root } = await mountPanel(store)

    await act(async () => {
      store.set(notifySessionWorkbenchActivityAtom, {
        agentModeHasPriority: false,
        sessionId,
        surface: SessionWorkbenchSurface.Files,
      })
      store.set(requestRightPanelCollapseAtom)
    })

    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(store.get(filesNeedsAttentionFamily(sessionId))).toBe(true)
    expect(host.querySelector('[data-testid="session-workbench-files"]')?.className)
      .toContain('animate-surface-attention')

    await act(async () => root.unmount())
  })

  it('reveals Files when the right column is empty and stays quiet while Files is visible', async () => {
    const store = createStore()
    const sessionId = 'session-attachment-reveal'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Results)
    store.set(setRightPanelCollapsedAtom, true)
    const { host, root } = await mountPanel(store)

    await act(async () => {
      store.set(notifySessionWorkbenchActivityAtom, {
        agentModeHasPriority: false,
        sessionId,
        surface: SessionWorkbenchSurface.Files,
      })
    })

    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(filesNeedsAttentionFamily(sessionId))).toBe(false)
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden'))
      .toBe('false')

    await act(async () => {
      store.set(notifySessionWorkbenchActivityAtom, {
        agentModeHasPriority: false,
        sessionId,
        surface: SessionWorkbenchSurface.Files,
      })
    })

    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(filesNeedsAttentionFamily(sessionId))).toBe(false)

    await act(async () => root.unmount())
  })

  it('keeps the first simultaneous activity in front and flashes the other tool', async () => {
    const store = createStore()
    const sessionId = 'session-simultaneous-files-browser'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setRightPanelCollapsedAtom, true)
    const { host, root } = await mountPanel(store)

    await act(async () => {
      store.set(notifySessionWorkbenchActivityAtom, {
        agentModeHasPriority: false,
        sessionId,
        surface: SessionWorkbenchSurface.Files,
      })
      store.set(notifySessionWorkbenchActivityAtom, {
        agentModeHasPriority: false,
        sessionId,
        surface: SessionWorkbenchSurface.Browser,
      })
    })

    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(filesNeedsAttentionFamily(sessionId))).toBe(false)
    expect(store.get(browserNeedsAttentionFamily(sessionId))).toBe(true)
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden'))
      .toBe('false')
    expect(host.querySelector('[data-testid="session-workbench-browser"]')?.className)
      .toContain('animate-surface-attention')

    await act(async () => root.unmount())
  })

  it('lets a simultaneously arriving Agent surface cover Files without losing its attention', async () => {
    const store = createStore()
    const sessionId = 'session-simultaneous-files-agent'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setRightPanelCollapsedAtom, true)
    const { host, root } = await mountPanel(store)

    await act(async () => {
      store.set(notifySessionWorkbenchActivityAtom, {
        agentModeHasPriority: false,
        sessionId,
        surface: SessionWorkbenchSurface.Files,
      })
      store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'clarify' })
      store.set(briefFamily(sessionId), '# Agent 抢占')
      store.set(openSpecPreviewAtom)
    })

    expect(host.querySelector('[data-testid="session-mode-surface"]')).not.toBeNull()
    expect(host.textContent).toContain('Agent 抢占')
    expect(store.get(filesNeedsAttentionFamily(sessionId))).toBe(true)
    expect(host.querySelector('[data-testid="session-workbench-files"]')?.className)
      .toContain('animate-surface-attention')

    await act(async () => root.unmount())
  })

  it('keeps a visible native Browser in front and flashes Files in the background', async () => {
    const visibilityCalls: Array<{ focusHost?: boolean; visible: boolean }> = []
    browserApi.setVisible = async (visible, focusHost) => {
      visibilityCalls.push({ focusHost, visible })
    }
    const store = createStore()
    const sessionId = 'session-attachment-browser-handoff'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)
    visibilityCalls.length = 0

    await act(async () => {
      store.set(notifySessionWorkbenchActivityAtom, {
        agentModeHasPriority: false,
        sessionId,
        surface: SessionWorkbenchSurface.Files,
      })
    })

    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Browser)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(filesNeedsAttentionFamily(sessionId))).toBe(true)
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden'))
      .toBe('true')
    const files = host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-files"]')!
    expect(files.className).toContain('animate-surface-attention')
    expect(files.getAttribute('aria-label')).toBe('已添加新文件，点击查看')
    expect(document.body.querySelector('[data-testid="files-attention-status"]')?.textContent)
      .toBe('已添加新文件，点击查看')
    expect(visibilityCalls.some((call) => !call.visible)).toBe(false)

    await act(async () => root.unmount())
  })

  it('keeps another renderer tool in front and clears Files attention after Files is shown', async () => {
    const store = createStore()
    const sessionId = 'session-attachment-results-background'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Results)
    const { host, root } = await mountPanel(store)

    await act(async () => {
      store.set(notifySessionWorkbenchActivityAtom, {
        agentModeHasPriority: false,
        sessionId,
        surface: SessionWorkbenchSurface.Files,
      })
    })

    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Results)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(filesNeedsAttentionFamily(sessionId))).toBe(true)
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden'))
      .toBe('true')

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-files"]')?.click()
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    expect(store.get(filesNeedsAttentionFamily(sessionId))).toBe(false)
    expect(host.querySelector('[data-testid="session-workbench-files"]')?.className)
      .not.toContain('animate-surface-attention')

    await act(async () => root.unmount())
  })

  it('never lets Files activity replace the foreground Agent surface', async () => {
    const store = createStore()
    const sessionId = 'session-attachment-agent-foreground'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'clarify' })
    store.set(briefFamily(sessionId), '# 任务定义\n\nAgent 保持前台。')
    store.set(openSpecPreviewAtom)
    const { host, root } = await mountPanel(store)

    await act(async () => {
      store.set(notifySessionWorkbenchActivityAtom, {
        agentModeHasPriority: true,
        sessionId,
        surface: SessionWorkbenchSurface.Files,
      })
    })

    expect(host.querySelector('[data-testid="session-mode-surface"]')).not.toBeNull()
    expect(host.textContent).toContain('Agent 保持前台')
    expect(store.get(filesNeedsAttentionFamily(sessionId))).toBe(true)
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden'))
      .toBe('true')

    await act(async () => root.unmount())
  })

  it('keeps Files collapsed and flashes it while an Agent mode is available', async () => {
    const store = createStore()
    const sessionId = 'session-attachment-agent-available'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'explore' })
    store.set(briefFamily(sessionId), '# 任务定义\n\nAgent 可用。')
    store.set(setRightPanelCollapsedAtom, true)
    const { host, root } = await mountPanel(store)

    await act(async () => {
      store.set(notifySessionWorkbenchActivityAtom, {
        agentModeHasPriority: true,
        sessionId,
        surface: SessionWorkbenchSurface.Files,
      })
    })

    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(store.get(filesNeedsAttentionFamily(sessionId))).toBe(true)
    expect(host.querySelector('[data-testid="session-agent-status-indicator"]')?.getAttribute('data-state'))
      .toBe('background-open')
    expect(host.querySelector('[data-testid="session-workbench-files"]')?.className)
      .toContain('animate-surface-attention')

    await act(async () => root.unmount())
  })

  it('does not auto-open a Files notice that completed after the user switched Sessions', async () => {
    const store = createStore()
    const sourceSessionId = 'session-attachment-background'
    store.set(activeSessionIdAtom, 'session-current')
    const { host, root } = await mountPanel(store)

    store.set(notifySessionWorkbenchActivityAtom, {
      agentModeHasPriority: false,
      sessionId: sourceSessionId,
      surface: SessionWorkbenchSurface.Files,
    })
    await act(async () => {
      store.set(activeSessionIdAtom, sourceSessionId)
      store.set(setRightPanelCollapsedAtom, true)
    })

    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(store.get(filesNeedsAttentionFamily(sourceSessionId))).toBe(true)
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden'))
      .toBe('true')
    expect(host.querySelector('[data-testid="session-workbench-files"]')?.className)
      .toContain('animate-surface-attention')

    await act(async () => root.unmount())
  })

  it('holds Files attention until an automatically opened Files surface is truly visible', async () => {
    nativeWindowForeground = false
    const store = createStore()
    const sessionId = 'session-attachment-background-window'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setRightPanelCollapsedAtom, true)
    const { host, root } = await mountPanel(store)

    await act(async () => {
      store.set(notifySessionWorkbenchActivityAtom, {
        agentModeHasPriority: false,
        sessionId,
        surface: SessionWorkbenchSurface.Files,
      })
    })

    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(filesNeedsAttentionFamily(sessionId))).toBe(true)
    expect(host.querySelector('[data-testid="session-workbench-files"]')?.className)
      .toContain('animate-surface-attention')

    await act(async () => {
      nativeWindowForeground = true
      onWindowForegroundChanged?.(true)
      await Promise.resolve()
    })
    expect(store.get(filesNeedsAttentionFamily(sessionId))).toBe(false)

    await act(async () => root.unmount())
  })

  it('keeps the Bridgic launcher inert until an Agent mode surface is available', async () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-agent-unavailable')
    const { host, root } = await mountPanel(store)

    const launcher = host.querySelector<HTMLButtonElement>('[data-testid="session-agent-launcher"]')!
    expect(launcher.className).toContain('border-transparent')
    expect(launcher.disabled).toBe(true)
    expect(launcher.getAttribute('aria-controls')).toBeNull()
    expect(launcher.getAttribute('aria-expanded')).toBeNull()
    expect(launcher.querySelector('[data-testid="session-agent-status-indicator"]')).toBeNull()
    await act(async () => launcher.click())

    expect(host.querySelector('[data-testid="session-mode-surface"]')).toBeNull()
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    expect(document.body.querySelector('[data-testid="session-agent-tip"]')).toBeNull()

    await act(async () => root.unmount())
  })

  it('keeps Browser selected and unblocked when the unavailable Agent launcher is clicked', async () => {
    const store = createStore()
    const sessionId = 'session-browser-agent-unavailable'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)

    const launcher = host.querySelector<HTMLButtonElement>('[data-testid="session-agent-launcher"]')!
    expect(launcher.disabled).toBe(true)
    await act(async () => {
      launcher.click()
      await Promise.resolve()
    })

    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Browser)
    expect(store.get(browserSurfaceBlockedAtom)).toBe(false)
    expect(host.querySelector('[data-testid="session-workbench-browser-content"]')?.getAttribute('aria-hidden'))
      .toBe('false')
    expect(document.body.querySelector('[data-testid="session-agent-tip"]')).toBeNull()

    await act(async () => root.unmount())
  })

  it('uses the same static Bridgic launcher to open and collapse an available Build task', async () => {
    const store = createStore()
    const sessionId = 'session-build-task'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'clarify' })
    store.set(briefFamily(sessionId), '# 任务定义\n\n保留静态 Bridgic 标识。')
    const { host, root } = await mountPanel(store)

    const launcher = host.querySelector<HTMLButtonElement>('[data-testid="session-agent-launcher"]')!
    expect(launcher.textContent).toContain('Bridgic')
    expect(host.querySelector('[data-testid="session-mode-surface"]')).toBeNull()
    expect(launcher.querySelector('[data-testid="session-agent-status-indicator"]')?.getAttribute('data-state')).toBe('background-open')
    expect(launcher.querySelector('[data-testid="session-agent-status-indicator"]')?.className).toContain('bg-text-secondary/65')

    await act(async () => launcher.click())
    expect(host.querySelector('[data-testid="session-mode-surface"]')).not.toBeNull()
    expect(host.textContent).toContain('保留静态 Bridgic 标识')
    expect(launcher.textContent).toContain('Bridgic')
    expect(launcher.className).toContain('bg-bg-selected')
    expect(launcher.querySelector('[data-testid="session-agent-status-indicator"]')?.getAttribute('data-state')).toBe('active')
    expect(launcher.querySelector('[data-testid="session-agent-status-indicator"]')?.className).toContain('bg-text-secondary/65')
    expect(launcher.querySelector('.left-0')).toBeNull()

    await act(async () => launcher.click())
    expect(host.querySelector('[data-testid="session-mode-surface"]')).toBeNull()
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(launcher.querySelector('[data-testid="session-agent-status-indicator"]')?.getAttribute('data-state')).toBe('background-open')

    await act(async () => root.unmount())
  })

  it('uses the same static Bridgic launcher to open an active Workflow Run', async () => {
    const store = createStore()
    const sessionId = 'session-run-details'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'run_workflow', stage: 'execute' })
    store.set(workflowRunFamily(sessionId), {
      workflowId: 'wf-details',
      generation: 'gen-details',
      workflowName: '目录统计',
      sourceSessionId: sessionId,
      phase: 'execute',
      stepIndex: 0,
      executionSteps: ['读取目录', '生成报告'],
      validationSteps: ['检查报告'],
    })
    const { host, root } = await mountPanel(store)

    const launcher = host.querySelector<HTMLButtonElement>('[data-testid="session-agent-launcher"]')!
    expect(launcher.textContent).toContain('Bridgic')
    expect(launcher.querySelector('[data-testid="session-agent-status-indicator"]')?.getAttribute('data-state')).toBe('background-open')
    await act(async () => launcher.click())

    expect(host.querySelector('[data-testid="workflow-run-details-pane"]')).not.toBeNull()
    expect(launcher.textContent).toContain('Bridgic')
    expect(launcher.querySelector('[data-testid="session-agent-status-indicator"]')?.getAttribute('data-state')).toBe('active')
    expect(Array.from(host.querySelectorAll('[data-testid="session-surface-rail"] [role="tab"]')).map((tab) => tab.getAttribute('data-testid')))
      .toEqual([
        'session-workbench-files',
        'session-workbench-workflows',
        'session-workbench-results',
        'session-workbench-presentation',
        'session-workbench-browser',
      ])

    await act(async () => root.unmount())
  })

  it('closes and collapses a foreground Build pane when Build exits', async () => {
    const store = createStore()
    const sessionId = 'session-build-completed'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Workflows)
    store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'verify' })
    store.set(briefFamily(sessionId), '# 任务定义\n\n保留完成后的构建结果。')
    store.set(streamingFamily(sessionId), {
      messageId: 'stream-build-completed',
      content: '',
      toolCalls: [],
      blocks: [
        {
          type: 'task_confirm',
          requestId: 'task-build-completed',
          taskMarkdown: '# 任务定义\n\n保留完成后的构建结果。',
          status: 'confirmed',
        },
        {
          type: 'workflow_confirm',
          requestId: 'workflow-build-completed',
          defaultName: '构建完成测试',
          status: 'continued',
        },
      ],
      startedAt: Date.now(),
    })
    const { host, root } = await mountPanel(store)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="session-agent-launcher"]')?.click()
    })
    expect(host.querySelector('[data-testid="session-mode-surface"]')).not.toBeNull()

    await act(async () => {
      store.set(applyAgentEventAtom, {
        sessionId,
        event: { type: 'stage', position: { mode: 'normal', stage: null } },
      })
    })

    expect(host.querySelector('[data-testid="session-mode-surface"]')).toBeNull()
    expect(host.querySelector('[data-testid="session-mode-completion-handoff"]')).toBeNull()
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Workflows)
    expect(host.querySelector('[data-testid="session-workbench-workflows-content"]')?.getAttribute('aria-hidden')).toBe('true')

    await act(async () => root.unmount())
  })

  it('preserves a workbench tool the user selected while Build was running', async () => {
    const store = createStore()
    const sessionId = 'session-build-user-takeover'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'clarify' })
    store.set(briefFamily(sessionId), '# 任务定义\n\n用户在构建时查看工作流。')
    const { host, root } = await mountPanel(store)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="session-agent-launcher"]')?.click()
    })
    expect(host.querySelector('[data-testid="session-mode-surface"]')).not.toBeNull()

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-workflows"]')?.click()
      await Promise.resolve()
    })
    expect(host.querySelector('[data-testid="session-mode-surface"]')).toBeNull()
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Workflows)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(host.querySelector('[data-testid="session-agent-status-indicator"]')?.getAttribute('data-state')).toBe('background-open')

    await act(async () => {
      store.set(applyAgentEventAtom, {
        sessionId,
        event: { type: 'stage', position: { mode: 'normal', stage: null } },
      })
    })

    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(host.querySelector('[data-testid="session-agent-status-indicator"]')).toBeNull()
    expect(host.querySelector('[data-testid="session-workbench-workflows-content"]')?.getAttribute('aria-hidden')).toBe('false')

    await act(async () => root.unmount())
  })

  it('closes and collapses a foreground Workflow Run pane when Run exits', async () => {
    const store = createStore()
    const sessionId = 'session-run-completed'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Results)
    store.set(thinkingModeFamily(sessionId), { mode: 'run_workflow', stage: 'validate' })
    store.set(workflowRunFamily(sessionId), {
      workflowId: 'wf-completed',
      generation: 'gen-completed',
      workflowName: '完成态测试',
      sourceSessionId: sessionId,
      phase: 'validate',
      stepIndex: 0,
      executionSteps: ['执行任务'],
      validationSteps: ['检查结果'],
    })
    store.set(streamingFamily(sessionId), {
      messageId: 'stream-run-completed',
      content: '',
      toolCalls: [],
      blocks: [{
        type: 'workflow_result',
        runId: 'run-completed',
        workflowId: 'wf-completed',
        workflowName: '完成态测试',
        status: 'completed',
        validationStatus: 'passed',
        createdAt: '2026-08-13T08:00:00Z',
        summary: '运行与验证完成',
      }],
      startedAt: Date.now(),
    })
    const { host, root } = await mountPanel(store)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="session-agent-launcher"]')?.click()
    })
    expect(host.querySelector('[data-testid="workflow-run-details-pane"]')).not.toBeNull()

    await act(async () => {
      store.set(applyAgentEventAtom, {
        sessionId,
        event: { type: 'stage', position: { mode: 'normal', stage: null } },
      })
    })

    expect(host.querySelector('[data-testid="session-mode-surface"]')).toBeNull()
    expect(host.querySelector('[data-testid="session-mode-completion-handoff"]')).toBeNull()
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Results)
    expect(host.querySelector('[data-testid="session-workbench-results-content"]')?.getAttribute('aria-hidden')).toBe('true')

    await act(async () => root.unmount())
  })

  it('makes an unresolved browser_open visibly busy before the first Browser tab exists', async () => {
    const store = createStore()
    const sessionId = 'session-browser-first-open'
    store.set(activeSessionIdAtom, sessionId)
    startBrowserTool(
      store,
      sessionId,
      'tool-open',
      'browser_open',
      { url: 'https://example.com' },
    )
    const { host, root } = await mountPanel(store)

    const browserButton = host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-browser"]')
    expect(store.get(embeddedBrowserSnapshotAtom).sessions).toHaveLength(0)
    expect(browserButton?.getAttribute('aria-busy')).toBe('true')
    expect(browserButton?.getAttribute('aria-label')).toBe('Bridgic 正在操作浏览器')
    expect(browserButton?.textContent).toContain('操作中')
    expect(browserButton?.className).toContain('bg-status-warning-bg')
    expect(browserButton?.className).toContain('animate-surface-attention')
    expect(browserButton?.className).toContain('motion-reduce:animate-none')
    expect(browserButton?.getAttribute('data-attention')).toBe('true')
    expect(host.querySelector('[data-testid="session-workbench-browser-status-indicator"]')?.getAttribute('data-state')).toBe('attention')
    expect(host.querySelector('[data-testid="browser-activity-notice"]')).toBeNull()
    expect(browserButton?.querySelector('.animate-pulse')).toBeNull()
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)

    await act(async () => {
      store.set(setEmbeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
      await Promise.resolve()
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden')).toBe('false')
    expect(host.querySelector('[data-testid="session-workbench-browser-content"]')?.getAttribute('aria-hidden')).toBe('true')

    await act(async () => {
      store.set(streamingFamily(sessionId), {
        messageId: 'stream-snapshot',
        content: '',
        toolCalls: [{ toolUseId: 'tool-snapshot', name: 'browser_snapshot', input: {} }],
        blocks: [],
        startedAt: Date.now(),
      })
    })
    expect(browserButton?.getAttribute('aria-busy')).toBe('true')
    expect(host.querySelector('[data-testid="session-workbench-browser-status-indicator"]')?.getAttribute('data-state')).toBe('attention')
    expect(host.querySelector('[data-testid="browser-activity-notice"]')).toBeNull()
    expect(browserButton?.querySelector('.animate-pulse')).toBeNull()

    await act(async () => root.unmount())
  })

  it('uses one right-edge rail for background-open and focused tool states', async () => {
    const store = createStore()
    const sessionId = 'session-browser-open-page'
    store.set(activeSessionIdAtom, sessionId)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)

    const browserButton = host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-browser"]')
    const backgroundIndicator = browserButton?.querySelector<HTMLElement>(
      '[data-testid="session-workbench-browser-status-indicator"]',
    )
    expect(browserButton?.textContent).toContain('浏览器')
    expect(browserButton?.getAttribute('aria-busy')).toBeNull()
    expect(host.querySelector('[data-testid="browser-attention-status"]')?.textContent).toBe('')
    expect(backgroundIndicator?.dataset.state).toBe('background-open')
    expect(backgroundIndicator?.className).toContain('-right-[3px]')
    expect(backgroundIndicator?.className).toContain('h-5')
    expect(backgroundIndicator?.className).toContain('w-0.5')
    expect(backgroundIndicator?.className).toContain('bg-text-secondary/65')
    expect(browserButton?.querySelector('svg rect')).toBeNull()

    await act(async () => {
      browserButton?.click()
      await Promise.resolve()
    })
    expect(browserButton?.getAttribute('aria-selected')).toBe('true')
    expect(browserButton?.className).toContain('bg-bg-selected')
    expect(browserButton?.querySelector('.left-0')).toBeNull()
    const activeIndicator = browserButton?.querySelector<HTMLElement>(
      '[data-testid="session-workbench-browser-status-indicator"]',
    )
    expect(activeIndicator?.dataset.state).toBe('active')
    expect(activeIndicator?.className).toContain('-right-[3px]')
    expect(activeIndicator?.className).toContain('bg-text-secondary/65')
    await act(async () => {
      browserButton?.click()
      await Promise.resolve()
    })

    await act(async () => root.unmount())
  })

  it('keeps foreground Browser activity blue without raising unseen attention', async () => {
    const store = createStore()
    const sessionId = 'session-browser-foreground-action'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)
    await act(async () => {
      startBrowserTool(
        store,
        sessionId,
        'tool-foreground',
        'browser_click',
        { ref: 'target' },
      )
    })

    const browserButton = host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-browser"]')!
    expect(browserButton.getAttribute('aria-busy')).toBe('true')
    expect(browserButton.getAttribute('data-attention')).toBeNull()
    expect(browserButton.className).toContain('bg-accent-blue-subtle')
    expect(browserButton.className).not.toContain('animate-surface-attention')
    expect(browserButton.querySelector('.animate-pulse')).not.toBeNull()

    await act(async () => root.unmount())
  })

  it('never announces a foreground Browser action as unseen activity', async () => {
    const store = createStore()
    const sessionId = 'session-browser-foreground-no-announcement'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)
    const status = host.querySelector<HTMLElement>('[data-testid="browser-attention-status"]')!
    const nonEmptyMutations: string[] = []
    const observer = new MutationObserver(() => {
      if (status.textContent) nonEmptyMutations.push(status.textContent)
    })
    observer.observe(status, { childList: true, characterData: true, subtree: true })

    await act(async () => {
      startBrowserTool(store, sessionId, 'tool-foreground-announcement', 'browser_click')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(status.textContent).toBe('')
    expect(nonEmptyMutations).toEqual([])
    observer.disconnect()
    await act(async () => root.unmount())
  })

  it('holds Browser attention while the native host window is in the background', async () => {
    nativeWindowForeground = false
    const store = createStore()
    const sessionId = 'session-browser-native-window-background'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)

    await act(async () => {
      startBrowserTool(store, sessionId, 'tool-background', 'browser_new_tab')
    })

    const browserButton = host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-browser"]')!
    expect(browserButton.getAttribute('data-attention')).toBe('true')
    expect(browserButton.className).toContain('bg-status-warning-bg')
    expect(host.querySelector('[data-testid="browser-attention-status"]')?.textContent).toBe('浏览器有新动态，点击查看')

    await act(async () => {
      nativeWindowForeground = true
      onWindowForegroundChanged?.(true)
    })
    expect(browserButton.getAttribute('data-attention')).toBeNull()
    expect(host.querySelector('[data-testid="browser-attention-status"]')?.textContent).toBe('')

    await act(async () => root.unmount())
  })

  it('does not relatch a foreground close after the final Browser tab disappears', async () => {
    const store = createStore()
    const sessionId = 'session-browser-foreground-final-tab-close'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)
    const browserButton = host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-browser"]')!

    await act(async () => {
      startBrowserTool(store, sessionId, 'tool-foreground-close', 'browser_close_tab')
    })
    expect(browserButton.getAttribute('data-attention')).toBeNull()

    await act(async () => {
      store.set(setEmbeddedBrowserSnapshotAtom, {
        sessions: [{ sessionId, activeTabId: null, tabs: [] }],
      })
    })
    expect(browserButton.getAttribute('data-attention')).toBeNull()

    await act(async () => {
      finishBrowserTool(store, sessionId, 'tool-foreground-close', 'closed')
    })
    expect(browserButton.getAttribute('data-attention')).toBeNull()
    expect(host.querySelector('[data-testid="browser-attention-status"]')?.textContent).toBe('')

    await act(async () => root.unmount())
  })

  it('holds attention while a renderer surface blocks the native Browser', async () => {
    const store = createStore()
    const sessionId = 'session-browser-surface-blocked'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)

    try {
      await act(async () => {
        store.set(setBrowserSurfaceBlockerAtom, { source: 'test-overlay', blocked: true })
      })
      await act(async () => {
        startBrowserTool(
          store,
          sessionId,
          'tool-blocked',
          'browser_click',
          { ref: 'target' },
        )
      })

      const browserButton = host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-browser"]')!
      expect(browserButton.getAttribute('data-attention')).toBe('true')
      expect(browserButton.className).toContain('bg-status-warning-bg')
      expect(host.querySelector('[data-testid="browser-attention-status"]')?.getAttribute('role')).toBe('status')
      expect(host.querySelector('[data-testid="browser-attention-status"]')?.textContent).toBe('浏览器有新动态，点击查看')

      await act(async () => {
        store.set(setBrowserSurfaceBlockerAtom, { source: 'test-overlay', blocked: false })
      })
      expect(browserButton.getAttribute('data-attention')).toBeNull()
      expect(browserButton.className).toContain('bg-accent-blue-subtle')
      expect(host.querySelector('[data-testid="browser-attention-status"]')?.textContent).toBe('')
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('requests attention when a hidden page creates another tab', async () => {
    const store = createStore()
    const sessionId = 'session-browser-popup-background'
    store.set(activeSessionIdAtom, sessionId)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)

    const popupTab: EmbeddedBrowserTabInfo = {
      ...emptyTab,
      tabId: 'tab-popup',
      targetId: 'target-popup',
      webContentsId: 13,
    }
    await act(async () => {
      store.set(embeddedBrowserSnapshotAtom, {
        sessions: [{
          sessionId,
          activeTabId: emptyTab.tabId,
          tabs: [emptyTab, popupTab],
        }],
      })
    })

    const browserButton = host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-browser"]')!
    expect(browserButton.getAttribute('data-attention')).toBe('true')
    expect(browserButton.getAttribute('aria-label')).toBe('浏览器有新动态，点击查看')
    expect(browserButton.querySelector('[data-state="attention"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="browser-attention-status"]')?.textContent).toBe('浏览器有新动态，点击查看')

    await act(async () => root.unmount())
  })

  it('keeps one live region mounted while switching into a Session with Browser attention', async () => {
    const store = createStore()
    const firstSession = 'session-attention-a'
    const secondSession = 'session-attention-b'
    store.set(activeSessionIdAtom, firstSession)
    const { host, root } = await mountPanel(store)
    const status = host.querySelector<HTMLElement>('[data-testid="browser-attention-status"]')!

    await act(async () => {
      startBrowserTool(store, secondSession, 'tool-background-session', 'browser_new_tab')
    })
    expect(status.textContent).toBe('')

    await act(async () => {
      store.set(activeSessionIdAtom, secondSession)
      await Promise.resolve()
    })

    expect(host.querySelector('[data-testid="browser-attention-status"]')).toBe(status)
    expect(status.textContent).toBe('浏览器有新动态，点击查看')
    await act(async () => root.unmount())
  })

  it('stays visibly busy after the Browser tool returns while the active tab is still loading', async () => {
    const store = createStore()
    const sessionId = 'session-browser-loading-after-result'
    store.set(activeSessionIdAtom, sessionId)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId, { ...emptyTab, loading: true }))
    startBrowserTool(
      store,
      sessionId,
      'tool-loading',
      'browser_open',
      { url: 'https://example.com' },
    )
    const { host, root } = await mountPanel(store)

    const browserButton = host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-browser"]')
    expect(browserButton?.getAttribute('aria-label')).toBe('Bridgic 正在操作浏览器')

    await act(async () => {
      finishBrowserTool(store, sessionId, 'tool-loading', 'opened', 120)
    })

    expect(browserButton?.getAttribute('aria-busy')).toBe('true')
    expect(browserButton?.getAttribute('aria-label')).toBe('浏览器正在加载')
    expect(browserButton?.textContent).toContain('加载中')
    expect(browserButton?.className).toContain('bg-status-warning-bg')
    expect(host.querySelector('[data-testid="session-workbench-browser-status-indicator"]')?.getAttribute('data-state')).toBe('attention')
    expect(host.querySelector('[data-testid="browser-activity-notice"]')).toBeNull()

    await act(async () => root.unmount())
  })

  it('keeps the busy dwell brief but holds background attention until Browser is viewed', async () => {
    jest.useFakeTimers()
    const store = createStore()
    const sessionId = 'session-browser-activity-dwell'
    store.set(activeSessionIdAtom, sessionId)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)
    const browserButton = host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-browser"]')!

    try {
      await act(async () => {
        startBrowserTool(
          store,
          sessionId,
          'tool-click',
          'browser_click',
          { ref: 'target' },
        )
      })
      expect(browserButton.getAttribute('aria-busy')).toBe('true')

      await act(async () => {
        finishBrowserTool(store, sessionId, 'tool-click', 'clicked')
      })
      await act(async () => jest.advanceTimersByTime(399))
      expect(browserButton.getAttribute('aria-busy')).toBe('true')
      expect(browserButton.querySelector('.animate-pulse')).toBeNull()

      await act(async () => jest.advanceTimersByTime(1))
      expect(browserButton.getAttribute('aria-busy')).toBeNull()
      expect(browserButton.getAttribute('data-attention')).toBe('true')
      expect(browserButton.getAttribute('aria-label')).toBe('浏览器有新动态，点击查看')
      expect(browserButton.className).toContain('bg-status-warning-bg')

      await act(async () => {
        browserButton.click()
        await Promise.resolve()
      })
      expect(browserButton.getAttribute('data-attention')).toBeNull()
      expect(browserButton.className).toContain('bg-bg-selected')
    } finally {
      await act(async () => root.unmount())
      jest.useRealTimers()
    }
  })

  it('keeps attention after a background action closes the final tab until Browser is selected', async () => {
    const store = createStore()
    const sessionId = 'session-browser-background-final-tab-close'
    store.set(activeSessionIdAtom, sessionId)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)
    const browserButton = host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-browser"]')!

    await act(async () => {
      startBrowserTool(store, sessionId, 'tool-close-final', 'browser_close_tab')
    })
    await act(async () => {
      store.set(setEmbeddedBrowserSnapshotAtom, {
        sessions: [{ sessionId, activeTabId: null, tabs: [] }],
      })
    })

    expect(browserButton.getAttribute('data-attention')).toBe('true')
    expect(host.querySelector('[data-testid="browser-attention-status"]')).not.toBeNull()

    await act(async () => {
      browserButton.click()
      await Promise.resolve()
    })
    expect(browserButton.getAttribute('data-attention')).toBeNull()
    expect(host.querySelector('[data-testid="browser-attention-status"]')?.textContent).toBe('')

    await act(async () => {
      finishBrowserTool(store, sessionId, 'tool-close-final', 'closed')
    })
    expect(browserButton.getAttribute('data-attention')).toBeNull()

    await act(async () => root.unmount())
  })

  it('retracts an empty Browser after its final tab closes but preserves manual Browser selection', async () => {
    const store = createStore()
    const sessionId = 'session-browser-final-tab-close'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(setEmbeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)

    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(host.querySelector('[data-testid="session-workbench-browser-content"]')?.getAttribute('aria-hidden')).toBe('false')

    await act(async () => {
      store.set(setEmbeddedBrowserSnapshotAtom, {
        sessions: [{ sessionId, activeTabId: null, tabs: [] }],
      })
      await Promise.resolve()
    })

    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Browser)
    expect(host.querySelector('[data-testid="session-workbench-browser-content"]')?.getAttribute('aria-hidden')).toBe('true')

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-browser"]')?.click()
    })
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Browser)
    expect(host.querySelector('[data-testid="browser-launch-empty-state"]')).toBeNull()
    expect(host.querySelector('[data-testid="browser-canvas"]')).not.toBeNull()

    await act(async () => root.unmount())
  })

  it('does not retract a renderer tool chosen before the Browser final-tab snapshot arrives', async () => {
    const store = createStore()
    const sessionId = 'session-browser-close-after-tool-switch'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(setEmbeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-files"]')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)

    await act(async () => {
      store.set(setEmbeddedBrowserSnapshotAtom, { sessions: [] })
      await Promise.resolve()
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden')).toBe('false')

    await act(async () => root.unmount())
  })

  it('does not flicker closed when the final tab disappears during a tool handoff', async () => {
    const hidden = deferred()
    browserApi.setVisible = async (visible, focusHost) => {
      if (!visible && focusHost === true) await hidden.promise
    }
    const store = createStore()
    const sessionId = 'session-final-tab-during-tool-handoff'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(setEmbeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-files"]')?.click()
      await Promise.resolve()
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Browser)

    await act(async () => {
      store.set(setEmbeddedBrowserSnapshotAtom, { sessions: [] })
      await Promise.resolve()
    })
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)

    await act(async () => {
      hidden.release()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden')).toBe('false')

    await act(async () => root.unmount())
  })

  it('waits for native Browser hide acknowledgement before switching to any renderer tool', async () => {
    const hidden = deferred()
    browserApi.setVisible = async (visible, focusHost) => {
      if (!visible && focusHost === true) await hidden.promise
    }
    const store = createStore()
    const sessionId = 'session-browser-to-files'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    store.set(setFilesNeedsAttentionAtom, { sessionId, needsAttention: true })
    const { host, root } = await mountPanel(store)

    const files = host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-files"]')!
    await act(async () => files.click())

    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Browser)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(filesNeedsAttentionFamily(sessionId))).toBe(true)
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden')).toBe('true')

    await act(async () => {
      hidden.release()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    expect(store.get(filesNeedsAttentionFamily(sessionId))).toBe(false)
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden')).toBe('false')

    await act(async () => root.unmount())
  })

  it('recovers to Browser if the native surface cannot hide', async () => {
    browserApi.setVisible = async (visible, focusHost) => {
      if (!visible && focusHost === true) throw new Error('native hide failed')
    }
    const store = createStore()
    const sessionId = 'session-browser-hide-fails'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    store.set(setFilesNeedsAttentionAtom, { sessionId, needsAttention: true })
    const { host, root } = await mountPanel(store)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-files"]')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Browser)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(filesNeedsAttentionFamily(sessionId))).toBe(true)
    expect(host.querySelector('[data-testid="session-workbench-browser-content"]')?.getAttribute('aria-hidden')).toBe('false')
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden')).toBe('true')

    await act(async () => root.unmount())
  })

  it('finishes a pending Browser handoff when its native surface disappears', async () => {
    const hidden = deferred()
    browserApi.setVisible = async (visible, focusHost) => {
      if (!visible && focusHost === true) await hidden.promise
    }
    const store = createStore()
    const sessionId = 'session-browser-disappears'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-workflows"]')?.click()
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Browser)

    await act(async () => {
      store.set(embeddedBrowserSnapshotAtom, { sessions: [] })
      await Promise.resolve()
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Workflows)
    expect(host.querySelector('[data-testid="session-workbench-workflows-content"]')?.getAttribute('aria-hidden')).toBe('false')

    hidden.release()
    await act(async () => root.unmount())
  })

  it('gates a Build surface until the native Browser acknowledges hiding', async () => {
    const hidden = deferred()
    browserApi.setVisible = async (visible, focusHost) => {
      if (!visible && focusHost === true) await hidden.promise
    }
    const store = createStore()
    const sessionId = 'session-browser-to-task'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'clarify' })
    store.set(briefFamily(sessionId), '# 任务定义\n\n原生表面隐藏后才显示。')
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="session-agent-launcher"]')?.click()
    })
    expect(host.querySelector('[data-testid="session-mode-surface"]')?.getAttribute('aria-busy')).toBe('true')
    expect(host.textContent).not.toContain('原生表面隐藏后才显示')

    await act(async () => {
      hidden.release()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.querySelector('[data-testid="session-mode-surface"]')?.getAttribute('aria-busy')).toBe('false')
    expect(host.textContent).toContain('原生表面隐藏后才显示')

    await act(async () => root.unmount())
  })

  it('transfers mode ownership immediately while Browser-to-tool handoff stays pending', async () => {
    const hidden = deferred()
    browserApi.setVisible = async (visible, focusHost) => {
      if (!visible && focusHost === true) await hidden.promise
    }
    const store = createStore()
    const sessionId = 'session-mode-to-files-before-hide'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'clarify' })
    store.set(briefFamily(sessionId), '# 任务定义\n\n等待原生浏览器隐藏。')
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="session-agent-launcher"]')?.click()
      host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-files"]')?.click()
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Browser)
    expect(host.querySelector('[data-testid="session-mode-surface"]')).toBeNull()
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden')).toBe('true')

    await act(async () => {
      hidden.release()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    expect(host.querySelector('[data-testid="session-mode-surface"]')).toBeNull()
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden')).toBe('false')

    await act(async () => root.unmount())
  })

  it('preserves a tool takeover when Build exits during a native Browser handoff', async () => {
    const hidden = deferred()
    browserApi.setVisible = async (visible, focusHost) => {
      if (!visible && focusHost === true) await hidden.promise
    }
    const store = createStore()
    const sessionId = 'session-mode-exits-during-tool-takeover'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'clarify' })
    store.set(briefFamily(sessionId), '# 任务定义\n\n用户已切到文件。')
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="session-agent-launcher"]')?.click()
      host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-files"]')?.click()
      store.set(applyAgentEventAtom, {
        sessionId,
        event: { type: 'stage', position: { mode: 'normal', stage: null } },
      })
    })
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)

    await act(async () => {
      hidden.release()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Files)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(host.querySelector('[data-testid="session-mode-surface"]')).toBeNull()
    expect(host.querySelector('[data-testid="session-workbench-files-content"]')?.getAttribute('aria-hidden')).toBe('false')

    await act(async () => root.unmount())
  })

  it('recovers Browser when a retargeted mode handoff fails to hide the native surface', async () => {
    const hidden = deferredFailure()
    browserApi.setVisible = async (visible, focusHost) => {
      if (!visible && focusHost === true) await hidden.promise
    }
    const store = createStore()
    const sessionId = 'session-mode-retarget-hide-fails'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'clarify' })
    store.set(briefFamily(sessionId), '# 任务定义\n\n隐藏失败时恢复浏览器。')
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="session-agent-launcher"]')?.click()
      host.querySelector<HTMLButtonElement>('[data-testid="session-workbench-files"]')?.click()
      hidden.reject(new Error('native hide failed after retarget'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(store.get(sessionWorkbenchSurfaceAtom)).toBe(SessionWorkbenchSurface.Browser)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(host.querySelector('[data-testid="session-mode-surface"]')).toBeNull()
    expect(host.querySelector('[data-testid="session-workbench-browser-content"]')?.getAttribute('aria-hidden')).toBe('false')

    await act(async () => root.unmount())
  })

  it('retargets an in-flight Browser-to-mode handoff to a resize collapse', async () => {
    const hidden = deferred()
    browserApi.setVisible = async (visible, focusHost) => {
      if (!visible && focusHost === true) await hidden.promise
    }
    const store = createStore()
    const sessionId = 'session-browser-to-rail'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'clarify' })
    store.set(briefFamily(sessionId), '# 任务定义\n\n拖拽收起优先。')
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(embeddedBrowserSnapshotAtom, browserSnapshot(sessionId))
    const { host, root } = await mountPanel(store)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="session-agent-launcher"]')?.click()
    })
    await act(async () => store.set(requestRightPanelCollapseAtom))
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)

    await act(async () => {
      hidden.release()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(host.querySelector('[data-testid="session-mode-surface"]')).toBeNull()

    await act(async () => root.unmount())
  })

  it('remounts the Browser-to-mode gate for each viewed Session', async () => {
    const firstHide = deferred()
    const secondHide = deferred()
    const hideQueue = [firstHide, secondHide]
    browserApi.setVisible = async (visible, focusHost) => {
      if (visible || focusHost !== true) return
      const next = hideQueue.shift()
      if (next) await next.promise
    }
    const store = createStore()
    const firstSession = 'session-gate-a'
    const secondSession = 'session-gate-b'
    store.set(thinkingModeFamily(firstSession), { mode: 'build', stage: 'clarify' })
    store.set(briefFamily(firstSession), '# A\n\n第一会话内容。')
    store.set(thinkingModeFamily(secondSession), { mode: 'build', stage: 'clarify' })
    store.set(briefFamily(secondSession), '# B\n\n第二会话内容。')
    store.set(embeddedBrowserSnapshotAtom, {
      sessions: [
        { sessionId: firstSession, activeTabId: 'tab-a', tabs: [{ ...emptyTab, tabId: 'tab-a' }] },
        { sessionId: secondSession, activeTabId: 'tab-b', tabs: [{ ...emptyTab, tabId: 'tab-b' }] },
      ],
    })
    store.set(activeSessionIdAtom, firstSession)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(openSpecPreviewAtom)
    const { host, root } = await mountPanel(store)

    expect(host.querySelector('[data-testid="session-mode-surface"]')?.getAttribute('aria-busy')).toBe('true')
    await act(async () => {
      firstHide.release()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.querySelector('[data-testid="session-mode-surface"]')?.getAttribute('aria-busy')).toBe('false')
    expect(host.textContent).toContain('第一会话内容')

    await act(async () => {
      store.set(activeSessionIdAtom, secondSession)
      store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
      store.set(openSpecPreviewAtom)
      await Promise.resolve()
    })
    expect(host.querySelector('[data-testid="session-mode-surface"]')?.getAttribute('aria-busy')).toBe('true')
    expect(host.textContent).not.toContain('第二会话内容')

    await act(async () => {
      secondHide.release()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.querySelector('[data-testid="session-mode-surface"]')?.getAttribute('aria-busy')).toBe('false')
    expect(host.textContent).toContain('第二会话内容')

    await act(async () => root.unmount())
  })
})
