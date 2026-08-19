import { useAtomValue, useSetAtom } from 'jotai'
import {
  BookOpenText,
  CheckCircle2,
  ClipboardList,
  Compass,
  Download,
  FileCheck2,
  FileCode2,
  FileText,
  ListTree,
  RefreshCw,
  Settings2,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  hydrateWorkflowDetailAtom,
  exportWorkflowAtom,
  workflowDetailsAtom,
} from '@/atoms/workflows'
import { ComposerTarget, type ComposerTarget as ComposerTargetType } from '@/atoms/amphi'
import { runWorkflowAtom } from '@/atoms/workflow-session'
import { CodeBlock } from '@/components/markdown/CodeBlock'
import { MarkdownMessage } from '@/components/markdown/MarkdownMessage'
import type { WorkflowDetail } from '@/lib/amphiClient'
import { cn } from '@/lib/cn'
import { Icons } from './Icons'
import { Modal } from './Modal'
import { Tooltip } from './Tooltip'

export interface WorkflowDetailProps {
  workflowId?: string
  name?: string
  composerTarget?: ComposerTargetType
  onClose?: () => void
}

type WorkflowDocumentKind = 'markdown' | 'code'

interface WorkflowDocument {
  id: string
  label: string
  path: string
  content: string
  kind: WorkflowDocumentKind
  icon: LucideIcon
  language?: string
}

interface OutlineHeading {
  id: string
  level: number
  text: string
}

/** Display a saved Workflow as navigable documents, source files, and outlines. */
export function WorkflowDetailModal({
  workflowId,
  name,
  composerTarget = ComposerTarget.CurrentSession,
  onClose,
}: WorkflowDetailProps) {
  const { t } = useTranslation()
  const details = useAtomValue(workflowDetailsAtom)
  const hydrateDetail = useSetAtom(hydrateWorkflowDetailAtom)
  const exportWorkflow = useSetAtom(exportWorkflowAtom)
  const runWorkflow = useSetAtom(runWorkflowAtom)
  const detail = workflowId ? details[workflowId] : undefined
  const [loadError, setLoadError] = useState('')
  const [activeTab, setActiveTab] = useState(0)

  useEffect(() => {
    if (!workflowId) return
    let cancelled = false
    hydrateDetail({ workflowId })
      .then(() => {
        if (!cancelled) setLoadError('')
      })
      .catch(() => {
        if (!cancelled) setLoadError(t('workflow.detail.loadError'))
      })
    return () => {
      cancelled = true
    }
  }, [hydrateDetail, t, workflowId])

  const title = detail?.name || name || t('workflow.detail.title')
  const runnableName = detail?.name || name
  const description = detail?.info?.desc?.trim()

  return (
    <Modal
      width={1240}
      onClose={onClose}
      tabs={[t('workflow.detail.tabs.info'), t('workflow.detail.tabs.runtime')]}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      contentStyle={{ overflow: 'hidden' }}
      customHeader={
        <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-5 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-blue-subtle text-text-accent">
            {Icons.workflow(20)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-lg font-semibold text-text-primary">{title}</div>
            <div className="mt-0.5 truncate text-sm text-text-secondary">
              {description || workflowId || t('workflow.detail.savedWorkflow')}
            </div>
          </div>
          {workflowId ? (
            <>
              <button
                type="button"
                aria-label={t('workflow.detail.runAria', { name: title })}
                disabled={!runnableName}
                onClick={() => {
                  if (!runnableName) return
                  runWorkflow({
                    workflow: { id: workflowId, name: runnableName },
                    composerTarget,
                  })
                  onClose?.()
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-blue px-3 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
              >
                {Icons.play(13)} {composerTarget === ComposerTarget.NewSession ? t('workflow.detail.runInNewSession') : t('workflow.detail.run')}
              </button>
              <button
                type="button"
                onClick={() => void exportWorkflow({ workflowId, name: title })}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-default px-3 text-xs font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              >
                <Download size={13} /> {t('workflow.detail.export')}
              </button>
            </>
          ) : null}
          <Tooltip content={t('workflow.detail.close')}>
            <button
              type="button"
              aria-label={t('workflow.detail.closeAria')}
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
            >
              {Icons.x(18)}
            </button>
          </Tooltip>
        </div>
      }
    >
      <WorkflowDetailBody
        workflowId={workflowId}
        detail={detail}
        loadError={loadError}
        activeTab={activeTab}
      />
    </Modal>
  )
}

function WorkflowDetailBody({
  workflowId,
  detail,
  loadError,
  activeTab,
}: {
  workflowId?: string
  detail?: WorkflowDetail
  loadError: string
  activeTab: number
}) {
  const { t } = useTranslation()
  if (!workflowId) return <WorkflowDetailState text={t('workflow.detail.selectWorkflow')} />
  if (loadError && !detail) return <WorkflowDetailState text={loadError} />
  if (!detail) return <WorkflowDetailState text={t('workflow.detail.loading')} />
  if (activeTab === 0) return <WorkflowDetailView detail={detail} loadError={loadError} />
  if (activeTab === 1) {
    return (
      <WorkflowDetailEmptyState
        icon={Settings2}
        title={t('workflow.detail.runtimeEmpty.title')}
        description={t('workflow.detail.runtimeEmpty.description')}
      />
    )
  }
  return <WorkflowDetailView detail={detail} loadError={loadError} />
}

function WorkflowDetailState({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-[68vh] max-h-[680px] flex-col items-center justify-center gap-3 text-sm text-text-secondary">
      <span>{text}</span>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-default px-3 text-xs font-semibold hover:bg-bg-hover">
          <RefreshCw size={13} /> {t('workflow.detail.retry')}
        </button>
      ) : null}
    </div>
  )
}

function WorkflowDetailEmptyState({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return (
    <div className="flex h-[68vh] max-h-[680px] min-h-[420px] items-center justify-center px-8 text-center">
      <div className="flex max-w-sm flex-col items-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-md border border-border-subtle bg-bg-app text-text-tertiary">
          <Icon size={20} strokeWidth={1.7} />
        </span>
        <div className="mt-3 text-sm font-semibold text-text-primary">{title}</div>
        <div className="mt-1 text-sm text-text-tertiary">{description}</div>
      </div>
    </div>
  )
}

export function WorkflowDetailView({ detail, loadError }: { detail: WorkflowDetail; loadError: string }) {
  const { t, i18n } = useTranslation()
  const { sourceDocuments, scriptFiles, buildDocuments } = useMemo(() => {
    const result: { sourceDocuments: WorkflowDocument[]; scriptFiles: WorkflowDocument[]; buildDocuments: WorkflowDocument[] } = {
      sourceDocuments: [],
      scriptFiles: [],
      buildDocuments: [],
    }
    const program = detail.fields.program
    const files = program?.files ?? []
    const normalizePath = (path: string) => path.replace(/\\/g, '/')
    const isPreviewableProgram = (path: string, content: string) => {
      const normalized = path.toLowerCase()
      return !normalized.split('/').includes('__pycache__')
        && !/\.(?:py[co]|class|o|so|dylib|dll|exe)$/.test(normalized)
        && !normalized.endsWith('/.ds_store')
        && !content.includes('\0')
    }
    const entry = files.find((file) => normalizePath(file.path).toLowerCase() === 'workflow.md')
    const validation = files.find((file) => normalizePath(file.path).toLowerCase() === 'validate.md')

    const stripFrontmatter = (content: string): string => {
      const lines = content.split(/\r?\n/)
      if (lines[0]?.trim() !== '---') return content.trim()
      const end = lines.slice(1).findIndex((line) => line.trim() === '---')
      return end < 0 ? content.trim() : lines.slice(end + 2).join('\n').trim()
    }

    const addBuildDocument = (id: string, label: string, path: string, content: string | null | undefined, icon: LucideIcon) => {
      const body = content?.trim()
      if (body) result.buildDocuments.push({ id, label, path, content: body, kind: 'markdown', icon })
    }

    if (entry?.content.trim()) {
      result.sourceDocuments.push({
        id: 'source:workflow',
        label: t('workflow.detail.source.taskFlow'),
        path: 'WORKFLOW.md',
        content: stripFrontmatter(entry.content),
        kind: 'markdown',
        icon: BookOpenText,
      })
    } else if (program?.readme?.trim()) {
      result.sourceDocuments.push({
        id: 'source:readme',
        label: t('workflow.detail.source.taskFlow'),
        path: 'README',
        content: program.readme.trim(),
        kind: 'markdown',
        icon: BookOpenText,
      })
    }
    if (validation?.content.trim()) {
      result.sourceDocuments.push({
        id: 'source:validate',
        label: t('workflow.detail.source.validation'),
        path: 'VALIDATE.md',
        content: stripFrontmatter(validation.content),
        kind: 'markdown',
        icon: FileCheck2,
      })
    }
    addBuildDocument('task', t('workflow.detail.build.task'), 'task.md', detail.fields.task?.value, ClipboardList)
    addBuildDocument('explore', t('workflow.detail.build.explore'), 'explore.md', detail.fields.explore?.value, Compass)
    addBuildDocument('verify', t('workflow.detail.build.verify'), 'verify.md', detail.fields.verify?.value, FileCheck2)

    const languages: Record<string, string> = {
      c: 'c',
      cpp: 'cpp',
      css: 'css',
      go: 'go',
      html: 'html',
      js: 'javascript',
      json: 'json',
      jsx: 'jsx',
      md: 'markdown',
      py: 'python',
      rs: 'rust',
      sh: 'shell',
      sql: 'sql',
      ts: 'typescript',
      tsx: 'tsx',
      yaml: 'yaml',
      yml: 'yaml',
    }
    for (const file of files) {
      const path = normalizePath(file.path)
      if (path.toLowerCase() === 'workflow.md' || path.toLowerCase() === 'validate.md') continue
      if (!isPreviewableProgram(path, file.content)) continue
      const filename = path.split('/').at(-1) || path
      const extension = filename.includes('.') ? filename.split('.').at(-1)?.toLowerCase() ?? '' : ''
      const markdown = extension === 'md' || extension === 'mdx'
      result.scriptFiles.push({
        id: `source:${path}`,
        label: filename,
        path,
        content: file.content,
        kind: markdown ? 'markdown' : 'code',
        icon: markdown ? FileText : FileCode2,
        language: file.language || languages[extension] || 'text',
      })
    }
    return result
  }, [detail, t])

  const entries = [...sourceDocuments, ...scriptFiles, ...buildDocuments]
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [scriptsOpen, setScriptsOpen] = useState(false)
  const selected = entries.find((entry) => entry.id === selectedId)
    ?? buildDocuments.find((entry) => entry.id === 'task')
    ?? entries[0]
  const createdAt = detail.info?.created_at
    ? new Intl.DateTimeFormat(i18n.language, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(detail.info.created_at))
    : null

  if (!selected) return <WorkflowDetailState text={t('workflow.detail.noPreview')} />

  return (
    <div className="flex h-[68vh] max-h-[680px] min-h-0 flex-col">
      {loadError ? <div className="shrink-0 bg-status-error-bg px-5 py-2 text-xs text-status-error">{loadError}</div> : null}
      <div className="flex shrink-0 items-center justify-between gap-5 border-b border-border-subtle px-5 py-3 text-xs text-text-secondary">
        <div className="min-w-0 truncate font-mono text-text-tertiary">{detail.id}</div>
        <div className="flex shrink-0 items-center gap-4">
          <span>{t('workflow.detail.counts.instructions', { count: sourceDocuments.length })}</span>
          {scriptFiles.length > 0 ? <span>{t('workflow.detail.counts.scriptFiles', { count: scriptFiles.length })}</span> : null}
          <span>{t('workflow.detail.counts.buildDocuments', { count: buildDocuments.length })}</span>
          {createdAt ? <span>{createdAt}</span> : null}
          <span className="inline-flex items-center gap-1 font-semibold text-status-success">
            <CheckCircle2 size={13} strokeWidth={1.8} /> {t('workflow.detail.saved')}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <aside className="w-[220px] shrink-0 overflow-y-auto border-r border-border-subtle bg-bg-app p-2.5 max-md:max-h-[148px] max-md:w-full max-md:overflow-x-auto max-md:border-b max-md:border-r-0">
          <div className="max-md:flex max-md:w-max max-md:gap-2">
            {buildDocuments.length > 0 ? (
              <WorkflowNavGroup label={t('workflow.detail.buildDocumentsLabel', { count: buildDocuments.length })} entries={buildDocuments} selectedId={selected.id} onSelect={setSelectedId} />
            ) : null}
            <WorkflowSourceNavGroup
              documents={sourceDocuments}
              scripts={scriptFiles}
              scriptsOpen={scriptsOpen}
              selectedId={selected.id}
              onSelect={setSelectedId}
              onToggleScripts={() => {
                if (scriptsOpen && scriptFiles.some((entry) => entry.id === selected.id)) {
                  setSelectedId(sourceDocuments[0]?.id ?? buildDocuments[0]?.id ?? null)
                }
                setScriptsOpen((open) => !open)
              }}
            />
          </div>
        </aside>
        <WorkflowDocumentReader key={selected.id} entry={selected} />
      </div>
    </div>
  )
}

function WorkflowSourceNavGroup({
  documents,
  scripts,
  scriptsOpen,
  selectedId,
  onSelect,
  onToggleScripts,
}: {
  documents: WorkflowDocument[]
  scripts: WorkflowDocument[]
  scriptsOpen: boolean
  selectedId: string
  onSelect: (id: string) => void
  onToggleScripts: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="mb-4 last:mb-0 max-md:mb-0 max-md:flex max-md:gap-1.5">
      <div className="px-2 py-1.5 text-xs font-semibold text-text-tertiary max-md:hidden">
        {t('workflow.detail.sourceFilesLabel', { count: documents.length + scripts.length })}
      </div>
      {documents.map((entry) => (
        <WorkflowNavItem key={entry.id} entry={entry} selected={entry.id === selectedId} onSelect={onSelect} />
      ))}
      {scripts.length > 0 ? (
        <>
          <button
            type="button"
            aria-label={t(scriptsOpen ? 'workflow.detail.collapseScriptsAria' : 'workflow.detail.expandScriptsAria')}
            aria-expanded={scriptsOpen}
            onClick={onToggleScripts}
            className="mb-0.5 flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-text-secondary hover:bg-bg-hover max-md:mb-0 max-md:w-[158px] max-md:shrink-0"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-subtle bg-bg-surface text-text-tertiary">
              <FileCode2 size={14} strokeWidth={1.7} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-text-primary">{t('workflow.detail.scriptFiles')}</span>
              <span className="mt-0.5 block text-xs text-text-tertiary">{t('workflow.detail.counts.implementationFiles', { count: scripts.length })}</span>
            </span>
            <span className={cn('shrink-0 text-text-tertiary transition-transform', scriptsOpen && 'rotate-90')}>
              {Icons.chevronRight(14)}
            </span>
          </button>
          {scriptsOpen ? scripts.map((entry) => (
            <div key={entry.id} className="pl-3 max-md:pl-0">
              <WorkflowNavItem entry={entry} selected={entry.id === selectedId} onSelect={onSelect} />
            </div>
          )) : null}
        </>
      ) : null}
    </div>
  )
}

function WorkflowNavGroup({
  label,
  entries,
  selectedId,
  onSelect,
}: {
  label: string
  entries: WorkflowDocument[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  return (
    <div className="mb-4 last:mb-0 max-md:mb-0 max-md:flex max-md:gap-1.5">
      <div className="px-2 py-1.5 text-xs font-semibold text-text-tertiary max-md:hidden">{label}</div>
      {entries.map((entry) => (
        <WorkflowNavItem key={entry.id} entry={entry} selected={entry.id === selectedId} onSelect={onSelect} />
      ))}
    </div>
  )
}

function WorkflowNavItem({
  entry,
  selected,
  onSelect,
}: {
  entry: WorkflowDocument
  selected: boolean
  onSelect: (id: string) => void
}) {
  const Icon = entry.icon
  return (
    <button
      type="button"
      onClick={() => onSelect(entry.id)}
      className={cn(
        'mb-0.5 flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-2 text-left max-md:mb-0 max-md:w-[158px] max-md:shrink-0',
        selected ? 'bg-accent-blue-subtle text-text-accent' : 'text-text-secondary hover:bg-bg-hover',
      )}
    >
      <span className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-bg-surface',
        selected ? 'border-brand-blue/20 text-text-accent' : 'border-border-subtle text-text-tertiary',
      )}>
        <Icon size={14} strokeWidth={1.7} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-sm font-semibold', selected ? 'text-text-accent' : 'text-text-primary')}>{entry.label}</span>
        <span className="mt-0.5 block truncate font-mono text-xs text-text-tertiary">{entry.path}</span>
      </span>
    </button>
  )
}

function WorkflowDocumentReader({ entry }: { entry: WorkflowDocument }) {
  const { t, i18n } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [outline, setOutline] = useState<OutlineHeading[]>([])
  const [activeHeading, setActiveHeading] = useState<string | null>(null)
  const [outlineOpen, setOutlineOpen] = useState(false)

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content || entry.kind !== 'markdown') {
      setOutline([])
      setActiveHeading(null)
      return
    }

    const prefix = entry.id.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'document'
    const elements = Array.from(content.querySelectorAll<HTMLElement>('h1, h2, h3, h4'))
      .filter((element) => Boolean(element.textContent?.trim()))
    const headings = elements.map((element, index) => {
      const id = `workflow-${prefix}-heading-${index}`
      element.id = id
      element.style.scrollMarginTop = '24px'
      return { id, level: Number(element.tagName.slice(1)), text: element.textContent?.trim() || '' }
    })
    setOutline(headings)
    setActiveHeading(headings[0]?.id ?? null)

    let frame: number | null = null
    const updateActiveHeading = () => {
      frame = null
      const threshold = scroll.getBoundingClientRect().top + 40
      let current = headings[0]?.id ?? null
      for (let index = 0; index < elements.length; index += 1) {
        const element = elements[index]
        if (!element || element.getBoundingClientRect().top > threshold) break
        current = headings[index]?.id ?? current
      }
      setActiveHeading(current)
    }
    const handleScroll = () => {
      if (frame === null) frame = window.requestAnimationFrame(updateActiveHeading)
    }
    scroll.addEventListener('scroll', handleScroll, { passive: true })
    updateActiveHeading()
    return () => {
      scroll.removeEventListener('scroll', handleScroll)
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [entry.content, entry.id, entry.kind])

  const selectHeading = (heading: OutlineHeading) => {
    contentRef.current?.querySelector<HTMLElement>(`#${heading.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActiveHeading(heading.id)
    setOutlineOpen(false)
  }
  const metric = entry.kind === 'code'
    ? t('workflow.detail.metrics.lines', { count: entry.content ? entry.content.split(/\r?\n/).length : 0 })
    : t('workflow.detail.metrics.characters', { count: entry.content.length.toLocaleString(i18n.language) })
  const showOutline = outline.length > 1

  return (
    <div className="relative flex min-w-0 flex-1 bg-bg-surface">
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-6 py-3">
          <div className="min-w-0">
            <div className="truncate text-md font-semibold text-text-primary">{entry.label}</div>
            <div className="mt-0.5 truncate font-mono text-xs text-text-tertiary">{entry.path}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs text-text-tertiary">
            <span>{metric}</span>
            {showOutline ? (
              <Tooltip content={t('workflow.detail.outline')}>
                <button
                  type="button"
                  aria-label={t('workflow.detail.openOutlineAria')}
                  aria-expanded={outlineOpen}
                  onClick={() => setOutlineOpen((open) => !open)}
                  className="hidden h-7 w-7 items-center justify-center rounded-md hover:bg-bg-hover hover:text-text-accent max-xl:flex"
                >
                  <ListTree size={15} strokeWidth={1.8} />
                </button>
              </Tooltip>
            ) : null}
          </div>
        </div>

        {showOutline && outlineOpen ? (
          <div className="absolute right-4 top-14 z-30 max-h-[70%] w-64 overflow-y-auto rounded-md border border-border-default bg-bg-elevated p-2 shadow-lg xl:hidden">
            <WorkflowOutline headings={outline} activeHeading={activeHeading} onSelect={selectHeading} />
          </div>
        ) : null}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-8 py-7 max-md:px-5 max-md:py-5">
          <div ref={contentRef} className={cn('mx-auto', entry.kind === 'markdown' ? 'max-w-[720px]' : 'max-w-[920px]')}>
            {entry.kind === 'markdown' ? (
              <MarkdownMessage
                content={entry.content}
                className={cn(
                  'text-md leading-7 text-text-primary',
                  '[&_p]:my-3 [&_li]:my-1',
                  '[&_h1]:mb-7 [&_h1]:mt-0 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:leading-[1.35]',
                  '[&_h2]:mb-3 [&_h2]:mt-9 [&_h2]:text-lg [&_h2]:font-semibold',
                  '[&_h3]:mb-2 [&_h3]:mt-7 [&_h3]:text-base [&_h3]:font-semibold',
                  '[&_h4]:mb-2 [&_h4]:mt-5 [&_h4]:text-sm [&_h4]:font-semibold',
                  '[&_table]:text-sm [&_th]:px-3 [&_th]:py-2 [&_td]:px-3 [&_td]:py-2',
                  '[&_svg]:h-auto [&_svg]:max-w-full',
                )}
              />
            ) : (
              <CodeBlock code={entry.content} lang={entry.language || 'text'} />
            )}
          </div>
        </div>
      </main>

      {showOutline ? (
        <aside className="hidden w-[190px] shrink-0 overflow-y-auto border-l border-border-subtle bg-bg-surface p-3 xl:block">
          <WorkflowOutline headings={outline} activeHeading={activeHeading} onSelect={selectHeading} />
        </aside>
      ) : null}
    </div>
  )
}

function WorkflowOutline({ headings, activeHeading, onSelect }: { headings: OutlineHeading[]; activeHeading: string | null; onSelect: (heading: OutlineHeading) => void }) {
  const { t } = useTranslation()
  const minimumLevel = Math.min(...headings.map((heading) => heading.level))
  return (
    <div>
      <div className="px-2 py-1.5 text-xs font-semibold text-text-tertiary">{t('workflow.detail.thisDocumentOutline')}</div>
      {headings.map((heading) => {
        const active = heading.id === activeHeading
        return (
          <button
            key={heading.id}
            type="button"
            onClick={() => onSelect(heading)}
            className={cn(
              'relative block w-full truncate rounded-sm py-1.5 pr-2 text-left text-xs leading-5',
              active ? 'bg-accent-blue-subtle font-semibold text-text-accent' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
            style={{ paddingLeft: 10 + Math.min(heading.level - minimumLevel, 3) * 12 }}
          >
            {active ? <span className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-brand-blue" /> : null}
            {heading.text}
          </button>
        )
      })}
      <div className="mx-2 mt-3 border-t border-border-subtle pt-3 text-xs text-text-tertiary">{t('workflow.detail.counts.sections', { count: headings.length })}</div>
    </div>
  )
}
