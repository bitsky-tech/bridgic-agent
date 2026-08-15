/**
 * Singleton Shiki highlighter + on-demand language loading.
 *
 * Invariants:
 *  - The whole renderer shares one Highlighter instance (the first createHighlighter is fairly heavy),
 *    cached in a module-level Promise so it is not recreated for every code block.
 *  - Languages are loaded on demand via loadLanguage, with already-loaded ones recorded in loadedLangs to avoid reloading.
 *  - Unknown languages fall back to 'text' (plain text) rather than throwing.
 *  - Both themes (github-light / github-dark) are preloaded, and one is chosen by the current resolved theme.
 *
 * Renderer-only (browser environment; Vite bundles shiki's wasm).
 */
import {
  bundledLanguages,
  createHighlighter,
  type BundledLanguage,
  type Highlighter,
} from 'shiki'

const LIGHT_THEME = 'github-light'
const DARK_THEME = 'github-dark'

let highlighterPromise: Promise<Highlighter> | null = null
const loadedLangs = new Set<string>()

/** Lazily create and cache the singleton highlighter (both themes preloaded, languages loaded on demand later). */
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [LIGHT_THEME, DARK_THEME],
      langs: [],
    })
  }
  return highlighterPromise
}

/**
 * Highlight a piece of code into an HTML string.
 *
 * @param lang  Language identifier; falls back to plain text when it is not in shiki's bundled language table.
 * @param theme The current resolved theme, which decides whether light or dark colors are used.
 * @throws If shiki fails internally (WASM loading, etc.); callers should fall back to un-highlighted plain text.
 */
export async function highlightToHtml(
  code: string,
  lang: string,
  theme: 'light' | 'dark',
): Promise<string> {
  const hl = await getHighlighter()
  const supported = lang.length > 0 && lang in bundledLanguages
  const useLang = supported ? lang : 'text'
  if (supported && !loadedLangs.has(useLang)) {
    await hl.loadLanguage(useLang as BundledLanguage)
    loadedLangs.add(useLang)
  }
  return hl.codeToHtml(code, {
    lang: useLang,
    theme: theme === 'dark' ? DARK_THEME : LIGHT_THEME,
  })
}
