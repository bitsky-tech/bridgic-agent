/**
 * Execution-mode quick-switch pill in the input box — shows the current mode (icon + name) and opens a menu on click to
 * switch it (applies globally and stays in sync with the settings page). "Advanced settings" at the bottom of the menu jumps
 * to Settings · Execution mode tab.
 *
 * Reads `executionModeAtom`; clicking an option calls `setExecutionModeAtom`; on mount `loadExecutionModeAtom`
 * fetches the real value once. The menu's open state is component-local UI (useState) and closes on outside click.
 *
 * Positioning: the menu uses `position: fixed` anchored to the trigger button's rect (see `computeMenuPlacement`),
 * which lets it escape clipping by Landing's `overflow-auto` container — an earlier `absolute` version had the top
 * options of an upward-opening menu clipped by the container's top edge.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import {
  executionModeAtom,
  loadExecutionModeAtom,
  setExecutionModeAtom,
} from '@/atoms/permissions'
import { cn } from '@/lib/cn'
import { MODE_META } from './modeMeta'
import { modeIcon, modeTint, PIcon } from './icons'

const MENU_MARGIN = 8 // minimum gap between the menu and the viewport edge
const MENU_GAP = 6 // gap between the menu and the trigger button (≈ the former mb-1.5)

interface MenuPlacement {
  style: CSSProperties
  /** Whether the menu opens above the button (true) or below it (false) — this decides the chevron's direction. */
  openUp: boolean
}

/** Compute the dropdown's fixed position from the trigger button's viewport rect. The right edge aligns with the button's right edge;
 *  it opens on whichever side of the button is "roomier" (the Pipeline button sits at the bottom → upwards, the Landing button sits high → downwards),
 *  then `maxHeight` clamps it to that side's available height, guaranteeing options are never clipped at any window height (it scrolls internally instead). */
function computeMenuPlacement(rect: DOMRect): MenuPlacement {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const right = vw - rect.right
  const spaceAbove = rect.top - MENU_MARGIN
  const spaceBelow = vh - rect.bottom - MENU_MARGIN
  if (spaceAbove >= spaceBelow) {
    return {
      openUp: true,
      style: {
        position: 'fixed',
        right,
        bottom: vh - rect.top + MENU_GAP,
        maxHeight: Math.max(0, spaceAbove - MENU_GAP),
      },
    }
  }
  return {
    openUp: false,
    style: {
      position: 'fixed',
      right,
      top: rect.bottom + MENU_GAP,
      maxHeight: Math.max(0, spaceBelow - MENU_GAP),
    },
  }
}

export function ComposerModePill() {
  const { t } = useTranslation()
  const mode = useAtomValue(executionModeAtom)
  const setMode = useSetAtom(setExecutionModeAtom)
  const load = useSetAtom(loadExecutionModeAtom)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  // Snapshot the trigger button's viewport coordinates when opening, for computeMenuPlacement to position the menu.
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const labelKey = MODE_META.find((m) => m.id === mode)?.labelKey ?? 'permission.mode.auto.label'
  const label = t(labelKey)
  const placement = open && triggerRect ? computeMenuPlacement(triggerRect) : null

  return (
    <div ref={ref}>
      <button
        ref={btnRef}
        onClick={() => {
          const next = !open
          if (next) setTriggerRect(btnRef.current?.getBoundingClientRect() ?? null)
          setOpen(next)
        }}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border-subtle text-xs text-text-secondary"
      >
        <span className={modeTint(mode)}>{modeIcon(mode)(13)}</span>
        <span className="font-semibold text-text-primary">{label}</span>
        {/* The chevron direction follows the actual popup direction: flipped up when opening upwards, down when opening downwards / closed. */}
        <span className={cn('text-text-tertiary transition-transform', placement?.openUp && 'rotate-180')}>
          {PIcon.chevron(10)}
        </span>
      </button>
      {placement && (
        <div
          style={placement.style}
          className="w-72 rounded-lg border border-border-default bg-bg-elevated shadow-lg overflow-y-auto overflow-x-hidden z-50 p-1.5"
        >
          {MODE_META.map((m) => {
            const on = m.id === mode
            return (
              <div
                key={m.id}
                onClick={() => {
                  void setMode(m.id)
                  setOpen(false)
                }}
                className={cn(
                  'flex items-start gap-2.5 px-3 py-2.5 rounded-md cursor-pointer border border-transparent',
                  on && 'bg-bg-hover',
                )}
              >
                <span className={cn('mt-0.5 shrink-0', modeTint(m.id))}>{modeIcon(m.id)(16)}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-text-primary">{t(m.labelKey)}</div>
                  <div className="text-[11px] text-text-secondary mt-0.5 leading-snug">{t(m.descKey)}</div>
                </div>
                {on && <span className="text-brand-blue mt-0.5 shrink-0">{PIcon.check(14)}</span>}
              </div>
            )
          })}
          <div className="px-3 pt-2 pb-1 mt-1 border-t border-border-subtle text-[11px] text-text-tertiary">
            {t('permission.pill.globalNote')}
          </div>
        </div>
      )}
    </div>
  )
}
