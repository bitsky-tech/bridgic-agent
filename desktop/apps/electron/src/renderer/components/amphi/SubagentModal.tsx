import { AlertCircle, CheckCircle2, Clock3, LoaderCircle, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { AgentRole, type AgentMessage } from '@shared/types'
import {
  cancelTurnAtom,
  hydratedSessionIdsAtom,
  loadSessionMessagesAtom,
  messageFamily,
  streamingFamily,
} from '@/atoms/agent'
import { clearSessionHumanRequestAtom, pendingBySessionAtom } from '@/atoms/human-request'
import { SubagentLifecycle, subagentsAtom } from '@/atoms/subagents'
import { HumanRequestChoice } from '@/components/human-request/HumanRequestBanner'
import { PermissionApproval } from '@/components/permissions'
import { Pipeline } from './Pipeline'
import { Modal } from './Modal'

export interface SubagentModalProps {
  invocationId: string
  goal?: string
  status?: string
  onClose?: () => void
}

export function SubagentModal({ invocationId, goal, status, onClose }: SubagentModalProps) {
  const { t } = useTranslation()
  const state = useAtomValue(subagentsAtom).get(invocationId)
  const messages = useAtomValue(messageFamily(invocationId))
  const streaming = useAtomValue(streamingFamily(invocationId))
  const hydratedSessionIds = useAtomValue(hydratedSessionIdsAtom)
  const pendingRequest = useAtomValue(pendingBySessionAtom).get(invocationId)
  const loadMessages = useSetAtom(loadSessionMessagesAtom)
  const cancelTurn = useSetAtom(cancelTurnAtom)
  const clearHumanRequest = useSetAtom(clearSessionHumanRequestAtom)
  const [stopping, setStopping] = useState(false)
  const currentStatus = state?.status ?? status ?? 'running'
  const lifecycleStatus = pendingRequest &&
    currentStatus !== 'awaiting_human' &&
    currentStatus !== 'awaiting_permission'
    ? 'awaiting_human'
    : currentStatus
  const lifecycle = SubagentLifecycle.from(lifecycleStatus)
  const taskGoal = state?.goal.trim() || goal?.trim() || ''
  const taskMessage: AgentMessage | undefined = taskGoal &&
    !messages.some((message) => message.role === AgentRole.User)
    ? {
        id: `subagent-goal:${invocationId}`,
        role: AgentRole.User,
        text: taskGoal,
        toolCalls: [],
        done: true,
        createdAt: 0,
      }
    : undefined
  const displayMessages = taskMessage ? [taskMessage, ...messages] : messages
  const tailMessage = messages.at(-1)
  const interactionBlocks = streaming?.blocks ?? (
    tailMessage?.role === AgentRole.Assistant ? tailMessage.blocks ?? [] : []
  )
  const pendingPermissionBlock = interactionBlocks
    .findLast((block) => block.type === 'permission' && !block.decided)

  useEffect(() => {
    let cancelled = false
    if (lifecycle.isActive) {
      void import('@/lib/amphiWsConnection').then((module) => {
        if (!cancelled) module.getAmphiWsConnection().subscribe(invocationId)
      })
    }
    void loadMessages(invocationId)
    return () => {
      cancelled = true
    }
  }, [invocationId, lifecycle.isActive, loadMessages])

  const terminal = !lifecycle.isActive
  let statusTone = 'text-text-secondary'
  if (lifecycle.tone === 'attention') {
    statusTone = 'text-status-warning'
  } else if (lifecycle.tone === 'error') {
    statusTone = 'text-status-error'
  } else if (lifecycle.tone === 'muted') {
    statusTone = 'text-text-tertiary'
  }

  return (
    <Modal
      width={920}
      title={(
        <span className="flex items-center gap-2.5">
          <span>{t('subagent.modal.title')}</span>
          <span className={`inline-flex items-center gap-1.5 text-xs font-normal ${statusTone}`}>
            {lifecycle.indicator === 'spinner' && <LoaderCircle size={12} className="animate-spin" />}
            {lifecycle.indicator === 'queued' && <Clock3 size={12} />}
            {lifecycle.indicator === 'attention' && <AlertCircle size={12} />}
            {lifecycle.indicator === 'completed' &&
              <CheckCircle2 size={12} className="text-status-success" />}
            {lifecycle.indicator === 'stopped' && <Square size={11} />}
            {lifecycle.indicator === 'failed' && <AlertCircle size={12} />}
            {lifecycle.label}
          </span>
          {!terminal && (
            <button
              type="button"
              disabled={stopping}
              onClick={() => {
                setStopping(true)
                clearHumanRequest(invocationId)
                cancelTurn(invocationId)
              }}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-status-error/40 px-2.5 py-1.5 text-xs font-medium text-status-error hover:bg-status-error/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Square size={11} fill="currentColor" />
              {stopping ? t('subagent.modal.stopping') : t('subagent.modal.stop')}
            </button>
          )}
        </span>
      )}
      onClose={onClose}
      contentStyle={{ overflow: 'hidden' }}
    >
      <div className="flex h-[min(680px,72vh)] min-h-[440px] flex-col">
        <div className="min-h-0 flex-1">
          <Pipeline
            session={{
              id: invocationId,
              messages: displayMessages,
              streaming,
              pending: !hydratedSessionIds.has(invocationId),
              emptyText: t('subagent.modal.preparing'),
            }}
          />
        </div>

        {pendingRequest && (
          <div className="border-t border-border-subtle px-5 py-3">
            <HumanRequestChoice request={pendingRequest} />
          </div>
        )}
        {!stopping && !terminal && pendingPermissionBlock?.type === 'permission' && (
          <div className="border-t border-border-subtle px-5 py-3">
            <PermissionApproval
              key={`permission:${pendingPermissionBlock.requestId ?? ''}`}
              items={pendingPermissionBlock.items}
              questions={pendingPermissionBlock.questions}
              requestId={pendingPermissionBlock.requestId}
              sessionId={invocationId}
            />
          </div>
        )}
      </div>
    </Modal>
  )
}
