import { Bot, ChevronDown } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentMessageSubagent } from '@/atoms/agent'
import { ModalKind, openModalAtom } from '@/atoms/amphi'
import { SubagentLifecycle, subagentsAtom } from '@/atoms/subagents'
import { cn } from '@/lib/cn'
import { AgentStatusIndicator } from './AgentStatusIndicator'
import { Collapse } from './Collapse'

export interface SubagentGroupProps {
  subagents: AgentMessageSubagent[]
}

export function SubagentGroup({ subagents }: SubagentGroupProps) {
  const { t } = useTranslation()
  const live = useAtomValue(subagentsAtom)
  const openModal = useSetAtom(openModalAtom)
  // Keep sequential CLI children expanded by default until the user collapses them.
  const [open, setOpen] = useState(true)
  const children = subagents.map((child) => {
    const merged = { ...child, ...live.get(child.invocationId) }
    return { ...merged, lifecycle: SubagentLifecycle.from(merged.status) }
  })
  const counts = children.reduce<Record<string, number>>((result, child) => {
    const kind = child.lifecycle.kind
    result[kind] = (result[kind] ?? 0) + 1
    return result
  }, {})
  const summaries = ([
    ['running', 'status.subagent.runningShort'],
    ['queued', 'status.subagent.queuedShort'],
    ['awaiting_subagents', 'status.subagent.awaitingSubagentsShort'],
    ['awaiting_human', 'status.subagent.awaitingHumanShort'],
    ['awaiting_permission', 'status.subagent.awaitingPermissionShort'],
    ['completed', 'status.subagent.completedShort'],
    ['stopped', 'status.subagent.stoppedShort'],
    ['failed', 'status.subagent.failedShort'],
  ] as const).flatMap(([kind, labelKey]) => {
    const count = counts[kind]
    return count ? [t('subagent.group.count', { label: t(labelKey), n: count })] : []
  })

  return (
    <div className="ml-5 border-l border-border-subtle pl-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 py-1.5 text-left text-[11px] text-text-tertiary hover:text-text-secondary"
      >
        <Bot size={13} className="shrink-0 text-brand-blue" />
        <span className="font-medium text-text-secondary">{t('subagent.group.summary', { n: children.length })}</span>
        <span className="min-w-0 flex-1 truncate">{summaries.join(' · ')}</span>
        <ChevronDown size={12} className={cn('shrink-0 transition-transform', !open && '-rotate-90')} />
      </button>
      <Collapse open={open}>
        <div className="max-h-56 space-y-0.5 overflow-y-auto pb-1 pr-1">
          {children.map((child) => {
            const { lifecycle } = child
            return (
              <button
                key={child.invocationId}
                type="button"
                onClick={() => openModal({
                  type: ModalKind.Subagent,
                  invocationId: child.invocationId,
                  goal: child.goal,
                  status: child.status,
                })}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-bg-hover',
                  lifecycle.needsUserAction && 'bg-status-warning/5',
                )}
              >
                <span className="flex size-5 shrink-0 items-center justify-center">
                  {lifecycle.indicator !== 'none' && (
                    <AgentStatusIndicator
                      indicator={lifecycle.indicator}
                      label={lifecycle.label}
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                  {child.goal || t('subagent.group.untitled')}
                </span>
                <span className="shrink-0 text-[11px] text-text-tertiary">
                  {lifecycle.shortLabel}
                </span>
              </button>
            )
          })}
        </div>
      </Collapse>
    </div>
  )
}
