import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { MessageBlock } from '@/atoms/agent'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => { await GlobalRegistrator.unregister() })

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { MessageContent } = await import('../MessageContent')

describe('MessageContent process presentation', () => {
  it('omits the aggregate summary only for inline embeds and preserves the original confirmation control', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const store = createStore()
    const blocks: MessageBlock[] = [{ type: 'confirmation', question: 'Approved scope?', response: '**Current files only**' }]
    const render = async (processPresentation?: 'collapsible' | 'inline') => act(async () => {
      root.render(<Provider store={store}><MessageContent blocks={blocks} sessionId="confirmation-session" processPresentation={processPresentation} /></Provider>)
    })
    const confirmation = () => [...host.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
      .find((button) => button.textContent?.includes('Approved scope?'))!

    await render()
    expect(host.textContent).toContain('执行过程')
    expect(host.textContent).toContain('0 次调用')
    expect(confirmation().closest('.grid')).not.toBeNull()

    await render('inline')
    expect(host.textContent).not.toContain('执行过程')
    expect(host.textContent).not.toContain('0 次调用')
    expect(confirmation().closest('.grid')).toBeNull()
    expect(confirmation().getAttribute('aria-expanded')).toBe('false')
    await act(async () => confirmation().click())
    expect(confirmation().getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('strong')?.textContent).toBe('Current files only')

    await render()
    expect(host.textContent).toContain('执行过程')
    expect(host.textContent).toContain('0 次调用')
    await act(async () => root.unmount())
    host.remove()
  })
})
