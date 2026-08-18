import { useState } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import {
  currentPendingFrameworkInteractionAtom,
  type PendingFrameworkInteraction,
} from '@/atoms/agent'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { currentHumanRequestAtom } from '@/atoms/human-request'
import { BuildConfirmCard } from '@/components/amphi/BuildConfirmCard'
import { TaskConfirmCard } from '@/components/amphi/TaskConfirmCard'
import { WorkflowConfirmCard } from '@/components/amphi/WorkflowConfirmCard'
import { PermissionApproval } from '@/components/permissions'
import { Icons } from '@/components/amphi/Icons'
import { HumanRequestChoice } from './HumanRequestBanner'

interface InteractionPresentation {
  title: string
  summary: string
  icon: JSX.Element
}

function presentationFor(
  block: PendingFrameworkInteraction,
  t: (key: string, options?: Record<string, unknown>) => string,
): InteractionPresentation {
  if (block.type === 'permission') {
    return {
      title: t('humanRequest.framework.permissionTitle'),
      summary: t('humanRequest.framework.permissionSummary', { n: block.items.length }),
      icon: Icons.alert(15),
    }
  }
  if (block.type === 'build_confirm') {
    return {
      title: t('humanRequest.framework.buildTitle'),
      summary: t('humanRequest.framework.buildSummary'),
      icon: Icons.workflow(15),
    }
  }
  if (block.type === 'task_confirm') {
    return {
      title: t('humanRequest.framework.taskTitle'),
      summary: t('humanRequest.framework.taskSummary'),
      icon: Icons.file(15),
    }
  }
  return {
    title: t('humanRequest.framework.workflowTitle'),
    summary: t('humanRequest.framework.workflowSummary'),
    icon: Icons.workflowResult(15),
  }
}

function InteractionBody({
  block,
  sessionId,
}: {
  block: PendingFrameworkInteraction
  sessionId?: string
}) {
  if (block.type === 'permission') {
    return (
      <PermissionApproval
        items={block.items}
        questions={block.questions}
        requestId={block.requestId}
        sessionId={sessionId}
        floating
      />
    )
  }
  if (block.type === 'build_confirm') {
    return <BuildConfirmCard block={block} sessionId={sessionId} floating />
  }
  if (block.type === 'task_confirm') {
    return <TaskConfirmCard block={block} sessionId={sessionId} floating />
  }
  return <WorkflowConfirmCard block={block} floating />
}

/** One floating home for every framework-owned human interaction. */
export function FrameworkInteractionOverlay() {
  const { t } = useTranslation()
  const humanRequest = useAtomValue(currentHumanRequestAtom)
  const frameworkInteraction = useAtomValue(currentPendingFrameworkInteractionAtom)
  const sessionId = useAtomValue(activeSessionIdAtom) ?? undefined
  const [collapsedKey, setCollapsedKey] = useState<string | null>(null)

  if (humanRequest) {
    const requestKey =
      humanRequest.requestId ??
      `${humanRequest.sessionId}:${humanRequest.questions[0]?.question ?? ''}`
    return <HumanRequestChoice key={requestKey} request={humanRequest} floating />
  }
  if (!frameworkInteraction) return null

  const key = `${frameworkInteraction.type}:${frameworkInteraction.requestId ?? ''}`
  const collapsed = collapsedKey === key
  const presentation = presentationFor(frameworkInteraction, t)

  // Collapse HIDES the panel, it must never unmount it: the cards keep their edits in
  // component-local state (the workflow name being typed, permission selections), and
  // unmounting on collapse wiped all of it — reopening the panel silently reverted the
  // user's rename to the default. The body IS keyed by the request, so a *different*
  // pending interaction still gets a fresh card (stale name can't leak across requests).
  return (
    <>
      {collapsed && (
        <button
          type="button"
          onClick={() => setCollapsedKey(null)}
          className="flex h-10 w-full items-center gap-2 rounded-xl border border-border-default bg-bg-elevated px-3 shadow-lg animate-focus-enter"
          aria-label={t('humanRequest.expandAria')}
        >
          <span className="flex shrink-0 text-text-accent">{presentation.icon}</span>
          <span className="shrink-0 text-xs font-semibold text-text-primary">{presentation.title}</span>
          <span className="min-w-0 flex-1 truncate text-left text-xs text-text-secondary">
            {presentation.summary}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-text-accent">
            {t('humanRequest.expand')} {Icons.chevronDown(12)}
          </span>
        </button>
      )}
      <section
        className={cn(
          'max-h-[min(560px,calc(100dvh_-_190px))] overflow-y-auto rounded-xl border border-border-default bg-bg-elevated p-3 shadow-xl animate-focus-enter',
          collapsed && 'hidden',
        )}
      >
        <header className="mb-3 flex items-center gap-2 border-b border-border-subtle pb-2.5">
          <span className="flex text-text-accent">{presentation.icon}</span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-text-primary">{presentation.title}</div>
            <div className="mt-0.5 truncate text-xs text-text-secondary">{presentation.summary}</div>
          </div>
          <button
            type="button"
            onClick={() => setCollapsedKey(key)}
            className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          >
            {t('humanRequest.collapse')} <span className="rotate-180">{Icons.chevronDown(12)}</span>
          </button>
        </header>
        <InteractionBody key={key} block={frameworkInteraction} sessionId={sessionId} />
      </section>
    </>
  )
}
