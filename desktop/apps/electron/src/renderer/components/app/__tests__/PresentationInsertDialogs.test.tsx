import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'
import type { PresentationInsertDialogValue } from '../PresentationInsertDialogs'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Simulate } = await import('react-dom/test-utils')
const { i18n } = await import('@/lib/i18n')
const {
  PresentationInsertDialogs,
  parsePresentationChartSeries,
  resizePresentationTableCells,
} = await import('../PresentationInsertDialogs')

const mountedRoots = new Set<Root>()

beforeEach(async () => {
  await i18n.changeLanguage('en')
})

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots) root.unmount()
    mountedRoots.clear()
  })
  document.body.replaceChildren()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function updateValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const view = element.ownerDocument.defaultView!
  let prototype: object = view.HTMLInputElement.prototype
  if (element instanceof view.HTMLTextAreaElement) prototype = view.HTMLTextAreaElement.prototype
  else if (element instanceof view.HTMLSelectElement) prototype = view.HTMLSelectElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
  Simulate.change(element)
}

async function mountDialog(props: Partial<Parameters<typeof PresentationInsertDialogs>[0]> = {}): Promise<{ root: Root; submitted: PresentationInsertDialogValue[] }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mountedRoots.add(root)
  const submitted: PresentationInsertDialogValue[] = []
  await act(async () => {
    root.render(
      <PresentationInsertDialogs
        open="table"
        slides={[{ id: 'slide-1', name: 'Cover' }, { id: 'slide-2', name: 'Details' }]}
        onClose={() => undefined}
        onSubmit={(value) => submitted.push(value)}
        {...props}
      />,
    )
  })
  return { root, submitted }
}

describe('PresentationInsertDialogs helpers', () => {
  it('resizes table data without losing cells and parses chart series strictly', () => {
    expect(resizePresentationTableCells([['A', 'B'], ['C', 'D']], 3, 1)).toEqual([['A'], ['C'], ['']])
    expect(resizePresentationTableCells([], 0, 20)).toHaveLength(1)
    expect(resizePresentationTableCells([], 0, 20)[0]).toHaveLength(10)
    expect(parsePresentationChartSeries('Revenue: 12, 18\nCost: 7, 9', 2)).toEqual([
      { name: 'Revenue', values: [12, 18] },
      { name: 'Cost', values: [7, 9] },
    ])
    expect(parsePresentationChartSeries('Revenue: 12', 2)).toBeNull()
    expect(parsePresentationChartSeries('Revenue: twelve, 18', 2)).toBeNull()
  })
})

describe('PresentationInsertDialogs', () => {
  it('edits and submits a bounded table matrix', async () => {
    const { submitted } = await mountDialog({
      initialValue: { kind: 'table', rows: 2, columns: 2, cells: [['A', 'B'], ['C', 'D']] },
    })
    const firstCell = document.querySelector<HTMLInputElement>('[data-testid="presentation-insert-table-cell-0-0"]')!
    await act(async () => updateValue(firstCell, 'Updated'))
    await act(async () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())

    expect(submitted).toEqual([{
      kind: 'table',
      rows: 2,
      columns: 2,
      cells: [['Updated', 'B'], ['C', 'D']],
    }])
  })

  it('submits chart data and rejects a pie chart with multiple series', async () => {
    const { submitted } = await mountDialog({
      open: 'chart',
      initialValue: {
        kind: 'chart',
        chartType: 'line',
        title: 'Trend',
        categories: ['Q1', 'Q2'],
        series: [{ name: 'Revenue', values: [12, 18] }],
      },
    })
    const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(submit.disabled).toBe(false)
    await act(async () => submit.click())
    expect(submitted[0]).toEqual({
      kind: 'chart',
      chartType: 'line',
      title: 'Trend',
      categories: ['Q1', 'Q2'],
      series: [{ name: 'Revenue', values: [12, 18] }],
    })

    const type = document.querySelector<HTMLSelectElement>('[data-testid="presentation-insert-chart-type"]')!
    const series = document.querySelector<HTMLTextAreaElement>('[data-testid="presentation-insert-chart-series"]')!
    await act(async () => {
      updateValue(type, 'pie')
      updateValue(series, 'Revenue: 12, 18\nCost: 4, 6')
    })
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('exactly one series')

    await act(async () => updateValue(series, 'Revenue: 0, -2'))
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('greater than zero')
  })

  it('supports slide links and preserves optional tooltip text', async () => {
    const { submitted } = await mountDialog({
      open: 'link',
      initialValue: {
        kind: 'link',
        targetType: 'slide',
        url: '',
        slideId: 'slide-2',
        label: 'Jump to details',
        tooltip: 'Open slide 2',
      },
    })
    expect(document.querySelector<HTMLSelectElement>('[data-testid="presentation-insert-link-slide"]')?.value).toBe('slide-2')
    await act(async () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    expect(submitted[0]).toEqual({
      kind: 'link',
      targetType: 'slide',
      url: '',
      slideId: 'slide-2',
      label: 'Jump to details',
      tooltip: 'Open slide 2',
    })
  })

  it('hides and does not require the label when the linked object owns its display content', async () => {
    const { submitted } = await mountDialog({
      open: 'link',
      linkLabelEditable: false,
      initialValue: {
        kind: 'link',
        targetType: 'url',
        url: 'https://example.com/image',
        slideId: '',
        label: '',
        tooltip: 'Open image source',
      },
    })
    expect(document.querySelector('[data-testid="presentation-insert-link-label"]')).toBeNull()
    const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(submit.disabled).toBe(false)
    await act(async () => submit.click())
    expect(submitted[0]).toEqual({
      kind: 'link',
      targetType: 'url',
      url: 'https://example.com/image',
      slideId: '',
      label: '',
      tooltip: 'Open image source',
    })
  })

  it('submits footer display flags and apply scope', async () => {
    const { submitted } = await mountDialog({
      open: 'footer',
      initialValue: { kind: 'footer', text: 'Confidential', showDate: false, showSlideNumber: true, applyAll: false },
    })
    const showDate = document.querySelector<HTMLInputElement>('[data-testid="presentation-insert-footer-date"]')!
    await act(async () => showDate.click())
    await act(async () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    expect(submitted[0]).toEqual({
      kind: 'footer',
      text: 'Confidential',
      showDate: true,
      showSlideNumber: true,
      applyAll: false,
    })
  })
})
