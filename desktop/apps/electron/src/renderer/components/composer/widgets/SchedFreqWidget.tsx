/**
 * `sched-freq` widget — inline schedule-frequency picker (Doubao style).
 *
 * The sentence shows a clickable chip with the human-readable frequency
 * (`Mon 14:00 ⌄`); clicking opens a portaled popover with the full cron picker
 * (mode dropdown + dependent time fields + live preview). value = 6-field cron,
 * flat = describeCronCN(value). Popover portals to body so it escapes the
 * composer's overflow clipping; keydown inside is stopped so it won't reach the
 * composer's send/menu handlers. Registers kind `'sched-freq'`.
 *
 * Positioning invariant: the popover **must land entirely inside the region the
 * renderer actually paints** — inside the viewport, and to the left of the embedded
 * Browser's native surface, which composites above this page and would swallow any
 * overlapping part outright. It narrows before it overflows either edge. The
 * chip lives inside the composer and the composer is pinned to the bottom of the window,
 * so "always open downward" inevitably pushes the popover past the bottom edge of the
 * screen — the user simply cannot click it (we actually hit this).
 * The position is computed by `computePopoverPos` from the chip rect + viewport alone (opening
 * upward anchors with CSS `bottom` plus a `maxHeight` that clamps the available
 * headroom), and it **never reads the popover's own height** — reading it would
 * oscillate every frame: "measure the clamped height → decide it fits → drop the
 * clamp → grow back again". While open it recomputes on resize / any ancestor
 * scroll; a `fixed` coordinate sticks to the wrong place the moment it goes stale.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { cn } from '@/lib/cn'
import {
  buildCron,
  CronPeriod,
  describeCron,
  parseCronToState,
  type CronState,
} from '@/lib/cron'
import { Icons } from '@/components/amphi'
import { useOverlayRightLimit } from '@/hooks/useOverlayRightLimit'
import { throttleRaf } from '@/lib/throttleRaf'
import { computePopoverPos, type PopoverPos } from './popoverPos'
import { registerWidget, WidgetKind, type WidgetViewProps } from './registry'

const buildPeriodOpts = (t: TFunction): { value: CronPeriod; label: string }[] => [
  { value: CronPeriod.Minute, label: t('widget.schedFreq.period.minute') },
  { value: CronPeriod.Hour, label: t('widget.schedFreq.period.hour') },
  { value: CronPeriod.Day, label: t('widget.schedFreq.period.day') },
  { value: CronPeriod.Week, label: t('widget.schedFreq.period.week') },
  { value: CronPeriod.Month, label: t('widget.schedFreq.period.month') },
  { value: CronPeriod.Quarter, label: t('widget.schedFreq.period.quarter') },
  { value: CronPeriod.Year, label: t('widget.schedFreq.period.year') },
  { value: CronPeriod.Custom, label: t('widget.schedFreq.period.custom') },
]
const buildDayOpts = (t: TFunction): { value: string; label: string }[] => [
  { value: '0', label: t('cron.weekday.sunday') },
  { value: '1', label: t('cron.weekday.monday') },
  { value: '2', label: t('cron.weekday.tuesday') },
  { value: '3', label: t('cron.weekday.wednesday') },
  { value: '4', label: t('cron.weekday.thursday') },
  { value: '5', label: t('cron.weekday.friday') },
  { value: '6', label: t('cron.weekday.saturday') },
]
const buildMonthOpts = (t: TFunction): { value: string; label: string }[] => [
  { value: '1', label: t('cron.month.january') },
  { value: '2', label: t('cron.month.february') },
  { value: '3', label: t('cron.month.march') },
  { value: '4', label: t('cron.month.april') },
  { value: '5', label: t('cron.month.may') },
  { value: '6', label: t('cron.month.june') },
  { value: '7', label: t('cron.month.july') },
  { value: '8', label: t('cron.month.august') },
  { value: '9', label: t('cron.month.september') },
  { value: '10', label: t('cron.month.october') },
  { value: '11', label: t('cron.month.november') },
  { value: '12', label: t('cron.month.december') },
]
const buildQuarterOpts = (t: TFunction): { value: string; label: string }[] => [
  { value: '1', label: t('widget.schedFreq.quarterStartMonth', { n: 1 }) },
  { value: '2', label: t('widget.schedFreq.quarterStartMonth', { n: 2 }) },
  { value: '3', label: t('widget.schedFreq.quarterStartMonth', { n: 3 }) },
]

// Unified fields: 8px radius, h-8 equal height, subtle border that brightens on hover/focus.
const SELECT_CLS =
  'appearance-none h-8 pl-2.5 pr-7 bg-bg-input border border-border-subtle rounded-md text-text-primary text-sm outline-none cursor-pointer hover:border-border-strong focus:border-brand-blue transition-colors'
// Number box narrowed + mono alignment + native spinner hidden (otherwise it is wide and ugly).
const NUM_CLS =
  'w-11 h-8 bg-bg-input border border-border-subtle rounded-md text-text-primary text-sm text-center font-mono outline-none hover:border-border-strong focus:border-brand-blue transition-colors [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'

function Sel({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <span className="relative inline-flex">
      <select value={value} onChange={(e) => onChange(e.target.value)} className={SELECT_CLS}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 flex text-text-tertiary">
        {Icons.chevronDown(12)}
      </span>
    </span>
  )
}

function Num({
  value,
  onChange,
  min,
  max,
}: {
  value: string
  onChange: (v: string) => void
  min: number
  max: number
}) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        // min/max on type=number only constrain the spinner, they do not block manual
        // typing → clamp explicitly into [min,max], otherwise typing e.g. 99 for the hour
        // would build an invalid cron. Empty string is allowed so the field stays editable.
        const raw = e.target.value
        if (raw === '') return onChange('')
        const n = parseInt(raw, 10)
        if (Number.isNaN(n)) return
        onChange(String(Math.max(min, Math.min(max, n))))
      }}
      className={NUM_CLS}
    />
  )
}

const Word = ({ children }: { children: ReactNode }) => (
  <span className="text-sm text-text-tertiary shrink-0">{children}</span>
)

/** Renders the time fields matching the current period (§1.24: early-return per period,
 *  no nested ternaries). */
function PeriodFields({ st, set }: { st: CronState; set: (k: keyof CronState, v: string) => void }) {
  const { t } = useTranslation()
  // The "at HH:MM" group is locked into a nowrap unit so flex-wrap can never split it
  // across two lines.
  const timeFields = (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Word>{t('widget.schedFreq.word.at')}</Word>
      <Num value={st.hour} onChange={(v) => set('hour', v)} min={0} max={23} />
      <span className="text-sm text-text-tertiary">:</span>
      <Num value={st.minute} onChange={(v) => set('minute', v)} min={0} max={59} />
    </span>
  )
  if (st.period === CronPeriod.Custom) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-text-tertiary">{t('widget.schedFreq.cronExpr')}</span>
        <input
          type="text"
          value={st.custom}
          onChange={(e) => set('custom', e.target.value)}
          className="w-full h-8 bg-bg-input border border-border-subtle rounded-md text-text-primary text-sm px-2.5 outline-none font-mono hover:border-border-strong focus:border-brand-blue transition-colors"
        />
      </div>
    )
  }
  if (st.period === CronPeriod.Minute) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2.5">
        <Word>{t('widget.schedFreq.word.atNth')}</Word>
        <Num value={st.second} onChange={(v) => set('second', v)} min={0} max={59} />
        <Word>{t('widget.schedFreq.word.second')}</Word>
      </div>
    )
  }
  if (st.period === CronPeriod.Hour) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2.5">
        <Word>{t('widget.schedFreq.word.atNth')}</Word>
        <Num value={st.minute} onChange={(v) => set('minute', v)} min={0} max={59} />
        <Word>{t('widget.schedFreq.word.minute')}</Word>
      </div>
    )
  }
  if (st.period === CronPeriod.Week) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2.5">
        <Word>{t('widget.schedFreq.word.on')}</Word>
        <Sel value={st.dayOfWeek} onChange={(v) => set('dayOfWeek', v)} options={buildDayOpts(t)} />
        {timeFields}
      </div>
    )
  }
  if (st.period === CronPeriod.Month) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2.5">
        <Word>{t('widget.schedFreq.word.onNth')}</Word>
        <Num value={st.dayOfMonth} onChange={(v) => set('dayOfMonth', v)} min={1} max={31} />
        <Word>{t('widget.schedFreq.word.day')}</Word>
        {timeFields}
      </div>
    )
  }
  if (st.period === CronPeriod.Quarter) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2.5">
        <Word>{t('widget.schedFreq.word.startMonth')}</Word>
        <Sel value={st.quarterStart} onChange={(v) => set('quarterStart', v)} options={buildQuarterOpts(t)} />
        <Word>{t('widget.schedFreq.word.onNth')}</Word>
        <Num value={st.dayOfMonth} onChange={(v) => set('dayOfMonth', v)} min={1} max={31} />
        <Word>{t('widget.schedFreq.word.day')}</Word>
        {timeFields}
      </div>
    )
  }
  if (st.period === CronPeriod.Year) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2.5">
        <Word>{t('widget.schedFreq.word.on')}</Word>
        <Sel value={st.month} onChange={(v) => set('month', v)} options={buildMonthOpts(t)} />
        <Word>{t('widget.schedFreq.word.onNth')}</Word>
        <Num value={st.dayOfMonth} onChange={(v) => set('dayOfMonth', v)} min={1} max={31} />
        <Word>{t('widget.schedFreq.word.day')}</Word>
        {timeFields}
      </div>
    )
  }
  // day
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-2.5">{timeFields}</div>
}

// `rightLimit` comes from the caller (`useOverlayRightLimit`): the embedded
// Browser paints over this page, and the popover keeps to its left rather than
// blanking the browser for a dropdown.
const viewportSize = (rightLimit: number) => ({
  width: window.innerWidth,
  height: window.innerHeight,
  rightLimit,
})

/** Whether two positions are equivalent — used to skip pointless re-renders while scrolling. */
function samePos(a: PopoverPos | null, b: PopoverPos): boolean {
  return (
    a != null
    && a.left === b.left
    && a.width === b.width
    && a.top === b.top
    && a.bottom === b.bottom
    && a.maxHeight === b.maxHeight
  )
}

/** Inline schedule-frequency picker: the chip shows the human-readable frequency; clicking
 *  opens a portaled popover to configure it (mode + dependent fields + preview). */
export function SchedFreqWidget({ value, onChange }: WidgetViewProps) {
  const { t } = useTranslation()
  const describe = (expression: string) => describeCron(expression, (key, options) => String(t(key, options)))
  const [st, setSt] = useState<CronState>(() => parseCronToState(value))
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<PopoverPos | null>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const rightLimit = useOverlayRightLimit()

  const cron = buildCron(st)

  const set = (k: keyof CronState, v: string) => {
    const next = { ...st, [k]: v }
    setSt(next)
    const c = buildCron(next)
    onChange(c, describe(c))
  }

  // Compute the position in the same tick as the open (positioning only needs the chip
  // rect, not the popover height), so there is no "render first, correct later"
  // intermediate state and nothing has to be hidden on the first frame.
  const toggle = () => {
    const anchor = chipRef.current?.getBoundingClientRect()
    if (anchor) setPos(computePopoverPos(anchor, viewportSize(rightLimit)))
    setOpen((o) => !o)
  }

  // While open, recompute on ancestor scroll / window resize: a fixed coordinate is a
  // snapshot and goes stale as soon as a container scrolls (SessionRow hit the same
  // trap). We do **not** observe the popover's own size — positioning does not depend on
  // its height; taller content just scrolls inside maxHeight (see the infinite loop
  // described in the popoverPos.ts header).
  useEffect(() => {
    if (!open) return
    const place = () => {
      const anchor = chipRef.current?.getBoundingClientRect()
      if (!anchor) return
      const next = computePopoverPos(anchor, viewportSize(rightLimit))
      // Skip setState when the value did not change: scroll fires once per frame, and
      // setting blindly would re-render the whole popover (Sel + PeriodFields + preview)
      // every frame.
      setPos((prev) => (samePos(prev, next) ? prev : next))
    }
    // Re-place immediately, not only on the listeners below: `rightLimit` changes
    // when the browser appears or its dock is resized, and an already-open popover
    // would otherwise sink underneath the native view it was placed to avoid.
    place()
    const schedulePlace = throttleRaf(place)
    // scroll uses the capture phase: what scrolls is an ancestor container (composer /
    // message list), and the event does not bubble to window.
    window.addEventListener('resize', schedulePlace)
    window.addEventListener('scroll', schedulePlace, true)
    return () => {
      schedulePlace.cancel()
      window.removeEventListener('resize', schedulePlace)
      window.removeEventListener('scroll', schedulePlace, true)
    }
  }, [open, rightLimit])

  // Close on outside mousedown / Esc while open.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (chipRef.current?.contains(e.target as Node)) return
      if (popoverRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        onClick={toggle}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn(
          'inline-flex items-center gap-1 align-baseline rounded-md border px-2 py-0.5 text-xs cursor-pointer',
          'bg-accent-purple-subtle text-text-accent-purple border-brand-purple/30 hover:border-brand-purple',
        )}
      >
        {describe(cron)}
        <span className={cn('flex transition-transform', open && 'rotate-180')}>{Icons.chevronDown(11)}</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            onKeyDown={(e) => e.stopPropagation()}
            className="fixed z-[110] overflow-y-auto bg-bg-modal border border-border-default rounded-xl shadow-modal p-4 flex flex-col gap-4"
            // Width is part of the placement, not a class: computePopoverPos narrows it
            // when the free column cannot hold POPOVER_WIDTH, and it clamps `left` against
            // whatever width it settled on. Writing the width here as well would drift
            // silently from the offset it was clamped with.
            //
            // Exactly one of top / bottom is set: opening upward must anchor via bottom,
            // otherwise positioning would depend on the popover height (see the infinite
            // loop in the popoverPos.ts header). maxHeight is always present, so
            // overflowing content scrolls inside the popover instead of overturning the
            // placement.
            style={{ ...pos }}
          >
            {/* Frequency mode */}
            <div className="flex items-center gap-2.5">
              <span className="text-sm font-semibold text-text-primary shrink-0">
                {st.period === CronPeriod.Custom ? t('widget.schedFreq.mode') : t('widget.schedFreq.every')}
              </span>
              <Sel
                value={st.period}
                onChange={(v) => set('period', v)}
                options={buildPeriodOpts(t).map((o) => ({ value: o.value, label: o.label }))}
              />
            </div>
            {/* Dependent fields */}
            <PeriodFields st={st} set={set} />
            {/* Preview — human-readable only, never the raw cron. */}
            <div className="flex items-center gap-2.5 pt-3 border-t border-border-subtle">
              <span className="text-2xs font-semibold text-text-accent bg-accent-blue-subtle px-2 py-0.5 rounded-full shrink-0">
                {t('widget.schedFreq.preview')}
              </span>
              <span className="text-xs text-text-secondary">{describe(cron)}</span>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

registerWidget({ kind: WidgetKind.SchedFreq, Component: SchedFreqWidget })
