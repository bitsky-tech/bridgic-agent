/**
 * Keep every locale JSON under packages/shared/src/i18n/locales/ sorted, and
 * verify that all locales define exactly the same set of keys.
 *
 *   bun run sort-locales                    # rewrite the files
 *   bun run sort-locales --check            # exit 1 if any file is out of order
 *   bun run sort-locales --check-parity     # exit 1 if the locales disagree on keys
 *
 * Why parity is checked here rather than at runtime: a key present in `en` but
 * missing from `zh` does not throw — react-i18next falls back to echoing the raw
 * key, so the Chinese UI silently renders `gatewayBoot.incompatible.title` where
 * a sentence should be. Nothing in lint, typecheck or the test suite notices,
 * and the only signal is someone running the app in Chinese and looking at that
 * exact screen.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LOCALES_DIR = join(import.meta.dir, '../packages/shared/src/i18n/locales')
const CHECK = process.argv.includes('--check')
const CHECK_PARITY = process.argv.includes('--check-parity')

function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSortKeys)
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = deepSortKeys((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/** Flatten to dotted leaf paths so a missing nested branch shows up as its leaves. */
function leafKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [prefix]
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  )
}

let anyDirty = false
const keysByLocale = new Map<string, Set<string>>()

for (const file of readdirSync(LOCALES_DIR)) {
  if (!file.endsWith('.json')) continue
  const path = join(LOCALES_DIR, file)
  const raw = readFileSync(path, 'utf-8')
  const parsed = JSON.parse(raw)
  const sorted = deepSortKeys(parsed)
  const next = JSON.stringify(sorted, null, 2) + '\n'

  keysByLocale.set(file, new Set(leafKeys(parsed)))

  // Compare with line endings normalised. This check is about key ORDER, not
  // bytes, and git checks these files out as CRLF on Windows (no .gitattributes,
  // and core.autocrlf defaults to true there) — so a byte comparison reports
  // "not sorted" for a perfectly sorted file. Write mode below still emits LF,
  // which is what the repository stores.
  if (raw.replace(/\r\n/gu, '\n') !== next) {
    anyDirty = true
    if (CHECK || CHECK_PARITY) {
      console.error(`✘ ${file} is not sorted`)
    } else {
      writeFileSync(path, next, 'utf-8')
      console.log(`✔ sorted ${file}`)
    }
  }
}

let parityBroken = false
if (CHECK_PARITY) {
  const locales = [...keysByLocale.keys()].sort()
  // Compare against the union rather than a designated "base" locale: a key
  // added only to zh is just as broken as one added only to en, and picking a
  // base would hide one of those directions.
  const union = new Set<string>()
  for (const keys of keysByLocale.values()) for (const k of keys) union.add(k)

  for (const locale of locales) {
    const keys = keysByLocale.get(locale)
    if (!keys) continue
    const missing = [...union].filter((k) => !keys.has(k)).sort()
    if (missing.length > 0) {
      parityBroken = true
      console.error(`\n✘ ${locale} is missing ${missing.length} key(s):`)
      for (const k of missing) console.error(`    ${k}`)
    }
  }
  if (!parityBroken) {
    console.log(`✔ locale key parity: ${locales.join(', ')} all define ${union.size} keys`)
  }
}

if ((CHECK || CHECK_PARITY) && anyDirty) {
  console.error('\nRun `bun run sort-locales` to fix ordering.')
}
if (parityBroken) {
  console.error(
    '\nAdd the missing translations. A missing key renders as the raw key path in the UI — ' +
      'it does not throw, so nothing else in CI will catch it.',
  )
}
if (((CHECK || CHECK_PARITY) && anyDirty) || parityBroken) {
  process.exit(1)
}
