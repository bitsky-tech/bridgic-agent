import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { BridgicLogo } from '@/components/amphi/Primitives'
import { SurfaceStatusIcon, type SurfaceStatus } from './SurfaceStatusIcon'

interface AgentDockEntryProps {
  active: boolean
  modeAvailable: boolean
  modeAriaLabel?: string
  onOpenMode: () => void
}

/** Permanent Bridgic entry: opens the current Agent mode surface when one is available. */
export function AgentDockEntry({
  active,
  modeAvailable,
  modeAriaLabel,
  onOpenMode,
}: AgentDockEntryProps) {
  const { t } = useTranslation()
  let iconState: SurfaceStatus | undefined
  if (active) iconState = 'active'
  else if (modeAvailable) iconState = 'background-open'
  let statusLabel = t('session.resourcePanel.agent')
  if (active) statusLabel = t('session.resourcePanel.agentViewing')
  else if (modeAvailable) statusLabel = t('session.resourcePanel.agentBackground')
  const accessibleLabel = modeAvailable && modeAriaLabel
    ? `${statusLabel} · ${modeAriaLabel}`
    : statusLabel

  return (
    <button
      type="button"
      aria-controls={modeAvailable ? 'session-surface-mode' : undefined}
      aria-expanded={modeAvailable ? active : undefined}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      className={cn(
        'relative flex h-[53px] w-full flex-col items-center justify-center gap-1 overflow-hidden rounded-[10px]',
        'border border-transparent text-text-accent-purple transition-colors hover:bg-bg-hover',
        'disabled:cursor-default disabled:hover:bg-transparent',
        active && 'hover:bg-transparent',
      )}
      data-testid="session-agent-launcher"
      disabled={!modeAvailable}
      onClick={modeAvailable ? onOpenMode : undefined}
    >
      <SurfaceStatusIcon
        selected={active}
        state={iconState}
        testId="session-agent-status-indicator"
      >
        <BridgicLogo size={18} />
      </SurfaceStatusIcon>
      <span className={cn(
        'max-w-[58px] truncate text-2xs leading-none tracking-tight',
        active ? 'font-semibold' : 'font-medium',
      )}>
        {t('session.resourcePanel.agent')}
      </span>
    </button>
  )
}
