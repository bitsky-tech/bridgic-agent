import { useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import type { MessageBlock } from '@shared/types'
import { ComposerTarget, ModalKind, openModalAtom } from '@/atoms/amphi'
import { useWorkflowResultAtom } from '@/atoms/workflow-session'
import { cn } from '@/lib/cn'
import { formatWorkflowRunShortTimestamp } from '@/lib/workflowRun'
import { Icons } from './Icons'

type WorkflowResultBlock = Extract<MessageBlock, { type: 'workflow_result' }>

/** Durable terminal Workflow result shown outside the execution timeline. */
export function WorkflowResultCard({ block }: { block: WorkflowResultBlock }) {
  const { t } = useTranslation()
  const openModal = useSetAtom(openModalAtom)
  const insertWorkflowResult = useSetAtom(useWorkflowResultAtom)
  const completed = block.status === 'completed'
  const hasReusableResult = block.status === 'failed' || block.resultFileCount !== 0
  const title = completed
    ? t('workflow.result.title.completed')
    : t('workflow.result.title.failed')
  let description = t('workflow.result.description.failed')
  if (completed) {
    description = block.validationStatus === 'passed'
      ? t('workflow.result.description.completedVerified')
      : t('workflow.result.description.completed')
  }

  return (
    <section
      role="status"
      aria-label={title}
      className={cn(
        'max-w-3xl rounded-lg border px-3.5 py-3',
        completed
          ? 'border-status-success bg-status-success-bg'
          : 'border-status-error bg-status-error-bg',
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border bg-bg-elevated',
            completed
              ? 'border-status-success text-status-success'
              : 'border-status-error text-status-error',
          )}
        >
          {completed ? Icons.check(17) : Icons.x(15)}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          <p className="mt-0.5 text-sm leading-5 text-text-secondary">{description}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-tertiary">
              <span className="font-medium text-text-secondary">{block.workflowName}</span>
              <span aria-hidden="true">·</span>
              <span>{formatWorkflowRunShortTimestamp(block.createdAt)}</span>
              {typeof block.resultFileCount === 'number' && block.resultFileCount > 0 ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{t('workflow.result.resultFiles', { count: block.resultFileCount })}</span>
                </>
              ) : null}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() => openModal({
                  type: ModalKind.WorkflowRunDetail,
                  runId: block.runId,
                  composerTarget: ComposerTarget.CurrentSession,
                })}
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              >
                {Icons.eye(13)}{' '}
                {completed ? t('workflow.result.viewResult') : t('workflow.result.viewFailure')}
              </button>
              {hasReusableResult ? (
                <button
                  type="button"
                  onClick={() => insertWorkflowResult({
                    result: {
                      id: block.runId,
                      workflowName: block.workflowName,
                      createdAt: block.createdAt,
                    },
                    composerTarget: ComposerTarget.CurrentSession,
                  })}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                >
                  {Icons.at(12)} {t('workflow.result.citeResult')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
