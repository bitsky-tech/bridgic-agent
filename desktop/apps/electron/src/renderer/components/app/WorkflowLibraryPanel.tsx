import { useEffect, useMemo, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import {
  ComposerTarget,
  ModalKind,
  openModalAtom,
} from '@/atoms/amphi'
import { activeSessionIdAtom, sessionCompletionSeqByIdAtom } from '@/atoms/sessions'
import { runWorkflowAtom } from '@/atoms/workflow-session'
import {
  activeSessionWorkflowsAtom,
  hydrateSessionWorkflowsAtom,
  hydrateWorkflowDefinitionsAtom,
  workflowsAtom,
} from '@/atoms/workflows'
import { Icons } from '@/components/amphi/Icons'
import { Card, StatusDot } from '@/components/amphi/Primitives'
import { matchesFilter } from '@/components/composer/matchesFilter'
import type { WorkflowSummary } from '@/lib/amphiClient'
import {
  WorkbenchEmptyState,
  WorkbenchScopeButtons,
  WorkbenchSearchField,
  WorkbenchToolHeader,
  WorkbenchToolScrollArea,
  WorkbenchToolSurface,
} from './WorkbenchToolPrimitives'

const WorkflowScope = {
  Session: 'session',
  All: 'all',
} as const
type WorkflowScope = (typeof WorkflowScope)[keyof typeof WorkflowScope]

/** Saved-workflow workbench. Its scope, query, hydration, and actions are tool-local. */
export function WorkflowLibraryPanel({ active = true }: { active?: boolean }) {
  const { t } = useTranslation()
  const sessionId = useAtomValue(activeSessionIdAtom)
  const completionSeqById = useAtomValue(sessionCompletionSeqByIdAtom)
  const sessionWorkflows = useAtomValue(activeSessionWorkflowsAtom)
  const allWorkflows = useAtomValue(workflowsAtom)
  const hydrateSessionWorkflows = useSetAtom(hydrateSessionWorkflowsAtom)
  const hydrateWorkflowDefinitions = useSetAtom(hydrateWorkflowDefinitionsAtom)
  const openModal = useSetAtom(openModalAtom)
  const runWorkflow = useSetAtom(runWorkflowAtom)
  const [scope, setScope] = useState<WorkflowScope>(WorkflowScope.Session)
  const [query, setQuery] = useState('')
  const [stateSessionId, setStateSessionId] = useState(sessionId)

  if (stateSessionId !== sessionId) {
    setStateSessionId(sessionId)
    setScope(WorkflowScope.Session)
    setQuery('')
  }

  const completionSeq = sessionId ? completionSeqById[sessionId] ?? 0 : 0
  useEffect(() => {
    if (!active) return
    if (scope === WorkflowScope.All) {
      void hydrateWorkflowDefinitions()
      return
    }
    if (sessionId) void hydrateSessionWorkflows(sessionId)
  }, [active, completionSeq, hydrateSessionWorkflows, hydrateWorkflowDefinitions, scope, sessionId])

  const source = scope === WorkflowScope.Session ? sessionWorkflows : allWorkflows
  const visibleWorkflows = useMemo(() => {
    const q = query.trim()
    if (!q) return source
    return source.filter((workflow) => matchesFilter(
      `${workflow.name} ${workflow.desc ?? ''}`,
      q,
    ))
  }, [query, source])

  const previewWorkflow = (workflow: WorkflowSummary) => {
    openModal({
      type: ModalKind.WorkflowDetail,
      workflowId: workflow.id,
      workflowName: workflow.name,
      composerTarget: ComposerTarget.CurrentSession,
    })
  }

  return (
    <WorkbenchToolSurface testId="workflow-library-panel">
      <WorkbenchToolHeader
        icon={Icons.workflow(15)}
        iconClassName="bg-entity-workflow-bg text-entity-workflow"
        testId="workflow-library-header"
        title={t('session.workbench.workflows.title', {
          defaultValue: t('rightPanel.filters.workflows'),
        })}
      />
      <div className="flex shrink-0 flex-col gap-2 px-3 pt-3">
        <WorkbenchSearchField
          clearLabel={t('rightPanel.clearSearchAria')}
          onQueryChange={setQuery}
          query={query}
          searchPlaceholder={t('session.workbench.workflows.searchPlaceholder', {
            defaultValue: t('center.workflows.searchPlaceholder'),
          })}
          testId="workflow-library-search"
        />
        <WorkbenchScopeButtons
          ariaLabel={t('session.workbench.workflows.scopeAria', {
            defaultValue: t('rightPanel.filters.workflows'),
          })}
          onChange={setScope}
          options={[
            {
              value: WorkflowScope.Session,
              label: t('session.workbench.workflows.scopeSession', {
                defaultValue: t('mention.scope.sessionFiles'),
              }),
            },
            {
              value: WorkflowScope.All,
              label: t('session.workbench.workflows.scopeAll', {
                defaultValue: t('rightPanel.filters.all'),
              }),
            },
          ]}
          value={scope}
        />
      </div>
      <WorkbenchToolScrollArea>
        {visibleWorkflows.length === 0 ? (
          <WorkbenchEmptyState
            icon={Icons.workflow(22)}
            title={query.trim()
              ? t('rightPanel.noMatch', { query: query.trim() })
              : t('session.workbench.workflows.empty', {
                defaultValue: t('rightPanel.groupEmpty'),
              })}
          />
        ) : (
          <div className="flex flex-col gap-2">
            {visibleWorkflows.map((workflow) => (
              <WorkflowLibraryCard
                key={workflow.id}
                onPreview={() => previewWorkflow(workflow)}
                onRun={() => runWorkflow({
                  workflow: { id: workflow.id, name: workflow.name },
                  composerTarget: ComposerTarget.CurrentSession,
                })}
                workflow={workflow}
              />
            ))}
          </div>
        )}
      </WorkbenchToolScrollArea>
    </WorkbenchToolSurface>
  )
}

function WorkflowLibraryCard({
  onPreview,
  onRun,
  workflow,
}: {
  onPreview: () => void
  onRun: () => void
  workflow: WorkflowSummary
}) {
  const { t } = useTranslation()
  return (
    <Card className="min-w-0 overflow-hidden border-l-2 border-l-entity-workflow">
      <div className="p-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-entity-workflow-bg text-entity-workflow">
            {Icons.workflow(15)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-text-primary">{workflow.name}</div>
            {workflow.desc ? (
              <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-text-tertiary">
                {workflow.desc}
              </p>
            ) : null}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="inline-flex min-w-0 items-center gap-1 text-xs text-status-success">
            <StatusDot size={6} status="success" />
            <span className="truncate">
              {t('session.workbench.workflows.built', {
                defaultValue: t('rightPanel.buildSucceeded'),
              })}
            </span>
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              aria-label={t('session.workbench.workflows.viewAria', {
                defaultValue: t('rightPanel.workflowDetail'),
                name: workflow.name,
              })}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border-subtle bg-bg-surface px-2 text-xs font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              data-testid={`workflow-library-view-${workflow.id}`}
              onClick={onPreview}
              type="button"
            >
              {Icons.eye(12)}
              {t('session.workbench.workflows.view', {
                defaultValue: t('rightPanel.workflowDetail'),
              })}
            </button>
            <button
              aria-label={t('session.workbench.workflows.runAria', {
                defaultValue: t('rightPanel.runWorkflowAria', { name: workflow.name }),
                name: workflow.name,
              })}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-entity-command px-2.5 text-xs font-semibold text-text-on-brand hover:opacity-90"
              data-testid={`workflow-library-run-${workflow.id}`}
              onClick={onRun}
              type="button"
            >
              {Icons.play(11)}
              {t('session.workbench.workflows.run', {
                defaultValue: t('rightPanel.run'),
              })}
            </button>
          </div>
        </div>
      </div>
    </Card>
  )
}
