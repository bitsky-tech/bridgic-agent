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

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="升序"]')?.click())
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
    const mergeMenu = host.querySelector<HTMLSelectElement>('[aria-label="更多合并选项"]')
    expect([...mergeMenu?.options ?? []].map((option) => option.textContent)).toContain('跨列合并')
    await act(async () => {
      if (!mergeMenu) return
      mergeMenu.value = 'merge-across'
      mergeMenu.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onAction).toHaveBeenCalledWith('merge-across', undefined)

    await act(async () => root.render(<ExcelRibbon {...commonProps} activeTab="formulas" />))
    expect(host.querySelector('[aria-label="全部函数"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="财务"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="日期与时间"]')).not.toBeNull()
    const lookupMenu = host.querySelector<HTMLSelectElement>('[aria-label="查找与引用"]')
    expect([...lookupMenu?.options ?? []].map((option) => option.value)).toContain('XLOOKUP')
    await act(async () => {
      if (!lookupMenu) return
      lookupMenu.value = 'XLOOKUP'
      lookupMenu.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onAction).toHaveBeenCalledWith('formula-insert', 'XLOOKUP')

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="全部函数"]')?.click())
    expect(onAction).toHaveBeenCalledWith('formula-more', undefined)
    await act(async () => root.unmount())
  })
})
