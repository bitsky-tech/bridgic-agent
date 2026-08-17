/**
 * SettingsAboutTab —— 更新状态行的两条容易读错的语义。
 *
 * 这两条都是真机测出来的,不是设想的:
 *  - 后台已有检查/下载在跑时点「检查更新」,行不能被重置成「检查中」——
 *    那会把「已下载 45%」这个唯一有信息量的状态抹掉,按钮看起来像坏的;
 *  - 没有新版本时要说「已是最新」,而不是落进失败分支。用户在真机上看到
 *    「检查失败」时的第一反应就是这里缺了提示(实际那次是真失败,但这条
 *    路径本身必须有测试钉住)。
 *
 * 不断言具体措辞:文案走 i18n,绑措辞会让每次改文案都红(见 agent.test.ts
 * 里同样的教训)。第一条改为比较点击前后的整行文本是否**没变**。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { atom } = await import('jotai')

// The real atom talks to the daemon; there is none here.
mock.module('@/atoms/update', () => ({
  requestUpdateCardAtom: atom(null, () => {}),
}))

const { i18n } = await import('@/lib/i18n')
const { I18nextProvider } = await import('react-i18next')
const { SettingsAboutTab } = await import('../SettingsAboutTab')
const {
  APP_NEW_ISSUE_URL,
  COMMERCIAL_LICENSE_CONTACT,
  FEEDBACK_CONTACT,
  PUBLIC_REPO_URL,
  SECURITY_CONTACT,
  SOCIAL_X_URL,
} = await import('@shared/app-meta')

type UpdateListener = (event: unknown) => void

/** Mirrors `UpdateCheckOutcome`; declared locally so the mock is not narrowed. */
type Outcome = 'started' | 'busy' | 'staged' | 'disabled'

let listener: UpdateListener | null = null
const checkNow = mock<() => Promise<Outcome>>(async () => 'started')
const getStatus = mock(async () => ({ isEnabled: true, stagedVersion: null as string | null }))
const openExternal = mock<(url: string) => Promise<void>>(async () => {})
const writeText = mock<(text: string) => Promise<void>>(async () => {})

beforeEach(() => {
  listener = null
  checkNow.mockClear()
  openExternal.mockClear()
  writeText.mockClear()
  checkNow.mockImplementation(async () => 'started')
  getStatus.mockImplementation(async () => ({ isEnabled: true, stagedVersion: null }))
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    events: {
      onAutoUpdate: (cb: UpdateListener) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    },
    update: { checkNow, getStatus },
    app: { getVersion: async () => '0.1.11' },
    shell: { openExternal },
  }
  // happy-dom ships no clipboard; the copy button is unusable without one.
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

/**
 * The `I18nextProvider` mirrors `main.tsx`, which wraps the whole app in one.
 * Without it `useTranslation()` binds to react-i18next's global default
 * instance, which in a FULL suite run is not the instance imported here: a
 * `mock.module` registered by some earlier file re-evaluates `lib/i18n.ts` and
 * a second i18next is constructed. Both land on Chinese via the cached detector,
 * so the split stayed invisible until a test switched language — then this file
 * flipped its own instance to English while the component kept rendering the
 * global one's Chinese. Passing the instance explicitly removes the guesswork
 * and makes the mount match production wiring.
 */
async function mountAbout() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <SettingsAboutTab onRequestClose={() => {}} />
      </I18nextProvider>,
    )
  })
  return {
    host,
    emit: async (event: unknown) => {
      await act(async () => listener?.(event))
    },
    click: async () => {
      await act(async () => {
        host.querySelector<HTMLElement>('[data-testid="about-check"]')?.click()
      })
    },
    clickTestId: async (testId: string) => {
      await act(async () => {
        host.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.click()
      })
    },
    // Counts rather than the node itself: a rendered element carries React's
    // `__reactFiber$…` back-pointer, so handing one to `expect` makes a failure
    // serialize the entire fiber tree — 70+ seconds and thousands of lines for
    // what should read "expected 1, got 0".
    count: (testId: string) => host.querySelectorAll(`[data-testid="${testId}"]`).length,
    cleanup: async () => {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

describe('SettingsAboutTab update row', () => {
  it('keeps showing download progress when a check is already in flight', async () => {
    checkNow.mockImplementation(async () => 'busy')
    const { host, emit, click, cleanup } = await mountAbout()

    await emit({ type: 'progress', percent: 45, bytesPerSecond: 1024 })
    const duringDownload = host.textContent

    await click()

    // 关键:'busy' 不能把进度行重置掉 —— 那正是「点了没反应」的来源。
    expect(host.textContent).toBe(duringDownload)
    expect(checkNow).toHaveBeenCalledTimes(1)

    await cleanup()
  })

  it('reports "up to date" rather than a failure when no update exists', async () => {
    const { host, emit, cleanup } = await mountAbout()

    await emit({ type: 'not-available' })

    expect(host.textContent).toContain(i18n.t('modals.about.updateUpToDate'))
    await cleanup()
  })

  it('shows the error copy for a genuinely failed check', async () => {
    const { host, emit, cleanup } = await mountAbout()

    await emit({ type: 'error', message: 'HttpError: 404' })

    // 失败必须可见 —— 静默会被读成「已经是最新了」。
    expect(host.textContent).toContain(i18n.t('modals.about.updateFailed'))
    await cleanup()
  })
})

/**
 * 授权声明和联系方式是**合同性文本**,不是装饰:这里显示的协议名必须和仓库实际
 * 附带的 `/LICENSE` 一致,不一致就是对外说错了自己的授权条款。
 *
 * 这一组盯的是地址和跳转目标这类**常量**,不是措辞 —— 所以可以直接断言字面量,
 * 与文件头「不绑措辞」的原则不冲突。上一版把个人 Gmail 当商业授权联系方式发了
 * 出去且没人发现,正是因为这块一条测试都没有。
 */
describe('SettingsAboutTab licence + contacts', () => {
  it('names AGPL and never Apache', async () => {
    const { host, cleanup } = await mountAbout()

    expect(host.textContent).toContain('AGPL')
    expect(host.textContent).not.toContain('Apache')

    await cleanup()
  })

  it('shows the three contact addresses', async () => {
    const { host, cleanup } = await mountAbout()

    expect(host.textContent).toContain(COMMERCIAL_LICENSE_CONTACT)
    expect(host.textContent).toContain(SECURITY_CONTACT)
    expect(host.textContent).toContain(FEEDBACK_CONTACT)
    // 个人邮箱一旦回流就是对外事故,单独钉死。
    expect(host.textContent).not.toContain('gmail.com')

    await cleanup()
  })

  it('hands a mailto: link to the OS when an address is clicked', async () => {
    const { clickTestId, cleanup } = await mountAbout()

    await clickTestId('about-link-security')

    expect(openExternal).toHaveBeenCalledWith(`mailto:${SECURITY_CONTACT}`)

    await cleanup()
  })

  it('copies the bare address rather than opening the mail client', async () => {
    const { clickTestId, cleanup } = await mountAbout()

    await clickTestId('about-copy-business')

    expect(writeText).toHaveBeenCalledWith(COMMERCIAL_LICENSE_CONTACT)
    // 复制不该顺带唤起邮件客户端 —— 那是两个不同的意图。
    expect(openExternal).not.toHaveBeenCalled()

    await cleanup()
  })

  it('offers the repository, which AGPL §6 makes a source-availability route rather than a nicety', async () => {
    const { host, clickTestId, cleanup } = await mountAbout()

    expect(host.textContent).toContain(PUBLIC_REPO_URL)
    await clickTestId('about-link-repository')
    expect(openExternal).toHaveBeenCalledWith(PUBLIC_REPO_URL)

    await cleanup()
  })

  it('routes issue reporting to GitHub instead of an inbox', async () => {
    const { clickTestId, cleanup } = await mountAbout()

    await clickTestId('about-link-issue')

    expect(openExternal).toHaveBeenCalledWith(APP_NEW_ISSUE_URL)
    expect(openExternal).not.toHaveBeenCalledWith(expect.stringContaining('mailto:'))

    await cleanup()
  })
})

/**
 * 社区入口按界面语言分流。两个方向都会真的伤到人:把英文用户送进中文频道,他打开
 * 是一屏读不懂的消息;把微信二维码留在英文界面上,他连扫码的 App 都没装。
 *
 * Discord 的两个邀请链接在这里**写死字面量**,不引用常量 —— 这一组要钉的恰恰是
 * 「哪种语言对应哪个频道」,若引用常量,断言就退化成 `X === X`,把两个链接对调也
 * 照样是绿的。上面那组盯的是「地址不能写错」,所以引用常量是对的;这里盯的是
 * 「路由不能接反」,必须各自独立地写出期望值。
 */
const DISCORD_INVITE_ZH = 'https://discord.gg/XcEqrwKUXN'
const DISCORD_INVITE_EN = 'https://discord.gg/yFYVSm9tPC'

describe('SettingsAboutTab community links', () => {
  afterEach(async () => {
    // test-setup 把整轮测试钉在中文上,借走了就得还,否则后面的文件拿到英文。
    await i18n.changeLanguage('zh')
  })

  it('opens the X account', async () => {
    const { clickTestId, cleanup } = await mountAbout()

    await clickTestId('about-link-x')

    expect(openExternal).toHaveBeenCalledWith(SOCIAL_X_URL)

    await cleanup()
  })

  it('sends a Chinese UI to the Chinese Discord channel', async () => {
    const { clickTestId, cleanup } = await mountAbout()

    await clickTestId('about-link-discord')

    expect(openExternal).toHaveBeenCalledWith(DISCORD_INVITE_ZH)

    await cleanup()
  })

  it('sends an English UI to the English Discord channel', async () => {
    await i18n.changeLanguage('en')
    const { clickTestId, cleanup } = await mountAbout()

    await clickTestId('about-link-discord')

    expect(openExternal).toHaveBeenCalledWith(DISCORD_INVITE_EN)

    await cleanup()
  })

  it('keeps the WeChat QR code out of an English UI entirely', async () => {
    await i18n.changeLanguage('en')
    const { count, cleanup } = await mountAbout()

    // 不是隐藏,是整行不存在 —— 折叠起来的入口对英文用户依然是噪音。
    expect(count('about-wechat-toggle')).toBe(0)

    await cleanup()
  })

  it('reveals the WeChat QR code only after the row is clicked', async () => {
    const { count, clickTestId, cleanup } = await mountAbout()

    expect(count('about-wechat-qr')).toBe(0)
    await clickTestId('about-wechat-toggle')
    expect(count('about-wechat-qr')).toBe(1)
    // 再点一次要能收回去,否则「关于」页会被一张二维码永久撑高。
    await clickTestId('about-wechat-toggle')
    expect(count('about-wechat-qr')).toBe(0)

    await cleanup()
  })
})
