/**
 * Translation lookup for the main process.
 *
 * The tray menu, the application menu and the quit dialog are native UI the user reads, so
 * they have to follow the same language as the window. Main cannot borrow the renderer's
 * i18next instance — different process, and the tray is built before any window exists — so
 * it reads the same `zh.json` / `en.json` through this minimal lookup.
 *
 * Deliberately not i18next: main owns ~27 strings with no plurals, no namespaces and no
 * detector (the language is decided by `gui-settings.applyLocale`, see below). Pulling the
 * full runtime in would add startup cost to the process that must paint the tray first.
 *
 * **No `electron` import here**, so bun:test can load it. Deciding *which* language is
 * active reads `app.getLocale()` and therefore lives in `gui-settings.applyLocale`, which
 * calls `setMainLocale` on boot and on every settings write.
 */
import en from '@app/shared/i18n/locales/en.json'
import zh from '@app/shared/i18n/locales/zh.json'
import type { ResolvedLocale } from '../shared/locale'

const CATALOGS: Record<ResolvedLocale, unknown> = { zh, en }

/** Resolve a dotted key against one catalog; `undefined` when the path is absent. */
function lookup(bundle: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    bundle,
  )
}

/**
 * Render `key` in `locale`, substituting `{{var}}` placeholders from `vars`.
 *
 * An unknown key returns the key itself, matching i18next: a raw key on screen reads as a
 * bug the user can report, whereas an empty tray item is one they cannot even describe. A
 * placeholder with no matching value is left in place for the same reason.
 */
export function translate(
  locale: ResolvedLocale,
  key: string,
  vars: Record<string, string | number> = {},
): string {
  const template = lookup(CATALOGS[locale], key)
  if (typeof template !== 'string') return key
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole)
}

// English rather than Chinese as the pre-boot default: `fallbackLng` in the renderer's
// i18next is 'en', and the value is overwritten by applyLocale before the tray is built.
let current: ResolvedLocale = 'en'

/** Point subsequent `mt` calls at `locale`. Called from `gui-settings.applyLocale`. */
export function setMainLocale(locale: ResolvedLocale): void {
  current = locale
}

/** The language main is currently rendering in. */
export function mainLocale(): ResolvedLocale {
  return current
}

/** `translate` against the active language — the form call sites use. */
export function mt(key: string, vars: Record<string, string | number> = {}): string {
  return translate(current, key, vars)
}
