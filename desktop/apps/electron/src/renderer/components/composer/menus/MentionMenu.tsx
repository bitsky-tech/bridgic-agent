/**
 * Mention menu (@ popover) for Session files, Workflow results, Workflows, and Schedules.
 *
 * Dumb renderer: ALL state (expansion, mode, rows) arrives via
 * `useMentionMenuState`'s result; the host (FreeFormInput) owns keyboard
 * selection. The menu renders EXACTLY `state.rows` in order, so the host's
 * selectedIndex always points at the visible row.
 *
 * The popover has NO search box of its own (deliberate spec): the query is
 * whatever the user typed after `@` in the composer. Empty query = tree
 * browse (same hierarchy as the right panel); non-empty = flattened search
 * rows with breadcrumb + highlight. The header scopes results by resource.
 * cmdk is not used — for the same design reason as SlashMenu (contenteditable focus conflicts).
 */
import { Fragment, useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Icons } from '@/components/amphi/Icons'
import { Highlighted, hitCrumbRanges, hitSizeLabel } from '@/components/amphi/SearchHighlight'
import { extColor, formatSize } from '@/lib/fileTree'
import { formatWorkflowRunTimestamp, workflowRunCommandInput } from '@/lib/workflowRun'
import type { WorkflowRunSummary, WorkflowSummary } from '@/lib/amphiClient'
import type { Schedule } from '@/lib/schedule'
import type { CaretFloatingStyle } from '../hooks/useCaretFloatingPosition'
import type { MentionMenuState, MentionRow, MentionScope } from './useMentionMenuState'
import { MENTION_SCOPES } from './mentionScope'

/** Menu width in px — MUST equal the `w-[440px]` on the root div; exported so
 *  useCaretFloatingPosition clamps against the real width. */
export const MENTION_MENU_WIDTH = 440

/** Menu height in px at its tallest, for the same reason as the width — the flip decision needs
 *  the real number or the menu ends up anchored off the top of the window.
 *  Sum of the boxes below: header ~101 (pt-3 + a 28px icon row + mt-2.5 + a 36px tab strip + pb-2.5
 *  + its border) + body `max-h-[300px]` + footer 33 (h-8 + its border). Rounded up, and deliberately
 *  the *maximum* rather than the current row count: overestimating only flips a menu that would
 *  have just fit, underestimating clips it. */
export const MENTION_MENU_MAX_HEIGHT = 440

export interface MentionMenuProps {
  state: MentionMenuState
  /** The composer's @-filter (display only — filtering happened in the hook). */
  filter: string
  selectedIndex: number
  style: CaretFloatingStyle
  onToggleExpand: (key: string) => void
  onPick: (row: MentionRow) => void
  onPreviewWorkflowRun: (run: WorkflowRunSummary) => void
  onPreviewWorkflow: (workflow: WorkflowSummary) => void
}
export function MentionMenu({
  state,
  filter,
  selectedIndex,
  style,
  onToggleExpand,
  onPick,
  onPreviewWorkflowRun,
  onPreviewWorkflow,
}: MentionMenuProps) {
  // Scroll the highlighted item into view whenever selectedIndex changes (block:'nearest')
  const highlightedRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    highlightedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const q = filter.trim()

  return (
    <div
      style={style}
      className="z-50 w-[440px] overflow-hidden rounded-lg border border-border-default bg-bg-elevated shadow-lg"
      onMouseDown={(e) => e.preventDefault()}
    >
      <MentionMenuHeader state={state} q={q} />

      <div className="max-h-[300px] overflow-auto p-1.5">
        <MenuBody
          state={state}
          q={q}
          selectedIndex={selectedIndex}
          highlightedRef={highlightedRef}
          onToggleExpand={onToggleExpand}
          onPick={onPick}
          onPreviewWorkflowRun={onPreviewWorkflowRun}
          onPreviewWorkflow={onPreviewWorkflow}
        />
      </div>
      <MentionMenuFooter />
    </div>
  )
}

interface MentionMenuHeaderProps {
  state: MentionMenuState
  q: string
}

/** Category tab labels (the order comes from MENTION_SCOPES, a single source of truth that cannot drift). */
const SCOPE_LABEL_KEYS: Record<MentionScope, string> = {
  all: 'mention.scope.all',
  'session-files': 'mention.scope.sessionFiles',
  'workflow-runs': 'mention.scope.workflowRuns',
  workflows: 'mention.scope.workflows',
  schedules: 'mention.scope.schedules',
}

/** The count in the top-right of each category tab ("all" = the sum of the four categories). */
function scopeCount(state: MentionMenuState, scope: MentionScope): number {
  if (scope === 'session-files') return state.sessionFileTotal
  if (scope === 'workflow-runs') return state.workflowRunTotal
  if (scope === 'workflows') return state.workflowTotal
  if (scope === 'schedules') return state.scheduleTotal
  return state.sessionFileTotal
    + state.workflowRunTotal
    + state.workflowTotal
    + state.scheduleTotal
}

function MentionMenuHeader({ state, q }: MentionMenuHeaderProps) {
  const { t } = useTranslation()
  return (
    <div className="border-b border-border-subtle px-3 pb-2.5 pt-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-blue-subtle text-text-accent">
            {Icons.at(14)}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text-primary">{t('mention.title')}</div>
            <div className="mt-0.5 truncate text-xs text-text-tertiary">
              {q ? t('mention.searchingFor', { query: q }) : t('mention.subtitle')}
            </div>
          </div>
        </div>
        <kbd className="shrink-0 rounded border border-border-subtle bg-bg-hover px-1.5 py-0.5 text-2xs text-text-tertiary">
          Esc
        </kbd>
      </div>
      <div role="tablist" aria-label={t('mention.tablistLabel')} className="mt-2.5 grid grid-cols-5 gap-1 rounded-md bg-bg-hover p-1">
        {MENTION_SCOPES.map((scope) => (
          <button
            key={scope}
            type="button"
            role="tab"
            aria-selected={state.scope === scope}
            onClick={() => state.setScope(scope)}
            className={cn(
              'flex h-7 min-w-0 items-center justify-center gap-1 rounded px-2 text-xs font-medium text-text-tertiary transition-colors',
              state.scope === scope && 'bg-bg-elevated text-text-primary shadow-sm',
            )}
          >
            <span className="truncate">{t(SCOPE_LABEL_KEYS[scope])}</span>
            <span className="shrink-0 tabular-nums text-xs text-text-tertiary">{scopeCount(state, scope)}</span>
          </button>
        ))}
      </div>
      {state.searchPartial && (state.scope === 'all' || state.scope === 'session-files') && (
        <div className="mt-2 text-xs text-status-warning">{t('mention.partialWarning')}</div>
      )}
    </div>
  )
}

interface MenuBodyProps {
  state: MentionMenuState
  q: string
  selectedIndex: number
  highlightedRef: React.Ref<HTMLDivElement>
  onToggleExpand: (key: string) => void
  onPick: (row: MentionRow) => void
  onPreviewWorkflowRun: (run: WorkflowRunSummary) => void
  onPreviewWorkflow: (workflow: WorkflowSummary) => void
}

/** List-area branches: empty state / loading / row list (§1.24 extract components rather than nesting ternaries). */
function MenuBody({
  state,
  q,
  selectedIndex,
  highlightedRef,
  onToggleExpand,
  onPick,
  onPreviewWorkflowRun,
  onPreviewWorkflow,
}: MenuBodyProps) {
  const { t } = useTranslation()
  if (state.empty) {
    let message = t('mention.empty.default')
    if (q) message = t('mention.empty.noMatch', { query: q })
    else if (state.scope === 'workflow-runs') message = t('mention.empty.workflowRuns')
    else if (state.scope === 'session-files') message = t('mention.empty.sessionFiles')
    else if (state.scope === 'workflows') message = t('mention.empty.workflows')
    else if (state.scope === 'schedules') message = t('mention.empty.schedules')
    return (
      <div className="px-2.5 py-6 text-center text-sm text-text-tertiary leading-[1.6]">
        {message}
        {state.scope === 'session-files' && (
          <>
            <br />
            {t('mention.empty.sessionFilesHint')}
          </>
        )}
      </div>
    )
  }

  const rowKey = (row: MentionRow): string => {
    if (row.kind === 'workflow-run') return `run:${row.run.id}`
    if (row.kind === 'workflow') return `workflow:${row.workflow.id}`
    if (row.kind === 'schedule') return `schedule:${row.schedule.id}`
    if (row.kind === 'scope-link') return `scope-link:${row.scope}`
    if (row.kind === 'search') return `search:${row.hit.mountId}:${row.hit.relPath}`
    if (row.kind === 'more') return `more:${row.key}`
    return `tree:${row.key}`
  }
  const rowSection = (row: MentionRow): string => {
    if (
      row.kind === 'workflow-run'
      || row.kind === 'scope-link'
      || (row.kind === 'more' && row.section === 'workflow-runs')
    ) return t('mention.section.workflowRuns')
    if (row.kind === 'workflow') return t('mention.section.workflows')
    if (row.kind === 'schedule') return t('mention.section.schedules')
    return t('mention.section.sessionFiles')
  }

  return (
    <>
      {state.loading && (
        <div className="px-2.5 py-1 text-xs text-text-tertiary">
          {state.mode === 'search' ? t('mention.loading.search') : t('mention.loading.browse')}
        </div>
      )}
      {state.rows.map((row, idx) => {
        const selected = idx === selectedIndex
        const ref = selected ? highlightedRef : null
        let item: ReactNode
        if (row.kind === 'workflow-run') item = (
          <WorkflowRunRow
            row={row}
            selected={selected}
            rowRef={ref}
            onPick={onPick}
            onPreview={onPreviewWorkflowRun}
          />
        )
        else if (row.kind === 'workflow') item = (
          <WorkflowRow
            row={row}
            selected={selected}
            rowRef={ref}
            onPick={onPick}
            onPreview={onPreviewWorkflow}
          />
        )
        else if (row.kind === 'schedule') item = (
          <ScheduleRow row={row} selected={selected} rowRef={ref} onPick={onPick} />
        )
        else if (row.kind === 'scope-link') item = (
          <ScopeLinkRow row={row} selected={selected} rowRef={ref} onPick={onPick} />
        )
        else if (row.kind === 'tree') item = (
          <TreeRow
            row={row}
            selected={selected}
            rowRef={ref}
            onToggleExpand={onToggleExpand}
            onPick={onPick}
          />
        )
        else if (row.kind === 'more') item = (
          <MoreRow row={row} selected={selected} rowRef={ref} onPick={onPick} />
        )
        else item = (
          <SearchRow row={row} selected={selected} rowRef={ref} onPick={onPick} />
        )
        return (
          <Fragment key={rowKey(row)}>
            {state.scope === 'all' && (idx === 0 || rowSection(state.rows[idx - 1]!) !== rowSection(row)) && (
              <MentionSectionLabel label={rowSection(row)} />
            )}
            {item}
          </Fragment>
        )
      })}
    </>
  )
}

interface WorkflowRowProps extends RowProps<Extract<MentionRow, { kind: 'workflow' }>> {
  onPreview: (workflow: WorkflowSummary) => void
}

function WorkflowRow({ row, selected, rowRef, onPick, onPreview }: WorkflowRowProps) {
  const { t } = useTranslation()
  const workflow = row.workflow
  return (
    <div
      ref={rowRef}
      onClick={() => onPick(row)}
      className={cn(
        'group/workflow flex cursor-pointer items-center gap-2 rounded-md border-l-2 border-transparent px-2.5 py-2 hover:bg-bg-hover',
        selected && 'border-brand-blue bg-bg-selected',
      )}
    >
      <span data-resource-kind="workflow" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-entity-workflow-bg text-entity-workflow">
        {Icons.workflow(14)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{workflow.name}</div>
          <span className="shrink-0 rounded-full bg-entity-workflow-bg px-1.5 py-0.5 text-2xs font-medium text-entity-workflow">{t('mention.badge.workflow')}</span>
        </div>
        <div className="mt-0.5 truncate text-xs text-text-tertiary">
          {t('mention.workflow.editable')} · {workflow.desc || t('mention.workflow.defaultDesc')}
        </div>
      </div>
      <button
        type="button"
        aria-label={t('mention.previewWorkflowAria', { name: workflow.name })}
        onClick={(event) => {
          event.stopPropagation()
          onPreview(workflow)
        }}
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-surface hover:text-text-accent',
          selected ? 'opacity-100' : 'opacity-0 group-hover/workflow:opacity-100',
        )}
      >
        {Icons.eye(13)}
      </button>
    </div>
  )
}

function ScheduleRow({ row, selected, rowRef, onPick }: RowProps<Extract<MentionRow, { kind: 'schedule' }>>) {
  const { t } = useTranslation()
  const schedule: Schedule = row.schedule
  return (
    <div
      ref={rowRef}
      onClick={() => onPick(row)}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-md border-l-2 border-transparent px-2.5 py-2 hover:bg-bg-hover',
        selected && 'border-brand-blue bg-bg-selected',
      )}
    >
      <span data-resource-kind="schedule" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-entity-schedule-bg text-entity-schedule">
        {Icons.clock(14)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{schedule.name}</div>
          <span className="shrink-0 rounded-full bg-entity-schedule-bg px-1.5 py-0.5 text-2xs font-medium text-entity-schedule">{t('mention.badge.schedule')}</span>
        </div>
        <div className="mt-0.5 truncate text-xs text-text-tertiary">
          {schedule.desc || t('mention.schedule.defaultDesc')}
        </div>
      </div>
    </div>
  )
}

function ScopeLinkRow({
  row,
  selected,
  rowRef,
  onPick,
}: RowProps<Extract<MentionRow, { kind: 'scope-link' }>>) {
  const { t } = useTranslation()
  return (
    <div
      ref={rowRef}
      data-resource-kind="workflow-run-scope-link"
      onClick={() => onPick(row)}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-entity-workflow-run hover:bg-bg-hover',
        selected && 'bg-bg-selected',
      )}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-entity-workflow-run-bg">
        {Icons.workflowResult(14)}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {t('mention.viewAllRuns', { total: row.total })}
      </span>
      <span className="shrink-0">{Icons.chevronRight(13)}</span>
    </div>
  )
}

function MentionSectionLabel({ label }: { label: string }) {
  return (
    <div
      data-mention-section={label}
      className="px-2 pb-1 pt-1.5 text-xs font-semibold uppercase text-text-tertiary"
    >
      {label}
    </div>
  )
}

function MentionMenuFooter() {
  const { t } = useTranslation()
  return (
    <div className="flex h-8 items-center gap-3 border-t border-border-subtle px-3 text-xs text-text-tertiary">
      <span><kbd>↑↓</kbd> {t('mention.footer.select')}</span>
      <span><kbd>←→</kbd> {t('mention.footer.switchScope')}</span>
      <span><kbd>Enter</kbd> {t('mention.footer.reference')}</span>
    </div>
  )
}

interface WorkflowRunRowProps extends RowProps<Extract<MentionRow, { kind: 'workflow-run' }>> {
  onPreview: (run: WorkflowRunSummary) => void
}

function WorkflowRunRow({ row, selected, rowRef, onPick, onPreview }: WorkflowRunRowProps) {
  const { t } = useTranslation()
  const run = row.run
  const input = workflowRunCommandInput(run)
  let status = t('mention.runStatus.running')
  let statusTone = 'bg-status-info-bg text-status-info'
  if (run.status === 'completed') {
    status = t('mention.runStatus.completed')
    statusTone = 'bg-status-success-bg text-status-success'
  } else if (run.status === 'failed') {
    status = t('mention.runStatus.failed')
    statusTone = 'bg-status-error-bg text-status-error'
  } else if (run.status === 'cancelled') {
    status = t('mention.runStatus.cancelled')
    statusTone = 'bg-bg-hover text-text-tertiary'
  } else if (run.status === 'paused') {
    status = t('mention.runStatus.paused')
    statusTone = 'bg-bg-hover text-text-secondary'
  } else if (run.status === 'waiting') {
    status = t('mention.runStatus.waiting')
    statusTone = 'bg-status-warning-bg text-status-warning'
  }
  return (
    <div
      ref={rowRef}
      onClick={() => onPick(row)}
      className={cn(
        'group/workflow-run flex cursor-pointer items-center gap-2 rounded-md border-l-2 border-transparent px-2.5 py-2 hover:bg-bg-hover',
        selected && 'border-brand-blue bg-bg-selected',
      )}
    >
      <span data-resource-kind="workflow-run" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-entity-workflow-run-bg text-entity-workflow-run">
        {Icons.workflowResult(14)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{run.workflow_name}</div>
          <span className="shrink-0 rounded-full bg-entity-workflow-run-bg px-1.5 py-0.5 text-2xs font-medium text-entity-workflow-run">
            {t('mention.badge.workflowRun')}
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <div className="min-w-0 flex-1 truncate text-xs text-text-tertiary">
            {formatWorkflowRunTimestamp(run.created_at)}{input ? ` · ${input}` : ''}
          </div>
          <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-medium', statusTone)}>{status}</span>
        </div>
      </div>
      <button
        type="button"
        aria-label={t('mention.previewRunAria', { name: run.workflow_name })}
        onClick={(event) => {
          event.stopPropagation()
          onPreview(run)
        }}
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-surface hover:text-text-accent',
          selected ? 'opacity-100' : 'opacity-0 group-hover/workflow-run:opacity-100',
        )}
      >
        {Icons.eye(13)}
      </button>
    </div>
  )
}

interface RowProps<R extends MentionRow> {
  row: R
  selected: boolean
  /** The ref for scrollIntoView, attached to the selected row; null for unselected rows. */
  rowRef: React.Ref<HTMLDivElement>
  onPick: (row: MentionRow) => void
}

function TreeRow({
  row,
  selected,
  rowRef,
  onToggleExpand,
  onPick,
}: RowProps<Extract<MentionRow, { kind: 'tree' }>> & { onToggleExpand: (key: string) => void }) {
  const { t } = useTranslation()
  const isFolder = row.nodeKind === 'folder'
  const handleClick = (): void => {
    // Clicking a folder row = expand/collapse (matching tree intuition); clicking a file row = reference it directly.
    // "Referencing" a folder goes through the hover @ at the end of the row (or Enter on the keyboard).
    if (row.expandable) onToggleExpand(row.key)
    else if (!isFolder) onPick(row)
  }
  return (
    <div
      ref={rowRef}
      onClick={handleClick}
      className={cn(
        'group/mention-tree flex items-center gap-1.5 px-2 py-[5px] rounded-md cursor-pointer hover:bg-bg-hover',
        selected && 'bg-bg-selected',
      )}
    >
      {/* Indent guides: one 13px left border segment per level, visually continuous across rows (same as the right-panel tree). */}
      {Array.from({ length: row.depth }, (_, i) => (
        <span
          key={i}
          className="w-[13px] self-stretch border-l border-border-subtle flex-shrink-0"
        />
      ))}
      <span className="w-3.5 flex justify-center text-text-tertiary flex-shrink-0">
        {row.expandable && (row.expanded ? Icons.chevronDown(12) : Icons.chevronRight(12))}
      </span>
      <span className={cn('flex flex-shrink-0', extColor(row.name, row.nodeKind))}>
        {isFolder ? Icons.folder(15) : Icons.file(14)}
      </span>
      <span className="flex-1 min-w-0 text-sm font-medium font-mono text-text-primary truncate">
        {row.name}
      </span>
      {row.loadingChildren && (
        <span className="text-xs text-text-tertiary flex-shrink-0">{t('mention.tree.loading')}</span>
      )}
      {row.unreadable && (
        <span className="text-xs text-text-tertiary flex-shrink-0">{t('mention.tree.unreadable')}</span>
      )}
      {row.sizeBytes !== null && (
        <span className="text-xs text-text-tertiary flex-shrink-0">
          {formatSize(row.sizeBytes)}
        </span>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onPick(row)
        }}
        aria-label={t('mention.tree.referenceAria', { name: row.name })}
        // Always rendered, shown/hidden via opacity (§LS1): folders can be referenced with the mouse too, not only via Enter.
        className="w-4 text-center text-xs font-semibold text-text-accent flex-shrink-0 opacity-0 group-hover/mention-tree:opacity-100 transition-opacity"
      >
        @
      </button>
    </div>
  )
}

function MoreRow({ row, selected, rowRef, onPick }: RowProps<Extract<MentionRow, { kind: 'more' }>>) {
  const { t } = useTranslation()
  return (
    <div
      ref={rowRef}
      onClick={() => onPick(row)}
      className={cn(
        'flex items-center gap-1.5 px-2 py-[5px] rounded-md cursor-pointer hover:bg-bg-hover',
        selected && 'bg-bg-selected',
      )}
    >
      <span className="w-3.5 flex-shrink-0" />
      <span className="text-xs text-text-accent">{t('mention.more', { remaining: row.remaining })}</span>
    </div>
  )
}

function SearchRow({
  row,
  selected,
  rowRef,
  onPick,
}: RowProps<Extract<MentionRow, { kind: 'search' }>>) {
  const h = row.hit
  return (
    <div
      ref={rowRef}
      onClick={() => onPick(row)}
      className={cn(
        'flex items-center gap-2 px-2.5 py-[7px] rounded-md cursor-pointer hover:bg-bg-hover',
        selected && 'bg-bg-selected',
      )}
    >
      <span className={cn('flex flex-shrink-0', extColor(h.name, h.kind))}>
        {h.kind === 'folder' ? Icons.folder(15) : Icons.file(14)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-mono text-text-primary truncate">
          <Highlighted text={h.name} ranges={h.nameRanges} />
        </div>
        {h.crumb.length > 0 && (
          <div className="flex items-center gap-1 mt-px text-xs text-text-tertiary truncate">
            <span className="flex flex-shrink-0">{Icons.folder(10)}</span>
            <span className="truncate">
              <Highlighted text={h.crumb.join(' / ')} ranges={hitCrumbRanges(h)} />
            </span>
          </div>
        )}
      </div>
      <span className="text-xs text-text-tertiary flex-shrink-0">
        {hitSizeLabel(h)}
      </span>
    </div>
  )
}
