/**
 * WindowedList — render a long list in scroll-appended chunks: full data,
 * lazy DOM.
 *
 * Mounts the first `chunk` rows plus an IntersectionObserver sentinel; each
 * time the sentinel scrolls into view another `chunk` mounts. This is DOM
 * windowing only — the data array is complete in memory, nothing is fetched.
 * Rows never unmount as you scroll (append-only), so row-local state (open
 * menus, expansion) survives; the trade-off is that DOM cost is bounded by
 * how far the user has scrolled, not constant. Good enough for hundreds-to-
 * thousands of rows; revisit with true virtualization only if a list grows
 * past that.
 *
 * `visibleCount` intentionally never resets when `items` changes: `slice`
 * clamps on shrink (a narrowed filter simply shows everything), and keeping
 * the window on identity changes avoids yanking the user back to the top on
 * every keystroke of a search box.
 *
 * Generalized from FileTreeView's WindowedLevel (its load-while-scrolling requirement);
 * shared by the schedule / asset / session lists.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useInfiniteScrollSentinel } from '@/hooks/useInfiniteScrollSentinel'

/** Default rows appended per scroll step — FileTreeView's proven chunk size. */
export const WINDOWED_LIST_CHUNK = 200

export interface WindowedListProps<T> {
  items: readonly T[]
  /** Row renderer. Rows must carry their own `key`. */
  children: (item: T, index: number) => React.ReactNode
  /** Rows appended per scroll step. */
  chunk?: number
  /** Wrapper class — defaults to a plain vertical flex column. */
  className?: string
}

export function WindowedList<T>({
  items,
  children,
  chunk = WINDOWED_LIST_CHUNK,
  className = 'flex flex-col',
}: WindowedListProps<T>) {
  const { t } = useTranslation()
  const [visibleCount, setVisibleCount] = useState(chunk)
  const hasMore = items.length > visibleCount
  const sentinelRef = useInfiniteScrollSentinel(
    () => setVisibleCount((count) => count + chunk),
    hasMore,
  )

  return (
    <div className={className}>
      {items.slice(0, visibleCount).map((item, index) => children(item, index))}
      {hasMore && (
        <div ref={sentinelRef} className="px-2 py-[5px] text-[10px] text-text-tertiary">
          {t('windowedList.loadingMore', { count: items.length })}
        </div>
      )}
    </div>
  )
}
