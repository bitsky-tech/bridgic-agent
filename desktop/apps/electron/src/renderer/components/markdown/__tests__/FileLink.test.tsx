import { afterAll, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const showItemInFolder = mock((_path: string) => Promise.resolve())
const writeText = mock((_text: string) => Promise.resolve())
const w = globalThis as typeof globalThis & {
  api?: Record<string, unknown>
  navigator: { clipboard?: unknown }
}
w.api = { ...w.api, shell: { showItemInFolder, openPath: async () => {} } }
Object.defineProperty(w.navigator, 'clipboard', { value: { writeText }, configurable: true })

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Provider } = await import('jotai')
const { FileLink } = await import('../FileLink')

const TARGET = { path: '/Users/me/out/最终报告 v3.pdf', name: '最终报告 v3.pdf' }

async function renderLink() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <Provider>
        <FileLink target={TARGET}>报告</FileLink>
      </Provider>,
    )
  })
  return host
}

describe('FileLink', () => {
  it('reveals the file in the OS file manager', async () => {
    showItemInFolder.mockClear()
    const host = await renderLink()
    const button = host.querySelector<HTMLButtonElement>(
      `button[aria-label="在文件管理器中显示 ${TARGET.name}"]`,
    )
    expect(button).not.toBeNull()
    await act(async () => {
      button?.click()
    })
    expect(showItemInFolder).toHaveBeenCalledWith(TARGET.path)
  })

  it('copies the absolute path, not the visible link text', async () => {
    // Users copy a file to share it, so the copied value must be its disk path rather than the label "Report".
    writeText.mockClear()
    const host = await renderLink()
    const button = host.querySelector<HTMLButtonElement>(
      `button[aria-label="复制路径 ${TARGET.name}"]`,
    )
    await act(async () => {
      button?.click()
    })
    expect(writeText).toHaveBeenCalledWith(TARGET.path)
  })

  it('keeps both actions mounted so hover never shifts the surrounding text', async () => {
    // §LS1: links are inline with paragraph text, so conditional rendering shifts the whole line on hover.
    // Keep the icon's space mounted and change only opacity.
    const host = await renderLink()
    const buttons = host.querySelectorAll('button')
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(button.className).toContain('opacity-0')
      expect(button.className).toContain('group-hover/filelink:opacity-100')
    }
  })

  it('scopes the hover group so sibling links do not light each other up', async () => {
    // An unnamed group would reveal every link icon in a paragraph when any one link is hovered.
    const host = await renderLink()
    expect(host.querySelector('.group\\/filelink')).not.toBeNull()
  })
})
