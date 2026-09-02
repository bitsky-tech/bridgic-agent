import { afterAll, afterEach, describe, expect, it, jest } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ExcelRibbon } = await import('../ExcelRibbon')

afterEach(() => document.body.replaceChildren())
afterAll(async () => GlobalRegistrator.unregister())

describe('ExcelRibbon', () => {
  it('matches the presentation workbench hierarchy and exposes the open-source feature categories', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onAction = jest.fn()
    const onActiveTabChange = jest.fn()

    await act(async () => root.render(
      <ExcelRibbon
        activeTab="home"
        disabled={false}
        locale="zh-CN"
        onAction={onAction}
        onActiveTabChange={onActiveTabChange}
        onAddressSubmit={jest.fn()}
        onFormulaSubmit={jest.fn()}
        selectionAddress="B10"
        selectionValue="=SUM(B2:B9)"
      />,
    ))

    const categoryTabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(categoryTabs.map((tab) => tab.textContent)).toEqual(['开始', '插入', '数据', '公式', '视图'])
    expect(host.querySelector<HTMLInputElement>('[aria-label="Name box"]')?.value).toBe('B10')
    expect(host.querySelector<HTMLInputElement>('[aria-label="Formula bar"]')?.value).toBe('=SUM(B2:B9)')

    await act(async () => categoryTabs[2]?.click())
    expect(onActiveTabChange).toHaveBeenCalledWith('data')

    await act(async () => root.render(
      <ExcelRibbon
        activeTab="data"
        disabled={false}
        locale="zh-CN"
        onAction={onAction}
        onActiveTabChange={onActiveTabChange}
        onAddressSubmit={jest.fn()}
        onFormulaSubmit={jest.fn()}
        selectionAddress="B10"
        selectionValue="=SUM(B2:B9)"
      />,
    ))
    expect(host.querySelector('[aria-label="数据验证"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="条件格式"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="筛选"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="排序"]')).not.toBeNull()

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="排序"]')?.click())
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === '升序')?.click())
    expect(onAction).toHaveBeenCalledWith('sort-ascending', undefined)

    await act(async () => root.unmount())
  })

  it('exposes explicit merge choices, a categorized formula library, and no sticky native tooltips', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onAction = jest.fn()
    const commonProps = {
      disabled: false,
      locale: 'zh-CN' as const,
      onAction,
      onActiveTabChange: jest.fn(),
      onAddressSubmit: jest.fn(),
      onFormulaSubmit: jest.fn(),
      selectionAddress: 'A1',
      selectionValue: '',
    }

    await act(async () => root.render(<ExcelRibbon {...commonProps} activeTab="home" />))
    expect(host.querySelector('[title]')).toBeNull()
    expect(host.querySelector('[aria-label="合并后居中"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="顶端对齐"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="增加小数位"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="筛选"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="排序"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="插入"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="图表"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="打印"]')).toBeNull()
    expect(host.querySelectorAll('[data-compact-ribbon-action="true"]').length).toBe(8)
    expect(host.querySelectorAll('[data-compact-variant="inline"]').length).toBe(6)
    expect(host.querySelectorAll('[data-compact-variant="tall"]').length).toBe(2)
    expect(host.querySelector('[aria-label="条件格式"]')?.getAttribute('data-compact-variant')).toBe('tall')
    expect(host.querySelector('[data-quick-layout="data"]')?.children.length).toBe(3)
    expect(host.querySelector('[aria-label="数据验证"]')?.getAttribute('data-compact-variant')).toBe('inline')
    expect(host.querySelector('[aria-label="冻结窗格"]')).toBeNull()
    expect(host.querySelector('[aria-label="自动求和"]')).toBeNull()
    expect(host.querySelector('[data-quick-layout="insert"]')?.children.length).toBe(3)
    expect(host.querySelector('[aria-label="插入"]')?.getAttribute('data-compact-variant')).toBe('tall')
    expect(host.querySelector('[aria-label="启用筛选"]')).toBeNull()
    expect(host.querySelector('[aria-label="折线图"]')).toBeNull()

    const bold = host.querySelector<HTMLButtonElement>('[aria-label="加粗"]')
    await act(async () => bold?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(document.querySelector('[data-ribbon-tooltip="true"]')?.textContent).toBe('加粗')
    await act(async () => bold?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    expect(document.querySelector('[data-ribbon-tooltip="true"]')).toBeNull()

    const mergeMenu = host.querySelector<HTMLSelectElement>('[aria-label="更多合并选项"]')
    expect([...mergeMenu?.options ?? []].map((option) => option.textContent)).toContain('跨列合并')
    await act(async () => {
      if (!mergeMenu) return
      mergeMenu.value = 'merge-across'
      mergeMenu.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onAction).toHaveBeenCalledWith('merge-across', undefined)

    await act(async () => root.render(<ExcelRibbon {...commonProps} activeTab="formulas" recentFunctions={['XLOOKUP']} />))
    expect(host.querySelector('[aria-label="插入函数"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="自动求和"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="最近使用"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="财务"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="日期与时间"]')).not.toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="查找与引用"]')?.click())
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === 'XLOOKUP')?.click())
    expect(onAction).toHaveBeenCalledWith('formula-insert', 'XLOOKUP')

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="自动求和"]')?.click())
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === '平均值')?.click())
    expect(onAction).toHaveBeenCalledWith('formula-average', undefined)

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="插入函数"]')?.click())
    expect(onAction).toHaveBeenCalledWith('formula-more', undefined)
    await act(async () => root.unmount())
  })

  it('exposes the professional insert groups and dispatches their concrete commands', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onAction = jest.fn()
    await act(async () => root.render(
      <ExcelRibbon
        activeTab="insert"
        disabled={false}
        locale="zh-CN"
        onAction={onAction}
        onActiveTabChange={jest.fn()}
        onAddressSubmit={jest.fn()}
        onFormulaSubmit={jest.fn()}
        selectionAddress="A1:C8"
        selectionValue=""
      />,
    ))

    expect(host.querySelector('[aria-label="数据透视表"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="单元格"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="行和列"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="统计图表"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="网络链接"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="插入图片"]')).not.toBeNull()

    const cellMenu = host.querySelector<HTMLButtonElement>('[aria-label="单元格"]')
    await act(async () => cellMenu?.click())
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes('右移'))?.click())
    expect(onAction).toHaveBeenCalledWith('insert-cells-right', undefined)
    expect(cellMenu?.getAttribute('aria-expanded')).toBe('false')

    const chartMenu = host.querySelector<HTMLButtonElement>('[aria-label="统计图表"]')
    await act(async () => chartMenu?.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="折线图"]')?.click())
    expect(onAction).toHaveBeenCalledWith('insert-chart', 'line')
    expect(chartMenu?.getAttribute('aria-expanded')).toBe('false')

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="数据透视表"]')?.click())
    expect(onAction).toHaveBeenCalledWith('insert-pivot-table', undefined)
    await act(async () => root.unmount())
  })

  it('exposes a compact, functional worksheet view toolbar', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onAction = jest.fn()
    await act(async () => root.render(
      <ExcelRibbon
        activeTab="view"
        disabled={false}
        locale="zh-CN"
        onAction={onAction}
        onActiveTabChange={jest.fn()}
        onAddressSubmit={jest.fn()}
        onFormulaSubmit={jest.fn()}
        selectionAddress="E3"
        selectionValue=""
        viewState={{ darkMode: true, gridlines: true, highlightMode: 'both', showZeros: false, zoom: 1.25 }}
      />,
    ))

    expect(host.querySelector('[aria-label="高亮所在行列"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="行高列宽"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="冻结窗格"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="深色显示"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="深色显示"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector('[aria-label="高亮所在行列"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector('[aria-label="显示比例 125%"]')).not.toBeNull()
    expect(host.querySelector('[data-quick-layout="view-options"]')?.children.length).toBe(2)
    expect(host.querySelector('[aria-label="显示网格线"]')?.getAttribute('aria-checked')).toBe('true')
    expect(host.querySelector('[aria-label="显示零值"]')?.getAttribute('aria-checked')).toBe('false')

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="冻结窗格"]')?.click())
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === '冻结至当前单元格')?.click())
    expect(onAction).toHaveBeenCalledWith('freeze-selection', undefined)

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="显示网格线"]')?.click())
    expect(onAction).toHaveBeenCalledWith('toggle-gridlines', undefined)
    await act(async () => root.unmount())
  })
})
