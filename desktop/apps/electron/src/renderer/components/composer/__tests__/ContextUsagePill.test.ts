import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { contextUsageFamily } = await import('@/atoms/agent')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { ContextUsagePill, formatContextTokens } = await import('../ContextUsagePill')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

describe('formatContextTokens', () => {
  it('keeps the compact context indicator readable', () => {
    expect(formatContextTokens(999)).toBe('999')
    expect(formatContextTokens(12_345)).toBe('12.3k')
    expect(formatContextTokens(128_000)).toBe('128k')
    expect(formatContextTokens(1_250_000)).toBe('1.3m')
  })
})

describe('ContextUsagePill', () => {
  it('renders nothing before the session has a context snapshot', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'new-session')

    await act(async () => {
      root.render(createElement(Provider, { store }, createElement(ContextUsagePill)))
    })

    expect(host.innerHTML).toBe('')
    await act(async () => root.unmount())
    host.remove()
  })

  it('shows provider-reported cache hits in the usage detail', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'cached-session')
    store.set(contextUsageFamily('cached-session'), {
      modelId: 'gpt-test',
      inputTokens: 60,
      outputTokens: 10,
      cachedInputTokens: 42,
      usedTokens: 60,
      usableTokens: 100,
      percentage: 60,
      source: 'provider',
      breakdown: {
        systemPromptTokens: 10,
        dynamicContextTokens: 10,
        toolSchemaTokens: 10,
        sessionHistoryTokens: 20,
        currentInputTokens: 10,
      },
    })

    await act(async () => {
      root.render(createElement(Provider, { store }, createElement(ContextUsagePill)))
    })
    const trigger = host.querySelector<HTMLElement>('[aria-label]')
    expect(trigger).not.toBeNull()
    await act(async () => {
      trigger?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 320))
    })

    const tooltip = document.querySelector('[role="tooltip"]')
    expect(tooltip?.textContent).toContain('42')
    expect(tooltip?.querySelector('[role="progressbar"]')).not.toBeNull()
    expect(tooltip?.querySelector('[data-context-part]')).toBeNull()
    expect(tooltip?.querySelector('[data-context-cache]')).not.toBeNull()
    await act(async () => root.unmount())
    host.remove()
  })

  it('omits the cache card when the provider does not report cache usage', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'uncached-session')
    store.set(contextUsageFamily('uncached-session'), {
      modelId: 'gpt-test',
      inputTokens: 60,
      outputTokens: 10,
      cachedInputTokens: null,
      usedTokens: 60,
      usableTokens: 100,
      percentage: 60,
      source: 'provider',
      breakdown: {
        systemPromptTokens: 10,
        dynamicContextTokens: 10,
        toolSchemaTokens: 10,
        sessionHistoryTokens: 20,
        currentInputTokens: 10,
      },
    })

    await act(async () => {
      root.render(createElement(Provider, { store }, createElement(ContextUsagePill)))
    })
    const trigger = host.querySelector<HTMLElement>('[aria-label]')
    await act(async () => {
      trigger?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 320))
    })

    expect(document.querySelector('[role="tooltip"]')?.querySelector('[data-context-cache]')).toBeNull()
    await act(async () => root.unmount())
    host.remove()
  })
})
