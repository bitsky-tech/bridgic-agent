import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const testWindow = globalThis.window as Window & { __localResourceToken__?: string }
beforeEach(() => {
  testWindow.__localResourceToken__ = 'human-request-test-token'
})
afterEach(() => {
  delete testWindow.__localResourceToken__
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Provider } = await import('jotai')
const { HumanRequestChoice } = await import('../HumanRequestBanner')

describe('HumanRequestChoice review list', () => {
  it('keeps long evidence collapsed and omits the free-form row', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider>
          <HumanRequestChoice
            request={{
              sessionId: 'session-review',
              questions: [{
                question: '请选择需要继续分析的论文',
                layout: 'review-list',
                multiSelect: true,
                allowOther: false,
                allowEmpty: true,
                emptyLabel: '不分析任何论文',
                minSelections: 0,
                maxSelections: 2,
                options: [
                  {
                    label: 'MemRefine',
                    description: 'OpenReview · 2026-06-11',
                    preview: '这是一段默认折叠的长证据。',
                  },
                  { label: 'ACON', description: 'arXiv · 2025-10-01' },
                ],
              }],
            }}
          />
        </Provider>,
      )
    })

    expect(host.textContent).toContain('MemRefine')
    expect(host.textContent).toContain('查看详情')
    expect(host.textContent).toContain('不分析任何论文')
    expect(host.textContent).not.toContain('这是一段默认折叠的长证据。')
    expect(host.textContent).not.toContain('输入自定义回答')

    expect(host.querySelector('.opacity-50')?.textContent).toContain('提交')
    const chooseNone = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('不分析任何论文'),
    )
    await act(async () => chooseNone?.click())
    expect(host.querySelector('.opacity-50')).toBeNull()

    const details = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('查看详情'),
    )
    await act(async () => details?.click())
    expect(host.textContent).toContain('这是一段默认折叠的长证据。')
    expect(host.textContent).toContain('收起')

    await act(async () => root.unmount())
    host.remove()
  })

  it('preserves the existing compact question presentation', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider>
          <HumanRequestChoice
            request={{
              sessionId: 'session-compact',
              questions: [{
                question: '请选择执行方式',
                options: [{ label: '自动' }, { label: '手动' }],
              }],
            }}
          />
        </Provider>,
      )
    })

    expect(host.textContent).toContain('自动')
    expect(host.textContent).toContain('手动')
    expect(host.textContent).toContain('其他')

    await act(async () => root.unmount())
    host.remove()
  })

  it('uses each tab layout independently and renders legacy multi-select as a review list', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider>
          <HumanRequestChoice
            request={{
              sessionId: 'session-mixed-layouts',
              prompt: '比较资料',
              questions: [
                {
                  question: '选择实现方案',
                  header: '实现方案',
                  layout: 'compact',
                  options: [{ label: '方案 A' }, { label: '方案 B' }],
                },
                {
                  question: '选择首期能力',
                  header: '首期能力',
                  layout: 'compact',
                  multiSelect: true,
                  allowOther: false,
                  options: [{ label: '关键词搜索' }, { label: '语义搜索' }],
                },
              ],
            }}
          />
        </Provider>,
      )
    })

    const cardBody = host.querySelector<HTMLElement>('[data-question-layout]')
    expect(cardBody?.dataset.questionLayout).toBe('compact')
    expect(host.querySelector('[aria-label="问题背景"]')?.className).not.toContain('bg-bg-input')

    const secondTab = Array.from(host.querySelectorAll<HTMLElement>('div')).find(
      (element) => element.textContent?.trim() === '首期能力' && element.className.includes('cursor-pointer'),
    )
    await act(async () => secondTab?.click())

    expect(cardBody?.dataset.questionLayout).toBe('review-list')
    expect(host.textContent).toContain('已选择 0/2')
    expect(host.querySelector<HTMLElement>('[data-option-index="0"]')?.className).toContain(
      'border-border-subtle',
    )

    await act(async () => root.unmount())
    host.remove()
  })

  it('renders Markdown in questions and options without link clicks selecting an option', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider>
          <HumanRequestChoice
            request={{
              sessionId: 'session-markdown',
              prompt: [
                '![本地示意图](file:///tmp/interaction.png)',
                '',
                '```mermaid',
                'flowchart LR',
                'A --> B',
                '```',
              ].join('\n'),
              questions: [{
                question: '请参考 **说明**：[项目文档](https://example.com/docs)',
                options: [{
                  label: '**使用 SDK** · [查看接口](https://example.com/api)',
                  description: '通过 `client.run()` 完成调用。![SDK 图标](https://example.com/sdk.png)',
                  preview: '补充的 **Markdown** 详情。',
                }],
                allowOther: false,
              }],
            }}
          />
        </Provider>,
      )
    })

    expect(host.querySelector('strong')?.textContent).toBe('说明')
    expect(host.querySelector('[aria-label="问题背景"]')).not.toBeNull()
    expect(host.textContent).not.toContain('背景资料')
    expect(Array.from(host.querySelectorAll('code')).some((code) => code.textContent === 'client.run()')).toBe(true)
    expect(host.querySelectorAll('a')).toHaveLength(2)
    const localImageUrl = new URL(host.querySelector('img')?.getAttribute('src') ?? '')
    expect(localImageUrl.protocol).toBe('bridgic-local:')
    expect(localImageUrl.searchParams.get('src')).toBe('file:///tmp/interaction.png')
    expect(localImageUrl.searchParams.get('token')).toBe('human-request-test-token')
    expect(host.textContent).toContain('flowchart LR')
    expect(host.textContent).not.toContain('补充的 Markdown 详情。')
    const option = host.querySelector<HTMLElement>('[data-option-index="0"]')!
    expect(option.dataset.selected).toBe('false')

    const optionLink = Array.from(host.querySelectorAll('a')).find((link) =>
      link.textContent?.includes('查看接口'),
    )
    await act(async () => optionLink?.click())
    expect(option.dataset.selected).toBe('false')
    const optionImage = host.querySelector<HTMLImageElement>('img[alt="SDK 图标"]')
    await act(async () => optionImage?.click())
    expect(option.dataset.selected).toBe('false')

    const details = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('查看详情'),
    )
    await act(async () => details?.click())
    expect(host.textContent).toContain('补充的 Markdown 详情。')
    expect(option.dataset.selected).toBe('false')

    await act(async () => root.unmount())
    host.remove()
  })
})
