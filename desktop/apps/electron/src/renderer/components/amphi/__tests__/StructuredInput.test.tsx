import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { MessageBlock } from '@/atoms/agent'
import type { ReactNode } from 'react'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  document.body.replaceChildren()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Provider } = await import('jotai')
const { i18n } = await import('@/lib/i18n')
const { StructuredInput } = await import('../StructuredInput')

async function render(node: ReactNode): Promise<HTMLDivElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    createRoot(host).render(<Provider>{node}</Provider>)
  })
  return host
}

describe('StructuredInput', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })

  // A pasted path followed by the request typed after it used to be swallowed whole: the entire
  // line parsed as one absolute path, so the prose became part of the link target and its basename.
  it('keeps a path with prose after it as plain text', async () => {
    const text = '/Users/me/Documents/chapter 2.docx  turn section 2.1 into a deck, ignore the rest.'
    const host = await render(<StructuredInput blocks={[{ type: 'text', text }]} />)

    expect(host.querySelector('a')).toBeNull()
    expect(host.textContent).toBe(text)
  })

  it('keeps a standalone path line as plain text instead of a link or preview', async () => {
    const blocks: MessageBlock[] = [{ type: 'text', text: '/tmp/screenshot.png' }]
    const host = await render(<StructuredInput blocks={blocks} />)

    expect(host.querySelector('a')).toBeNull()
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toBe('/tmp/screenshot.png')
  })

  it('still renders mention and slash tokens as badges', async () => {
    const blocks: MessageBlock[] = [
      { type: 'slash', id: 'build', label: 'build' },
      { type: 'text', text: ' see ' },
      { type: 'mention', group: 'file', label: 'report.md', id: 'report' },
      { type: 'text', text: '\n/tmp/a.png' },
    ]
    const host = await render(<StructuredInput blocks={blocks} />)

    expect(host.querySelector('[data-input-token="slash"]')?.textContent).toContain('build')
    expect(host.querySelector('[data-input-token="mention"]')?.textContent).toContain('report.md')
    // The trailing path is on a line of its own, which is exactly the shape the old
    // scanner upgraded. It must stay text now.
    expect(host.querySelector('a')).toBeNull()
    expect(host.querySelector('img')).toBeNull()
  })
})
