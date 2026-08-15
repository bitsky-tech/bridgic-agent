/**
 * EmbeddedShowcasePage — the two things a refactor here gets wrong.
 *
 * The placeholder must cover a frame that is already loading, not stand in for
 * one that has not been created: rendering the frame only once `loaded` is true
 * deadlocks, because `loaded` can only ever be set by the frame's own load event.
 * And the placeholder has to actually clear on that event, or every preview looks
 * permanently stuck.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { EmbeddedShowcasePage } = await import('../EmbeddedShowcasePage')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const URL = 'https://showcase.bridgic.ai/zh/workflows/xiaohongshu?bridgic-embed=1&bridgic-theme=dark'
/** i18n is pinned to zh by test-setup.ts, so the copy is the Chinese one. */
const PLACEHOLDER = '正在加载工作流页面'

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<EmbeddedShowcasePage url={URL} title="preview" />)
  })
  return {
    frame: () => host.querySelector('iframe'),
    text: () => host.textContent ?? '',
    finishLoading: async () => {
      await act(async () => {
        host.querySelector('iframe')?.dispatchEvent(new Event('load'))
      })
    },
  }
}

describe('EmbeddedShowcasePage', () => {
  it('mounts the frame straight away and covers it with a placeholder', async () => {
    const v = await mount()

    expect(v.text()).toContain(PLACEHOLDER)
    // The frame exists *while* the placeholder shows -- this is the assertion that
    // fails if someone turns the placeholder into an either/or render.
    expect(v.frame()?.getAttribute('src')).toBe(URL)
  })

  it('clears the placeholder once the frame reports it loaded', async () => {
    const v = await mount()
    await v.finishLoading()

    expect(v.text()).not.toContain(PLACEHOLDER)
    expect(v.frame()?.getAttribute('src')).toBe(URL)
  })
})
