import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
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

  let detail = t('composer.contextUsage.unavailable')
  if (pendingRecalculation) {
    detail = t('composer.contextUsage.pendingDetail')
  } else if (usage.usableTokens !== null) {
    const remaining = Math.max(0, usage.usableTokens - usage.usedTokens)
    detail = [
      t('composer.contextUsage.used', {
        used: formatContextTokens(usage.usedTokens),
        capacity: formatContextTokens(usage.usableTokens),
      }),
      t('composer.contextUsage.remaining', { remaining: formatContextTokens(remaining) }),
      usage.source === 'estimated'
        ? t('composer.contextUsage.estimatedDetail')
        : t('composer.contextUsage.providerDetail'),
    ].join('\n')
  } else {
    detail = [
      t('composer.contextUsage.unknownCapacity', {
        used: formatContextTokens(usage.usedTokens),
      }),
      usage.source === 'estimated'
        ? t('composer.contextUsage.estimatedDetail')
        : t('composer.contextUsage.providerDetail'),
    ].join('\n')
  }

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
