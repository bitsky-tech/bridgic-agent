import { useEffect, useMemo, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { ComposerTarget, ModalKind, openModalAtom } from '@/atoms/amphi'
import { activeSessionIdAtom, sessionCompletionSeqByIdAtom } from '@/atoms/sessions'
import { useWorkflowResultAtom } from '@/atoms/workflow-session'
import {
  activeSessionWorkflowRunsAtom,
  hydrateAllWorkflowRunsAtom,
  hydrateSessionWorkflowRunsStrictAtom,
  workflowRunsAtom,
} from '@/atoms/workflows'
import { Icons } from '@/components/amphi/Icons'
import type { WorkflowRunSummary } from '@/lib/amphiClient'
import { cn } from '@/lib/cn'
import {
  formatWorkflowRunShortTimestamp,
  workflowRunCommandInput,
} from '@/lib/workflowRun'
import {
  WorkbenchScopeButtons,
  WorkbenchSearchField,
  WorkbenchToolHeader,
  WorkbenchToolScrollArea,
  WorkbenchToolSurface,
} from './WorkbenchToolPrimitives'

type ResultScope = 'session' | 'all'
type ResultStatus = 'all' | 'completed' | 'failed'

/** Independent Run Records tool: it owns its own scope, filters and hydration lifecycle. */
export function WorkflowResultsPanel({ active = true }: { active?: boolean }) {
  const sessionId = useAtomValue(activeSessionIdAtom)
  return (
    <WorkflowResultsPanelForSession
      key={sessionId ?? 'no-session'}
      active={active}
      sessionId={sessionId}
    />
  )
}

function WorkflowResultsPanelForSession({
  active,
  sessionId,
}: {
  active: boolean
  sessionId: string | null
}) {
  const { t } = useTranslation()
  const completionSeqById = useAtomValue(sessionCompletionSeqByIdAtom)
  const allRuns = useAtomValue(workflowRunsAtom)
  const sessionRuns = useAtomValue(activeSessionWorkflowRunsAtom)
  const hydrateAllRuns = useSetAtom(hydrateAllWorkflowRunsAtom)
  const hydrateSessionRuns = useSetAtom(hydrateSessionWorkflowRunsStrictAtom)
  const openModal = useSetAtom(openModalAtom)
  const referenceResult = useSetAtom(useWorkflowResultAtom)
  const [scope, setScope] = useState<ResultScope>('session')
  const [status, setStatus] = useState<ResultStatus>('all')
  const [query, setQuery] = useState('')
  const completionSeq = sessionId ? completionSeqById[sessionId] ?? 0 : 0
  const hydrationKey = `${sessionId ?? 'global'}:${completionSeq}`
  const [hydratedKey, setHydratedKey] = useState<string | null>(null)
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const loading = hydratedKey !== hydrationKey

  useEffect(() => {
    if (!active || hydratedKey === hydrationKey) return
    let current = true
    const requests: Array<Promise<unknown>> = [hydrateAllRuns()]
    if (sessionId) requests.push(hydrateSessionRuns(sessionId))
    void Promise.all(requests)
      .then(() => {
        if (current) setHydratedKey(hydrationKey)
      })
      .catch(() => {
        if (current) setFailedKey(hydrationKey)
      })
    return () => {
      current = false
    }
  }, [active, hydrateAllRuns, hydratedKey, hydrateSessionRuns, hydrationKey, sessionId])

  const sourceRuns = scope === 'session' ? sessionRuns : allRuns
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleRuns = useMemo(() => [...sourceRuns]
    .filter((run) => status === 'all' || effectiveResultStatus(run) === status)
    .filter((run) => !normalizedQuery || [
      run.workflow_name,
      run.workflow_input.text,
      run.id,
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
    .toSorted((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)), [
    normalizedQuery,
    sourceRuns,
    status,
  ])

  const openRun = (run: WorkflowRunSummary) => {
    openModal({
      type: ModalKind.WorkflowRunDetail,
      runId: run.id,
      composerTarget: ComposerTarget.CurrentSession,
    })
  }
  const referenceRun = (run: WorkflowRunSummary) => {
    referenceResult({
      result: {
        id: run.id,
        workflowName: run.workflow_name,
        createdAt: run.created_at,
      },
      composerTarget: ComposerTarget.CurrentSession,
    })
  }

  const queryNoMatch = Boolean(query.trim())
  const filteredEmpty = !queryNoMatch && status !== 'all'
  let emptyText = queryNoMatch
    ? t('session.workbench.results.noMatch', { query: query.trim() })
    : t('session.workbench.results.empty')
  if (filteredEmpty) emptyText = t('session.workbench.results.filterNoMatch')

  let content = (
    <div className="flex flex-col gap-2" data-testid="workflow-results-list">
      {visibleRuns.map((run) => (
        <WorkflowResultRow
          key={run.id}
          run={run}
          onOpen={() => openRun(run)}
          onReference={effectiveResultStatus(run) === 'completed'
            ? () => referenceRun(run)
            : undefined}
        />
      ))}
    </div>
  )
  if (failedKey === hydrationKey && sourceRuns.length === 0) {
    content = <PanelState kind="error" text={t('session.workbench.results.loadFailed')} />
  } else if (loading && sourceRuns.length === 0) {
    content = <PanelState kind="loading" text={t('asset.common.loading')} />
  } else if (visibleRuns.length === 0) {
    content = <PanelState kind={queryNoMatch || filteredEmpty ? 'no-match' : 'empty'} text={emptyText} />
  }

  return (
    <WorkbenchToolSurface
      className="bg-bg-surface"
      testId="workflow-results-tool"
    >
      <WorkbenchToolHeader
        icon={Icons.workflowResult(17)}
        iconClassName="bg-entity-workflow-run-bg text-entity-workflow-run"
        testId="workbench-results-header"
        title={t('session.workbench.results.title')}
      />
      <div className="shrink-0 px-3 pt-3">
        <WorkbenchSearchField
          clearLabel={t('rightPanel.clearSearchAria')}
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder={t('session.workbench.results.searchPlaceholder')}
        />
      </div>
      <div className="shrink-0 px-3 pt-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <WorkbenchScopeButtons
            ariaLabel={t('session.workbench.results.scopeAria')}
            value={scope}
            onChange={setScope}
            options={[
              {
                value: 'session',
                label: t('session.workbench.results.scopeSession'),
                count: sessionRuns.length,
              },
              {
                value: 'all',
                label: t('session.workbench.results.scopeAll'),
                count: allRuns.length,
              },
            ]}
          />
          <label className="ml-auto min-w-0">
            <span className="sr-only">{t('session.workbench.results.statusAria')}</span>
            <select
              aria-label={t('session.workbench.results.statusAria')}
              className="h-7 max-w-full rounded-md border border-border-subtle bg-bg-input px-2 text-xs text-text-secondary outline-none focus:border-brand-blue"
              data-testid="workflow-results-status"
              onChange={(event) => setStatus(event.target.value as ResultStatus)}
              value={status}
            >
              <option value="all">{t('session.workbench.results.statusAll')}</option>
              <option value="completed">{t('session.workbench.results.statusCompleted')}</option>
              <option value="failed">{t('session.workbench.results.statusFailed')}</option>
            </select>
          </label>
        </div>
      </div>
      <WorkbenchToolScrollArea>{content}</WorkbenchToolScrollArea>
    </WorkbenchToolSurface>
  )
}

function PanelState({
  kind,
  text,
}: {
  kind: 'empty' | 'error' | 'loading' | 'no-match'
  text: string
}) {
  return (
    <div
      className="flex min-h-40 items-center justify-center px-4 text-center text-xs leading-5 text-text-tertiary"
      data-kind={kind}
      data-testid="workflow-results-state"
      role="status"
    >
      {text}
    </div>
  )
}

function WorkflowResultRow({
  onOpen,
  onReference,
  run,
}: {
  onOpen: () => void
  onReference?: () => void
  run: WorkflowRunSummary
}) {
  const { t } = useTranslation()
  const effectiveStatus = effectiveResultStatus(run)
  const completed = effectiveStatus === 'completed'
  const failed = effectiveStatus === 'failed'
  let statusKey = `workflow.runDetail.status.${run.status}`
  if (completed) statusKey = 'session.workbench.results.statusCompleted'
  else if (failed) statusKey = 'session.workbench.results.statusFailed'
  const input = workflowRunCommandInput(run)
  let statusIcon = Icons.workflowResult(16)
  if (completed) statusIcon = Icons.check(15)
  else if (failed) statusIcon = Icons.x(14)

  return (
    <article
      className="min-w-0 rounded-lg border border-border-subtle bg-bg-elevated p-3"
      data-testid={`workflow-result-${run.id}`}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          aria-hidden="true"
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
            completed && 'bg-status-success-bg text-status-success',
            failed && 'bg-status-error-bg text-status-error',
            !completed && !failed && 'bg-entity-workflow-run-bg text-entity-workflow-run',
          )}
        >
          {statusIcon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-[13px] font-semibold leading-5 text-text-primary">
            {run.workflow_name}
          </h3>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-text-tertiary">
            <span
              className={cn(
                'font-medium',
                completed && 'text-status-success',
                failed && 'text-status-error',
              )}
            >
              {t(statusKey)}
            </span>
            <span aria-hidden="true">·</span>
            <time dateTime={run.finished_at ?? run.created_at}>
              {formatWorkflowRunShortTimestamp(run.finished_at ?? run.created_at)}
            </time>
          </div>
        </div>
      </div>
      {input ? (
        <p className="mt-2 line-clamp-2 break-words text-xs leading-5 text-text-secondary">
          {input}
        </p>
      ) : null}
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 border-t border-border-subtle pt-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-text-tertiary" title={run.id}>
          {run.id}
        </span>
        {onReference ? (
          <button
            aria-label={t('session.workbench.results.referenceAria', { name: run.workflow_name })}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-semibold text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            data-testid={`workflow-result-reference-${run.id}`}
            onClick={onReference}
            type="button"
          >
            {Icons.at(12)}
            <span>{t('session.workbench.results.reference')}</span>
          </button>
        ) : null}
        <button
          aria-label={t('session.workbench.results.viewAria', { name: run.workflow_name })}
          className="inline-flex h-7 shrink-0 items-center justify-center rounded-md px-2 text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          data-testid={`workflow-result-view-${run.id}`}
          onClick={onOpen}
          type="button"
        >
          {Icons.eye(14)}
        </button>
      </div>
    </article>
  )
}

function effectiveResultStatus(run: WorkflowRunSummary): 'completed' | 'failed' | 'other' {
  if (run.status === 'failed' || run.validation_status === 'failed') return 'failed'
  if (run.status === 'completed') return 'completed'
  return 'other'
}
