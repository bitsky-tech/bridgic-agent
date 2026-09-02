import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { thinkingModeFamily } = await import('@/atoms/agent')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { PresentationModePane } = await import('../PresentationModePane')

describe('PresentationModePane', () => {
  it('shows the four-stage production skeleton and current stage', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-presentation-pane'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'presentation', stage: 'ppt_compose' })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <PresentationModePane />
        </Provider>,
      )
    })

    const stages = host.querySelectorAll('[data-stage]')
    expect(stages).toHaveLength(4)
    expect(host.querySelector('[data-stage="ppt_brief"]')?.getAttribute('data-state')).toBe('complete')
    expect(host.querySelector('[data-stage="ppt_plan"]')?.getAttribute('data-state')).toBe('complete')
    expect(host.querySelector('[data-stage="ppt_compose"]')?.getAttribute('data-state')).toBe('current')
    expect(host.querySelector('[data-stage="ppt_review"]')?.getAttribute('data-state')).toBe('pending')

    await act(async () => root.unmount())
    host.remove()
  })
})
