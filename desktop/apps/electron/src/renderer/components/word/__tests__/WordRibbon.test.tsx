import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { i18n } = await import('@/lib/i18n')
const { WordRibbon } = await import('../WordRibbon')

beforeEach(async () => i18n.changeLanguage('zh'))
afterEach(() => document.body.replaceChildren())
afterAll(async () => GlobalRegistrator.unregister())

describe('WordRibbon', () => {
  it('uses the Excel ribbon hierarchy with Word-specific command groups', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const onActiveTabChange = jest.fn()
    const props = {
      activeTab: 'home' as const,
      onActiveTabChange,
      onCommand: jest.fn(),
      onEditFooter: jest.fn(),
      onEditHeader: jest.fn(),
      onInlineStyle: jest.fn(),
      onInsertCaption: jest.fn(),
      onInsertCitation: jest.fn(),
      onInsertFootnote: jest.fn(),
      onInsertHtml: jest.fn(),
      onInsertImage: jest.fn(),
      onInsertLink: jest.fn(),
      onInsertPageBreak: jest.fn(),
      onInsertTable: jest.fn(),
      onInsertTableOfContents: jest.fn(),
      onPageChange: jest.fn(),
      onTableAction: jest.fn(),
      onToggleRibbon: jest.fn(),
      onToggleRuler: jest.fn(),
      onZoomChange: jest.fn(),
      page: { margins: 'normal' as const, orientation: 'portrait' as const, size: 'a4' as const },
      ribbonCollapsed: false,
      rulerVisible: true,
      tableActive: true,
      zoom: 100,
    }

    await act(async () => root.render(<WordRibbon {...props} />))
    expect(host.querySelector('[data-ribbon-layout="excel-aligned"]')).not.toBeNull()
    expect([...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['开始', '插入', '页面', '引用', '视图'])
    expect([...host.querySelectorAll('[data-word-ribbon-group="true"]')].map((group) => group.getAttribute('aria-label')))
      .toEqual(['剪贴板与历史', '字体', '段落', '样式'])
    expect(host.querySelector('[aria-label="字体"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="加粗"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="粘贴"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="剪切"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="复制"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="编号列表"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="打印"]')).toBeNull()
    expect(host.querySelector('[aria-label="查找"]')).toBeNull()

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="粘贴"]')?.click())
    expect(props.onCommand).toHaveBeenCalledWith('paste')

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="加粗"]')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 1))
    })
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('加粗')

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="word-tab-insert"]')?.click())
    expect(onActiveTabChange).toHaveBeenCalledWith('insert')
    await act(async () => root.render(<WordRibbon {...props} activeTab="insert" />))
    expect(host.querySelector('[aria-label="分页符"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="表格"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="图片"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="链接"]')).not.toBeNull()

    await act(async () => root.render(<WordRibbon {...props} activeTab="view" />))
    expect(host.querySelector('[aria-label="标尺"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="查找"]')).toBeNull()

    await act(async () => root.render(<WordRibbon {...props} ribbonCollapsed />))
    expect(host.querySelector('[data-testid="word-ribbon"]')?.className).toContain('h-0')
    expect(host.querySelector('[data-testid="word-ribbon-toolbar"]')?.getAttribute('aria-hidden')).toBe('true')
    await act(async () => root.unmount())
  })
})
