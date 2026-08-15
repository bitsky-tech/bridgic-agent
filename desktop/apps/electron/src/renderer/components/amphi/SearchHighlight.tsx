/**
 * Presentation pieces for `FileSearchHit`: hit highlighting + crumb range alignment + the size label on the right.
 *
 * It was extracted because there are **two** consumers that must render the same hits the same way (the 2+ threshold of §4.8):
 * the composer's `@` reference popover (`menus/MentionMenu.tsx`) and the right panel's "session outputs" search
 * results (`SessionAssetsSearch.tsx`). Both query `fs.searchDir` directly, and if each wrote its own highlighting,
 * the same query would look different in the two places.
 *
 * Highlighting is not decoration: the backend `file-search.ts` matches by **subsequence** (`aaa` can hit
 * `.agents/skills/…/cli-sdk-api-mapping.md`), so without marking the match positions the results look
 * completely unrelated to the query.
 */
import type { ReactNode } from 'react'
import { i18n } from '@/lib/i18n'
import { formatSize } from '@/lib/fileTree'
import type { FileSearchHit } from '@shared/file-search'

/**
 * The single wording for "nothing found".
 *
 * The three empty states (whole panel / group / file list) must use identical wording, otherwise one search shows
 * two different phrasings on the same screen. It lives in this module rather than in RightPanel: RightPanel →
 * SessionAssets → SessionAssetsSearch is already a one-way chain, and putting the wording at the head of the chain
 * would bend it into a cycle.
 *
 * @param scope only the noun changes (content / files / …); the sentence pattern is fixed.
 */
export function noMatchText(query: string, scope = i18n.t('asset.search.contentScope')): string {
  return i18n.t('asset.search.noMatch', { query, scope })
}

export interface HighlightedProps {
  text: string
  /** `[start, end)` character ranges; when empty the text is emitted unchanged. */
  ranges: Array<[number, number]>
}

/** Highlight matched fragments (<mark>, blue on blue, per the design mock). When ranges is empty the text is emitted unchanged. */
export function Highlighted({ text, ranges }: HighlightedProps) {
  if (ranges.length === 0) return <>{text}</>
  const parts: ReactNode[] = []
  let cursor = 0
  ranges.forEach(([s, e], i) => {
    if (s > cursor) parts.push(text.slice(cursor, s))
    parts.push(
      <mark key={i} className="bg-accent-blue-subtle text-brand-blue rounded-[3px] px-px">
        {text.slice(s, e)}
      </mark>,
    )
    cursor = e
  })
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

/** Number of '/' characters before index in `joined`. */
function countSeps(joined: string, index: number): number {
  let n = 0
  for (let i = 0; i < index && i < joined.length; i += 1) {
    if (joined[i] === '/') n += 1
  }
  return n
}

/** crumbRanges are indices into `crumb.join('/')`; display uses ' / ' (2 extra characters per separator),
 *  so ranges are shifted by the number of separators that precede them. */
export function hitCrumbRanges(h: FileSearchHit): Array<[number, number]> {
  if (h.crumbRanges.length === 0) return []
  const joined = h.crumb.join('/')
  return h.crumbRanges.map(([s, e]) => [s + countSeps(joined, s) * 2, e + countSeps(joined, e) * 2])
}

/** Right-hand label: folder → 'folder'; file → size (blank when stat fails / is unknown). */
export function hitSizeLabel(h: FileSearchHit): string {
  if (h.kind === 'folder') return i18n.t('asset.search.folder')
  return h.sizeBytes === null ? '' : formatSize(h.sizeBytes)
}
