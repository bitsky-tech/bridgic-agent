import { useEffect, useId, useMemo, useRef, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useDebugDraft } from './DebugDrafts'
import { useDebugText } from './DebugSessionProvider'

export interface RequestItem {
  index: number
  label: string
  preview: string
  search: string
  category?: string
}

const PAGE_SIZE = 20

/** Keep long request collections bounded; mount the selected item's full body only. */
export function RequestItemBrowser({ items, stateKey, label, searchLabel, filterRoles = false, children }: {
  items: RequestItem[]; stateKey: string; label: string; searchLabel: string; filterRoles?: boolean
  children: (index: number) => ReactNode
}) {
  const text = useDebugText()
  const detailId = useId()
  const directory = useRef<HTMLOListElement>(null)
  const [state, setState] = useDebugDraft(`browser:${stateKey}`, () => ({ query: '', category: '', selected: 0 }))
  const categories = useMemo(() => [...new Set(items.map(item => item.category).filter((value): value is string => Boolean(value)))], [items])
  const filtered = useMemo(() => {
    const needle = state.query.trim().toLocaleLowerCase()
    return items.filter(item => (!state.category || item.category === state.category) && (!needle || item.search.toLocaleLowerCase().includes(needle)))
  }, [items, state.query, state.category])
  const position = Math.max(0, filtered.findIndex(item => item.index === state.selected))
  const selected = filtered[position]
  const page = Math.floor(position / PAGE_SIZE)
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  useEffect(() => {
    const list = directory.current
    const row = list?.querySelector<HTMLElement>('[aria-current=true]')
    if (!list || !row) return
    const revealSelection = () => {
      const listBounds = list.getBoundingClientRect()
      const rowBounds = row.getBoundingClientRect()
      if (rowBounds.top < listBounds.top) list.scrollTop += rowBounds.top - listBounds.top
      else if (rowBounds.bottom > listBounds.bottom) list.scrollTop += rowBounds.bottom - listBounds.bottom
    }
    revealSelection()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(revealSelection)
    observer.observe(list)
    return () => observer.disconnect()
  }, [selected?.index, page, state.query, state.category])
  const select = (next: number) => {
    const item = filtered[next]
    if (item) setState(current => ({ ...current, selected: item.index }))
  }
  return <div className="debug-request-browser">
    <div className="debug-request-search">
      <label><Search size={13} aria-hidden="true" /><input type="search" aria-label={searchLabel} placeholder={searchLabel} value={state.query}
        onChange={event => { const query = event.target.value; setState(current => ({ ...current, query })) }} /></label>
      {filterRoles ? <select aria-label={text('modelCall.filterRole')} value={state.category} onChange={event => { const category = event.target.value; setState(current => ({ ...current, category })) }}>
        <option value="">{text('modelCall.allRoles')}</option>
        {categories.map(category => <option key={category}>{category}</option>)}
      </select> : null}
      <span className="debug-request-count">{filtered.length} / {items.length}</span>
    </div>
    {selected ? <div className="debug-request-browser-layout">
      <div className="debug-request-directory">
        <ol ref={directory} key={`${page}:${state.query}:${state.category}`} aria-label={label}>
          {visible.map(item => <li key={item.index}><button type="button" aria-label={`${item.index + 1} · ${item.label}`} aria-current={item.index === selected.index ? 'true' : undefined}
            aria-controls={detailId} onClick={() => setState(current => ({ ...current, selected: item.index }))}>
            <span className="debug-request-item-number">{String(item.index + 1).padStart(2, '0')}</span>
            <strong>{item.label}</strong><span className="debug-request-item-preview">{item.preview || '—'}</span>
          </button></li>)}
        </ol>
        {filtered.length > PAGE_SIZE ? <div className="debug-request-pagination">
          <button type="button" aria-label={text('modelCall.previousPage')} disabled={page === 0} onClick={() => select((page - 1) * PAGE_SIZE)}><ChevronLeft size={13} /></button>
          <span>{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} / {filtered.length}</span>
          <button type="button" aria-label={text('modelCall.nextPage')} disabled={(page + 1) * PAGE_SIZE >= filtered.length} onClick={() => select((page + 1) * PAGE_SIZE)}><ChevronRight size={13} /></button>
        </div> : null}
      </div>
      <section className="debug-request-item-detail" id={detailId} aria-label={text('modelCall.selectedItem')}>
        <div className="debug-request-item-navigation"><strong>{selected.label}</strong><span>{position + 1} / {filtered.length}</span>
        </div>
        <div key={selected.index} className="debug-request-item-content" tabIndex={0}>{children(selected.index)}</div>
      </section>
    </div> : <p className="debug-request-empty" role="status">{text(items.length ? 'modelCall.noMatches' : 'modelCall.emptyCollection')}</p>}
  </div>
}
