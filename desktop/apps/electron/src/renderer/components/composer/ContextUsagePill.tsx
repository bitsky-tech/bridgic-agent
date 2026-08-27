import {
  Gauge,
  Sparkles,
  Zap,
} from 'lucide-react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import type { ContextUsageSnapshot } from '@shared/types'
import { activeContextUsageAtom } from '@/atoms/agent'
import { activeModelAtom } from '@/atoms/models'
import { cn } from '@/lib/cn'
import { Tooltip } from '../amphi/Tooltip'

const CIRCLE_LENGTH = 2 * Math.PI * 6

export function formatContextTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`
  return String(value)
}

function ContextUsagePanel({ usage }: { usage: ContextUsageSnapshot }) {
  const { t } = useTranslation()
  const percentage = usage.percentage
  const progress = Math.min(100, Math.max(0, percentage ?? 0))
  const remaining = usage.usableTokens === null
    ? null
    : Math.max(0, usage.usableTokens - usage.usedTokens)
  const cachePercentage = usage.inputTokens > 0 && usage.cachedInputTokens !== null
    ? Math.min(100, usage.cachedInputTokens / usage.inputTokens * 100)
    : 0

  let progressClass = 'bg-brand-blue'
  let progressTextClass = 'text-text-accent'
  if (percentage !== null && percentage >= 85) {
    progressClass = 'bg-status-error'
    progressTextClass = 'text-status-error'
  } else if (percentage !== null && percentage >= 70) {
    progressClass = 'bg-status-warning'
    progressTextClass = 'text-status-warning'
  }

  return (
    <div className="w-[272px] whitespace-normal p-1.5 text-left">
      <div className="flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-blue-subtle text-text-accent">
          <Gauge size={15} strokeWidth={1.8} aria-hidden="true" />
        </span>
        <div className="text-xs font-semibold text-text-primary">
          {t('composer.contextUsage.title')}
        </div>
      </div>

      <div className="mt-3">
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-[10px] text-text-tertiary">
            {t('composer.contextUsage.usedLabel')}
          </span>
          <span className={cn('font-mono text-xs font-semibold', progressTextClass)}>
            {usage.usableTokens !== null
              ? t('composer.contextUsage.usedValue', {
                  used: formatContextTokens(usage.usedTokens),
                  capacity: formatContextTokens(usage.usableTokens),
                })
              : t('composer.contextUsage.usedOnly', {
                  used: formatContextTokens(usage.usedTokens),
                })}
          </span>
        </div>
        <div
          className="h-2 overflow-hidden rounded-full bg-bg-hover"
          role="progressbar"
          aria-label={t('composer.contextUsage.label')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentage === null ? undefined : progress}
        >
          {percentage !== null && (
            <div
              className={cn('h-full rounded-full transition-[width] duration-300', progressClass)}
              style={{ width: `${progress}%` }}
            />
          )}
        </div>
        <div className="mt-1.5 flex justify-between text-[10px] text-text-tertiary">
          <span>
            {percentage !== null
              ? `${usage.source === 'estimated' ? '≈' : ''}${Math.round(percentage)}%`
              : t('composer.contextUsage.capacityUnknown')}
          </span>
          {remaining !== null && (
            <span>{t('composer.contextUsage.remainingCompact', {
              remaining: formatContextTokens(remaining),
            })}</span>
          )}
        </div>
      </div>

      {usage.cachedInputTokens !== null && (
        <div
          className="mt-3 flex items-center gap-2.5 border-t border-border-subtle pt-3"
          data-context-cache
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-bg-elevated text-text-accent-purple">
            <Zap size={14} strokeWidth={1.9} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-medium text-text-accent-purple">
              {t('composer.contextUsage.cacheTitle')}
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-xs font-semibold text-text-primary">
                {t('composer.contextUsage.tokenValue', {
                  tokens: formatContextTokens(usage.cachedInputTokens),
                })}
              </span>
              <span className="text-[10px] text-text-tertiary">
                {t('composer.contextUsage.cacheRatio', {
                  percentage: Math.round(cachePercentage),
                })}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function ContextUsagePill() {
  const { t } = useTranslation()
  const usage = useAtomValue(activeContextUsageAtom)
  const activeModel = useAtomValue(activeModelAtom)
  if (!usage) return null
  const pendingRecalculation = Boolean(
    activeModel && usage.modelId !== activeModel.modelId,
  )
  const percentage = pendingRecalculation ? null : usage.percentage
  const progress = Math.min(100, Math.max(0, percentage ?? 0))
  let tone = 'text-text-tertiary'
  if (percentage !== null) {
    tone = 'text-text-accent'
    if (percentage >= 85) tone = 'text-status-error'
    else if (percentage >= 70) tone = 'text-status-warning'
  }
  let label = '—'
  if (pendingRecalculation) label = t('composer.contextUsage.pending')
  else if (percentage !== null) {
    label = `${usage.source === 'estimated' ? '≈' : ''}${Math.round(percentage)}%`
  }

  const detail = pendingRecalculation
    ? (
        <div className="w-[250px] whitespace-normal p-1.5 text-left">
          <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
            <Sparkles size={14} className="text-text-accent-purple" aria-hidden="true" />
            {t('composer.contextUsage.pending')}
          </div>
          <p className="mt-1.5 text-[10px] leading-4 text-text-tertiary">
            {t('composer.contextUsage.pendingDetail')}
          </p>
        </div>
      )
    : <ContextUsagePanel usage={usage} />

  return (
    <Tooltip content={detail}>
      <span
        className={cn(
          'inline-flex h-7 select-none items-center gap-1 rounded-md px-1.5 text-xs font-medium',
          'bg-bg-hover',
          tone,
        )}
        aria-label={`${t('composer.contextUsage.label')}: ${label}`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2" />
          {percentage !== null && (
            <circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={CIRCLE_LENGTH}
              strokeDashoffset={CIRCLE_LENGTH * (1 - progress / 100)}
              transform="rotate(-90 8 8)"
            />
          )}
        </svg>
        <span>{label}</span>
      </span>
    </Tooltip>
  )
}
