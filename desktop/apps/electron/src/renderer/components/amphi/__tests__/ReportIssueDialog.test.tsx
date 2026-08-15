import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ElectronAPI } from '@shared/types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { installApiStub } = await import('@/lib/apiStub')
await import('@/lib/i18n')
const { APP_NEW_ISSUE_URL } = await import('@shared/app-meta')
const {
  issueReportRequestAtom,
  openIssueReportAtom,
} = await import('@/atoms/issue-report')
const { ReportIssueDialog } = await import('../ReportIssueDialog')

function installTestApi(override: (api: ElectronAPI) => ElectronAPI): () => void {
  const apiWindow = window as unknown as { api?: ElectronAPI }
  const originalApi = apiWindow.api
  delete apiWindow.api
  installApiStub()
  if (!apiWindow.api) throw new Error('api stub was not installed')
  apiWindow.api = override(apiWindow.api)
  return () => {
    if (originalApi) apiWindow.api = originalApi
    else delete apiWindow.api
  }
}

function findCheckboxByLabel(pattern: RegExp): HTMLInputElement | null {
  const label = Array.from(document.body.querySelectorAll<HTMLLabelElement>('label'))
    .find((candidate) => pattern.test(candidate.textContent ?? ''))
  return label?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null
}

describe('ReportIssueDialog', () => {
  it('keeps the global renderer entry independent from Session and run context', async () => {
    const openedUrls: string[] = []
    const restoreApi = installTestApi((api) => ({
      ...api,
      shell: {
        ...api.shell,
        openExternal: async (url) => { openedUrls.push(url) },
      },
      system: {
        ...api.system,
        getDiagnostics: async () => {
          throw new Error('global feedback must not collect diagnostics by default')
        },
      },
    }))

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(openIssueReportAtom, {
      source: 'renderer',
      userText: 'unrelated Session user message',
      assistantText: 'unrelated Session Agent reply',
      model: { modelId: 'unrelated-model' },
      executionMode: 'auto',
      thinking: { mode: 'normal', stage: null },
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <ReportIssueDialog />
        </Provider>,
      )
    })

    const advanced = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-advanced-toggle"]')
    await act(async () => { advanced?.click() })

    const attachments = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    expect(attachments).toHaveLength(1)
    expect(findCheckboxByLabel(/系统环境|System environment/i)).toBe(attachments[0] ?? null)
    expect(findCheckboxByLabel(/模型与运行模式|Model and run mode/i)).toBeNull()
    expect(findCheckboxByLabel(/用户消息|User message/i)).toBeNull()
    expect(findCheckboxByLabel(/Agent 回复与执行过程|Agent reply and execution process/i)).toBeNull()
    expect(attachments[0]?.checked).toBe(false)

    const primary = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-primary"]')
    if (!primary) throw new Error('report issue primary action not rendered')
    await act(async () => { primary.click() })

    expect(openedUrls).toEqual([APP_NEW_ISSUE_URL])

    await act(async () => { root.unmount() })
    host.remove()
    restoreApi()
  })

  it('keeps Gateway errors opt-in and serializes them as independent error details', async () => {
    const openedUrls: string[] = []
    const restoreApi = installTestApi((api) => ({
      ...api,
      shell: {
        ...api.shell,
        openExternal: async (url) => { openedUrls.push(url) },
      },
    }))

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const gatewayError = 'Gateway 连接失败：backend unavailable'
    store.set(openIssueReportAtom, { source: 'gateway', error: gatewayError })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <ReportIssueDialog />
        </Provider>,
      )
    })

    let advanced = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-advanced-toggle"]')
    await act(async () => { advanced?.click() })
    expect(findCheckboxByLabel(/错误详情|Error details/i)?.checked).toBe(false)
    expect(findCheckboxByLabel(/Agent 回复与执行过程|Agent reply and execution process/i)).toBeNull()

    const firstPrimary = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-primary"]')
    if (!firstPrimary) throw new Error('report issue primary action not rendered')
    await act(async () => { firstPrimary.click() })
    expect(openedUrls).toEqual([APP_NEW_ISSUE_URL])

    await new Promise((resolve) => setTimeout(resolve, 1))
    await act(async () => {
      store.set(openIssueReportAtom, { source: 'gateway', error: gatewayError })
    })
    advanced = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-advanced-toggle"]')
    await act(async () => { advanced?.click() })
    const errorDetails = findCheckboxByLabel(/错误详情|Error details/i)
    if (!errorDetails) throw new Error('Gateway error details option not rendered')
    await act(async () => { errorDetails.click() })

    const primary = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-primary"]')
    if (!primary) throw new Error('report issue primary action not rendered')
    await act(async () => { primary.click() })

    expect(openedUrls).toHaveLength(2)
    const body = new URL(openedUrls[1]!).searchParams.get('body') ?? ''
    expect(body).toContain(gatewayError)
    expect(body).toMatch(/## (错误详情|Error details)/)
    expect(body).not.toMatch(/## (Agent 回复与执行过程|Agent reply and execution process)/)

    await act(async () => { root.unmount() })
    host.remove()
    restoreApi()
  })

  it('keeps a message-scoped error inside the Agent execution record', async () => {
    const openedUrls: string[] = []
    const restoreApi = installTestApi((api) => ({
      ...api,
      shell: {
        ...api.shell,
        openExternal: async (url) => { openedUrls.push(url) },
      },
    }))

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const messageError = 'Agent transport failed during this Turn'
    store.set(openIssueReportAtom, { source: 'message', error: messageError })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <ReportIssueDialog />
        </Provider>,
      )
    })
    const advanced = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-advanced-toggle"]')
    await act(async () => { advanced?.click() })

    expect(findCheckboxByLabel(/^错误详情|^Error details/i)).toBeNull()
    const agentRecord = findCheckboxByLabel(/Agent 回复与执行过程|Agent reply and execution process/i)
    if (!agentRecord) throw new Error('Agent execution record option not rendered')
    expect(agentRecord.disabled).toBe(false)
    await act(async () => { agentRecord.click() })

    const primary = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-primary"]')
    if (!primary) throw new Error('report issue primary action not rendered')
    await act(async () => { primary.click() })

    const body = new URL(openedUrls[0]!).searchParams.get('body') ?? ''
    expect(body).toContain(messageError)
    expect(body).toMatch(/## (Agent 回复与执行过程|Agent reply and execution process)/)
    expect(body).not.toMatch(/## (错误详情|Error details)/)

    await act(async () => { root.unmount() })
    host.remove()
    restoreApi()
  })

  it('keeps all attachments opt-in and opens an untouched new issue URL by default', async () => {
    const openedUrls: string[] = []
    const restoreApi = installTestApi((api) => ({
      ...api,
      shell: {
        ...api.shell,
        openExternal: async (url) => { openedUrls.push(url) },
      },
    }))

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(openIssueReportAtom, {
      source: 'message',
      userText: 'private user message',
      assistantText: 'private assistant message',
      model: { modelId: 'test-model' },
      executionMode: 'auto',
      thinking: { mode: 'normal', stage: null },
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <ReportIssueDialog />
        </Provider>,
      )
    })

    const destination = document.body.querySelector<HTMLElement>('[data-testid="issue-report-destination"]')
    const primary = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-primary"]')
    const safetyNote = document.body.querySelector<HTMLElement>('[data-testid="issue-report-safety-note"]')
    const advanced = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-advanced-toggle"]')
    expect(destination?.nextElementSibling).toBe(primary)
    expect(primary?.nextElementSibling).toBe(safetyNote)
    expect(destination?.querySelector('svg')).not.toBeNull()
    expect(primary?.querySelector('svg')).not.toBeNull()
    expect(safetyNote?.querySelector('svg')).not.toBeNull()
    expect(advanced?.querySelector('svg')).not.toBeNull()
    expect(advanced?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { advanced?.click() })

    const attachments = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    expect(attachments).toHaveLength(4)
    expect(attachments.every((checkbox) => !checkbox.checked)).toBe(true)
    expect(document.body.querySelector('[data-testid="issue-report-sensitive-content-warning"]')).toBeNull()

    await act(async () => { attachments[2]?.click() })
    const sensitiveWarning = document.body.querySelector<HTMLElement>(
      '[data-testid="issue-report-sensitive-content-warning"]',
    )
    expect(sensitiveWarning?.textContent).toMatch(/密码|password/i)
    expect(sensitiveWarning?.textContent).toContain('API')
    expect(sensitiveWarning?.textContent).toMatch(/最后确认提交 issue|before final submission/i)
    await act(async () => { attachments[2]?.click() })
    expect(document.body.querySelector('[data-testid="issue-report-sensitive-content-warning"]')).toBeNull()

    if (!primary) throw new Error('report issue primary action not rendered')
    await act(async () => { primary.click() })

    expect(openedUrls).toEqual([APP_NEW_ISSUE_URL])
    expect(store.get(issueReportRequestAtom)).toBeNull()

    await act(async () => { root.unmount() })
    host.remove()
    restoreApi()
  })

  it('copies exactly the destination shown in the address card', async () => {
    const copiedValues: string[] = []
    const originalClipboard = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => { copiedValues.push(value) } },
    })

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(openIssueReportAtom, {
      source: 'message',
      assistantText: `private report content ${'x'.repeat(9_000)}`,
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <ReportIssueDialog />
        </Provider>,
      )
    })
    const advanced = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-advanced-toggle"]')
    await act(async () => { advanced?.click() })
    const attachments = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    await act(async () => { attachments[3]?.click() })
    expect(document.body.querySelector('[data-testid="issue-report-file-mode"]')).not.toBeNull()

    const destination = document.body.querySelector<HTMLElement>('[data-testid="issue-report-destination"]')
    const copyButton = destination?.querySelector<HTMLButtonElement>('button')
    await act(async () => { copyButton?.click() })

    expect(copiedValues).toEqual([APP_NEW_ISSUE_URL])
    expect(copiedValues[0]).not.toContain('private report content')

    await act(async () => { root.unmount() })
    host.remove()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    })
  })

  it('prefills only the information the user explicitly selects', async () => {
    const openedUrls: string[] = []
    const restoreApi = installTestApi((api) => ({
      ...api,
      shell: {
        ...api.shell,
        openExternal: async (url) => { openedUrls.push(url) },
      },
      system: {
        ...api.system,
        getDiagnostics: async () => {
          throw new Error('system diagnostics must stay uncollected when unchecked')
        },
      },
    }))

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(openIssueReportAtom, {
      source: 'message',
      userText: 'private user message',
      assistantText: 'private assistant message',
      model: { modelId: 'test-model', providerId: 'test-provider' },
      executionMode: 'auto',
      thinking: { mode: 'normal', stage: null },
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <ReportIssueDialog />
        </Provider>,
      )
    })
    const advanced = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-advanced-toggle"]')
    await act(async () => { advanced?.click() })
    const attachments = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    await act(async () => {
      attachments[1]?.click()
      attachments[2]?.click()
    })

    const primary = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-primary"]')
    if (!primary) throw new Error('report issue primary action not rendered')
    await act(async () => { primary.click() })

    expect(openedUrls).toHaveLength(1)
    const body = new URL(openedUrls[0]!).searchParams.get('body') ?? ''
    expect(body).toContain('test-provider / test-model')
    expect(body).toContain('private user message')
    expect(body).not.toContain('private assistant message')
    expect(body).not.toContain('App 版本')

    await act(async () => { root.unmount() })
    host.remove()
    restoreApi()
  })

  it('includes the complete visible Agent execution record only when selected', async () => {
    const openedUrls: string[] = []
    const restoreApi = installTestApi((api) => ({
      ...api,
      shell: {
        ...api.shell,
        openExternal: async (url) => { openedUrls.push(url) },
      },
    }))

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(openIssueReportAtom, {
      source: 'message',
      userText: 'private user message',
      assistantText: 'final diagnostic answer',
      agentTurn: {
        blocks: [
          { type: 'thinking', text: 'visible reasoning' },
          { type: 'text', text: 'I will inspect the environment.' },
          {
            type: 'tool',
            toolUseId: 'tool-1',
            name: 'bash',
            input: { command: 'env' },
            result: { output: 'PATH=/usr/bin', isError: false, durationMs: 62 },
          },
          { type: 'text', text: 'final diagnostic answer' },
        ],
        finalAnswer: 'final diagnostic answer',
      },
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <ReportIssueDialog />
        </Provider>,
      )
    })
    const advanced = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-advanced-toggle"]')
    await act(async () => { advanced?.click() })
    const attachments = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    const agentOptionText = attachments[3]?.parentElement?.textContent ?? ''
    const isChinese = agentOptionText.includes('Agent 回复与执行过程')
    expect(agentOptionText).toContain(isChinese
      ? '包括 Agent 回复、已展示的推理过程、工具调用及其结果'
      : 'Includes the agent reply, displayed reasoning, tool calls, and their results')
    await act(async () => { attachments[3]?.click() })
    const sensitiveWarning = document.body.querySelector<HTMLElement>(
      '[data-testid="issue-report-sensitive-content-warning"]',
    )
    expect(sensitiveWarning?.textContent).toMatch(/密码|password/i)
    expect(sensitiveWarning?.textContent).toMatch(/最后确认提交 issue|before final submission/i)

    const primary = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-primary"]')
    if (!primary) throw new Error('report issue primary action not rendered')
    await act(async () => { primary.click() })

    expect(openedUrls).toHaveLength(1)
    const body = new URL(openedUrls[0]!).searchParams.get('body') ?? ''
    expect(body).toContain(isChinese
      ? '## Agent 回复与执行过程'
      : '## Agent reply and execution process')
    expect(body).toContain(isChinese
      ? '[Agent 最终回复]\nfinal diagnostic answer'
      : '[Agent final reply]\nfinal diagnostic answer')
    expect(body).toContain(isChinese
      ? '[已展示的推理过程]\nvisible reasoning'
      : '[Displayed reasoning]\nvisible reasoning')
    expect(body).toContain(isChinese
      ? '[Agent 过程消息]\nI will inspect the environment.'
      : '[Agent process message]\nI will inspect the environment.')
    expect(body).toContain(isChinese ? '[工具调用: bash]' : '[Tool call: bash]')
    expect(body).toContain('"command": "env"')
    expect(body).toContain(isChinese ? '状态: 成功' : 'Status: Succeeded')
    expect(body).toContain(isChinese ? '耗时: 62 ms' : 'Duration: 62 ms')
    expect(body).toContain('PATH=/usr/bin')
    expect(body.match(/final diagnostic answer/g)).toHaveLength(1)
    expect(body).not.toContain('private user message')

    await act(async () => { root.unmount() })
    host.remove()
    restoreApi()
  })

  it('serializes the Agent execution record only after the user opts in', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(openIssueReportAtom, {
      source: 'message',
      agentTurn: {
        blocks: [{
          type: 'tool',
          toolUseId: 'tool-probe',
          name: 'bash',
          input: { serializationProbe: 'agent-turn' },
        }],
      },
    })

    const originalStringify = JSON.stringify
    let probeSerializations = 0
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      const value = args[0] as { serializationProbe?: string } | null
      if (value?.serializationProbe === 'agent-turn') probeSerializations += 1
      return originalStringify(...args)
    }) as typeof JSON.stringify

    try {
      await act(async () => {
        root.render(
          <Provider store={store}>
            <ReportIssueDialog />
          </Provider>,
        )
      })
      const advanced = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-advanced-toggle"]')
      await act(async () => { advanced?.click() })
      expect(probeSerializations).toBe(0)

      const attachments = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      await act(async () => { attachments[3]?.click() })
      expect(probeSerializations).toBe(1)

      await act(async () => {
        advanced?.click()
        advanced?.click()
      })
      expect(probeSerializations).toBe(1)
    } finally {
      JSON.stringify = originalStringify
      await act(async () => { root.unmount() })
      host.remove()
    }
  })

  it('exports an overlength report as Markdown before opening the plain GitHub URL', async () => {
    const openedUrls: string[] = []
    const exports: Array<{ suggestedName: string; content: string }> = []
    const restoreApi = installTestApi((api) => ({
      ...api,
      issueReport: {
        exportFile: async (request) => {
          exports.push(request)
          return { ok: true, path: `/tmp/${request.suggestedName}` }
        },
      },
      shell: {
        ...api.shell,
        openExternal: async (url) => { openedUrls.push(url) },
      },
    }))

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const longReply = `full execution record\n${'tool output '.repeat(1_000)}`
    store.set(openIssueReportAtom, {
      source: 'message',
      assistantText: longReply,
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <ReportIssueDialog />
        </Provider>,
      )
    })
    const advanced = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-advanced-toggle"]')
    await act(async () => { advanced?.click() })
    const attachments = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    await act(async () => { attachments[3]?.click() })

    const fileNotice = document.body.querySelector<HTMLElement>('[data-testid="issue-report-file-mode"]')
    const sensitiveWarning = document.body.querySelector<HTMLElement>(
      '[data-testid="issue-report-sensitive-content-warning"]',
    )
    const primary = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-primary"]')
    const isChinese = fileNotice?.textContent?.includes('所选内容较多') ?? false
    expect(fileNotice?.textContent).toContain(isChinese
      ? '所选内容较多，将通过文件附带'
      : 'The selected content will be attached as a file')
    expect(fileNotice?.textContent).toMatch(/bridgic-agent-feedback-\d{8}-\d{4}\.md/)
    expect(primary?.textContent).toContain(isChinese
      ? '导出反馈文件并前往 GitHub'
      : 'Export feedback file and open GitHub')
    expect(sensitiveWarning?.textContent).toContain(isChinese
      ? '请检查导出内容'
      : 'Review the exported file')
    expect(sensitiveWarning?.textContent).toMatch(/上传前|before uploading/i)
    expect(document.body.textContent).not.toContain(isChinese
      ? '请减少附带内容后重试'
      : 'Select less information and try again')
    expect(sensitiveWarning?.textContent).toMatch(/不会自动|do not automatically/i)

    if (!primary) throw new Error('report issue primary action not rendered')
    await act(async () => { primary.click() })

    expect(exports).toHaveLength(1)
    expect(exports[0]?.suggestedName).toMatch(/^bridgic-agent-feedback-\d{8}-\d{4}\.md$/)
    expect(exports[0]?.content).toContain('full execution record')
    expect(exports[0]?.content.length).toBeGreaterThan(8_000)
    expect(openedUrls).toEqual([APP_NEW_ISSUE_URL])
    expect(store.get(issueReportRequestAtom)).toBeNull()

    await act(async () => { root.unmount() })
    host.remove()
    restoreApi()
  })

  it('keeps the dialog open without an error when file export is cancelled', async () => {
    const openedUrls: string[] = []
    const restoreApi = installTestApi((api) => ({
      ...api,
      issueReport: {
        exportFile: async () => ({ ok: false, reason: 'cancelled' }),
      },
      shell: {
        ...api.shell,
        openExternal: async (url) => { openedUrls.push(url) },
      },
    }))

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(openIssueReportAtom, {
      source: 'message',
      assistantText: 'x'.repeat(9_000),
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <ReportIssueDialog />
        </Provider>,
      )
    })
    const advanced = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-advanced-toggle"]')
    await act(async () => { advanced?.click() })
    const attachments = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    await act(async () => { attachments[3]?.click() })
    const primary = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-primary"]')
    if (!primary) throw new Error('report issue primary action not rendered')
    await act(async () => { primary.click() })

    expect(openedUrls).toEqual([])
    expect(store.get(issueReportRequestAtom)).not.toBeNull()
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
    expect(primary.disabled).toBe(false)

    await act(async () => { root.unmount() })
    host.remove()
    restoreApi()
  })

  it('updates the file-mode preview after selected system diagnostics are loaded', async () => {
    let diagnosticsCalls = 0
    const restoreApi = installTestApi((api) => ({
      ...api,
      system: {
        ...api.system,
        getDiagnostics: async () => {
          diagnosticsCalls += 1
          return {
            appVersion: '0.1.0',
            platform: 'darwin',
            arch: 'arm64',
            osRelease: 'x'.repeat(1_000),
            electronVersion: '38.0.0',
            chromeVersion: '140.0.0',
          }
        },
      },
    }))

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(openIssueReportAtom, {
      source: 'message',
      userText: 'u'.repeat(7_600),
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <ReportIssueDialog />
        </Provider>,
      )
    })
    const advanced = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-advanced-toggle"]')
    await act(async () => { advanced?.click() })
    const attachments = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    await act(async () => { attachments[2]?.click() })
    expect(document.body.querySelector('[data-testid="issue-report-file-mode"]')).toBeNull()

    await act(async () => {
      attachments[0]?.click()
      await Promise.resolve()
    })

    expect(diagnosticsCalls).toBe(1)
    expect(document.body.querySelector('[data-testid="issue-report-file-mode"]')).not.toBeNull()

    await act(async () => { root.unmount() })
    host.remove()
    restoreApi()
  })

  it('retains the exported path and retries GitHub without exporting again', async () => {
    const exportedRequests: Array<{ suggestedName: string; content: string }> = []
    const revealedPaths: string[] = []
    let openAttempts = 0
    const exportedPath = '/tmp/bridgic-agent-feedback-test.md'
    const restoreApi = installTestApi((api) => ({
      ...api,
      issueReport: {
        exportFile: async (request) => {
          exportedRequests.push(request)
          return { ok: true, path: exportedPath }
        },
      },
      shell: {
        ...api.shell,
        openExternal: async () => {
          openAttempts += 1
          if (openAttempts === 1) throw new Error('browser unavailable')
        },
        showItemInFolder: async (path) => { revealedPaths.push(path) },
      },
    }))

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(openIssueReportAtom, {
      source: 'message',
      assistantText: 'x'.repeat(9_000),
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <ReportIssueDialog />
        </Provider>,
      )
    })
    const advanced = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-advanced-toggle"]')
    await act(async () => { advanced?.click() })
    const attachments = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    await act(async () => { attachments[3]?.click() })
    const primary = document.body.querySelector<HTMLButtonElement>('[data-testid="issue-report-primary"]')
    if (!primary) throw new Error('report issue primary action not rendered')
    await act(async () => { primary.click() })

    const exported = document.body.querySelector<HTMLElement>('[data-testid="issue-report-exported-file"]')
    expect(exported?.textContent).toContain(exportedPath)
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      exported?.textContent?.includes('反馈文件已导出') ? '文件不会丢失' : 'Your file is safe',
    )
    const showInFolder = exported?.querySelector<HTMLButtonElement>('button')
    await act(async () => { showInFolder?.click() })
    expect(revealedPaths).toEqual([exportedPath])

    expect(primary.textContent).toContain(exported?.textContent?.includes('反馈文件已导出')
      ? '重新打开 GitHub'
      : 'Open GitHub again')
    await act(async () => { primary.click() })
    expect(openAttempts).toBe(2)
    expect(exportedRequests).toHaveLength(1)
    expect(store.get(issueReportRequestAtom)).toBeNull()

    await act(async () => { root.unmount() })
    host.remove()
    restoreApi()
  })
})
