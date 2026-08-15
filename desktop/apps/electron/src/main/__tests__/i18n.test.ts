/**
 * Main-process translation lookup.
 *
 * The tray menu, the application menu and the quit dialog are native UI the user reads, so
 * they need the same language the window is in. Main can't reach the renderer's i18next
 * (different process, and the tray exists before any window does), so it reads the same
 * catalogs through this tiny lookup instead.
 *
 * Kept free of `electron` imports so bun:test can load it — resolving *which* language is
 * active touches `app.getLocale()` and lives in `gui-settings.applyLocale` instead.
 */
import { describe, expect, it } from 'bun:test'
import { mt, setMainLocale, translate } from '../i18n'

describe('translate', () => {
  it('reads the same catalogs the renderer does', () => {
    expect(translate('zh', 'main.tray.openWindow')).toBe('打开主界面')
    expect(translate('en', 'main.tray.openWindow')).toBe('Open Main Window')
  })

  it('interpolates {{var}} the way the renderer catalog is written', () => {
    expect(translate('zh', 'main.tray.status.ready', { version: '0.1.0' })).toBe('● 网关运行中 · v0.1.0')
    expect(translate('en', 'main.tray.status.ready', { version: '0.1.0' })).toBe('● Gateway running · v0.1.0')
  })

  it('returns the key for an unknown id, so a missing string is visible rather than blank', () => {
    // Matches i18next's default: a raw key on screen is a bug report; an empty
    // tray item is a menu the user cannot even describe.
    expect(translate('zh', 'main.nope.missing')).toBe('main.nope.missing')
  })

  it('leaves an unmatched placeholder alone instead of emptying it', () => {
    expect(translate('zh', 'main.tray.status.ready')).toContain('{{version}}')
  })
})

describe('setMainLocale / mt', () => {
  it('resolves against whatever language was last applied', () => {
    setMainLocale('en')
    expect(mt('main.tray.quitApp')).toBe('Quit Completely')
    setMainLocale('zh')
    expect(mt('main.tray.quitApp')).toBe('完全退出')
  })
})
