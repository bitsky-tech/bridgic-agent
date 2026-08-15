import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { BridgicLogo } from '@/components/amphi/Primitives'

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

  return (
    <button
      type="button"
      aria-controls={modeAvailable ? 'session-surface-mode' : undefined}
      aria-expanded={modeAvailable ? active : undefined}
      aria-label={modeAvailable ? modeAriaLabel : t('session.resourcePanel.agent')}
      className={cn(
        'relative flex h-[53px] w-full flex-col items-center justify-center gap-1 rounded-[10px]',
        'border border-transparent text-brand-purple transition-colors hover:bg-bg-hover',
        'disabled:cursor-default disabled:hover:bg-transparent',
        active && 'bg-bg-active',
      )}
      data-testid="session-agent-launcher"
      disabled={!modeAvailable}
      onClick={modeAvailable ? onOpenMode : undefined}
    >
      {active || modeAvailable ? (
        <span
          aria-hidden="true"
          className="absolute -right-[3px] top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-text-secondary/65"
          data-state={active ? 'active' : 'background-open'}
          data-testid="session-agent-status-indicator"
        />
      ) : null}
      <BridgicLogo size={18} />
      <span className="max-w-[46px] truncate text-[10px] font-medium leading-none">
        {t('session.resourcePanel.agent')}
      </span>
    </button>
  )
}
