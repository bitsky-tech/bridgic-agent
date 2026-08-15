/**
 * The "session hierarchy" left column of the run detail drawer — lists this run's main Agent + each sub-Agent,
 * and clicking one switches what the right column shows (controlled: `selectedSessionId` + `onSelect`).
 *
 * Pure presentation: the sub-Agent data is aggregated from the transcript by the parent (`collectRunSubagents`) and passed in;
 * each sub-Agent's `invocationId` is its session id, and `onSelect` simply raises that id for the right column to load.
 */
import { AlertCircle, Bot, CheckCircle2, Clock3, LoaderCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { RunChild } from '@/lib/amphiClient'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/components/amphi'
import { SubagentLifecycle } from '@/atoms/subagents'

/** Status icon (§1.24 branches returning different JSX → a child component with early returns). */
function KindIcon({ lifecycle }: { lifecycle: SubagentLifecycle }) {
  let icon = <AlertCircle size={13} className="text-text-tertiary" />
  if (lifecycle.indicator === 'spinner') {
    icon = <LoaderCircle size={13} className="animate-spin text-text-tertiary" />
  } else if (lifecycle.indicator === 'queued') {
    icon = <Clock3 size={13} className="text-text-tertiary" />
  } else if (lifecycle.indicator === 'attention') {
    icon = <AlertCircle size={13} className="text-status-warning" />
  } else if (lifecycle.indicator === 'completed') {
    icon = <CheckCircle2 size={13} className="text-status-success" />
  } else if (lifecycle.indicator === 'failed') {
    icon = <AlertCircle size={13} className="text-status-error" />
  }
  return <span aria-label={lifecycle.label}>{icon}</span>
}

/** One selectable item (shared by the main / sub Agents): §LS1 always-present transparent border, flipping to the brand color when selected, with zero displacement. */
function NavButton({ icon, label, selected, onClick }: {
  icon: ReactNode
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left hover:bg-bg-hover',
        selected && 'border-brand-blue bg-accent-blue-subtle',
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <Tooltip content={label} onlyWhenTruncated>
        <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">{label}</span>
      </Tooltip>
    </button>
  )
}

export interface RunAgentLayerNavProps {
  /** Sub-Agents aggregated from this run (the result of `collectRunSubagents`). */
  subagents: RunChild[]
  /** Session id of the main Agent (this run). */
  mainSessionId: string
  /** The session id currently shown in the right column (the main one, or some sub-Agent's `invocationId`). */
  selectedSessionId: string
  /** Switch what the right column shows. */
  onSelect: (sessionId: string) => void
}

/** Left-column session hierarchy: the main Agent item + the sub-Agent list, switching the right column's subject in a controlled way. */
export function RunAgentLayerNav({ subagents, mainSessionId, selectedSessionId, onSelect }: RunAgentLayerNavProps) {
  const { t } = useTranslation()
  return (
    <aside className="w-52 flex-shrink-0 overflow-y-auto border-r border-border-subtle px-2.5 py-3">
      <div className="mb-1.5 px-2 text-[11px] font-medium text-text-tertiary">{t('schedule.nav.title')}</div>
      <NavButton
        icon={<Bot size={14} className="text-brand-blue" />}
        label={t('schedule.nav.mainAgent')}
        selected={selectedSessionId === mainSessionId}
        onClick={() => onSelect(mainSessionId)}
      />
      {subagents.length > 0 && (
        <>
          <div className="mb-1 mt-3 px-2 text-[11px] text-text-tertiary">
            {t('schedule.nav.subAgents', { n: subagents.length })}
          </div>
          <div className="space-y-0.5">
            {subagents.map((child) => (
              <NavButton
                key={child.sessionId}
                icon={<KindIcon lifecycle={SubagentLifecycle.from(child.status)} />}
                label={child.title || t('schedule.nav.subAgentFallback')}
                selected={selectedSessionId === child.sessionId}
                onClick={() => onSelect(child.sessionId)}
              />
            ))}
          </div>
        </>
      )}
    </aside>
  )
}
