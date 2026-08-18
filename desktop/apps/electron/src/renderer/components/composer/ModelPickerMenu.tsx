/**
 * Model picker pill — the "current model" trigger button in the composer toolbar + the Modal picker.
 *
 * Switching takes effect GLOBALLY: the selected (provider, model) is mirrored
 * into the User row by the backend, every session uses the new model from its next chat turn, and
 * there is no per-session override.
 *
 * UI shape (switched to a Modal in Phase 2.5):
 *   - trigger: the pill button on the composer (unchanged)
 *   - a centred Modal overlay, 560px wide, max-h 80% (the Modal shell default)
 *   - top: the standard Modal title bar ("select model" + × to close)
 *   - second row: search box (search icon on the left, × to clear on the right)
 *   - body: a scrollable model list grouped by provider
 *   - keyboard: autoFocus on the search box; ↑↓ move between visible rows; Enter selects; Esc closes (built into Modal)
 *
 * Grouping fix (v3):
 *   - it used to use `catalog.filter(byProvider.has(c.id))` as the ordering source → a custom
 *     channel (whose provider_id is not in the built-in catalog) had its whole group filtered out
 *     and showed "no matching models" even when models had been configured for that provider.
 *   - it now uses `configuredProvidersAtom` as the ordering source, with a display_name fallback
 *     chain: `cp.display_name` (user-chosen) > the built-in catalog name > `cp.id`.
 *
 * The selected state follows §LS1: a 1px transparent border is always present + a pale
 * bg-accent-blue-subtle background; no ring/halo. The layout has no box-model change either, so zero
 * layout shift.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Icons } from '../amphi/Icons'
import { Modal } from '../amphi/Modal'
import { Tooltip } from '../amphi/Tooltip'
import {
  activeModelAtom,
  configuredProvidersAtom,
  getConfiguredProviderDisplayName,
  getProviderDisplayById,
  modelsAtom,
  modelsLastActionErrorAtom,
  providerCatalogAtom,
  setActiveModelByRowIdAtom,
  type ModelRow,
} from '@/atoms/models'
import { matchesFilter } from './matchesFilter'

interface ProviderGroup {
  id: string
  displayName: string
  rows: ModelRow[]
}

export function ModelPickerMenu() {
  const { t } = useTranslation()
  const activeModel = useAtomValue(activeModelAtom)
  const lastActionError = useAtomValue(modelsLastActionErrorAtom)
  const [open, setOpen] = useState(false)

  return (
    <>
      <Tooltip content={lastActionError ?? undefined}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="relative inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-bg-hover text-text-primary text-sm font-medium hover:bg-bg-active outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/40"
          aria-label={t('composer.model.switchAria')}
        >
          {Icons.robot(14)}
          <span>{activeModel?.modelId ?? t('composer.model.selectPlaceholder')}</span>
          {Icons.chevronDown(12)}
          {/* polish-3: when a write operation (add/delete/switch) has an uncleared error, show a 6px red dot
              in the pill's top-right corner. Hovering brings up a Tooltip with the error detail. It does not
              nag, it just signals that something is wrong; the detailed banner lives in the settings panel
              (modelsLastActionErrorAtom is the single source). The dot disappears once the error is cleared
              (the user clicks the × on the settings banner, or the next write operation succeeds). */}
          {lastActionError && (
            <span
              className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-status-error"
              aria-hidden
            />
          )}
        </button>
      </Tooltip>
      {open && <ModelPickerModal onClose={() => setOpen(false)} />}
    </>
  )
}

/** Modal body — search + grouped list + active highlight + keyboard nav. */
function ModelPickerModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const models = useAtomValue(modelsAtom)
  const catalog = useAtomValue(providerCatalogAtom)
  const configured = useAtomValue(configuredProvidersAtom)
  const activeModel = useAtomValue(activeModelAtom)
  const setActiveByRow = useSetAtom(setActiveModelByRowIdAtom)

  const [query, setQuery] = useState('')
  // highlightIndex<0 = the user has not navigated manually yet; the highlight then follows the active
  // row (see safeHighlight below, computed in the visibleRows index space so it matches rendering and
  // the keyboard). As soon as an arrow key / hover happens, highlightIndex>=0 takes over. Row maps both
  // active and highlighted to bg-bg-hover, so sharing a row cannot produce "two highlights".
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [])

  // Grouping source = the order of the configured list (== the backend's created_at ascending).
  // display_name fallback: cp.display_name > catalog.display_name > cp.id.
  // Custom channels (not in the catalog) also group correctly — that was the root cause of the old bug.
  const groups: ProviderGroup[] = useMemo(() => {
    const byProvider = new Map<string, ModelRow[]>()
    for (const r of models) {
      const arr = byProvider.get(r.providerId) ?? []
      arr.push(r)
      byProvider.set(r.providerId, arr)
    }
    const q = query.trim()
    const out: ProviderGroup[] = []
    for (const cp of configured) {
      const allRows = byProvider.get(cp.id) ?? []
      if (allRows.length === 0) continue  // disabled / empty allow-list
      const catEntry = catalog.find((c) => c.id === cp.id)
      const displayName = catEntry
        ? getConfiguredProviderDisplayName(catEntry, cp.display_name, t)
        : cp.display_name ?? cp.id
      const rows = q
        ? allRows.filter((r) => matchesFilter(r.modelId, q) || matchesFilter(displayName, q))
        : allRows
      if (rows.length > 0) out.push({ id: cp.id, displayName, rows })
    }
    return out
  }, [models, configured, catalog, query, t])

  // The flattened visible rows — keyboard ↑↓ move over this, never onto a group header.
  const visibleRows: ModelRow[] = useMemo(
    () => groups.flatMap((g) => g.rows),
    [groups],
  )
  // Position of the active row in the "visible rows" index space (after search / regrouping). -1 = not in the visible set.
  const activeIndex = useMemo(
    () => (activeModel ? visibleRows.findIndex((r) => r.id === activeModel.id) : -1),
    [visibleRows, activeModel],
  )
  // While the user has not navigated manually (highlightIndex<0) it follows the active row; otherwise
  // the hand-picked value is used and clamped. The key point: everything stays in the visibleRows index
  // space, which fixes the earlier misalignment caused by seeding from the full models index.
  const safeHighlight =
    highlightIndex >= 0 ? Math.min(highlightIndex, visibleRows.length - 1) : activeIndex

  const handleSelect = useCallback(
    (row: ModelRow) => {
      // The error is already exposed to the settings panel banner through modelsLastActionErrorAtom, so it
      // is swallowed here to avoid an unhandled rejection. On failure activeModelAtom is not updated, so
      // the picker's trigger button naturally rolls back to showing the previously active model.
      void setActiveByRow(row.id).catch(() => {})
      onClose()
    },
    [setActiveByRow, onClose],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Esc is handled by the Modal shell itself; this only deals with the business keys.
      // Navigation is based on safeHighlight (not the raw highlightIndex), so pressing an arrow key from
      // the initial "follow active" state continues from the visible highlight.
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (visibleRows.length > 0) {
          setHighlightIndex((safeHighlight + 1) % visibleRows.length)
        }
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (visibleRows.length > 0) {
          setHighlightIndex((safeHighlight - 1 + visibleRows.length) % visibleRows.length)
        }
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const row = visibleRows[safeHighlight]
        if (row) handleSelect(row)
      }
    },
    [visibleRows, safeHighlight, handleSelect],
  )

  return (
    <Modal title={t('composer.model.modalTitle')} width={560} onClose={onClose}>
      <div onKeyDown={handleKeyDown}>
        {/* Search bar */}
        <div className="px-5 py-3 border-b border-border-subtle flex items-center gap-2">
          <span className="text-text-tertiary flex-shrink-0">{Icons.search(14)}</span>
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('composer.model.searchPlaceholder')}
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
              className="text-text-tertiary hover:text-text-secondary flex-shrink-0"
              aria-label={t('composer.model.clearSearch')}
            >
              {Icons.x(14)}
            </button>
          )}
        </div>

        {/* Body */}
        <div className="py-2">
          <ModelPickerBody
            models={models}
            groups={groups}
            activeRowId={activeModel?.id ?? ''}
            visibleRows={visibleRows}
            safeHighlight={safeHighlight}
            setHighlightIndex={setHighlightIndex}
            onSelect={handleSelect}
          />
        </div>
      </div>
    </Modal>
  )
}

// ─── Sub-renderers ─────────────────────────────────────────────────────────

interface ModelPickerBodyProps {
  models: ModelRow[]
  groups: ProviderGroup[]
  activeRowId: string
  visibleRows: ModelRow[]
  safeHighlight: number
  setHighlightIndex: (i: number) => void
  onSelect: (row: ModelRow) => void
}

/** Modal body: no models / no matches / the grouped list — three early returns, so the Modal does not
 *  end up containing nested conditional-render ternaries. */
function ModelPickerBody({
  models,
  groups,
  activeRowId,
  visibleRows,
  safeHighlight,
  setHighlightIndex,
  onSelect,
}: ModelPickerBodyProps) {
  const { t } = useTranslation()
  if (models.length === 0) return <EmptyHint text={t('composer.model.emptyNoModels')} />
  if (groups.length === 0) return <EmptyHint text={t('composer.model.emptyNoMatch')} />
  return (
    <Groups
      groups={groups}
      activeRowId={activeRowId}
      visibleRows={visibleRows}
      safeHighlight={safeHighlight}
      setHighlightIndex={setHighlightIndex}
      onSelect={onSelect}
    />
  )
}

/** Centred empty-state hint (no models / no matches). */
function EmptyHint({ text }: { text: string }) {
  return <div className="px-3 py-12 text-sm text-text-tertiary text-center">{text}</div>
}

function Groups({
  groups,
  activeRowId,
  visibleRows,
  safeHighlight,
  setHighlightIndex,
  onSelect,
}: {
  groups: ProviderGroup[]
  activeRowId: string
  visibleRows: ModelRow[]
  safeHighlight: number
  setHighlightIndex: (i: number) => void
  onSelect: (row: ModelRow) => void
}) {
  // Per the design: groups are separated by a thin divider. Not before the first group.
  return (
    <>
      {groups.map((g, gi) => (
        <div key={g.id}>
          {gi > 0 && <div className="mx-3 my-1 h-px bg-border-subtle" />}
          <div className="px-4 pt-1.5 pb-1 text-xs font-semibold text-text-tertiary tracking-wide">
            {g.displayName}
          </div>
          {g.rows.map((row) => {
            const indexInVisible = visibleRows.indexOf(row)
            return (
              <Row
                key={row.id}
                row={row}
                active={row.id === activeRowId}
                highlighted={indexInVisible === safeHighlight}
                onHover={() => setHighlightIndex(indexInVisible)}
                onClick={() => onSelect(row)}
              />
            )
          })}
        </div>
      ))}
    </>
  )
}

function Row({
  row,
  active,
  highlighted,
  onHover,
  onClick,
}: {
  row: ModelRow
  active: boolean
  highlighted: boolean
  onHover: () => void
  onClick: () => void
}) {
  const { t } = useTranslation()
  // Per the design: row padding 8px×16px, tile 22×22, active gets only the pale bg-hover background (no
  // more blue border + blue fill), font weight 500 when active, and the "current" badge uses the brand colour.
  const brand = getProviderDisplayById(row.providerId)
  return (
    <button
      type="button"
      onMouseEnter={onHover}
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2.5 px-4 py-2 text-left cursor-pointer',
        (active || highlighted) && 'bg-bg-hover',
      )}
    >
      <span
        className="w-[22px] h-[22px] rounded-[5px] flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
        style={{ background: brand.brandColor }}
      >
        {brand.iconLetter}
      </span>
      <span
        className={cn(
          'flex-1 min-w-0 text-sm text-text-primary truncate',
          active ? 'font-medium' : 'font-normal',
        )}
      >
        {row.modelId}
      </span>
      {active && (
        <span className="text-2xs font-semibold px-1.5 py-0.5 rounded bg-accent-blue-subtle text-text-accent flex-shrink-0">
          {t('composer.model.current')}
        </span>
      )}
    </button>
  )
}
