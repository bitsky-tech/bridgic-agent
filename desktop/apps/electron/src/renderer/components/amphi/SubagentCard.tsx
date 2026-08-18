import { AlertCircle, Bot, CheckCircle2, ChevronRight, Clock3, LoaderCircle } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import type { MessageBlock } from '@/atoms/agent'
import { ModalKind, openModalAtom } from '@/atoms/amphi'
import { SubagentLifecycle, subagentsAtom } from '@/atoms/subagents'
import { cn } from '@/lib/cn'
import { AgentStatusIndicator } from './AgentStatusIndicator'

export interface SubagentCardProps {
  block: Extract<MessageBlock, { type: 'subagent' }>
}

export function SubagentCard({ block }: SubagentCardProps) {
  const { t } = useTranslation()
  const state = useAtomValue(subagentsAtom).get(block.invocationId)
  const openModal = useSetAtom(openModalAtom)
  const status = state?.status ?? block.status
  const lifecycle = SubagentLifecycle.from(status)
  const goal = state?.goal || block.goal || t('subagent.group.untitled')

  return (
    <button
      type="button"
      onClick={() => openModal({
        type: ModalKind.Subagent,
        invocationId: block.invocationId,
        goal,
        status,
      })}
      className="group relative flex w-full items-center gap-3 rounded-md border border-border-default bg-bg-surface px-3 py-2.5 text-left transition-colors hover:border-brand-blue hover:bg-bg-hover"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-blue-subtle text-text-accent">
        <Bot size={17} strokeWidth={1.7} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-xs font-semibold text-text-primary">{t('subagent.cardTitle')}</span>
          <span className={cn(
            'inline-flex items-center gap-1 text-xs',
            lifecycle.tone === 'attention' && 'text-status-warning',
            lifecycle.tone === 'error' && 'text-status-error',
            lifecycle.tone === 'success' && 'text-status-success',
            lifecycle.tone !== 'attention' && lifecycle.tone !== 'error' &&
              lifecycle.tone !== 'success' && 'text-text-tertiary',
          )}>
            {lifecycle.indicator === 'spinner' && <LoaderCircle size={11} className="animate-spin" />}
            {lifecycle.indicator === 'queued' && <Clock3 size={11} />}
            {lifecycle.indicator === 'attention' && <AlertCircle size={11} />}
            {lifecycle.indicator === 'completed' && <CheckCircle2 size={11} />}
            {(lifecycle.indicator === 'failed' || lifecycle.indicator === 'stopped') &&
              <AlertCircle size={11} />}
            {lifecycle.label}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-text-secondary">{goal}</span>
      </span>
      {lifecycle.needsUserAction && (
        <AgentStatusIndicator indicator="attention" label={lifecycle.label} />
      )}
      <ChevronRight size={15} className="shrink-0 text-text-tertiary transition-transform group-hover:translate-x-0.5" />
    </button>
  )
}
