/**
 * Skill name-conflict row — a single "overwrite" switch + a read-only "source → existing in system" comparison card.
 *
 * Clicking anywhere on the row (including the two comparison card areas) toggles one boolean decision: overwrite or do not overwrite
 * the version already in the system. The two `ConflictVersionPanel`s are purely presentational (update time + description) and carry no
 * selection; the sole exception is the "expand" button inside a card, whose click needs `stopPropagation` or it would also flip the overwrite switch.
 *
 * Decision semantics match the container: `accept === true` ↔ `decide[source_uri] === true` (overwrite the existing one with the new version).
 * The default `accept=false` (keep the existing one, the safest choice) is decided by the container's `initDecisions`; this component is purely controlled presentation.
 *
 * The pure functions (`isNewer`/`hasDescChanged`/`formatUpdatedAt`) are extracted to make unit testing easy (§4.12).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'
import { useIsClamped } from '@/hooks/useIsClamped'
import type { ScannedSkill, SkillDetail } from '@/lib/amphiClient'
import { Icons } from './Icons'

/** True when `a` is strictly newer than `b` by ISO-8601 lexical order.
 *  Either side null → false (a missing timestamp never counts as "newer"). */
export function isNewer(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  return a > b
}

/** True when the incoming description differs from the existing one (null counts as a change). */
export function hasDescChanged(incoming: string | null, existing: string | null): boolean {
  return incoming !== existing
}

/** Render an ISO-8601 stamp as `YYYY-MM-DD HH:mm`; null → em dash. */
export function formatUpdatedAt(iso: string | null): string {
  if (!iso) return '—'
  return iso.slice(0, 16).replace('T', ' ')
}

/** One read-only side of the conflict comparison (incoming vs existing). */
interface ConflictVersionPanelProps {
  label: string
  sub: string
  time: string | null
  desc: string | null
  newer: boolean
  descChanged: boolean
  expanded: boolean
  onToggleDesc: () => void
}

/** Pure display card — update time (green "newer" tag on the newer side) + clamped description. */
function ConflictVersionPanel({
  label,
  sub,
  time,
  desc,
  newer,
  descChanged,
  expanded,
  onToggleDesc,
}: ConflictVersionPanelProps) {
  const { t } = useTranslation()
  // Only show "expand/collapse" when this panel's description really overflows the line-clamp (each of the two panels measures its own description).
  const [descRef, clamped] = useIsClamped(desc, expanded)
  return (
    <div className="flex-1 min-w-0 flex flex-col rounded-md overflow-hidden border border-border-subtle bg-bg-elevated">
      <div className="flex items-center gap-1.5 px-2.5 py-[5px] bg-bg-hover text-text-tertiary">
        <span className="text-[10px] font-bold tracking-[0.02em]">{label}</span>
        <span className="text-[10px] font-medium opacity-80">· {sub}</span>
      </div>
      <div className="flex flex-col gap-2 flex-1 px-[11px] py-[9px]">
        <div className="flex items-center gap-1.5">
          <span className={cn('flex shrink-0', newer ? 'text-status-success' : 'text-text-tertiary')}>
            {Icons.clock(13)}
          </span>
          <span className="text-[11px] font-mono text-text-secondary">{formatUpdatedAt(time)}</span>
          {newer && (
            <span className="text-[9.5px] font-bold text-status-success bg-status-success-bg px-1.5 py-0.5 rounded-full">
              {t('skill.conflict.newer')}
            </span>
          )}
        </div>
        <div
          ref={descRef}
          className={cn('text-[11px] leading-[1.55] text-text-secondary', !expanded && 'line-clamp-4')}
        >
          {desc ?? '—'}
        </div>
        <div className="flex items-center gap-2 mt-auto">
          {descChanged && (
            <span className="inline-flex items-center gap-1 text-[9.5px] font-semibold text-brand-blue">
              {Icons.edit(10)} {t('skill.conflict.descChanged')}
            </span>
          )}
          {clamped && (
            <button
              type="button"
              className="ml-auto text-[10px] font-semibold text-brand-blue"
              onClick={(e) => {
                e.stopPropagation()
                onToggleDesc()
              }}
            >
              {expanded ? t('skill.common.collapse') : t('skill.common.expand')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** One same-name conflict row. Click anywhere (incl. cards) to toggle the overwrite switch. */
export interface ConflictResolveRowProps {
  name: string
  /** The skill about to be imported (the "source" side). */
  incoming: ScannedSkill
  /** The same-named installed skill that would be overwritten; null should not occur for conflicts. */
  existing: SkillDetail | null
  /** True = overwrite the existing skill with the incoming one. */
  accept: boolean
  onPick: (next: boolean) => void
}

/** Source → (overwrite) → system-existing, gated by a single per-row overwrite switch. */
export function ConflictResolveRow({ name, incoming, existing, accept, onPick }: ConflictResolveRowProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const incTime = incoming.updated_at
  const curTime = existing?.updated_at ?? null
  const descChanged = hasDescChanged(incoming.description, existing?.description ?? null)
  const toggleDesc = () => setExpanded((e) => !e)

  // §LS1: constant 1px border, flip color (+bg) on select — never width/ring.
  return (
    <div
      onClick={() => onPick(!accept)}
      className={cn(
        'p-3.5 rounded-md border cursor-pointer',
        accept ? 'border-brand-blue bg-accent-blue-subtle' : 'border-border-subtle bg-bg-hover',
      )}
    >
      <div className="flex items-center gap-2.5 mb-3">
        <span
          className={cn(
            'w-[19px] h-[19px] rounded-[5px] flex items-center justify-center shrink-0 border-[1.5px] text-white',
            accept ? 'border-brand-blue bg-brand-blue' : 'border-border-strong',
          )}
        >
          {accept && Icons.check(13)}
        </span>
        <span className="text-sm font-semibold font-mono text-text-primary">{name}</span>
      </div>
      <div className={cn('flex gap-2.5 items-stretch pl-[29px]', !accept && 'opacity-55')}>
        <ConflictVersionPanel
          label={t('skill.conflict.incoming')}
          sub={t('skill.conflict.incomingSub')}
          time={incTime}
          desc={incoming.description}
          newer={isNewer(incTime, curTime)}
          descChanged={descChanged}
          expanded={expanded}
          onToggleDesc={toggleDesc}
        />
        <div className="shrink-0 w-12 flex flex-col items-center justify-center gap-1 self-center text-brand-blue">
          {Icons.chevronRight(22)}
          <span className="text-[9px] font-bold whitespace-nowrap">{t('skill.conflict.overwrite')}</span>
        </div>
        <ConflictVersionPanel
          label={t('skill.conflict.existing')}
          sub={t('skill.conflict.existingSub')}
          time={curTime}
          desc={existing?.description ?? null}
          newer={isNewer(curTime, incTime)}
          descChanged={false}
          expanded={expanded}
          onToggleDesc={toggleDesc}
        />
      </div>
    </div>
  )
}
