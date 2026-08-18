/**
 * Presentational steps for the Skill import wizard (`SkillImportModal`).
 *
 * View components — the container owns the wizard + network state and passes
 * data + callbacks down. Rows may hold transient local UI state only (e.g. a
 * description's expand/collapse). Split out of `SkillImportModal.tsx` to keep
 * each file under the 400-line budget (§1.14).
 *
 * Conflict comparison follows "trim the UI first": only the update time the backend already has is shown, not version / author / command count.
 */
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'
import { useIsClamped } from '@/hooks/useIsClamped'
import type { ImportSummary, ScannedSkill, SkillDetail } from '@/lib/amphiClient'
import { Icons } from './Icons'
import { Tag } from './Primitives'
import { ConflictResolveRow } from './SkillConflictRow'
import { ImportMethod } from './SkillImportPick'

/** One scan row paired with its conflict-check verdict. */
export interface ReviewItem {
  scanned: ScannedSkill
  conflict: boolean
  existing: SkillDetail | null
}

/** Source bar at the top of Review — local shows the directory path, remote shows the source address + a source badge (GitHub / skills.sh). */
function SourceBar({
  source,
  path,
  remoteBadge,
}: {
  source: ImportMethod
  path: string
  remoteBadge?: string
}) {
  if (source === ImportMethod.Remote) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-hover border border-border-subtle mb-3.5">
        {Icons.link(14)}
        <span className="text-xs text-text-secondary font-mono flex-1 truncate">{path}</span>
        <span className="text-2xs font-semibold text-text-accent bg-accent-blue-subtle px-2 py-0.5 rounded-full shrink-0">
          {remoteBadge}
        </span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-hover border border-border-subtle mb-3.5">
      {Icons.folder(14)}
      <span className="text-xs text-text-secondary font-mono flex-1 truncate">{path}</span>
    </div>
  )
}

/** One new-skill row: click to include / exclude; description expands inline. */
function NewRow({
  item,
  checked,
  onToggle,
}: {
  item: ReviewItem
  checked: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  // Inline description expand/collapse — component-local UI state, aligned with the conflict row's ConflictVersionPanel.
  const [expanded, setExpanded] = useState(false)
  // Only show "expand/collapse" when the description really exceeds 3 lines (useIsClamped measures scrollHeight>clientHeight).
  const [descRef, clamped] = useIsClamped(item.scanned.description, expanded)
  // Clicking anywhere on the row toggles import/skip, hence a div rather than a button — that is what lets the nested "expand" be a legal
  // button (buttons cannot nest); the expand button calls stopPropagation so it does not also flip the checkbox.
  return (
    <div
      onClick={onToggle}
      className={cn(
        'w-full flex items-center gap-3 px-3.5 py-2.5 rounded-md border cursor-pointer text-left',
        checked
          ? 'border-brand-blue bg-accent-blue-subtle'
          : 'border-border-subtle bg-bg-elevated opacity-60 hover:border-border-strong',
      )}
    >
      <span
        className={cn(
          'w-[18px] h-[18px] rounded flex items-center justify-center flex-shrink-0 border-[1.5px] text-white',
          checked ? 'border-brand-blue bg-brand-blue' : 'border-border-strong',
        )}
      >
        {checked && Icons.check(12)}
      </span>
      <span className="w-[30px] h-[30px] rounded-md bg-bg-hover flex items-center justify-center text-text-tertiary flex-shrink-0">
        {Icons.terminal(15)}
      </span>
      <div className="flex-1 min-w-0">
        <div className={cn('text-sm font-semibold font-mono text-text-primary', !checked && 'line-through')}>
          {item.scanned.name}
        </div>
        {item.scanned.description && (
          <>
            <div
              ref={descRef}
              className={cn('text-xs text-text-secondary mt-0.5', !expanded && 'line-clamp-3')}
            >
              {item.scanned.description}
            </div>
            {clamped && (
              <button
                type="button"
                className="mt-1 text-2xs font-semibold text-text-accent"
                onClick={(e) => {
                  e.stopPropagation()
                  setExpanded((x) => !x)
                }}
              >
                {expanded ? t('skill.common.collapse') : t('skill.common.expand')}
              </button>
            )}
          </>
        )}
      </div>
      <Tag>{checked ? t('skill.common.new') : t('skill.import.review.skip')}</Tag>
    </div>
  )
}

/** Step 2 — review scan results and resolve conflicts. Rows are keyed by
 *  `local_path` (uniquely identifies each scanned skill dir; a remote repo scan
 *  gives every skill the same `source_uri`, so keying on that would collide). */
export function ImportReviewStep({
  source,
  path,
  remoteBadge,
  review,
  decide,
  onToggle,
  onBatch,
}: {
  source: ImportMethod
  path: string
  remoteBadge?: string
  review: ReviewItem[]
  decide: Record<string, boolean>
  onToggle: (key: string, value: boolean) => void
  onBatch: (replaceAll: boolean) => void
}) {
  const { t } = useTranslation()
  const conflicts = review.filter((r) => r.conflict)
  const news = review.filter((r) => !r.conflict)
  const allReplace = conflicts.length > 0 && conflicts.every((r) => decide[r.scanned.local_path])
  const allKeep = conflicts.length > 0 && conflicts.every((r) => !decide[r.scanned.local_path])
  return (
    <div className="px-6 pt-5 max-h-[440px] overflow-auto">
      <SourceBar source={source} path={path} remoteBadge={remoteBadge} />
      <div className="flex items-center gap-2 text-xs text-text-secondary mb-3">
        <Trans
          i18nKey="skill.import.review.scanned"
          values={{ n: review.length }}
          components={{ b: <strong className="text-text-primary" /> }}
        />
        {news.length > 0 && (
          <span className="text-status-success bg-status-success-bg px-2 py-0.5 rounded-full font-semibold">
            {t('skill.import.review.newBadge', { n: news.length })}
          </span>
        )}
        {conflicts.length > 0 && (
          <span className="text-status-warning bg-status-warning-bg px-2 py-0.5 rounded-full font-semibold">
            {t('skill.import.review.conflictBadge', { n: conflicts.length })}
          </span>
        )}
      </div>

      {review.length === 0 && (
        <div className="text-sm text-text-tertiary py-8 text-center">
          {source === ImportMethod.Remote
            ? t('skill.import.review.emptyRemote')
            : t('skill.import.review.emptyLocal')}
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-text-primary">
              {t('skill.import.review.conflictTitle', { n: conflicts.length })}
              <span className="font-normal text-text-tertiary">
                {t('skill.import.review.conflictHint')}
              </span>
            </span>
            <div className="flex items-center gap-1.5 text-xs">
              <button
                type="button"
                className={cn(
                  'inline-flex items-center gap-1 font-semibold px-2.5 py-1 rounded-sm border',
                  allReplace
                    ? 'border-brand-blue bg-brand-blue text-white'
                    : 'border-transparent text-text-accent',
                )}
                onClick={() => onBatch(true)}
              >
                {Icons.refresh(11)} {t('skill.import.review.replaceAll')}
              </button>
              <span className="w-px h-3 bg-border-default" />
              <button
                type="button"
                className={cn(
                  'font-semibold px-2.5 py-1 rounded-sm border',
                  allKeep
                    ? 'border-border-strong bg-bg-selected text-text-primary'
                    : 'border-transparent text-text-secondary',
                )}
                onClick={() => onBatch(false)}
              >
                {t('skill.import.review.keepAll')}
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {conflicts.map((r) => (
              <ConflictResolveRow
                key={r.scanned.local_path}
                name={r.scanned.name}
                incoming={r.scanned}
                existing={r.existing}
                accept={decide[r.scanned.local_path] ?? false}
                onPick={(next) => onToggle(r.scanned.local_path, next)}
              />
            ))}
          </div>
        </div>
      )}

      {news.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-text-secondary mb-2">{t('skill.import.review.newTitle', { n: news.length })}</div>
          <div className="flex flex-col gap-2">
            {news.map((r) => (
              <NewRow
                key={r.scanned.local_path}
                item={r}
                checked={decide[r.scanned.local_path] ?? true}
                onToggle={() => onToggle(r.scanned.local_path, !(decide[r.scanned.local_path] ?? true))}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Step 3 — import result summary. */
export function ImportResultStep({ summary }: { summary: ImportSummary }) {
  const { t } = useTranslation()
  return (
    <div className="px-6 pt-5 max-h-[440px] overflow-auto">
      <div className="flex items-center gap-2.5 p-3.5 rounded-md bg-status-success-bg mb-3">
        <span className="text-status-success">{Icons.check(18)}</span>
        <div className="text-sm text-text-primary">
          <Trans
            i18nKey="skill.import.result.success"
            values={{ n: summary.imported_skills.length }}
            components={{ b: <strong /> }}
          />
          {summary.failed_skills.length > 0 && (
            <span className="text-status-error">{t('skill.import.result.failure', { n: summary.failed_skills.length })}</span>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {summary.imported_skills.map((s) => (
          <div key={s.skill_id} className="flex items-center gap-2 text-xs">
            <span className="text-status-success">{Icons.check(12)}</span>
            <span className="font-mono text-text-primary">{s.name}</span>
            <Tag>{s.action === 'overwritten' ? t('skill.import.result.overwritten') : t('skill.common.new')}</Tag>
          </div>
        ))}
        {summary.failed_skills.map((s) => (
          <div key={s.source_uri} className="flex items-start gap-2 text-xs">
            <span className="text-status-error mt-0.5">{Icons.x(12)}</span>
            <div className="min-w-0">
              <span className="font-mono text-text-primary">{s.name}</span>
              <div className="text-xs text-text-tertiary truncate">{s.reason}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
