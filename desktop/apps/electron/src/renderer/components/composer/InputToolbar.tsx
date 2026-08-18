/**
 * Composer top toolbar: active-model pill and the input-source menu.
 *
 * Sits ABOVE the rounded input box (per design §center.jsx :: InputBar).
 * Send / Stop buttons live INSIDE the input box, owned by FreeFormInput —
 * this file is intentionally JUST the toolbar row.
 *
 * File actions mount LOCAL PATHS onto the current session (per-session mounts,
 * agent operates in place) — same destination as the composer's paste / drop
 * pipeline (all three entry points converge on session mounts). It opens a
 * menu with local files, local folders, and global Workflow results. Native
 * file selection stays split because Win/Linux can't mix
 * openFile+openDirectory in one native dialog; the actual dialog + draft
 * materialization + POST live in pickAndMountAtom.
 */
import { ArrowLeft, FileOutput } from 'lucide-react'
import { useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { Icons } from '../amphi/Icons'
import { ModelPickerMenu } from './ModelPickerMenu'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { pickAndMountAtom, requestMentionInsertAtom } from '@/atoms/mounts'
import { hydrateWorkflowRunsAtom, workflowRunsAtom } from '@/atoms/workflows'
import {
  formatWorkflowRunTimestamp,
  workflowRunCommandInput,
  workflowRunMentionLabel,
} from '@/lib/workflowRun'
import { MentionGroup } from './segments'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface InputToolbarProps {
  // intentionally empty — session scope + mount actions come from atoms.
}

export function InputToolbar(_props: InputToolbarProps) {
  const { t } = useTranslation()
  const sessionId = useAtomValue(activeSessionIdAtom)
  const workflowRuns = useAtomValue(workflowRunsAtom)
  const pickAndMount = useSetAtom(pickAndMountAtom)
  const hydrateWorkflowRuns = useSetAtom(hydrateWorkflowRunsAtom)
  const requestMention = useSetAtom(requestMentionInsertAtom)
  const [menuView, setMenuView] = useState<'root' | 'results' | null>(null)

  const pick = (kind: 'file' | 'folder') => {
    setMenuView(null)
    if (!sessionId) return
    void pickAndMount({ sessionId, kind })
  }

  const openResults = () => {
    setMenuView('results')
    void hydrateWorkflowRuns().catch(() => undefined)
  }

  const referenceResult = (run: (typeof workflowRuns)[number]) => {
    requestMention({
      id: run.id,
      label: workflowRunMentionLabel(run),
      group: MentionGroup.WorkflowRun,
    })
    setMenuView(null)
  }

  return (
    <div className="flex items-center gap-1.5">
      <ModelPickerMenu />
      <div className="w-px h-4 bg-border-subtle" />
      <div className="relative">
        <button
          type="button"
          onClick={() => setMenuView((view) => view ? null : 'root')}
          disabled={!sessionId}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-text-tertiary text-xs hover:text-text-secondary hover:bg-bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
          aria-label={t('composer.toolbar.addAria')}
          aria-expanded={menuView !== null}
        >
          {Icons.plus(14)}
          <span>{t('composer.toolbar.add')}</span>
        </button>
        {menuView && (
          <>
            {/* A transparent overlay catches outside clicks to close — the same lightweight approach as the session-row menu */}
            <div className="fixed inset-0 z-10" onClick={() => setMenuView(null)} />
            <div className="absolute bottom-full left-0 z-20 mb-1 min-w-[148px] overflow-hidden rounded-md border border-border-default bg-bg-input py-1 shadow-md">
              {menuView === 'root' ? (
                <>
                  <button type="button" onClick={() => pick('file')} className="w-full px-2.5 py-1.5 text-left text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary">
                    {t('composer.toolbar.pickFile')}
                  </button>
                  <button type="button" onClick={() => pick('folder')} className="w-full px-2.5 py-1.5 text-left text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary">
                    {t('composer.toolbar.pickFolder')}
                  </button>
                  <div className="mx-2 my-1 h-px bg-border-subtle" />
                  <button type="button" onClick={openResults} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary">
                    <FileOutput size={13} className="text-entity-workflow-run" /> {t('composer.toolbar.workflowRuns')}
                  </button>
                </>
              ) : (
                <div className="w-[280px]">
                  <button type="button" onClick={() => setMenuView('root')} className="flex w-full items-center gap-1.5 border-b border-border-subtle px-2.5 py-2 text-xs font-semibold text-text-secondary hover:bg-bg-hover">
                    <ArrowLeft size={13} /> {t('composer.toolbar.pickRun')}
                  </button>
                  <div className="max-h-[260px] overflow-y-auto p-1">
                    {workflowRuns.slice(0, 12).map((run) => {
                      const input = workflowRunCommandInput(run)
                      return (
                        <button key={run.id} type="button" onClick={() => referenceResult(run)} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-bg-hover">
                          <FileOutput size={14} className="shrink-0 text-entity-workflow-run" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold text-text-primary">{run.workflow_name}</span>
                            <span className="mt-0.5 block truncate text-2xs text-text-tertiary">
                              {formatWorkflowRunTimestamp(run.created_at)}{input ? ` · ${input}` : ''}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                    {workflowRuns.length === 0 ? (
                      <div className="px-3 py-5 text-center text-xs text-text-tertiary">{t('composer.toolbar.noRuns')}</div>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
