import { afterAll, afterEach, describe, expect, it, jest } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ExcelFormulaWizardDialog } = await import('../ExcelFormulaWizardDialog')

afterEach(() => document.body.replaceChildren())
afterAll(async () => GlobalRegistrator.unregister())

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for formula dialog state.')
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
  }
}

describe('Excel formula wizard dialog', () => {
  it('loads an existing formula, previews it, and inserts it at the target', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onConfirm = jest.fn()
    const onEvaluate = jest.fn(async (_formula: string) => ({ value: 'found' }))
    const expectedFormula = '=XLOOKUP(A2,B2:B8,C2:C8)'
    await act(async () => root.render(
      <ExcelFormulaWizardDialog
        initialFormula={expectedFormula}
        locale="zh-CN"
        onCancel={jest.fn()}
        onConfirm={onConfirm}
        onEvaluate={onEvaluate}
        recentFunctions={['SUM']}
        selectionAddress="A1"
        selectionSheetName="Sheet1"
        targetAddress="D4"
        targetSheetName="Sheet1"
      />,
    ))

    expect(host.textContent).toContain(expectedFormula)
    await waitFor(() => onEvaluate.mock.calls.some((call) => call[0] === expectedFormula))
    await waitFor(() => host.textContent?.includes('found') ?? false)
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '插入公式')?.click())
    expect(onConfirm).toHaveBeenCalledWith('=XLOOKUP(A2,B2:B8,C2:C8)', 'XLOOKUP')
    await act(async () => root.unmount())
  })

  it('filters by professional formula category', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(
      <ExcelFormulaWizardDialog
        locale="en-US"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
        onEvaluate={async () => ({ value: '' })}
        recentFunctions={[]}
        selectionAddress="A1"
        selectionSheetName="Sheet1"
        targetAddress="A1"
        targetSheetName="Sheet1"
      />,
    ))
    const category = host.querySelector<HTMLSelectElement>('[aria-label="Function category"]')!
    await act(async () => {
      category.value = 'financial'
      category.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const names = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].map((button) => button.textContent)
    expect(names).toContain('PMT')
    expect(names).not.toContain('XLOOKUP')
    await act(async () => root.unmount())
  })

  it('picks a sheet range without losing the original formula target', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onConfirm = jest.fn()
    const render = (selectionAddress: string) => root.render(
      <ExcelFormulaWizardDialog
        initialFormula="=SUM()"
        locale="zh-CN"
        onCancel={jest.fn()}
        onConfirm={onConfirm}
        onEvaluate={async () => ({ value: '42' })}
        recentFunctions={[]}
        selectionAddress={selectionAddress}
        selectionSheetName="Sheet1"
        targetAddress="D4"
        targetSheetName="Sheet1"
      />,
    )
    await act(async () => render('A1'))

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label^="在表格中选择单元格或区域"]')?.click())
    await act(async () => render('B2:B8'))
    const picker = host.querySelector<HTMLElement>('[aria-label="在表格中选择单元格或区域"]')!
    expect(picker.querySelector<HTMLInputElement>('input')?.value).toBe('B2:B8')
    await act(async () => [...picker.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '完成选择')?.click())

    expect(host.textContent).toContain('=SUM(B2:B8)')
    expect(host.textContent).toContain('Sheet1!D4')
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '插入公式')?.click())
    expect(onConfirm).toHaveBeenCalledWith('=SUM(B2:B8)', 'SUM')
    await act(async () => root.unmount())
  })

  it('can pick the range that was already selected when the picker opened', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(
      <ExcelFormulaWizardDialog
        initialFormula="=SUM()"
        locale="zh-CN"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
        onEvaluate={async () => ({ value: '42' })}
        recentFunctions={[]}
        selectionAddress="B2:B8"
        selectionSheetName="Sheet1"
        targetAddress="D4"
        targetSheetName="Sheet1"
      />,
    ))

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label^="在表格中选择单元格或区域"]')?.click())
    const picker = host.querySelector<HTMLElement>('[aria-label="在表格中选择单元格或区域"]')!
    expect(picker.querySelector<HTMLInputElement>('input')?.value).toBe('B2:B8')
    await act(async () => [...picker.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '完成选择')?.click())
    expect(host.textContent).toContain('=SUM(B2:B8)')
    await act(async () => root.unmount())
  })

  it('shows a friendly localized calculation error', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onEvaluate = jest.fn(async (_formula: string) => ({ errorCode: '#DIV/0!' }))
    await act(async () => root.render(
      <ExcelFormulaWizardDialog
        initialFormula="=SUM(1)"
        locale="zh-CN"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
        onEvaluate={onEvaluate}
        recentFunctions={[]}
        selectionAddress="A1"
        selectionSheetName="Sheet1"
        targetAddress="A1"
        targetSheetName="Sheet1"
      />,
    ))
    await waitFor(() => host.textContent?.includes('除数为 0') ?? false)
    expect(onEvaluate).toHaveBeenCalledWith('=SUM(1)')
    expect(host.textContent).toContain('除数为 0')
    await act(async () => root.unmount())
  })

  it('opens a formula selected from a ribbon category directly in its argument wizard', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(
      <ExcelFormulaWizardDialog
        initialFormula="=XLOOKUP()"
        locale="zh-CN"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
        onEvaluate={async () => ({ value: '' })}
        recentFunctions={[]}
        selectionAddress="A1"
        selectionSheetName="Sheet1"
        targetAddress="D4"
        targetSheetName="Sheet1"
      />,
    ))

    expect(host.querySelector('[aria-label="搜索函数名称、用途或参数"]')).toBeNull()
    expect(host.textContent).toContain('插入函数 · XLOOKUP')
    expect(host.querySelector('#formula-argument-0')).not.toBeNull()
    expect(host.textContent).toContain('公式将写入 Sheet1!D4')
    await act(async () => root.unmount())
  })
})
