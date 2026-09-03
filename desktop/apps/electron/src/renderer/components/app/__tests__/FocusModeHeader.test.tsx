import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { thinkingModeFamily, workflowRunFamily } = await import('@/atoms/agent')
const { briefFamily, openSpecPreviewAtom } = await import('@/atoms/build')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { FocusModeHeader, COMPACT_HEADER_WIDTH, EXPANDED_HEADER_WIDTH } =
  await import('../FocusModeHeader')
const { SESSION_STATUS_BAR_HEIGHT_PX } = await import('../SessionStatusBar')

describe('FocusModeHeader', () => {
  it('renders Build as a Session-level status bar with its stage rail', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'floating-build-session'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'explore' })
    store.set(briefFamily(sessionId), '# 任务\n\n创建一个飞书多维表格。')

    await act(async () => {
      root.render(
        <Provider store={store}>
          <FocusModeHeader />
        </Provider>,
      )
    })

    const statusBar = host.querySelector<HTMLElement>('[data-testid="build-mode-status-bar"]')!
    expect(statusBar.textContent).toContain('工作流构建')
    expect(statusBar.textContent).toContain('探路')
    expect(statusBar.textContent).toContain('任务创建')
    expect(statusBar.textContent).toContain('生成')
    expect(statusBar.textContent).toContain('验证')
    expect(statusBar.textContent).toContain('创建一个飞书多维表格')
    expect(statusBar.style.height).toBe(`${SESSION_STATUS_BAR_HEIGHT_PX}px`)
    expect(statusBar.textContent).not.toContain('任务说明书')
    expect(statusBar.querySelector('button')).toBeNull()
    expect(statusBar.querySelector('section')?.className).toContain('grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]')
    expect(statusBar.querySelector('[data-testid="session-status-rail"]')?.className).toContain('justify-self-center')
    expect(statusBar.querySelector('[data-testid="session-status-state"]')?.className).toContain('justify-self-end')
    expect(host.querySelector('[data-testid="full-stage-rail"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="compact-stage-rail"]')).toBeNull()
    expect(host.querySelector('[data-testid="focus-mode-capsule"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps the full mode progress visible without duplicating the task-surface entry', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'preview-open-session'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'explore' })
    store.set(briefFamily(sessionId), '# 任务\n\n创建一个飞书多维表格。')
    store.set(openSpecPreviewAtom)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <FocusModeHeader />
        </Provider>,
      )
    })

    expect(host.querySelector('[data-testid="compact-stage-rail"]')).toBeNull()
    expect(host.querySelector('[data-testid="full-stage-rail"]')).not.toBeNull()
    expect(host.textContent).not.toContain('收起')
    expect(host.textContent).not.toContain('任务说明书')
    expect(host.querySelector('[data-testid="build-mode-status-bar"] button')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('renders no top status area during a Workflow Run', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'workflow-run-session'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'run_workflow', stage: 'execute' })
    store.set(workflowRunFamily(sessionId), {
      workflowId: 'wf-1',
      generation: 'gen-1',
      workflowName: '飞书表格创建',
      sourceSessionId: sessionId,
      phase: 'execute',
      stepIndex: 1,
      executionSteps: ['确认凭证', '创建表格'],
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <FocusModeHeader />
        </Provider>,
      )
    })

    expect(host.innerHTML).toBe('')

    await act(async () => root.unmount())
    host.remove()
  })

  it('adapts the rail to the header container width', async () => {
    const OriginalResizeObserver = globalThis.ResizeObserver
    let resizeCallback: ResizeObserverCallback | undefined
    let observedBox: ResizeObserverBoxOptions | undefined
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }
      observe(_target: Element, options?: ResizeObserverOptions) {
        observedBox = options?.box
      }
      unobserve() {}
      disconnect() {}
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const resizeEntry = (borderWidth: number, contentWidth: number): ResizeObserverEntry => ({
      target: host,
      contentRect: { width: contentWidth } as DOMRectReadOnly,
      borderBoxSize: [{ inlineSize: borderWidth, blockSize: 0 }],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    })
    const store = createStore()
    const sessionId = 'narrow-header-session'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'explore' })
    store.set(briefFamily(sessionId), '# 任务\n\n创建一个飞书多维表格。')

    try {
      await act(async () => {
        root.render(
          <Provider store={store}>
            <FocusModeHeader />
          </Provider>,
        )
      })

      // Compute widths **from breakpoints** instead of hard-coding values. Earlier constants
      // failed whenever breakpoints changed for reasons unrelated to behavior. Four steps:
      // below COMPACT collapses; inside hysteresis stays collapsed; above EXPANDED expands;
      // returning to hysteresis stays expanded to avoid jitter near the threshold.
      const belowCompact = COMPACT_HEADER_WIDTH - 20
      const inHysteresis = COMPACT_HEADER_WIDTH + 16   // Between the two thresholds.
      const aboveExpanded = EXPANDED_HEADER_WIDTH + 6
      expect(inHysteresis).toBeGreaterThanOrEqual(COMPACT_HEADER_WIDTH)
      expect(inHysteresis).toBeLessThan(EXPANDED_HEADER_WIDTH)

      expect(observedBox).toBe('border-box')
      await act(async () => {
        resizeCallback?.([resizeEntry(belowCompact, belowCompact - 16)], {} as ResizeObserver)
      })
      const compactRail = host.querySelector<HTMLElement>('[data-testid="compact-stage-rail"]')!
      expect(compactRail).not.toBeNull()
      expect(compactRail.textContent).toBe('探路2/4')
      expect(compactRail.querySelector('svg')).toBeNull()

      const compactMarkup = compactRail.innerHTML
      await act(async () => {
        compactRail.dispatchEvent(new MouseEvent('mouseenter'))
      })
      expect(compactRail.innerHTML).toBe(compactMarkup)

      await act(async () => {
        resizeCallback?.([resizeEntry(inHysteresis, inHysteresis - 16)], {} as ResizeObserver)
      })
      expect(host.querySelector('[data-testid="compact-stage-rail"]')).not.toBeNull()

      await act(async () => {
        resizeCallback?.([resizeEntry(aboveExpanded, aboveExpanded - 16)], {} as ResizeObserver)
      })
      expect(host.querySelector('[data-testid="full-stage-rail"]')).not.toBeNull()

      await act(async () => {
        resizeCallback?.([resizeEntry(inHysteresis, inHysteresis - 16)], {} as ResizeObserver)
      })
      expect(host.querySelector('[data-testid="full-stage-rail"]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      host.remove()
      globalThis.ResizeObserver = OriginalResizeObserver
    }
  })

  it('removes the inline capsule when the Session leaves Build mode', async () => {
    const OriginalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'focus-exit-session'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'generate' })

    try {
      await act(async () => {
        root.render(
          <Provider store={store}>
            <FocusModeHeader />
          </Provider>,
        )
      })
      expect(host.textContent).toContain('生成')

      await act(async () => {
        store.set(thinkingModeFamily(sessionId), { mode: 'normal', stage: null })
      })
      expect(host.textContent).toBe('')
    } finally {
      await act(async () => root.unmount())
      host.remove()
      globalThis.ResizeObserver = OriginalResizeObserver
    }
  })
})
