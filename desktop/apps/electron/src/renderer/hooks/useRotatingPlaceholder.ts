/**
 * Rotates the composer placeholder, taking turns surfacing the two kinds of
 * things "nobody knows unless you say so": low-discoverability **capabilities**
 * (slash commands / @ references), and the **implicit constraints** you trip
 * over when you don't know them (a space is required before @, pasting very
 * long text turns it into an attachment, etc. — see the per-item sources on
 * `COMPOSER_TIPS`).
 *
 * Invariants:
 *   - `COMPOSER_TIPS[0]` is the original static copy — the first frame looks
 *     exactly as it did before this change; rotation only happens after the
 *     user lingers.
 *   - When `active=false` the timer does not exist (it isn't hidden, it doesn't
 *     run), the index freezes at its current value, and it continues from there
 *     when active again instead of jumping back to the first item.
 *
 * The caller owns the `active` decision: it MUST pass false when the input is
 * non-empty — the placeholder is hidden by CSS `:empty` at that point, so
 * continuing to rotate only makes the contentEditable re-render for nothing.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { i18n } from '@/lib/i18n'

/**
 * Composer rotating tips. Two kinds, interleaved:
 *
 *   - **Capability discovery** (the pre-existing ones): what features exist, what can be invoked;
 *   - **Pitfall rules** (the few carrying a ⚠ comment): implicit constraints you trip over when
 *     you don't know them, and once tripped you assume the app is broken.
 *     Each one maps to a real hard check in the code, not a generic usage tip.
 *
 * **Interleaving rather than appending** is deliberate: a full cycle takes `item count × 5s`,
 * and users rarely linger in front of the input for a whole cycle, so the pitfall entries are
 * placed up front and alternated with the capability ones, guaranteeing you hit a few pitfall
 * ones no matter how long you stay.
 *
 * Item 0 MUST be the original static copy (see the file-header invariants). `as const` rather
 * than `readonly string[]`: it keeps `[0]` a definite string under noUncheckedIndexedAccess, so
 * the fallback lookup needs no further assertion.
 */
export const COMPOSER_TIP_KEYS = [
  'composer.tips.input',
  // ⚠ segments.ts::findTriggerAtCaret —— the character before the trigger must be whitespace,
  // otherwise it counts as mid-word and no menu pops up (this blocks a@b in emails, the
  // http:// in URLs, and slashes inside Chinese/English words).
  'composer.tips.trigger',
  // Immediately after the previous one: state the rule first, then what this symbol can do.
  'composer.tips.mention',
  // ⚠ sendKeyAction.ts::resolveSendKeyAction —— Enter sends, Shift+Enter inserts a newline.
  // Do **NOT** word this as "the send key can be changed in settings": the 'cmd-enter' branch
  // of `composer.inputSendKey` is present in both the schema and the resolver, but **no UI
  // ever writes it** (4 reads, 0 writes across the whole repo), so a user who follows the hint
  // into settings comes up empty. Add this sentence back the day that toggle actually ships.
  'composer.tips.sendKey',
  // ⚠ pasteConstants.ts::LARGE_TEXT_THRESHOLD —— plain text above the threshold does not
  // enter the editor; it is uploaded and mounted as a session file. Without saying so, users
  // assume the paste failed.
  'composer.tips.longPaste',
  // ⚠ pasteClassify.ts —— only **real file objects** get mounted; plain text is never
  // auto-mounted even when it looks exactly like an absolute path (the clipboard cannot tell a
  // path string from natural language / a slash command). Same paste / drag-drop semantics as
  // the previous entry, so they sit together.
  'composer.tips.dropFile',
  'composer.tips.build',
  'composer.tips.schedule',
  // ⚠ zoom-keys.ts::pickZoomDelta + the zoomItems in main/index.ts —— UI zoom is buried in
  // keyboard shortcuts and in Settings → Appearance → UI zoom;
  // without saying so nobody knows the font size is adjustable (users who find the text too
  // small just assume the app doesn't support it). The copy keeps the same wording as the zoom
  // row in Modals.tsx: font size / icons / spacing all scale proportionally together, it is not
  // only the font size that changes.
  'composer.tips.zoom',
  'composer.tips.help',
  'composer.tips.slash',
] as const

/** The rendered tip table, for the pure tip-table tests. Runtime UI reads the keys through
 * `useTranslation` below, so language changes update the visible placeholder.
 *
 * A function rather than a `const`: a module-scope `i18n.t()` snapshots whatever language
 * was active at import time, which silently goes stale for any caller that resolves the
 * table after a language change. */
export function composerTips(): readonly string[] {
  return COMPOSER_TIP_KEYS.map((key) => i18n.t(key))
}

/**
 * Rotation interval. A Chinese tip takes about 2–3s to read, so 5s leaves a beat after you
 * finish — 3s would switch away the instant you're done and feels rushed instead.
 * One cycle = item count × 5s (currently 11 items = 55s); that is why the pitfall entries have to sit up front, see COMPOSER_TIPS.
 */
const ROTATE_INTERVAL_MS = 5000

/**
 * Returns the placeholder copy that should currently be shown.
 *
 * @param active whether to rotate. Passing false stops the timer and keeps the current copy.
 */
export function useRotatingPlaceholder(active: boolean): string {
  const { t } = useTranslation()
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(
      () => setIndex((i) => (i + 1) % COMPOSER_TIP_KEYS.length),
      ROTATE_INTERVAL_MS,
    )
    return () => clearInterval(timer)
  }, [active])
  return t(COMPOSER_TIP_KEYS[index] ?? COMPOSER_TIP_KEYS[0])
}
