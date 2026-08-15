/**
 * Code block: shiki syntax highlighting + language label + copy button + theme following.
 *
 * Invariants:
 *  - Highlighting is asynchronous (shiki); before it completes an un-highlighted plain-text <pre> is shown, and
 *    afterwards it is replaced by shiki's HTML output (escaped by shiki, so it is safe).
 *  - Any change to code / lang / resolved-theme re-highlights (both streaming token-by-token code updates and the
 *    user switching light/dark trigger it).
 *  - Highlighting failures (WASM, unknown errors) fall back to plain text without affecting the rest of the rendering.
 *
 * Dependencies: `themeAtom` provides the current resolved theme; `highlightToHtml` is a singleton highlighter.
 */
import { useEffect, useState } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { themeAtom } from '@/atoms/theme'
import { rlog } from '@/lib/logger'
import { highlightToHtml } from './shiki'

export interface CodeBlockProps {
  /** Code body (without the fence). */
  code: string
  /** Language identifier (e.g. `ts`); unknown languages are highlighted as plain text. */
  lang: string
  /** Active streaming block: stay plain text and skip shiki for now, highlighting only once this block closes (defer→false).
 *  This prevents flicker across multiple render passes, i.e. code changing token by token during streaming repeatedly triggering asynchronous re-highlighting (flipping between placeholder and finished output). */
  defer?: boolean
}

export function CodeBlock({ code, lang, defer = false }: CodeBlockProps) {
  const { t } = useTranslation()
  const resolved = useAtomValue(themeAtom).resolved
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    // Active streaming block: do not run shiki, keep the un-highlighted plain-text <pre> (html starts as null, and defer
    // only flips monotonically true→false, so no clearing is needed); once closed, defer→false re-runs this effect to produce highlighting.
    if (defer) return
    let cancelled = false
    highlightToHtml(code, lang, resolved)
      .then((out) => {
        if (!cancelled) setHtml(out)
      })
      .catch((err: unknown) => {
        // Fallback: keep showing plain text; do not let one code block drag down the whole message.
        rlog.warn('[markdown/code] highlight failed', err)
        if (!cancelled) setHtml(null)
      })
    return () => {
      cancelled = true
    }
  }, [code, lang, resolved, defer])

  const handleCopy = () => {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch((err: unknown) => rlog.warn('[markdown/code] copy failed', err))
  }

  return (
    <div className="my-2 rounded-md overflow-hidden border border-border-subtle">
      <div className="flex items-center justify-between px-3 py-1.5 bg-bg-hover text-xs text-text-tertiary">
        <span className="font-mono">{lang || 'text'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="cursor-pointer hover:text-text-primary transition-colors"
        >
          {copied ? t('markdown.code.copied') : t('markdown.code.copy')}
        </button>
      </div>
      {html ? (
        <div
          className="text-sm [&_pre]:m-0 [&_pre]:p-3 [&_pre]:overflow-x-auto [&_code]:font-mono"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="m-0 p-3 overflow-x-auto text-sm bg-bg-app">
          <code className="font-mono">{code}</code>
        </pre>
      )}
    </div>
  )
}
