import { afterAll, afterEach, describe, expect, it, jest } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ExcelHyperlinkDialog, ExcelPivotTableDialog } = await import('../ExcelInsertDialogs')

afterEach(() => document.body.replaceChildren())
afterAll(async () => GlobalRegistrator.unregister())

describe('Excel insert dialogs', () => {
  it('normalizes and submits hyperlink details for the current cell', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onConfirm = jest.fn()
    await act(async () => root.render(
      <ExcelHyperlinkDialog
        context={{ address: 'B2', values: [['Report']] }}
        locale="zh-CN"
        onCancel={jest.fn()}
        onConfirm={onConfirm}
      />,
    ))
    const inputs = host.querySelectorAll<HTMLInputElement>('input')
    await act(async () => {
      inputs[1]!.value = 'example.com/report'
      inputs[1]!.dispatchEvent(new Event('input', { bubbles: true }))
      inputs[1]!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => host.querySelector<HTMLFormElement>('form')?.requestSubmit())
    expect(onConfirm).toHaveBeenCalledWith({
      label: 'Report',
      url: 'https://example.com/report',
    })
    await act(async () => root.unmount())
  })

  it('shows localized guidance for an unsupported link instead of leaking a raw error', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(
      <ExcelHyperlinkDialog
        context={{ address: 'B2', values: [['Report']] }}
        locale="zh-CN"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    ))
    const url = host.querySelectorAll<HTMLInputElement>('input')[1]!
    await act(async () => {
      url.value = 'file:///private/report.xlsx'
      url.dispatchEvent(new Event('input', { bubbles: true }))
      url.dispatchEvent(new Event('change', { bubbles: true }))
      host.querySelector<HTMLFormElement>('form')?.requestSubmit()
    })
    expect(host.textContent).toContain('链接仅支持 http、https 或 mailto 地址。')
    expect(host.textContent).not.toContain('hyperlink-protocol-unsupported')
    await act(async () => root.unmount())
  })

  it('submits a field-based pivot configuration for the selected data', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onConfirm = jest.fn()
    await act(async () => root.render(
      <ExcelPivotTableDialog
        context={{
          address: 'A1:C3',
          values: [['Region', 'Product', 'Revenue'], ['North', 'Desk', 12], ['South', 'Chair', 9]],
        }}
        locale="zh-CN"
        onCancel={jest.fn()}
        onConfirm={onConfirm}
      />,
    ))
    const selects = host.querySelectorAll<HTMLSelectElement>('select')
    await act(async () => {
      selects[1]!.value = '1'
      selects[1]!.dispatchEvent(new Event('change', { bubbles: true }))
      selects[3]!.value = 'average'
      selects[3]!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => host.querySelector<HTMLFormElement>('form')?.requestSubmit())
    expect(onConfirm).toHaveBeenCalledWith({
      sourceAddress: 'A1:C3',
      rowField: 0,
      columnField: 1,
      valueField: 2,
      aggregate: 'average',
    })
    await act(async () => root.unmount())
  })
})
