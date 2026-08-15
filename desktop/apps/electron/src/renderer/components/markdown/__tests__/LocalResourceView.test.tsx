import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TOKEN = 'renderer-test-token'
const testWindow = globalThis.window as Window & { __localResourceToken__?: string }

beforeEach(() => {
  testWindow.__localResourceToken__ = TOKEN
})
afterEach(() => {
  delete testWindow.__localResourceToken__
  document.body.replaceChildren()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Provider } = await import('jotai')
const { MarkdownMessage } = await import('../MarkdownMessage')
const { LocalPathText } = await import('../LocalResourceView')

async function render(node: ReactNode): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<Provider>{node}</Provider>)
  })
  return { host, root }
}

function assertInternalSource(source: string | null, expectedFileUrl: string): void {
  expect(source).not.toBeNull()
  const url = new URL(source!)
  expect(url.protocol).toBe('bridgic-local:')
  expect(url.searchParams.get('src')).toBe(expectedFileUrl)
  expect(url.searchParams.get('token')).toBe(TOKEN)
}

describe('Markdown local resources', () => {
  it('rewrites a Markdown file image to the internal protocol', async () => {
    const { host, root } = await render(
      <MarkdownMessage content="![二维码](file:/tmp/auth%20qr.png)" />,
    )
    assertInternalSource(host.querySelector('img')?.getAttribute('src') ?? null, 'file:///tmp/auth%20qr.png')
    await act(async () => root.unmount())
  })

  it('rewrites a sanitized raw-HTML file image through the same bridge', async () => {
    const { host, root } = await render(
      <MarkdownMessage content={'<img src="file:///tmp/raw%20image.png" alt="raw local">'} />,
    )
    assertInternalSource(
      host.querySelector('img')?.getAttribute('src') ?? null,
      'file:///tmp/raw%20image.png',
    )
    expect(host.querySelector('img')?.getAttribute('alt')).toBe('raw local')
    await act(async () => root.unmount())
  })

  it('leaves remote images alone and never trusts an Agent-authored internal URL', async () => {
    const remote = await render(
      <MarkdownMessage content="![remote](https://example.com/image.png)" />,
    )
    expect(remote.host.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.com/image.png',
    )
    await act(async () => remote.root.unmount())

    const forged = await render(
      <MarkdownMessage
        content="![forged](bridgic-local://file?src=file:///tmp/private.png&token=forged)"
      />,
    )
    expect(
      (forged.host.querySelector('img')?.getAttribute('src') ?? '')
        .startsWith('bridgic-local:'),
    ).toBe(false)
    await act(async () => forged.root.unmount())
  })

  it('previews bare image/audio/video paths from all supported path families', async () => {
    const { host, root } = await render(
      <MarkdownMessage content={[
        '/tmp/result.png',
        '',
        'C:\\Users\\me\\demo.mp4',
        '',
        '\\\\server\\share\\voice.mp3',
      ].join('\n')} />,
    )

    assertInternalSource(host.querySelector('img')?.getAttribute('src') ?? null, 'file:///tmp/result.png')
    assertInternalSource(host.querySelector('video')?.getAttribute('src') ?? null, 'file:///C:/Users/me/demo.mp4')
    assertInternalSource(host.querySelector('audio')?.getAttribute('src') ?? null, 'file://server/share/voice.mp3')
    await act(async () => root.unmount())
  })

  it('keeps an explicit ordinary file link clickable instead of turning it into media', async () => {
    const { host, root } = await render(
      <MarkdownMessage content="[打开视频](file:///tmp/demo.mp4)" />,
    )
    expect(host.querySelector('video')).toBeNull()
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/tmp/demo.mp4')
    await act(async () => root.unmount())
  })

  it('honours image syntax for local audio/video by selecting the matching preview element', async () => {
    const { host, root } = await render(
      <MarkdownMessage content="![本地视频](file:/tmp/demo.mp4)" />,
    )
    expect(host.querySelector('img')).toBeNull()
    assertInternalSource(host.querySelector('video')?.getAttribute('src') ?? null, 'file:///tmp/demo.mp4')
    await act(async () => root.unmount())
  })

  it('does not upgrade paths embedded in prose or fenced code', async () => {
    const { host, root } = await render(
      <MarkdownMessage content={'结果在 /tmp/result.png。\n\n```text\n/tmp/code.png\n```'} />,
    )
    expect(host.querySelector('[data-local-resource]')).toBeNull()
    expect(host.textContent).toContain('/tmp/result.png')
    expect(host.querySelector('code')?.textContent).toContain('/tmp/code.png')
    await act(async () => root.unmount())
  })

  it('waits for a streaming line to close before upgrading its bare path', async () => {
    const { host, root } = await render(
      <MarkdownMessage content="/tmp/streaming.png" streaming />,
    )
    expect(host.querySelector('[data-local-resource]')).toBeNull()

    await act(async () => {
      root.render(
        <Provider>
          <MarkdownMessage content={'/tmp/streaming.png\n'} streaming />
        </Provider>,
      )
    })
    expect(host.querySelector('img')).not.toBeNull()
    await act(async () => root.unmount())
  })

  it('falls back to FileLink after a local image load failure', async () => {
    const { host, root } = await render(<MarkdownMessage content="/tmp/missing.png" />)
    const image = host.querySelector('img')
    expect(image).not.toBeNull()
    await act(async () => image?.dispatchEvent(new Event('error')))
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/tmp/missing.png')
    await act(async () => root.unmount())
  })
})

describe('plain user-message local resources', () => {
  it('upgrades only a standalone path line', async () => {
    const { host, root } = await render(
      <div className="whitespace-pre-wrap">
        <LocalPathText text={'不要转换 /tmp/inline.png\n/tmp/standalone.png'} />
      </div>,
    )
    expect(host.textContent).toContain('不要转换 /tmp/inline.png')
    expect(host.querySelectorAll('img')).toHaveLength(1)
    assertInternalSource(host.querySelector('img')?.getAttribute('src') ?? null, 'file:///tmp/standalone.png')
    await act(async () => root.unmount())
  })
})
