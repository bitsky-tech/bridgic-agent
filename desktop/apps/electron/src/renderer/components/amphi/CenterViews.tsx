/**
 * Center column views — Workflows grid, Skills manager, and My Assets finder.
 *
 * Rendered when activeNav === 'workflows' / 'skills' / 'assets'. All share
 * the header layout (title + subtitle + search box on the right) and a
 * scrollable body. Workflows, skills, and assets are backed by daemon-owned
 * domain records; this layer only owns presentation and local UI state.
 *
 * Refactored to Tailwind className per §1.22.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { cn } from '@/lib/cn'
import { useIsClamped } from '@/hooks/useIsClamped'
import { ComposerTarget, ModalKind, openModalAtom, selectNavAtom } from '@/atoms/amphi'
import {
  assetsHydrationErrorAtom,
  assetsHydrationStateAtom,
  hydrateAssetsAtom,
  sessionFileAssetsAtom,
} from '@/atoms/assets'
import { selectSessionAtom } from '@/atoms/sessions'
import { deleteWorkflowRunAtom, workflowRunsAtom } from '@/atoms/workflows'
import { useWorkflowResultAtom } from '@/atoms/workflow-session'
import {
  hydrateSkillsAtom,
  skillsAtom,
  skillsHydrationStateAtom,
  toggleSkillAtom,
  type SkillsHydrationState,
} from '@/atoms/skills'
import {
  SkillGroup,
  type SessionFileAsset,
  type SkillDetail,
  type WorkflowRunSummary,
} from '@/lib/amphiClient'
import { formatBytes } from '@/lib/toolDisplay'
import { formatWorkflowRunShortTimestamp, workflowRunInputBlocks } from '@/lib/workflowRun'
import { CenterPageLayout } from './CenterPageLayout'
import { EmptyState } from './EmptyState'
import { FilterTabs } from './FilterTabs'
import { RefreshButton } from './RefreshButton'
import { SearchBox } from './SearchBox'
import { Icons } from './Icons'
import { StructuredInput } from './StructuredInput'
import { WindowedList } from './WindowedList'
import { NavKey } from './LeftSidebar'
import { Btn, Card, Tag, Toggle } from './Primitives'

export interface Workflow {
  id: string
  name: string
  desc?: string
}

/** Workflows whose name or description matches `query` (empty query = all). The single source of truth for the search box's filtering rule. */
export function filterWorkflows(workflows: Workflow[], query: string): Workflow[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return workflows
  return workflows.filter((workflow) => [workflow.name, workflow.desc ?? '']
    .some((value) => value.toLocaleLowerCase().includes(normalized)))
}

export interface CenterWorkflowsProps {
  workflows?: Workflow[]
  onPickWorkflow?: (workflow: Workflow) => void
  onRunWorkflow?: (workflow: { id: string; name: string }) => void
  onImportWorkflow?: (file: File) => void
  onRenameWorkflow?: (workflow: { id: string; name: string }, name: string) => Promise<boolean>
  onExportWorkflow?: (workflow: { id: string; name: string }) => void
  onDeleteWorkflow?: (workflow: { id: string; name: string }) => void
  /** One-click creation of a scheduled task from a workflow (via a real new session that is pre-filled, with an @mention of that workflow seeded into the description area). */
  onScheduleWorkflow?: (workflow: { id: string; name: string }) => void
}

export function CenterWorkflows({
  workflows = [],
  onPickWorkflow,
  onRunWorkflow,
  onImportWorkflow,
  onRenameWorkflow,
  onExportWorkflow,
  onDeleteWorkflow,
  onScheduleWorkflow,
}: CenterWorkflowsProps) {
  const { t } = useTranslation()
  const importInputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [rename, setRename] = useState<{
    id: string
    value: string
    busy: boolean
    error: string
  } | null>(null)

  const isSearching = query.trim().length > 0
  const visible = useMemo(() => filterWorkflows(workflows, query), [query, workflows])

  const commitRename = async (workflow: Workflow) => {
    if (!rename || rename.id !== workflow.id || rename.busy) return
    const name = rename.value.trim()
    if (!name) {
      setRename({ ...rename, error: t('center.workflows.rename.emptyName') })
      return
    }
    if (name === workflow.name) {
      setRename(null)
      return
    }
    setRename({ ...rename, busy: true, error: '' })
    try {
      const renamed = await onRenameWorkflow?.(workflow, name)
      if (renamed === false) {
        setRename((current) => current?.id === workflow.id
          ? { ...current, busy: false, error: t('center.workflows.rename.failedCheckName') }
          : current)
        return
      }
      setRename(null)
    } catch {
      setRename((current) => current?.id === workflow.id
        ? { ...current, busy: false, error: t('center.workflows.rename.failedRetry') }
        : current)
    }
  }

  return (
    <CenterPageLayout
      title={t('center.common.workflows')}
      subtitle={t('center.workflows.subtitle')}
      actions={
        <>
          <input
            ref={importInputRef}
            type="file"
            accept=".amphi-workflow"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) onImportWorkflow?.(file)
              event.target.value = ''
            }}
          />
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder={t('center.workflows.searchPlaceholder')}
          />
          <Btn variant="primary" size="md" onClick={() => importInputRef.current?.click()}>
            {Icons.download(14)} {t('center.common.import')}
          </Btn>
        </>
      }
    >
      <>
        {visible.length === 0 ? (
          /* "No search matches" and "there are none at all" are two different things — the former suggests changing the keyword, the latter points to /build. */
          <EmptyState
            icon={Icons.workflow}
            title={isSearching ? t('center.workflows.empty.noMatchTitle') : t('center.workflows.empty.title')}
            description={isSearching ? t('center.workflows.empty.noMatchDesc') : t('center.workflows.empty.desc')}
          />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {visible.map((w) => (
              <Card
                key={w.id}
                data-testid={`workflow-card-${w.id}`}
                className="p-0 cursor-pointer"
                onClick={() => onPickWorkflow?.(w)}
              >
                <div className="px-[18px] py-4">
                  <div className="flex items-start justify-between mb-2.5">
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <div className="w-9 h-9 rounded-md bg-accent-blue-subtle flex items-center justify-center text-text-accent">
                        {Icons.workflow(18)}
                      </div>
                      <div className="min-w-0 flex-1">
                        {rename?.id === w.id ? (
                          <input
                            autoFocus
                            value={rename.value}
                            maxLength={200}
                            data-testid={`workflow-rename-input-${w.id}`}
                            aria-label={t('center.workflows.renameAria', { name: w.name })}
                            disabled={rename.busy}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => setRename({
                              ...rename,
                              value: event.target.value,
                              error: '',
                            })}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                void commitRename(w)
                              } else if (event.key === 'Escape') {
                                event.preventDefault()
                                setRename(null)
                              }
                            }}
                            className="h-8 w-full rounded-md border border-brand-blue bg-bg-input px-2 text-sm font-semibold text-text-primary outline-none disabled:opacity-60"
                          />
                        ) : (
                          <div className="truncate text-md font-semibold text-text-primary">{w.name}</div>
                        )}
                      </div>
                    </div>
                    {rename?.id !== w.id && onRenameWorkflow ? (
                      <button
                        type="button"
                        aria-label={t('center.workflows.renameAria', { name: w.name })}
                        data-testid={`workflow-rename-${w.id}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          setRename({ id: w.id, value: w.name, busy: false, error: '' })
                        }}
                        className="ml-2 flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
                      >
                        {Icons.edit(12)} {t('center.workflows.rename.action')}
                      </button>
                    ) : null}
                  </div>
                  <div className="text-sm text-text-secondary leading-[1.5] mb-3 min-h-[20px]">
                    {w.desc || t('center.workflows.noDesc')}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className={cn(
                      'text-xs',
                      rename?.id === w.id && rename.error
                        ? 'text-status-error'
                        : 'text-text-tertiary',
                    )}>
                      {rename?.id === w.id && rename.error ? rename.error : t('center.workflows.saved')}
                    </span>
                    <div className="flex gap-1.5">
                      {rename?.id === w.id ? (
                        <>
                          <Btn
                            variant="ghost"
                            size="xs"
                            data-testid={`workflow-rename-cancel-${w.id}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              if (!rename.busy) setRename(null)
                            }}
                          >
                            {t('center.common.cancel')}
                          </Btn>
                          <Btn
                            variant="default"
                            size="xs"
                            className={rename.busy ? 'pointer-events-none opacity-60' : undefined}
                            data-testid={`workflow-rename-save-${w.id}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              void commitRename(w)
                            }}
                          >
                            {rename.busy ? t('center.common.saving') : t('center.common.save')}
                          </Btn>
                        </>
                      ) : (
                        <>
                          <Btn variant="ghost" size="xs">
                            {Icons.eye(12)} {t('center.common.details')}
                          </Btn>
                          <Btn
                            variant="ghost"
                            size="xs"
                            onClick={(event) => {
                              event.stopPropagation()
                              onExportWorkflow?.({ id: w.id, name: w.name })
                            }}
                          >
                            {Icons.download(12)} {t('center.common.export')}
                          </Btn>
                          <Btn
                            variant="ghost"
                            size="xs"
                            className="text-status-error"
                            data-testid={`workflow-delete-${w.id}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              onDeleteWorkflow?.({ id: w.id, name: w.name })
                            }}
                          >
                            {Icons.trash(12)} {t('center.common.delete')}
                          </Btn>
                          <Btn
                            variant="default"
                            size="xs"
                            data-testid={`workflow-run-${w.id}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              onRunWorkflow?.({ id: w.id, name: w.name })
                            }}
                          >
                            {Icons.play(12)} {t('center.workflows.runInNewSession')}
                          </Btn>
                          <Btn
                            variant="ghost"
                            size="xs"
                            data-testid={`workflow-schedule-${w.id}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              onScheduleWorkflow?.({ id: w.id, name: w.name })
                            }}
                          >
                            {Icons.clock(12)} {t('center.workflows.schedule')}
                          </Btn>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </>
    </CenterPageLayout>
  )
}

/* ─── Skills management view ─── */

/** Backend `group` → i18n key of its source label. Single source of truth: shared by the filter tiers and the inline labels, no longer written twice. */
const SKILL_GROUP_LABEL_KEY: Record<SkillGroup, string> = {
  [SkillGroup.SelfCreated]: 'center.skills.group.selfCreated',
  [SkillGroup.Imported]: 'center.skills.group.imported',
  [SkillGroup.Builtin]: 'center.skills.group.builtin',
}

/** Four-tier source filter: 'all' = everything, the rest align with the backend `group`. */
const SKILL_FILTER_KEYS = [
  'all',
  SkillGroup.SelfCreated,
  SkillGroup.Imported,
  SkillGroup.Builtin,
] as const
type SkillFilterKey = (typeof SKILL_FILTER_KEYS)[number]

/** Backend `group` → source label (unknown/missing is treated as externally imported). */
function getSkillGroupLabel(t: TFunction, group: SkillGroup | null): string {
  return t((group && SKILL_GROUP_LABEL_KEY[group]) || SKILL_GROUP_LABEL_KEY[SkillGroup.Imported])
}

/** Filter-tier label: 'all' has its own wording, the rest reuse the group labels. */
function getSkillFilterLabel(t: TFunction, key: SkillFilterKey): string {
  return key === 'all' ? t('center.common.all') : getSkillGroupLabel(t, key)
}

/** One Skill card row: icon + mono name + source label + description + delete (non-built-in) + Toggle.
 *  UI trimmed first: version / domain / commit are not shown — the backend has no corresponding fields. */
function SkillRow({
  skill,
  onToggle,
  onDelete,
}: {
  skill: SkillDetail
  onToggle: (skill: SkillDetail) => void
  onDelete: (skill: SkillDetail) => void
}) {
  const { t } = useTranslation()
  const isBuiltin = skill.group === SkillGroup.Builtin
  // Inline description expand/collapse — component-local UI state, aligned with the import wizard's NewRow / ConflictVersionPanel.
  const [expanded, setExpanded] = useState(false)
  // Only show "expand/collapse" when the description really exceeds 3 lines (useIsClamped measures scrollHeight>clientHeight).
  const [descRef, clamped] = useIsClamped(skill.description, expanded)
  return (
    <Card data-testid={`skill-row-${skill.skill_id}`} className="px-[18px] py-4">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0',
            skill.enabled
              ? 'bg-accent-purple-subtle text-text-accent-purple'
              : 'bg-bg-hover text-text-tertiary',
          )}
        >
          {Icons.terminal(18)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-md font-semibold font-mono text-text-primary truncate">
              {skill.name}
            </span>
            <Tag>{getSkillGroupLabel(t, skill.group)}</Tag>
          </div>
          {skill.description && (
            <>
              <div
                ref={descRef}
                className={cn('text-sm text-text-secondary mt-0.5', !expanded && 'line-clamp-3')}
              >
                {skill.description}
              </div>
              {clamped && (
                <button
                  type="button"
                  className="mt-1 text-xs font-semibold text-text-accent"
                  onClick={() => setExpanded((x) => !x)}
                >
                  {expanded ? t('center.common.collapse') : t('center.common.expandFull')}
                </button>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Built-in Skills cannot be deleted (the backend refuses too), so only external / self-created rows show the delete entry point. */}
          {!isBuiltin && (
            <Btn
              variant="ghost"
              size="xs"
              data-testid={`skill-delete-${skill.skill_id}`}
              onClick={() => onDelete(skill)}
            >
              {Icons.trash(12)} {t('center.common.delete')}
            </Btn>
          )}
          <button
            type="button"
            onClick={() => onToggle(skill)}
            className="flex cursor-pointer"
            aria-label={t(
              skill.enabled ? 'center.skills.disableAria' : 'center.skills.enableAria',
              { name: skill.name },
            )}
          >
            <Toggle on={skill.enabled} />
          </button>
        </div>
      </div>
    </Card>
  )
}

/** List body — return early per hydration state (loading / error / empty / list), avoiding nested ternaries (§1.24). */
function SkillsBody({
  state,
  skills,
  onToggle,
  onDelete,
}: {
  state: SkillsHydrationState
  skills: SkillDetail[]
  onToggle: (skill: SkillDetail) => void
  onDelete: (skill: SkillDetail) => void
}) {
  const { t } = useTranslation()
  if (state === 'loading' && skills.length === 0) {
    return <EmptyState title={t('center.common.loading')} />
  }
  if (state === 'error') {
    return <EmptyState title={t('center.skills.loadFailed')} tone="error" />
  }
  if (skills.length === 0) {
    return <EmptyState icon={Icons.terminal} title={t('center.skills.empty')} />
  }
  return (
    <div className="flex flex-col gap-3">
      {skills.map((s) => (
        <SkillRow key={s.skill_id} skill={s} onToggle={onToggle} onDelete={onDelete} />
      ))}
    </div>
  )
}

/** Skills management view — wired to `skillsAtom`: real toggling + deletion + local import, with a four-tier source filter + search. */
export function CenterSkills() {
  const { t } = useTranslation()
  const skills = useAtomValue(skillsAtom)
  const hydrationState = useAtomValue(skillsHydrationStateAtom)
  const hydrate = useSetAtom(hydrateSkillsAtom)
  const toggleSkill = useSetAtom(toggleSkillAtom)
  const openModal = useSetAtom(openModalAtom)
  const [filter, setFilter] = useState<SkillFilterKey>('all')
  const [query, setQuery] = useState('')

  // Fetch the real list once on entering the page; the atom dedupes internally with an in-flight Promise, so remounting does not re-request.
  useEffect(() => {
    void hydrate()
  }, [hydrate])

  const q = query.trim().toLowerCase()
  const visible = skills.filter((s) => {
    if (filter !== 'all' && s.group !== filter) return false
    if (!q) return true
    return s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q)
  })

  const handleToggle = (s: SkillDetail) => {
    void toggleSkill({ skillId: s.skill_id, enabled: !s.enabled })
  }
  const handleDelete = (s: SkillDetail) => {
    openModal({ type: ModalKind.SkillDelete, skillId: s.skill_id, name: s.name })
  }

  return (
    <CenterPageLayout
      /* Not run through i18n, unlike the three sibling pages — "Skills" is left
         as-is here rather than silently introducing a key the locale files do
         not have. */
      title="Skills"
      subtitle={t('center.skills.subtitle')}
      actions={
        <>
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder={t('center.skills.searchPlaceholder')}
          />
          <Btn
            variant="primary"
            size="md"
            data-testid="skill-import-open"
            onClick={() => openModal({ type: ModalKind.SkillImport })}
          >
            {Icons.download(14)} {t('center.skills.manualImport')}
          </Btn>
        </>
      }
      filters={
        <FilterTabs
          tabs={SKILL_FILTER_KEYS.map((key) => ({ key, label: getSkillFilterLabel(t, key) }))}
          value={filter}
          onChange={setFilter}
          testIdPrefix="skill-filter-"
        />
      }
    >
      <SkillsBody
        state={hydrationState}
        skills={visible}
        onToggle={handleToggle}
        onDelete={handleDelete}
      />
    </CenterPageLayout>
  )
}

/* ─── My Assets ─── */

interface WorkflowResultGroup {
  key: string
  workflowName: string
  runs: WorkflowRunSummary[]
}

function assetDate(value: string, locale: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function mountSize(t: TFunction, asset: SessionFileAsset): string {
  if (!asset.exists) return t('center.assets.files.invalid')
  // Folders get a placeholder, never a count: the daemon deliberately never
  // reads a mounted directory (listing one trips the macOS TCC prompt and
  // walks the whole tree), so `item_count` is always null, and this flat
  // table has no expand affordance that could fetch a real one. The count
  // lives in the right panel's mount tree instead — see `mountMeta` in
  // MountRow.tsx, which stays blank while collapsed precisely because there
  // expanding DOES fill it in.
  if (asset.kind === 'folder') return '—'
  return formatBytes(asset.size_bytes ?? 0)
}

function runStatus(t: TFunction, run: WorkflowRunSummary): { label: string; tone: string } {
  if (run.status === 'completed') {
    return { label: t('center.common.status.completed'), tone: 'bg-status-success-bg text-status-success' }
  }
  if (run.status === 'failed' || run.validation_status === 'failed') {
    return { label: t('center.common.status.failed'), tone: 'bg-status-error-bg text-status-error' }
  }
  if (run.status === 'paused') return { label: t('center.common.status.paused'), tone: 'bg-bg-hover text-text-tertiary' }
  if (run.status === 'cancelled') return { label: t('center.common.status.cancelled'), tone: 'bg-bg-hover text-text-tertiary' }
  if (run.status === 'waiting') return { label: t('center.common.status.waiting'), tone: 'bg-status-warning-bg text-status-warning' }
  return { label: t('center.common.status.running'), tone: 'bg-accent-blue-subtle text-text-accent' }
}

function SessionFilesTable({
  assets,
  onOpenSession,
}: {
  assets: SessionFileAsset[]
  onOpenSession: (sessionId: string) => void
}) {
  const { t, i18n } = useTranslation()
  return (
    <section className="mb-7">
      <div className="mb-2.5 flex items-center justify-between">
        <div className="text-sm font-semibold text-text-primary">{t('center.assets.files.title')}</div>
        <div className="text-xs text-text-tertiary">{t('center.assets.files.subtitle', { n: assets.length })}</div>
      </div>
      <div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-surface">
        <div className="grid grid-cols-[minmax(0,1fr)_100px_110px_minmax(150px,220px)] gap-3 bg-bg-hover px-4 py-2 text-xs font-semibold text-text-tertiary">
          <span>{t('center.assets.files.col.name')}</span>
          <span>{t('center.assets.files.col.size')}</span>
          <span>{t('center.assets.files.col.addedAt')}</span>
          <span>{t('center.assets.files.col.session')}</span>
        </div>
        {assets.length === 0 ? (
          <div className="border-t border-border-subtle px-4 py-8 text-center text-sm text-text-tertiary">
            {t('center.assets.files.empty')}
          </div>
        ) : (
        <WindowedList items={assets}>
          {(asset) => (
          <div
            key={`${asset.session_id}:${asset.id}`}
            className="grid grid-cols-[minmax(0,1fr)_100px_110px_minmax(150px,220px)] items-center gap-3 border-t border-border-subtle px-4 py-2.5"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span className={cn('flex shrink-0', asset.exists ? 'text-text-accent' : 'text-status-error')}>
                {asset.kind === 'folder' ? Icons.folder(17) : Icons.file(17)}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-text-primary">{asset.name}</span>
                <span className="mt-0.5 block truncate font-mono text-2xs text-text-tertiary">{asset.path}</span>
              </span>
            </div>
            <span className={cn('text-xs', asset.exists ? 'text-text-secondary' : 'text-status-error')}>{mountSize(t, asset)}</span>
            <span className="font-mono text-xs text-text-secondary">{assetDate(asset.created_at, i18n.language)}</span>

            <button
              type="button"
              onClick={() => onOpenSession(asset.session_id)}
              className="truncate text-left text-xs font-medium text-text-accent hover:underline"
            >
              {asset.session_title || asset.session_id}
            </button>
          </div>
          )}
        </WindowedList>
        )}
      </div>
    </section>
  )
}

function WorkflowResultsTree({
  groups,
  queryActive,
  onPreviewRun,
  onUseRun,
  onDeleteRun,
}: {
  groups: WorkflowResultGroup[]
  queryActive: boolean
  onPreviewRun: (run: WorkflowRunSummary) => void
  onUseRun: (run: WorkflowRunSummary) => void
  onDeleteRun: (run: WorkflowRunSummary) => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  return (
    <section className="mb-7">
      <div className="mb-2.5 flex items-center justify-between">
        <div className="text-sm font-semibold text-text-primary">{t('center.assets.runs.title')}</div>
        <div className="text-xs text-text-tertiary">{t('center.assets.runs.subtitle', { n: groups.length })}</div>
      </div>
      <div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-surface">
        <div className="grid grid-cols-[minmax(0,1fr)_110px_150px] gap-3 bg-bg-hover px-4 py-2 text-xs font-semibold text-text-tertiary">
          <span>{t('center.assets.runs.col.name')}</span>
          <span>{t('center.assets.runs.col.status')}</span>
          <span>{t('center.assets.runs.col.time')}</span>
        </div>
        {groups.length === 0 ? (
          <div className="border-t border-border-subtle px-4 py-8 text-center text-sm text-text-tertiary">
            {t('center.assets.runs.empty')}
          </div>
        ) : (
        <WindowedList items={groups}>
          {(group) => {
          const open = queryActive || expanded.has(group.key)
          return (
            <div key={group.key} className="border-t border-border-subtle">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => {
                  const next = new Set(expanded)
                  if (open) next.delete(group.key)
                  else next.add(group.key)
                  setExpanded(next)
                }}
                className="grid w-full grid-cols-[minmax(0,1fr)_110px_150px] items-center gap-3 px-4 py-3 text-left hover:bg-bg-hover"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="shrink-0 text-text-tertiary">{open ? Icons.chevronDown(14) : Icons.chevronRight(14)}</span>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-blue-subtle text-text-accent">{Icons.workflow(15)}</span>
                  <span className="truncate text-sm font-semibold text-text-primary">{group.workflowName}</span>
                </span>
                <span className="text-xs text-text-secondary">{t('center.assets.runs.runCount', { n: group.runs.length })}</span>
                <span className="font-mono text-xs text-text-secondary">{formatWorkflowRunShortTimestamp(group.runs[0]?.created_at ?? '')}</span>
              </button>
              {open ? group.runs.map((run) => {
                const status = runStatus(t, run)
                const canDelete = ['completed', 'failed', 'cancelled'].includes(run.status)
                return (
                  <div key={run.id} className="relative border-t border-border-subtle bg-bg-app">
                    <button
                      type="button"
                      onClick={() => onPreviewRun(run)}
                      className="grid w-full grid-cols-[minmax(0,1fr)_110px_150px] items-center gap-3 px-4 py-2.5 pl-14 pr-44 text-left hover:bg-bg-hover"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-text-primary">
                          <StructuredInput blocks={workflowRunInputBlocks(run)} />
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-2xs text-text-tertiary">{run.id}</span>
                      </span>
                      <span className={cn('w-fit rounded-full px-2 py-0.5 text-2xs font-semibold', status.tone)}>{status.label}</span>
                      <span className="font-mono text-xs text-text-secondary">{formatWorkflowRunShortTimestamp(run.created_at)}</span>
                    </button>
                    {run.status === 'completed' ? (
                      <button
                        type="button"
                        onClick={() => onUseRun(run)}
                        className="absolute right-12 top-1/2 inline-flex h-7 -translate-y-1/2 items-center gap-1 rounded-md bg-brand-blue px-2.5 text-xs font-semibold text-white hover:opacity-90"
                        aria-label={t('center.assets.runs.useInNewSessionAria', { id: run.id })}
                      >
                        {Icons.at(11)} {t('center.assets.runs.useInNewSession')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={!canDelete}
                      onClick={() => onDeleteRun(run)}
                      className={cn(
                        'absolute right-3 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md',
                        canDelete
                          ? 'text-text-tertiary hover:bg-status-error-bg hover:text-status-error'
                          : 'cursor-not-allowed text-text-disabled',
                      )}
                      aria-label={t('center.assets.runs.deleteRunAria', { id: run.id })}
                    >
                      {Icons.trash(13)}
                    </button>
                  </div>
                )
              }) : null}
            </div>
          )
          }}
        </WindowedList>
        )}
      </div>
    </section>
  )
}

export function CenterAssets() {
  const { t } = useTranslation()
  const sessionFiles = useAtomValue(sessionFileAssetsAtom)
  const workflowRuns = useAtomValue(workflowRunsAtom)
  const hydrationState = useAtomValue(assetsHydrationStateAtom)
  const hydrationError = useAtomValue(assetsHydrationErrorAtom)
  const hydrate = useSetAtom(hydrateAssetsAtom)
  const deleteWorkflowRun = useSetAtom(deleteWorkflowRunAtom)
  const openWorkflowResultSession = useSetAtom(useWorkflowResultAtom)
  const openModal = useSetAtom(openModalAtom)
  const selectSession = useSetAtom(selectSessionAtom)
  const selectNav = useSetAtom(selectNavAtom)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleFiles = useMemo(() => {
    if (!normalizedQuery) return sessionFiles
    return sessionFiles.filter((asset) => [
      asset.name,
      asset.path,
      asset.session_title,
      asset.session_id,
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
  }, [normalizedQuery, sessionFiles])

  const workflowGroups = useMemo(() => {
    const grouped = new Map<string, WorkflowResultGroup>()
    for (const run of workflowRuns) {
      const current = grouped.get(run.workflow_name)
      if (current) current.runs.push(run)
      else grouped.set(run.workflow_name, {
        key: run.workflow_name,
        workflowName: run.workflow_name,
        runs: [run],
      })
    }
    return [...grouped.values()]
      .map((group) => {
        group.runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        if (!normalizedQuery || group.workflowName.toLocaleLowerCase().includes(normalizedQuery)) return group
        const runs = group.runs.filter((run) => [
          run.id,
          run.workflow_input.text,
          run.source_session_id,
        ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
        return { ...group, runs }
      })
      .filter((group) => group.runs.length > 0)
      .sort((a, b) => Date.parse(b.runs[0]?.created_at ?? '') - Date.parse(a.runs[0]?.created_at ?? ''))
  }, [normalizedQuery, workflowRuns])

  const openSession = (sessionId: string) => {
    selectSession(sessionId)
    selectNav(NavKey.Home)
  }

  return (
    <CenterPageLayout
      title={t('center.common.myAssets')}
      subtitle={t('center.assets.subtitle')}
      actions={
        <>
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder={t('center.assets.searchPlaceholder')}
          />
          {/* The page-level "loading" line only renders while there is nothing to
              show (`sessionFiles.length === 0 && ...`) — deliberately, so a
              refresh never blanks out content you are reading. That left the
              button as the only place a refresh could be seen at all. */}
          <RefreshButton onRefresh={hydrate} label={t('center.common.refresh')} />
        </>
      }
    >
      <>
        {hydrationState === 'loading' && sessionFiles.length === 0 && workflowRuns.length === 0 ? (
          <EmptyState title={t('center.assets.loading')} />
        ) : null}
        {hydrationError ? (
          <div className="mb-4 flex items-center justify-between rounded-md bg-status-error-bg px-4 py-2.5 text-sm text-status-error">
            <span>{hydrationError}</span>
            <button type="button" onClick={() => void hydrate()} className="font-semibold hover:underline">{t('center.common.retry')}</button>
          </div>
        ) : null}
        <SessionFilesTable assets={visibleFiles} onOpenSession={openSession} />
        <WorkflowResultsTree
          groups={workflowGroups}
          queryActive={Boolean(normalizedQuery)}
          onPreviewRun={(run) => openModal({
            type: ModalKind.WorkflowRunDetail,
            runId: run.id,
            composerTarget: ComposerTarget.NewSession,
          })}
          onUseRun={(run) => openWorkflowResultSession({
            result: {
              id: run.id,
              workflowName: run.workflow_name,
              createdAt: run.created_at,
            },
            composerTarget: ComposerTarget.NewSession,
          })}
          onDeleteRun={(run) => void deleteWorkflowRun(run)}
        />
      </>
    </CenterPageLayout>
  )
}
