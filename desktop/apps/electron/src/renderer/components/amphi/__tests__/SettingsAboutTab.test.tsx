/**
 * SettingsAboutTab: two easily misread update-status semantics.
 *
 * Both came from real-device behavior rather than hypothetical cases:
 *  - clicking Check for Updates while a background check or download is active must not reset
 *    the row to Checking, which erases useful progress such as 45% and makes the button look broken;
 *  - when no update exists, report Up to date rather than entering the failure branch. Users who
 *    saw Check failed first suspected that this path lacked feedback, so it needs explicit coverage.
 *
 * Do not assert exact i18n wording, which would make copy edits fail. For the first contract,
 * compare the entire row before and after clicking and require it to remain **unchanged**.
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
type OpenLogsResult = { ok: true; path: string } | { ok: false; reason: string }
const openLogs = mock<() => Promise<OpenLogsResult>>(async () => ({ ok: true, path: '/tmp/server.log' }))
const writeText = mock<(text: string) => Promise<void>>(async () => {})

beforeEach(() => {
  listener = null
  checkNow.mockClear()
  openExternal.mockClear()
  openLogs.mockClear()
  openLogs.mockImplementation(async () => ({ ok: true, path: '/tmp/server.log' }))
  writeText.mockClear()
  checkNow.mockImplementation(async () => 'started')
  getStatus.mockImplementation(async () => ({ isEnabled: true, stagedVersion: null }))
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
  workbench: {
    ensure: async () => undefined,
    activate: async () => undefined,
    close: async () => undefined,
  },
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
    backend: { openLogs },
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

    // Key contract: 'busy' must not reset the progress row, which made the click appear ineffective.
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

    // Failure must be visible; silence would be interpreted as already up to date.
    expect(host.textContent).toContain(i18n.t('modals.about.updateFailed'))
    await cleanup()
  })

  it('explains the wait while the smaller download is being prepared', async () => {
    const { host, emit, cleanup } = await mountAbout()

    await emit({ type: 'preparing' })

    // Rebuilding differential sources takes about 44 seconds and appears only on the first update
    // after installation. Without feedback, a static row after clicking is indistinguishable from a hang.
    expect(host.textContent).toContain(i18n.t('modals.about.updatePreparing'))
    await cleanup()
  })
})

/**
 * License and contact information are **contractual text**, not decoration. The displayed license
 * must match `/LICENSE`, or the product publicly states incorrect terms.
 *
 * This group protects **constants** such as addresses and destinations rather than prose, so
 * literal assertions do not conflict with avoiding copy coupling. A prior release exposed a
 * personal Gmail address for commercial licensing because this area had no tests.
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
    // Guard separately against accidentally reintroducing a personal address in the product.
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
    // Copying must not also launch the mail client; these are distinct intents.
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
 * Community entry points route by interface language. Both mistakes harm users: an English user
 * sent to the Chinese channel sees unreadable content, while an English UI should not offer a WeChat QR code.
 *
 * The two Discord invitations are **literal values** here rather than imported constants because
 * this group verifies which language maps to which channel. Importing them would reduce the assertion
 * to `X === X` and remain green if links were swapped. The previous group validates addresses;
 * this one independently validates routing.
 */
const DISCORD_INVITE_ZH = 'https://discord.gg/XcEqrwKUXN'
const DISCORD_INVITE_EN = 'https://discord.gg/yFYVSm9tPC'

describe('SettingsAboutTab community links', () => {
  afterEach(async () => {
    // test-setup fixes the suite language to Chinese; restore it after temporarily switching to English.
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

    // The entire row must be absent, not merely collapsed, because even a hidden entry is noise for English users.
    expect(count('about-wechat-toggle')).toBe(0)

    await cleanup()
  })

  it('reveals the WeChat QR code only after the row is clicked', async () => {
    const { count, clickTestId, cleanup } = await mountAbout()

    expect(count('about-wechat-qr')).toBe(0)
    await clickTestId('about-wechat-toggle')
    expect(count('about-wechat-qr')).toBe(1)
    // A second click must collapse it so a QR code does not permanently enlarge the About page.
    await clickTestId('about-wechat-toggle')
    expect(count('about-wechat-qr')).toBe(0)

    await cleanup()
  })
})

describe('SettingsAboutTab update row honesty', () => {
  it('does not claim "up to date" before anything has been checked', async () => {
    const { host, cleanup } = await mountAbout()

    // Regression guard rather than a current bug: `unknown` returns null today. It matters because
    // rebuilding differential sources takes about 44 seconds after discovering an update, during
    // which the panel receives stagedVersion: null. Folding unknown into the final else would
    // incorrectly claim Up to date while an update is being prepared.
    expect(host.textContent).not.toContain(i18n.t('modals.about.updateUpToDate'))
    await cleanup()
  })
})

describe('SettingsAboutTab check button feedback', () => {
  it('says something when a check is already running and the row is blank', async () => {
    // While the updater rebuilds differential sources for about 44 seconds, no event reaches the
    // panel. A user opening Settings sees a blank row and receives busy on manual check, so busy
    // must establish a visible state or the button appears broken.
    checkNow.mockImplementation(async () => 'busy')
    const { host, click, cleanup } = await mountAbout()

    await click()

    expect(host.textContent).toContain(i18n.t('modals.about.updateChecking'))
    await cleanup()
  })

  it('does not overwrite a more informative state with "checking"', async () => {
    // When download progress is already 45%, Checking is less informative. The busy fallback above
    // must not regress the original rule that preserves an existing progress row.
    checkNow.mockImplementation(async () => 'busy')
    const { host, emit, click, cleanup } = await mountAbout()

    await emit({ type: 'progress', percent: 45, bytesPerSecond: 1024 })
    const during = host.textContent
    await click()

    expect(host.textContent).toBe(during)
    await cleanup()
  })
})

describe('SettingsAboutTab logs row', () => {
  // The only OTHER graphical entry point for daemon logs is a tray line that
  // appears when the gateway is already failing; this row is the one a user
  // can reach proactively, and the only one that exists at all on Windows.
  it('reveals the daemon log folder from the About tab', async () => {
    const { host, clickTestId, count, cleanup } = await mountAbout()
    expect(count('about-open-logs')).toBe(1)

    await clickTestId('about-open-logs')

    expect(openLogs).toHaveBeenCalledTimes(1)
    expect(count('about-logs-missing')).toBe(0)
    void host
    await cleanup()
  })

  it('says so when no log file could be found instead of doing nothing', async () => {
    openLogs.mockImplementation(async () => ({ ok: false as const, reason: 'no daemon log found' }))
    const { clickTestId, count, cleanup } = await mountAbout()

    await clickTestId('about-open-logs')

    expect(count('about-logs-missing')).toBe(1)
    await cleanup()
  })
})
