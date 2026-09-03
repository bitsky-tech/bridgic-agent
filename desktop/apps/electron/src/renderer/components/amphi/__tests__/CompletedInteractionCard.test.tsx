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
})
