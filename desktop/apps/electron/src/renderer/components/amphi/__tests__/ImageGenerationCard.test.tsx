import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { i18n } = await import('@/lib/i18n')
const { ToolCallRow } = await import('../ToolCallRow')

let revealedPath = ''

beforeEach(async () => {
  revealedPath = ''
  await i18n.changeLanguage('zh')
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    shell: {
      showItemInFolder: (path: string) => { revealedPath = path },
    },
  }
})

describe('ImageGenerationCard', () => {
  it('shows an indeterminate image-specific state while the tool is running', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <ToolCallRow call={{
          toolUseId: 'image-running',
          name: 'generate_image',
          input: { prompt: '一只漂浮在云端的鲸鱼' },
        }} />,
      )
    })

    expect(host.querySelector('[data-image-generation-state="running"]')).not.toBeNull()
    expect(host.textContent).toContain('图片生成')
    expect(host.textContent).toContain('生成中')
    expect(host.textContent).toContain('正在构图与绘制')
    expect(host.textContent).toContain('一只漂浮在云端的鲸鱼')
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('[data-image-generation-state="running"]')?.className).not.toContain('max-w-')

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps the generated image out of the process card and reveals its file from details', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const path = '/tmp/generated-images/generated-test.png'

    await act(async () => {
      root.render(
        <ToolCallRow call={{
          toolUseId: 'image-success',
          name: 'generate_image',
          input: { prompt: '水墨山水', provider_id: 'openai', model: 'gpt-image-1' },
          result: {
            output: `Generated one image with openai/gpt-image-1.\n${path}`,
            isError: false,
            durationMs: 78_200,
          },
        }} />,
      )
    })

    expect(host.querySelector('[data-image-generation-state="success"]')).not.toBeNull()
    expect(host.textContent).toContain('图片生成')
    expect(host.textContent).toContain('已完成')
    expect(host.textContent).toContain('1m 18s')
    expect(host.textContent).not.toContain('generated-test.png')
    expect(host.querySelector('img')).toBeNull()

    const details = host.querySelector<HTMLButtonElement>('button[aria-label="图片生成详情"]')
    await act(async () => details?.click())
    expect(host.textContent).toContain('generated-test.png')
    expect(host.querySelector('img')).toBeNull()

    const reveal = Array.from(host.querySelectorAll('button')).find((button) => button.textContent?.includes('在文件中显示'))
    await act(async () => reveal?.click())
    expect(revealedPath).toBe(path)

    await act(async () => root.unmount())
    host.remove()
  })

  it('shows a friendly failure state with expandable provider details', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <ToolCallRow call={{
          toolUseId: 'image-error',
          name: 'generate_image',
          input: { prompt: '未来城市' },
          result: {
            output: 'Provider overloaded; please try again later',
            isError: true,
            durationMs: 12_000,
          },
        }} />,
      )
    })

    expect(host.querySelector('[data-image-generation-state="error"]')).not.toBeNull()
    expect(host.textContent).toContain('图片生成')
    expect(host.textContent).toContain('失败')
    expect(host.textContent).not.toContain('Provider overloaded')

    const details = host.querySelector<HTMLButtonElement>('button[aria-label="图片生成详情"]')
    await act(async () => details?.click())
    expect(host.textContent).toContain('Provider overloaded; please try again later')

    await act(async () => root.unmount())
    host.remove()
  })
})
