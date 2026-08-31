import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { AgentMessageToolCall, MessageBlock } from '@/atoms/agent'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { AgentRole } = await import('@shared/types')
const { applyAgentEventAtom, messageFamily, streamingFamily, thinkingModeFamily } = await import('@/atoms/agent')
const { setHumanRequestAtom } = await import('@/atoms/human-request')
const { issueReportRequestAtom } = await import('@/atoms/issue-report')
const { composerQuotesAtom } = await import('@/atoms/composer-quote')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { i18n } = await import('@/lib/i18n')
const { Pipeline } = await import('../Pipeline')

describe('Pipeline', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })

  it('keeps the latest Agent process expanded while a human interaction card is pending', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'interaction-session')
    store.set(messageFamily('interaction-session'), [{
      id: 'parked-agent-turn',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [
        { type: 'thinking', text: '正在整理验收规则。' },
        { type: 'text', text: '我已经根据任务整理了候选标准。' },
      ],
      done: true,
      finalAnswer: '',
      createdAt: 1,
    }])
    store.set(setHumanRequestAtom, {
      sessionId: 'interaction-session',
      kind: 'accept_rule',
      requestId: 'accept-1',
      rules: ['结果文件存在。'],
      questions: [{
        question: '结果文件存在。',
        options: [{ label: '接受' }, { label: '不接受' }],
      }],
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Pipeline />
        </Provider>,
      )
    })

    const processLabel = [...host.querySelectorAll('span')].find(
      (element) => element.textContent === '执行过程',
    )
    expect(processLabel?.parentElement?.firstElementChild?.className).toContain('rotate-90')
    expect(host.querySelector('[aria-label="消息操作"], [aria-label="Message actions"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('renders an explicit Child Session instead of the active Session', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'main-session')
    store.set(messageFamily('main-session'), [{
      id: 'main-message',
      role: AgentRole.User,
      text: '主会话消息',
      toolCalls: [],
      done: true,
      createdAt: 1,
    }])

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Pipeline
            session={{
              id: 'child-session',
              messages: [{
                id: 'child-message',
                role: AgentRole.User,
                text: '子会话任务输入',
                toolCalls: [],
                done: true,
                createdAt: 2,
              }],
              pending: false,
            }}
          />
        </Provider>,
      )
    })

    expect(host.textContent).toContain('子会话任务输入')
    expect(host.textContent).not.toContain('主会话消息')
    expect(host.querySelector('[aria-label="消息操作"], [aria-label="Message actions"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  // A reply to request_human carries no blocks (human-request.ts sends text only), so it renders
  // through the plain-content branch rather than StructuredInput. A path typed there is still just
  // the characters the user wrote, never a link.
  it('renders a bare path in a blockless user message as plain text', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const text = '/Users/me/Documents/chapter 2.docx  use section 2.1 for the deck'
    store.set(activeSessionIdAtom, 'blockless-session')
    store.set(messageFamily('blockless-session'), [{
      id: 'user-1', turnId: 'turn-1', role: AgentRole.User, text,
      toolCalls: [], done: true, createdAt: 1,
    }])

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Pipeline />
        </Provider>,
      )
    })

    expect(host.textContent).toContain(text)
    expect(host.querySelector('[class*="filelink"]')).toBeNull()
    expect(host.querySelector('a[href*=".docx"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('shows primary-conversation actions and snapshots the paired Turn for feedback', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const copiedTexts: string[] = []
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { copiedTexts.push(text) } },
    })
    const agentBlocks: MessageBlock[] = [
      { type: 'thinking', text: '先检查运行环境' },
      {
        type: 'tool',
        toolUseId: 'tool-1',
        name: 'bash',
        input: { command: 'pwd' },
        result: { output: '/tmp/work', isError: false, durationMs: 25 },
      },
      { type: 'text', text: '第二个回答' },
    ]
    const legacyToolCalls: AgentMessageToolCall[] = [{
      toolUseId: 'legacy-tool-1',
      name: 'read_file',
      input: { file_path: '/tmp/input.txt' },
      result: { output: 'legacy output', isError: false, durationMs: 10 },
    }]
    store.set(activeSessionIdAtom, 'action-session')
    store.set(thinkingModeFamily('action-session'), { mode: 'build', stage: 'verify' })
    store.set(messageFamily('action-session'), [
      {
        id: 'user-1', turnId: 'turn-1', role: AgentRole.User, text: '第一个问题',
        toolCalls: [], done: true, createdAt: 1,
      },
      {
        id: 'assistant-1', turnId: 'turn-1', role: AgentRole.Assistant, text: '', error: 'boom',
        toolCalls: [], done: true, createdAt: 2,
        completedAt: Date.parse('2026-08-10T12:30:00+08:00'), durationMs: 800,
      },
      {
        id: 'user-2', turnId: 'turn-2', role: AgentRole.User, text: '第二个问题',
        toolCalls: [], done: true, createdAt: 3,
      },
      {
        id: 'assistant-2', turnId: 'turn-2', role: AgentRole.Assistant, text: '第二个回答',
        thinking: '旧消息推理备份', toolCalls: legacyToolCalls, blocks: agentBlocks,
        finalAnswer: '第二个回答', done: true, model: 'gpt-5.6', executionMode: 'request', createdAt: 4,
        completedAt: Date.parse('2026-08-10T12:34:56+08:00'), durationMs: 1_200,
      },
    ])

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Pipeline />
        </Provider>,
      )
    })

    const actionGroups = [...host.querySelectorAll<HTMLElement>(
      '[aria-label="消息操作"], [aria-label="Message actions"]',
    )]
    expect(actionGroups.map((group) => group.querySelectorAll('button').length)).toEqual([2, 3, 2, 3])
    expect([...actionGroups[0]!.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')))
      .toEqual(['复制', '引用'])
    expect([...actionGroups[3]!.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')))
      .toEqual(['复制', '引用', '反馈'])
    expect(actionGroups[0]?.querySelector('button[aria-label="引用"] svg.lucide-quote')).not.toBeNull()
    expect(actionGroups[3]?.querySelector('button[aria-label="引用"] svg.lucide-quote')).not.toBeNull()
    expect(actionGroups[2]?.parentElement?.parentElement?.className).toContain('items-end')
    const latestAgentFooter = actionGroups[3]?.parentElement
    const generationInfo = actionGroups[3]?.previousElementSibling
    expect(actionGroups.every((group) => group.className.includes('group-hover/message:opacity-100'))).toBe(true)
    expect(actionGroups.every((group) => group.className.includes('focus-within:opacity-100'))).toBe(true)
    expect(actionGroups.every((group) => !group.className.includes('group-focus-within/message'))).toBe(true)
    expect(latestAgentFooter?.firstElementChild).toBe(generationInfo)
    expect(latestAgentFooter?.lastElementChild).toBe(actionGroups[3])
    expect(generationInfo?.getAttribute('aria-label')).toBe('消息生成信息')
    expect(generationInfo?.className).not.toContain('opacity-0')
    expect(actionGroups.every((group) => group.className.includes('opacity-0'))).toBe(true)
    expect(actionGroups[1]?.parentElement?.firstElementChild).toBe(actionGroups[1]?.previousElementSibling)
    expect(actionGroups[1]?.parentElement?.lastElementChild).toBe(actionGroups[1])

    const userQuote = actionGroups[2]?.querySelector<HTMLButtonElement>('button[aria-label="引用"]')
    await act(async () => userQuote?.click())
    expect(store.get(composerQuotesAtom)['action-session']).toEqual({
      sourceRole: 'user',
      text: '第二个问题',
      messageId: 'user-2',
      turnId: 'turn-2',
    })

    const latestAgentButtons = [...actionGroups[3]!.querySelectorAll<HTMLButtonElement>('button')]
    await act(async () => latestAgentButtons[0]?.click())
    expect(copiedTexts).toEqual(['第二个回答'])
    await act(async () => latestAgentButtons[1]?.click())
    expect(store.get(composerQuotesAtom)['action-session']).toEqual({
      sourceRole: 'assistant',
      text: '第二个回答',
      messageId: 'assistant-2',
      turnId: 'turn-2',
    })

    const feedbackButtons = host.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="反馈"], button[aria-label="Feedback"]',
    )
    await act(async () => feedbackButtons[1]?.click())
    const report = store.get(issueReportRequestAtom)
    expect(report?.source).toBe('message')
    expect(report?.sessionId).toBe('action-session')
    expect(report?.messageId).toBe('assistant-2')
    expect(report?.turnId).toBe('turn-2')
    expect(report?.userText).toBe('第二个问题')
    expect(report?.assistantText).toBe('第二个回答')
    expect(report?.agentTurn?.blocks).toEqual(agentBlocks)
    expect(report?.agentTurn?.finalAnswer).toBe('第二个回答')
    expect(report?.agentTurn?.fallbackText).toBe('第二个回答')
    expect(report?.agentTurn?.thinking).toBe('旧消息推理备份')
    expect(report?.agentTurn?.toolCalls).toEqual(legacyToolCalls)
    expect(report?.model).toEqual({ modelId: 'gpt-5.6' })
    expect(report?.executionMode).toBe('request')
    expect(report?.thinking).toEqual({ mode: 'build', stage: 'verify' })

    ;(agentBlocks[0] as Extract<MessageBlock, { type: 'thinking' }>).text = '已被外部修改'
    ;(agentBlocks[1] as Extract<MessageBlock, { type: 'tool' }>).input = { command: 'changed' }
    legacyToolCalls[0]!.result!.output = 'changed'
    expect(report?.agentTurn?.blocks[0]).toEqual({ type: 'thinking', text: '先检查运行环境' })
    expect(report?.agentTurn?.blocks[1]).toMatchObject({
      type: 'tool',
      input: { command: 'pwd' },
      result: { output: '/tmp/work' },
    })
    expect(report?.agentTurn?.toolCalls?.[0]?.result?.output).toBe('legacy output')

    await act(async () => root.unmount())
    host.remove()
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('carries a stopped AgentMessage into a clear terminal state', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-1')
    store.set(messageFamily('session-1'), [{
      id: 'stopped-message',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [{ type: 'thinking', text: '正在处理。' }],
      done: true,
      stopped: true,
      createdAt: 1,
    }])

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Pipeline />
        </Provider>,
      )
    })

    expect(host.textContent).toContain('执行过程')
    expect(host.textContent).not.toContain('0 次与您确认')
    expect(host.textContent).toContain('本次生成已停止')
    expect(host.textContent).toContain('您可以继续发送消息')
    const feedback = host.querySelector<HTMLButtonElement>(
      'button[aria-label="反馈"], button[aria-label="Feedback"]',
    )
    expect(feedback).not.toBeNull()
    await act(async () => feedback?.click())
    expect(store.get(issueReportRequestAtom)?.turnStatus).toBe('cancelled')

    await act(async () => root.unmount())
    host.remove()
  })

  it('shows the current reconnect attempt inside the active reply', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Pipeline
            session={{
              id: 'retrying-session',
              messages: [],
              streaming: {
                messageId: 'retrying-message',
                content: '',
                toolCalls: [],
                blocks: [],
                startedAt: 1,
                retry: { attempt: 1, maxRetries: 5, delaySeconds: 2 },
              },
              pending: false,
            }}
          />
        </Provider>,
      )
    })

    expect(host.textContent).toContain('正在重新连接 1/5')
    expect(host.querySelector('[aria-label="正在重新连接 1/5"]')).not.toBeNull()
    expect(host.querySelector('img[alt="Bridgic"]')?.parentElement?.className).not.toContain('animate-breathe')

    await act(async () => root.unmount())
    host.remove()
  })

  it('describes the active reasoning, generation, and tool phases', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const startedAt = Date.now() - 65_000

    const renderStreaming = async (streaming: NonNullable<Parameters<typeof Pipeline>[0]['session']>['streaming']) => {
      await act(async () => {
        root.render(
          <Provider store={store}>
            <Pipeline session={{ id: 'active-session', messages: [], streaming, pending: false }} />
          </Provider>,
        )
      })
    }

    await renderStreaming({
      messageId: 'message', content: '', toolCalls: [], blocks: [], startedAt, compacting: true,
    })
    expect(host.textContent).toContain('正在压缩上下文')
    expect(host.querySelector('[aria-label="正在压缩上下文"]')).not.toBeNull()

    await renderStreaming({
      messageId: 'message', content: '', toolCalls: [], blocks: [], startedAt,
    })
    expect(host.textContent).toContain('正在思考')
    expect(host.textContent).toContain('01:05')
    expect(host.querySelector('[aria-label="已运行 65 秒"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="正在思考"]')?.className).not.toContain('animate-breathe')
    expect(host.querySelectorAll('[aria-label="正在思考"] .agent-activity-wave > span')).toHaveLength(3)
    expect(host.querySelector('img[alt="Bridgic"]')?.parentElement?.className).not.toContain('animate-breathe')

    await renderStreaming({
      messageId: 'message', content: '正在整理', toolCalls: [],
      blocks: [{ type: 'text', text: '正在整理' }], startedAt,
    })
    expect(host.textContent).toContain('正在生成回复')
    const generatedText = host.textContent ?? ''
    expect(generatedText.indexOf('正在整理')).toBeLessThan(generatedText.indexOf('正在生成回复'))

    await renderStreaming({
      messageId: 'message', content: '',
      toolCalls: [{ toolUseId: 'tool-1', name: 'read_file', input: { file_path: '/tmp/notes.md' } }],
      blocks: [{ type: 'tool', toolUseId: 'tool-1', name: 'read_file', input: { file_path: '/tmp/notes.md' } }],
      startedAt,
    })
    expect(host.textContent).toContain('正在调用工具')
    const toolActivity = host.querySelector('[aria-label="正在调用工具"]')
    expect(toolActivity?.textContent).not.toContain('正在读取')
    expect(toolActivity?.textContent).not.toContain('notes.md')

    await act(async () => root.unmount())
    host.remove()
  })

  it('gives a pending Browser tool a dedicated row state and Browser-specific activity', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Pipeline
            session={{
              id: 'browser-tool-session',
              messages: [],
              streaming: {
                messageId: 'browser-tool-message',
                content: '',
                toolCalls: [{
                  toolUseId: 'browser-tool-open',
                  name: 'browser_open',
                  input: { url: 'https://example.com/article' },
                }],
                blocks: [{
                  type: 'tool',
                  toolUseId: 'browser-tool-open',
                  name: 'browser_open',
                  input: { url: 'https://example.com/article' },
                }],
                startedAt: Date.now(),
              },
              pending: false,
            }}
          />
        </Provider>,
      )
    })

    const activity = host.querySelector<HTMLElement>('[aria-label="正在操作浏览器"]')
    const browserRow = host.querySelector<HTMLButtonElement>('[data-browser-tool-state="running"]')
    expect(activity).not.toBeNull()
    expect(activity?.textContent).toContain('正在操作浏览器')
    expect(activity?.querySelectorAll('.agent-activity-wave > span')).toHaveLength(3)
    expect(host.querySelector('[aria-label="正在调用工具"]')).toBeNull()
    expect(browserRow).not.toBeNull()
    expect(browserRow?.textContent).toContain('打开网页')
    expect(browserRow?.textContent).toContain('example.com')
    expect(browserRow?.className).toContain('bg-accent-blue-subtle')
    expect(browserRow?.querySelector('.animate-pulse')).toBeNull()

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Pipeline
            session={{
              id: 'browser-tool-session',
              messages: [],
              streaming: {
                messageId: 'browser-snapshot-message',
                content: '',
                toolCalls: [{
                  toolUseId: 'browser-tool-snapshot',
                  name: 'browser_snapshot',
                  input: {},
                }],
                blocks: [{
                  type: 'tool',
                  toolUseId: 'browser-tool-snapshot',
                  name: 'browser_snapshot',
                  input: {},
                }],
                startedAt: Date.now(),
              },
              pending: false,
            }}
          />
        </Provider>,
      )
    })

    expect(host.querySelector('[aria-label="正在操作浏览器"]')).toBeNull()
    expect(host.querySelector('[aria-label="正在调用工具"]')).not.toBeNull()
    expect(host.querySelector('[data-browser-tool-state="running"]')).toBeNull()
    expect(host.textContent).toContain('页面快照')

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps Build mode out of the message activity row', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'build-live-session'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'build', stage: 'explore' })
    store.set(streamingFamily(sessionId), {
      messageId: 'build-live-message',
      content: '',
      toolCalls: [],
      blocks: [{ type: 'tool', toolUseId: 'tool-1', name: 'read_file', input: {} }],
      startedAt: Date.now(),
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Pipeline />
        </Provider>,
      )
    })

    const activity = host.querySelector<HTMLElement>('[aria-label="正在调用工具"]')!
    expect(host.querySelector('[data-testid="focus-mode-capsule"]')).toBeNull()
    expect(activity.textContent).toContain('正在调用工具')
    expect(activity.querySelectorAll('.agent-activity-wave > span')).toHaveLength(3)

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps a hydrated parent Turn active through the Child join window', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Pipeline
            session={{
              id: 'hydrated-parent',
              messages: [{
                id: 'parent-turn',
                role: AgentRole.Assistant,
                text: '',
                toolCalls: [],
                blocks: [{
                  type: 'subagent',
                  invocationId: 'hydrated-child',
                  goal: '审核结果',
                  status: 'completed',
                }],
                done: true,
                turnStatus: 'awaiting_subagents',
                createdAt: 1,
                completedAt: Date.now(),
                durationMs: 1_000,
              }],
              pending: false,
            }}
          />
        </Provider>,
      )
    })

    expect(host.querySelector('[aria-label="正在等待子 Agent"]')).not.toBeNull()
    expect(host.querySelectorAll('[aria-label="正在等待子 Agent"] .agent-activity-wave > span')).toHaveLength(3)
    expect(host.querySelector('[aria-label="消息生成信息"]')).toBeNull()
    const processLabel = [...host.querySelectorAll('span')].find(
      (element) => element.textContent === '执行过程',
    )
    expect(processLabel?.parentElement?.firstElementChild?.className).toContain('rotate-90')

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps a live parent Turn expanded and breathing while its blocking Child runs', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'live-parent')
    store.set(applyAgentEventAtom, {
      sessionId: 'live-parent',
      event: { type: 'message_start', messageId: 'parent-segment', role: 'assistant' },
    })
    store.set(applyAgentEventAtom, {
      sessionId: 'live-parent',
      event: {
        type: 'subagent_event',
        invocationId: 'live-child',
        mode: 'blocking',
        goal: '运行检查',
        status: 'running',
        phase: 'started',
      },
    })
    await act(async () => {
      root.render(
        <Provider store={store}>
          <Pipeline />
        </Provider>,
      )
    })

    expect(host.querySelector('[aria-label="正在等待子 Agent"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="消息生成信息"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('shows completion time and elapsed time below a finished reply', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Pipeline
            session={{
              id: 'completed-session',
              messages: [{
                id: 'completed-message',
                role: AgentRole.Assistant,
                text: '已经处理完成。',
                toolCalls: [],
                done: true,
                createdAt: 1,
                completedAt: Date.parse('2026-07-21T12:34:56+08:00'),
                durationMs: 61_200,
              }],
              pending: false,
            }}
          />
        </Provider>,
      )
    })

    const status = host.querySelector('[aria-label="消息生成信息"]')
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('用时 1m 1s')

    await act(async () => root.unmount())
    host.remove()
  })

  it('does not crash when a legacy reply has null completion metadata', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Pipeline
            session={{
              id: 'legacy-session',
              messages: [{
                id: 'legacy-message',
                role: AgentRole.Assistant,
                text: '旧会话回复',
                toolCalls: [],
                done: true,
                createdAt: 1,
                completedAt: null,
                durationMs: null,
              }],
              pending: false,
            }}
          />
        </Provider>,
      )
    })

    expect(host.textContent).toContain('旧会话回复')
    expect(host.querySelector('[aria-label="消息生成信息"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps Workflow stage content under a stable, independently collapsible heading', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const initialBlocks: MessageBlock[] = [
      {
        type: 'workflow_step',
        workflowId: 'wf-report',
        generation: 'generation-1',
        workflowName: '生成报告',
        phase: 'validate',
        stepIndex: 0,
        stepCount: 1,
        title: '核对唯一完整记录',
        status: 'running',
      },
      { type: 'thinking', text: '正在规划验证方式。' },
      {
        type: 'tool',
        toolUseId: 'search-records',
        name: 'grep',
        input: { pattern: 'record_id' },
      },
    ]
    const renderBlocks = async (blocks: MessageBlock[]) => {
      await act(async () => {
        root.render(
          <Provider store={store}>
            <Pipeline
              session={{
                id: 'workflow-stage-session',
                messages: [],
                streaming: {
                  messageId: 'workflow-stage-message',
                  content: '',
                  toolCalls: [],
                  blocks,
                  startedAt: 1,
                },
                pending: false,
              }}
            />
          </Provider>,
        )
      })
    }

    await renderBlocks(initialBlocks)

    const heading = host.querySelector<HTMLElement>('[data-testid="workflow-stage-header"]')!
    const content = host.querySelector<HTMLElement>('[data-testid="workflow-stage-content"]')!
    expect(heading.textContent).toContain('验证 1/1')
    expect(heading.textContent).toContain('核对唯一完整记录')
    expect(content.textContent).toContain('正在规划验证方式。')
    expect(content.textContent).toContain('record_id')

    await act(async () => heading.click())
    expect(heading.getAttribute('aria-expanded')).toBe('false')
    expect(heading.textContent).toContain('验证 1/1')

    await renderBlocks([
      ...initialBlocks,
      { type: 'confirmation', question: '是否继续验证？', response: '继续' },
      { type: 'thinking', text: '收到答复后继续检查。' },
    ])

    const continuedHeading = host.querySelector<HTMLElement>('[data-testid="workflow-stage-header"]')!
    const continuedContent = host.querySelector<HTMLElement>('[data-testid="workflow-stage-content"]')!
    expect(continuedHeading).toBe(heading)
    expect(continuedHeading.getAttribute('aria-expanded')).toBe('false')
    expect(continuedContent.textContent).toContain('已与您确认')
    expect(continuedContent.textContent).toContain('收到答复后继续检查。')

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps committed Workflow step content isolated under its own heading', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const blocks: MessageBlock[] = [
      {
        type: 'workflow_step',
        workflowId: 'wf-committed',
        generation: 'generation-1',
        workflowName: 'Committed workflow',
        phase: 'execute',
        stepIndex: 0,
        stepCount: 2,
        title: 'Inspect records',
        status: 'success',
        summary: 'Inspection completed',
      },
      { type: 'thinking', text: 'FIRST_STEP_PROCESS_ONLY' },
      {
        type: 'tool',
        toolUseId: 'inspect-records',
        name: 'read_file',
        input: { path: 'inspections.json' },
      },
      {
        type: 'workflow_step',
        workflowId: 'wf-committed',
        generation: 'generation-1',
        workflowName: 'Committed workflow',
        phase: 'execute',
        stepIndex: 1,
        stepCount: 2,
        title: 'Write final report',
        status: 'success',
        summary: 'Final report written',
      },
      { type: 'thinking', text: 'SECOND_STEP_PROCESS_ONLY' },
      {
        type: 'tool',
        toolUseId: 'write-final-report',
        name: 'write_file',
        input: { path: 'report.md' },
      },
    ]

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Pipeline
            session={{
              id: 'committed-workflow-session',
              messages: [{
                id: 'committed-workflow-message',
                role: AgentRole.Assistant,
                text: '',
                toolCalls: [],
                blocks,
                done: true,
                finalAnswer: '',
                createdAt: 1,
              }],
              pending: false,
            }}
          />
        </Provider>,
      )
    })

    const contents = host.querySelectorAll<HTMLElement>('[data-testid="workflow-stage-content"]')
    expect(contents).toHaveLength(2)
    expect(contents[0]?.textContent).toContain('FIRST_STEP_PROCESS_ONLY')
    expect(contents[0]?.textContent).not.toContain('SECOND_STEP_PROCESS_ONLY')
    expect(contents[1]?.textContent).toContain('SECOND_STEP_PROCESS_ONLY')
    expect(contents[1]?.textContent).not.toContain('FIRST_STEP_PROCESS_ONLY')
    expect(contents[1]?.textContent?.trim()).not.toBe('')

    await act(async () => root.unmount())
    host.remove()
  })

  it('groups Build process content under four independently collapsible stage headings', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const initialBlocks: MessageBlock[] = [
      { type: 'build_stage', stage: 'clarify' },
      { type: 'text', text: '整理任务说明书。' },
      { type: 'build_stage', stage: 'explore' },
      { type: 'text', text: '检查目标环境。' },
      { type: 'build_stage', stage: 'generate' },
      { type: 'text', text: '生成工作流文件。' },
      { type: 'build_stage', stage: 'verify' },
      { type: 'text', text: '执行验收检查。' },
    ]
    const renderBlocks = async (blocks: MessageBlock[]) => {
      await act(async () => {
        root.render(
          <Provider store={store}>
            <Pipeline
              session={{
                id: 'build-stage-session',
                messages: [],
                streaming: {
                  messageId: 'build-stage-message',
                  content: '',
                  toolCalls: [],
                  blocks,
                  startedAt: 1,
                },
                pending: false,
              }}
            />
          </Provider>,
        )
      })
    }

    await renderBlocks(initialBlocks)

    const headings = [...host.querySelectorAll<HTMLElement>('[data-testid="build-stage-header"]')]
    const contents = [...host.querySelectorAll<HTMLElement>('[data-testid="build-stage-content"]')]
    expect(headings).toHaveLength(4)
    expect(headings.map((heading) => heading.textContent)).toEqual([
      expect.stringContaining('构建 1/4任务创建'),
      expect.stringContaining('构建 2/4探路'),
      expect.stringContaining('构建 3/4生成'),
      expect.stringContaining('构建 4/4验证'),
    ])
    expect(contents.map((content) => content.textContent)).toEqual([
      expect.stringContaining('整理任务说明书。'),
      expect.stringContaining('检查目标环境。'),
      expect.stringContaining('生成工作流文件。'),
      expect.stringContaining('执行验收检查。'),
    ])

    const exploreHeading = headings[1]!
    await act(async () => exploreHeading.click())
    expect(exploreHeading.getAttribute('aria-expanded')).toBe('false')

    const withVerificationEvidence: MessageBlock[] = [
      ...initialBlocks,
      { type: 'thinking', text: '继续补充验证证据。' },
    ]
    await renderBlocks(withVerificationEvidence)

    const continuedHeadings = [...host.querySelectorAll<HTMLElement>('[data-testid="build-stage-header"]')]
    expect(continuedHeadings[1]).toBe(exploreHeading)
    expect(continuedHeadings[1]?.getAttribute('aria-expanded')).toBe('false')
    expect(contents[3]?.textContent).toContain('继续补充验证证据。')

    await renderBlocks([
      ...withVerificationEvidence,
      { type: 'build_stage', stage: null },
      { type: 'text', text: '构建完成后的普通回复。' },
    ])

    const closedContents = [...host.querySelectorAll<HTMLElement>('[data-testid="build-stage-content"]')]
    expect(host.querySelectorAll('[data-testid="build-stage-header"]')).toHaveLength(4)
    expect(closedContents[3]?.textContent).not.toContain('构建完成后的普通回复。')
    expect(host.textContent).toContain('构建完成后的普通回复。')

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps a followed conversation anchored after layout resize without stealing user scroll', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    const OriginalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()

    try {
      await act(async () => {
        root.render(
          <Provider store={store}>
            <Pipeline
              session={{
                id: 'resizing-session',
                messages: [{
                  id: 'message',
                  role: AgentRole.Assistant,
                  text: '较长的历史回复',
                  toolCalls: [],
                  done: true,
                  createdAt: 1,
                }],
                pending: false,
              }}
            />
          </Provider>,
        )
      })

      const scroller = host.querySelector<HTMLElement>('[aria-label="会话消息"]')
      expect(scroller).not.toBeNull()
      Object.defineProperties(scroller!, {
        clientHeight: { configurable: true, value: 400 },
        scrollHeight: { configurable: true, value: 1_000 },
      })

      await act(async () => resizeCallbacks[0]!([], {} as ResizeObserver))
      expect(scroller!.scrollTop).toBe(600)
      await act(async () => scroller!.dispatchEvent(new Event('scroll')))

      scroller!.scrollTop = 300
      await act(async () => scroller!.dispatchEvent(new Event('scroll')))
      Object.defineProperty(scroller!, 'clientHeight', { configurable: true, value: 300 })
      await act(async () => resizeCallbacks[0]!([], {} as ResizeObserver))
      expect(scroller!.scrollTop).toBe(300)
    } finally {
      await act(async () => root.unmount())
      host.remove()
      globalThis.ResizeObserver = OriginalResizeObserver
    }
  })
})
