import { AlertCircle, Clock3, Square } from 'lucide-react'
import type { SubagentLifecycleIndicator } from '@/atoms/subagents'
import { cn } from '@/lib/cn'
import { Icons } from './Icons'
import { Tooltip } from './Tooltip'

export type VisibleAgentStatusIndicator = Exclude<SubagentLifecycleIndicator, 'none'>

export interface AgentStatusIndicatorSpec {
  indicator: VisibleAgentStatusIndicator
  label: string
}

interface AgentStatusIndicatorProps extends AgentStatusIndicatorSpec {
  className?: string
}

/** Compact lifecycle marker shared by Session rows and Child cards. */
export function AgentStatusIndicator({
  indicator,
  label,
  className,
}: AgentStatusIndicatorProps) {
  return (
    <Tooltip content={label}>
      <span
        className={cn(
          'inline-flex h-[13px] w-[13px] shrink-0 items-center justify-center',
          indicator === 'attention' && 'text-status-info',
          indicator === 'completed' && 'text-status-success',
          indicator === 'failed' && 'text-status-error',
          (indicator === 'queued' || indicator === 'stopped') && 'text-text-tertiary',
          className,
        )}
        aria-label={label}
      >
        {indicator === 'spinner' && (
          <span className="agent-activity-wave">
            <span />
            <span />
            <span />
          </span>
        )}
        {indicator === 'queued' && <Clock3 size={12} />}
        {indicator === 'attention' && Icons.chat(13)}
        {indicator === 'completed' && Icons.check(13)}
        {indicator === 'stopped' && <Square size={10} />}
        {indicator === 'failed' && <AlertCircle size={12} />}
      </span>
    </Tooltip>
  )
}
