import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { CompletedInteractionCard } = await import('../CompletedInteractionCard')

describe('CompletedInteractionCard', () => {
  it('renders every confirmed acceptance rule as its own aligned row', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <CompletedInteractionCard
          block={{
            type: 'confirmation',
            kind: 'accept_rule',
            question: '完成标准已对齐',
            response: 'AC-001: 报告存在\nAC-002: 报告使用中文',
            rules: [
              { id: 'AC-001', text: 'AC-001: 报告存在' },
              { id: 'AC-002', text: 'AC-002：报告使用中文' },
            ],
          }}
        />,
      )
    })

    expect(host.textContent).toContain('已对齐的完成标准')
    expect(host.textContent).toContain('共 2 项')
    const items = host.querySelectorAll('ol[aria-label="已对齐的完成标准"] > li')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain('标准 1')
    expect(items[0]?.textContent).not.toContain('AC-001')
    expect(items[0]?.textContent).toContain('报告存在')
    expect(items[0]?.textContent).not.toContain('报告使用中文')
    expect(items[1]?.textContent).toContain('标准 2')
    expect(items[1]?.textContent).not.toContain('AC-002')
    expect(items[1]?.textContent).toContain('报告使用中文')

    await act(async () => root.unmount())
    host.remove()
  })

  it('shows a new message without claiming the acceptance rules were confirmed', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <CompletedInteractionCard
          block={{
            type: 'confirmation',
            kind: 'accept_rule_message',
            question: '完成标准稍后再对齐',
            response: '请把第一条规则改得更具体。',
          }}
        />,
      )
    })

    expect(host.textContent).toContain('完成标准稍后再对齐')
    expect(host.textContent).toContain('你发来了新消息')
    expect(host.textContent).toContain('请把第一条规则改得更具体。')
    expect(host.textContent).not.toContain('您的回答')

    await act(async () => root.unmount())
    host.remove()
  })

  it('shows direct input as a reply to the whole confirmation card', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <CompletedInteractionCard
          block={{
            type: 'confirmation',
            kind: 'confirmation_message',
            question: '工作流保存确认',
            response: '保存前请再调整名称策略。',
          }}
        />,
      )
    })

    expect(host.textContent).toContain('已回复工作流保存确认')
    expect(host.textContent).toContain('你发来了新消息')
    expect(host.textContent).toContain('保存前请再调整名称策略。')
    expect(host.textContent).not.toContain('已保存')

    await act(async () => root.unmount())
    host.remove()
  })

  it('shows an explicit execution-only completion choice', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <CompletedInteractionCard
          block={{
            type: 'confirmation',
            kind: 'accept_rule',
            question: '已选择不设置完成标准',
            response: '该工作流未设置完成标准，运行时只执行步骤，无需结果校验；执行报错仍会正常失败。',
            acceptanceMode: 'execution_only',
            rules: [],
          }}
        />,
      )
    })

    expect(host.textContent).toContain('未设置完成标准')
    expect(host.textContent).toContain('无需结果校验')
    expect(host.textContent).toContain('执行报错仍会明确失败')
    expect(host.textContent).not.toContain('已对齐的完成标准')

    await act(async () => root.unmount())
    host.remove()
  })

  it('renders each completed question beside its own answer', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <CompletedInteractionCard
          block={{
            type: 'confirmation',
            question: '你希望采用哪种回复风格？\n\n遇到不确定的地方时怎么处理？',
            response: '你希望采用哪种回复风格？: 简洁\n遇到不确定的地方时怎么处理？: 先向我确认',
          }}
        />,
      )
    })

    const items = Array.from(host.querySelectorAll('ol[aria-label="已确认的问答"] > li'))
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain('你希望采用哪种回复风格？')
    expect(items[0]?.textContent).toContain('简洁')
    expect(items[0]?.textContent).not.toContain('先向我确认')
    expect(items[1]?.textContent).toContain('遇到不确定的地方时怎么处理？')
    expect(items[1]?.textContent).toContain('先向我确认')
    expect(items[1]?.textContent).not.toContain('简洁')

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps Markdown background separate from the completed questions', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <CompletedInteractionCard
          block={{
            type: 'confirmation',
            prompt: '**方案背景**：[设计说明](https://example.com/design)',
            question: '选择哪种方案？',
            response: '方案 A',
          }}
        />,
      )
    })

    expect(host.querySelector('[aria-label="确认背景"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="确认背景"]')?.className).not.toContain('bg-bg-input')
    expect(host.querySelector('[aria-label="确认背景"] strong')?.textContent).toBe('方案背景')
    expect(host.textContent).not.toContain('背景资料')
    expect(host.querySelector('[aria-label="已确认的问答"]')?.textContent).toContain('选择哪种方案？')
    expect(host.querySelector('[aria-label="已确认的问答"]')?.textContent).toContain('方案 A')

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps an unstructured combined response intact instead of guessing pairs', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <CompletedInteractionCard
          block={{
            type: 'confirmation',
            question: '第一个问题？\n\n第二个问题？',
            response: '请按我刚才的整体说明处理。',
          }}
        />,
      )
    })

    const items = host.querySelectorAll('ol[aria-label="已确认的问答"] > li')
    expect(items).toHaveLength(1)
    expect(items[0]?.textContent).toContain('第一个问题？')
    expect(items[0]?.textContent).toContain('第二个问题？')
    expect(items[0]?.textContent).toContain('请按我刚才的整体说明处理。')

    await act(async () => root.unmount())
    host.remove()
  })

  // What the user typed is theirs; the card must not reinterpret it. A path they
  // wrote stays the characters they wrote, matching the plain chat bubble and the
  // task_confirm feedback line, which never went through Markdown either.
  it('renders a replied message verbatim, never as a link', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const response = '/tmp/report.pdf'

    await act(async () => {
      root.render(
        <CompletedInteractionCard
          block={{
            type: 'confirmation',
            kind: 'confirmation_message',
            question: '需要哪个文件？',
            response,
          }}
        />,
      )
    })

    expect(host.textContent).toContain(response)
    expect(host.querySelector('a')).toBeNull()
    expect(host.querySelector('img')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('renders a question answer verbatim while the agent-authored context keeps Markdown', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <CompletedInteractionCard
          block={{
            type: 'confirmation',
            prompt: '/tmp/context.pdf',
            question: '用哪个文件？',
            response: '/tmp/answer.pdf',
          }}
        />,
      )
    })

    // The answer is the user's own text.
    const answerRow = host.querySelector('ol[aria-label="已确认的问答"] > li')
    expect(answerRow?.textContent).toContain('/tmp/answer.pdf')
    expect(answerRow?.querySelector('a')).toBeNull()
    // The agent-authored context above it still renders as Markdown, links included.
    const context = host.querySelector('section[aria-label="确认背景"]')
    expect(context?.querySelector('a')?.getAttribute('href')).toBe('/tmp/context.pdf')

    await act(async () => root.unmount())
    host.remove()
  })
})
