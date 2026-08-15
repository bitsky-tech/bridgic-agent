/**
 * Right panel — 340px-wide "session outputs" column: a filter-chip row (All / Workflows / Run
 * results / Session files, each with a count) over vertically stacked groups.
 * "All" hides empty groups; picking a chip shows that single group (empty
 * state included).
 *
 * The workflow group = building cards (BuildingCard) + completed cards (CompletedCard); a run result
 * is another kind of global asset, shown in its own group with blue result cards so it does not get
 * mixed up with the purple definition cards.
 *
 * Filter state lives in atoms/amphi.ts (rightPanelFilterAtom) — cross-
 * component so "auto-switch to session files after a successful mount" (atoms/mounts.ts) can drive it.
 *
 * The search box (query) is **panel-local** useState and deliberately not an atom: no second
 * component reads or writes it (the two-component rule of §1.12). It acts differently on the two
 * groups — workflow cards go through the renderer-side `matchesFilter` (name/input are already at
 * hand); session files go through the main process `fs.searchDir` (subdirectories are lazy-loaded, so
 * the renderer has no complete data set to filter).
 *
 * The query string is **stored bound to the sessionId it belongs to**: this panel is rendered by
 * `BuildProgressPanel` according to `showRightPanelAtom`, and that atom stays true while switching
 * sessions — the panel does **not** remount, so a bare `useState('')` would carry session A's query
 * into session B, and B would open already filtered (with the user having no idea why things are
 * missing). It is reset by comparing sessionId during render rather than by an extra setState in a
 * useEffect (that would cost one more render pass and trip react-hooks/set-state-in-effect).
 *
 * `useMountSearch` is hoisted to this level rather than living inside SessionAssetsPanel: the "session
 * files" count on the chip, the group's visibility, and the whole-panel empty state all need the hit
 * count, and leaving it in the child would force those three to use the unfiltered mount count,
 * producing the contradiction "the chip says 2, the panel says nothing found".
 *
 * Refactored to Tailwind className per §1.22.
 */

import { useMemo, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { matchesFilter } from '@/components/composer/matchesFilter'
import { Icons } from './Icons'
import { Tooltip } from './Tooltip'
import { Badge, Card, StatusDot } from './Primitives'
import {
  ComposerTarget,
  RightPanelFilter,
  rightPanelFilterAtom,
  selectRightPanelFilterAtom,
} from '@/atoms/amphi'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { runWorkflowAtom, useWorkflowResultAtom } from '@/atoms/workflow-session'
import { mountsFamily } from '@/atoms/mounts'
import { useMountSearch } from '@/hooks/useMountSearch'
import { SessionAssetsPanel } from './SessionAssets'
import type { WorkflowRunSummary } from '@/lib/amphiClient'

function formatWorkflowRunShortTimestamp(value: string, locale: string): string {
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export interface BuildingFields {
  task?: string
  explore?: string
  program?: string
}

export interface CompletedWorkflow {
  id: string
  name: string
}

export interface RightPanelProps {
  building?: { fields?: BuildingFields } | null
  completed?: CompletedWorkflow[]
  workflowRuns?: WorkflowRunSummary[]
  /** Hide the legacy panel heading when a parent resource shell supplies it. */
  showHeader?: boolean
  /** Optional height used to align this header with adjacent dock surfaces. */
  headerHeight?: number
  /** Clicking a card's eye icon → open that workflow's full detail modal (including its task brief). */
  onPreviewWorkflow?: (workflowId: string, workflowName: string) => void
  /** Clicking a run result → open its persisted result detail. */
  onPreviewWorkflowRun?: (runId: string) => void
}

/** Small gray group label, matching the session-files header style in session-assets. */
function GroupLabel({ children }: { children: string }) {
  return <div className="text-xs font-semibold text-text-secondary px-1 mb-2">{children}</div>
}

interface PanelEmptyProps {
  /** Non-empty = we are in search mode, so the empty-state text must say "nothing found" rather than "nothing yet". */
  query: string
}

/** Large empty state for when the whole panel is empty — during a search it must switch to "nothing
 *  found" and must not report "no outputs yet" (the outputs are still there, they just did not match;
 *  saying "nothing yet" would make the user think they were lost). */
function PanelEmpty({ query }: PanelEmptyProps) {
  const { t } = useTranslation()
  // The two empty states differ only in icon and text, the wrapper is identical — pick here instead of duplicating the layout twice.
  const icon = query ? Icons.search(24) : Icons.workflow(24)
  const body = query ? (
    t('rightPanel.noMatch', { query })
  ) : (
    <>
      {t('rightPanel.empty.title')}
      <br />
      <span className="text-xs">{t('rightPanel.empty.description')}</span>
    </>
  )
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      <div className="w-12 h-12 rounded-xl bg-bg-hover flex items-center justify-center text-text-tertiary">
        {icon}
      </div>
      <div className="text-sm text-text-tertiary text-center leading-[1.6]">{body}</div>
    </div>
  )
}

interface GroupEmptyProps {
  /** Non-empty = we are in search mode. */
  query?: string
}

/** Centered hint when a single-group filter has nothing to show. */
function GroupEmpty({ query }: GroupEmptyProps) {
  const { t } = useTranslation()
  // An empty state during a search must make clear it is "nothing found" and not "there never was anything", otherwise the user thinks the outputs are gone.
  return (
    <div className="px-2.5 py-4 text-xs text-text-tertiary text-center">
      {query ? t('rightPanel.noMatch', { query }) : t('rightPanel.groupEmpty')}
    </div>
  )
}

export function RightPanel({
  building = null,
  completed = [],
  workflowRuns = [],
  showHeader = true,
  headerHeight,
  onPreviewWorkflow,
  onPreviewWorkflowRun,
}: RightPanelProps) {
  const { t } = useTranslation()
  const filter = useAtomValue(rightPanelFilterAtom)
  const selectFilter = useSetAtom(selectRightPanelFilterAtom)
  const sessionId = useAtomValue(activeSessionIdAtom)
  const mounts = useAtomValue(mountsFamily(sessionId ?? ''))
  // Switching sessions clears the query (see the file header). This uses React's official "adjust state
  // during render" idiom rather than "remember the (sessionId, text) pair and compare during render" —
  // the latter only stores **one** pair, so going A → B → A (without typing in B) would resurrect A's
  // old query verbatim, while having typed in B would not; one sequence of actions, two outcomes, and
  // the user cannot predict either. Here, the moment sessionId changes, text really is zeroed. Certain.
  const [query, setQuery] = useState('')
  const [querySession, setQuerySession] = useState(sessionId)
  if (querySession !== sessionId) {
    setQuerySession(sessionId)
    setQuery('')
  }
  const q = query.trim()
  // Do not switch the search off based on the current filter: even when the filter sits on "workflows"
  // and the file group is not rendered, the hit count on the "session files" chip must still show — that
  // is the user's only clue that "there are 12 matches in the other tab". Switching it off would make
  // the chip display a fake 0, which is far worse than one extra (already debounced) IPC call.
  const search = useMountSearch(query, sessionId)

  const visibleCompleted = useMemo(
    () => completed.filter((c) => matchesFilter(c.name, q)),
    [completed, q],
  )
  const visibleWorkflowRuns = useMemo(
    () => workflowRuns.filter((run) => matchesFilter(
      `${run.workflow_name} ${run.workflow_input.text}`,
      q,
    )),
    [q, workflowRuns],
  )
  // While searching, a "building" card matches on the text of its fields — it has no name, but the task
  // description usually contains exactly the word the user is looking for; excluding it from matching
  // entirely would make it vanish during a search.
  const buildingMatches =
    building != null && (q === '' || Object.values(building.fields ?? {}).some((v) => matchesFilter(v ?? '', q)))

  // During a search every group's count must be the **filtered** one: the chip number, the group's
  // visibility and the whole-panel empty state all read the same value, and using the unfiltered raw
  // count anywhere would disagree with what the panel actually shows.
  //
  // The file count uses `search.total`, not `hits.length`: the latter is truncated to
  // SEARCH_MAX_RESULTS = 50, so with 300 hits the chip would say "50" while the footnote right below it
  // says "300 matches in total" — exactly the contradiction this comment is here to prevent.
  const workflowCount = (buildingMatches ? 1 : 0) + visibleCompleted.length
  const workflowRunCount = visibleWorkflowRuns.length
  const fileCount = q ? search.total : mounts.length

  const chips: { key: RightPanelFilter; label: string; count?: number }[] = [
    { key: RightPanelFilter.All, label: t('rightPanel.filters.all') },
    { key: RightPanelFilter.Workflow, label: t('rightPanel.filters.workflows'), count: workflowCount },
    { key: RightPanelFilter.WorkflowRun, label: t('rightPanel.filters.runs'), count: workflowRunCount },
    { key: RightPanelFilter.Files, label: t('rightPanel.filters.files'), count: fileCount },
  ]

  // "All" hides empty groups; when a single group is selected it is shown even when empty (to carry the empty-state text).
  const show = (key: RightPanelFilter, count: number) =>
    filter === key || (filter === RightPanelFilter.All && count > 0)
  // While a search is in flight the session-files group **must** stay visible: the "searching…"
  // indicator lives inside SessionAssetsSearch, and while in flight fileCount is 0 — deciding
  // visibility on the count alone would hide this group, while the large empty state is suppressed by
  // the `!isSearching` below, leaving the entire panel blank (once per keystroke).
  const showFiles = show(RightPanelFilter.Files, fileCount) || (Boolean(q) && search.isSearching)
  // A search in flight does not count as "empty" — otherwise every keystroke would flash the large "no outputs yet" empty state.
  const allEmpty =
    workflowCount === 0
    && workflowRunCount === 0
    && fileCount === 0
    && !search.isSearching

  return (
    <div className="flex flex-col h-full">
      {showHeader && (
        <div
          className={cn(
            'flex shrink-0 items-center border-b border-border-subtle px-4',
            headerHeight === undefined && 'py-3.5',
          )}
          style={headerHeight === undefined ? undefined : { height: headerHeight }}
          data-testid="session-resources-header"
        >
          <span className="text-sm font-semibold text-text-primary">{t('rightPanel.title')}</span>
        </div>
      )}

      <div className="px-3 pt-3">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-bg-input border border-border-subtle">
          <span className="text-text-tertiary flex-shrink-0">{Icons.search(13)}</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('rightPanel.searchPlaceholder')}
            className="bg-transparent outline-none text-xs text-text-primary placeholder:text-text-tertiary w-full min-w-0"
          />
          {q && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('rightPanel.clearSearchAria')}
              className="flex items-center text-text-tertiary flex-shrink-0 hover:text-text-primary"
            >
              {Icons.x(12)}
            </button>
          )}
        </div>
      </div>

      <div className="px-3 pt-2 flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => selectFilter(c.key)}
            // §LS1: the 1px border is always present, the selected state only swaps bg/text/border colours — zero layout shift.
            className={cn(
              'px-2.5 py-1 rounded-full text-xs font-medium border',
              filter === c.key
                ? 'bg-text-primary text-text-inverse border-transparent'
                : 'bg-bg-hover text-text-secondary border-border-subtle hover:text-text-primary',
            )}
          >
            {c.label}
            {c.count !== undefined && <span className="ml-1 opacity-60">{c.count}</span>}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-3">
        {filter === RightPanelFilter.All && allEmpty ? (
          <PanelEmpty query={q} />
        ) : (
          <div className="flex flex-col gap-4">
            {show(RightPanelFilter.Workflow, workflowCount) && (
              <section>
                <GroupLabel>{t('rightPanel.filters.workflows')}</GroupLabel>
                <div className="flex flex-col gap-2">
                  {building && buildingMatches && <BuildingCard fields={building.fields ?? {}} />}
                  {visibleCompleted.map((c) => (
                    <CompletedCard
                      key={c.id}
                      {...c}
                      onPreview={() => onPreviewWorkflow?.(c.id, c.name)}
                    />
                  ))}
                  {workflowCount === 0 && <GroupEmpty query={q} />}
                </div>
              </section>
            )}
            {show(RightPanelFilter.WorkflowRun, workflowRunCount) && (
              <section>
                <GroupLabel>{t('rightPanel.filters.runs')}</GroupLabel>
                <div className="flex flex-col gap-2">
                  {visibleWorkflowRuns.map((run) => (
                    <WorkflowRunResultCard
                      key={run.id}
                      run={run}
                      onPreview={() => onPreviewWorkflowRun?.(run.id)}
                    />
                  ))}
                  {workflowRunCount === 0 && <GroupEmpty query={q} />}
                </div>
              </section>
            )}
            {/* SessionAssetsPanel brings its own "session files + add" group header, so no GroupLabel is needed. */}
            {showFiles && <SessionAssetsPanel query={query} search={search} />}
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Building card ─── */

export function BuildingCard({ fields = {} }: { fields?: BuildingFields }) {
  const { t } = useTranslation()
  const buildingFields: { key: keyof BuildingFields; label: string; editable: boolean }[] = [
    { key: 'task', label: t('rightPanel.building.fields.task'), editable: true },
    { key: 'explore', label: t('rightPanel.building.fields.explore'), editable: false },
    { key: 'program', label: t('rightPanel.building.fields.program'), editable: false },
  ]
  return (
    <Card
      // §LS1: active state = border color only. No box-shadow halo
      // (user feedback: halos look uncomfortable, the brand-blue border
      // already signals "this is in progress").
      className="border-[1.5px] border-brand-blue"
    >
      <div className="px-3.5 py-3 flex items-center justify-between border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-brand-blue inline-block" />
          <span className="text-sm font-semibold text-text-primary">{t('rightPanel.building.title')}</span>
        </div>
        <Badge color="info">{t('rightPanel.building.inProgress')}</Badge>
      </div>
      <div className="px-3.5 py-2.5 flex flex-col gap-1.5">
        {buildingFields.map((f) => {
          const filled = Boolean(fields[f.key])
          return (
            <div
              key={f.key}
              className={cn(
                'flex items-center gap-2 px-2.5 py-2 rounded-md bg-bg-hover',
                filled ? 'cursor-pointer opacity-100' : 'cursor-default opacity-40',
              )}
            >
              {filled ? (
                <StatusDot status="success" />
              ) : (
                <div className="w-2 h-2 rounded-full border-[1.5px] border-dashed border-text-tertiary" />
              )}
              <span
                className={cn(
                  'flex-1 text-sm font-medium',
                  filled ? 'text-text-primary' : 'text-text-tertiary',
                )}
              >
                {f.label}
              </span>
              {filled && f.editable && <span className="text-brand-blue">{Icons.edit(12)}</span>}
              {filled && !f.editable && <span className="text-text-tertiary">{Icons.eye(12)}</span>}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

/* ─── Completed card ─── */

export function CompletedCard({
  id,
  name,
  onPreview,
}: CompletedWorkflow & { onPreview?: () => void }) {
  const { t } = useTranslation()
  const runWorkflow = useSetAtom(runWorkflowAtom)

  return (
    <Card className="cursor-pointer">
      <div className="px-3.5 py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-accent-purple-subtle flex items-center justify-center text-brand-purple">
              {Icons.workflow(14)}
            </div>
            <div>
              <div className="text-sm font-semibold text-text-primary">{name}</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {/* Open that workflow's full detail modal (its task brief is at the top of the first tab).
                stopPropagation keeps the whole-card click from firing. */}
            <Tooltip content={t('rightPanel.workflowDetail')}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onPreview?.()
                }}
                className="flex items-center justify-center w-6 h-6 rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-brand-blue"
              >
                {Icons.eye(14)}
              </button>
            </Tooltip>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <StatusDot status="success" size={6} />
            <span className="text-xs text-status-success">{t('rightPanel.buildSucceeded')}</span>
          </div>
          <button
            type="button"
            aria-label={t('rightPanel.runWorkflowAria', { name })}
            onClick={(event) => {
              event.stopPropagation()
              runWorkflow({
                workflow: { id, name },
                composerTarget: ComposerTarget.CurrentSession,
              })
            }}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-brand-blue px-2.5 text-xs font-semibold text-white hover:opacity-90"
          >
            {Icons.play(11)} {t('rightPanel.run')}
          </button>
        </div>
      </div>
    </Card>
  )
}

/* ─── Workflow Run result card ─── */

export function WorkflowRunResultCard({
  run,
  onPreview,
}: {
  run: WorkflowRunSummary
  onPreview?: () => void
}) {
  const { t, i18n } = useTranslation()
  const completed = run.status === 'completed'
  const insertWorkflowResult = useSetAtom(useWorkflowResultAtom)
  return (
    <Card className="cursor-pointer border-l-2 border-l-brand-blue" onClick={onPreview}>
      <div className="px-3.5 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-blue-subtle text-brand-blue">
              {Icons.file(14)}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-text-primary">
                {run.workflow_name}
              </div>
              <div className="mt-0.5 text-[11px] text-text-tertiary">
                {formatWorkflowRunShortTimestamp(run.finished_at ?? run.created_at, i18n.language)}
              </div>
            </div>
          </div>
          <Tooltip content={t('rightPanel.runDetail')}>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onPreview?.()
              }}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-brand-blue"
            >
              {Icons.eye(14)}
            </button>
          </Tooltip>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <StatusDot status={completed ? 'success' : 'error'} size={6} />
            <span className={completed ? 'text-xs text-status-success' : 'text-xs text-status-error'}>
              {completed ? t('rightPanel.runCompleted') : t('rightPanel.runFailed')}
            </span>
          </div>
          {completed ? (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation()
                insertWorkflowResult({
                  result: {
                    id: run.id,
                    workflowName: run.workflow_name,
                    createdAt: run.created_at,
                  },
                  composerTarget: ComposerTarget.CurrentSession,
                })
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-brand-blue px-2.5 text-xs font-semibold text-white hover:opacity-90"
            >
              {Icons.at(11)} {t('workflow.common.useResult')}
            </button>
          ) : null}
        </div>
      </div>
    </Card>
  )
}
