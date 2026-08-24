import { useAtomValue, useSetAtom } from 'jotai'
import { Download, ExternalLink, FileOutput, MessageSquarePlus, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  exportWorkflowRunAtom,
  hydrateWorkflowRunDetailAtom,
  hydrateWorkflowRunFileAtom,
  loadWorkflowRunRawFileAtom,
  workflowRunDetailsAtom,
  workflowRunFilesAtom,
} from '@/atoms/workflows'
import { ComposerTarget, type ComposerTarget as ComposerTargetType } from '@/atoms/amphi'
import { useWorkflowResultAtom } from '@/atoms/workflow-session'
import { CodeBlock } from '@/components/markdown/CodeBlock'
import { MarkdownMessage } from '@/components/markdown/MarkdownMessage'
import type {
  WorkflowRunDetail,
  WorkflowRunFile,
  WorkflowRunFileContent,
  WorkflowRunRawFile,
  WorkflowRunSummary,
} from '@/lib/amphiClient'
import { cn } from '@/lib/cn'
import { workflowRunInputBlocks } from '@/lib/workflowRun'
import { Icons } from './Icons'
import { Modal } from './Modal'
import { Tooltip } from './Tooltip'
import { StructuredInput } from './StructuredInput'

export interface WorkflowRunDetailProps {
  runId: string
  initialFilePath?: string
  composerTarget?: ComposerTargetType
  onClose?: () => void
}

type RawPreviewKind = 'image' | 'pdf'

interface RawPreview {
  file: WorkflowRunRawFile
  url: string
}

const TEXT_PREVIEW_SUFFIXES = new Set(['txt', 'md', 'json', 'csv', 'tsv', 'yaml', 'yml'])
const IMAGE_PREVIEW_SUFFIXES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico'])

function fileSuffix(path: string): string {
  return path.split('.').at(-1)?.toLowerCase() ?? ''
}

function rawPreviewKind(file?: WorkflowRunFile): RawPreviewKind | null {
  if (!file) return null
  const suffix = fileSuffix(file.path)
  if (IMAGE_PREVIEW_SUFFIXES.has(suffix)) return 'image'
  if (suffix === 'pdf') return 'pdf'
  return null
}

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

function workflowRunFilePath(runDir: string, relativePath: string): string {
  const separator = runDir.includes('\\') ? '\\' : '/'
  const root = runDir.replace(/[\\/]+$/, '')
  const child = relativePath.replace(/^[\\/]+/, '').replace(/[\\/]+/g, separator)
  return `${root}${separator}${child}`
}

/** Display one durable Workflow Run without depending on its source definition. */
export function WorkflowRunDetailModal({
  runId,
  initialFilePath,
  composerTarget = ComposerTarget.CurrentSession,
  onClose,
}: WorkflowRunDetailProps) {
  const { t, i18n } = useTranslation()
  const details = useAtomValue(workflowRunDetailsAtom)
  const hydrateRunDetail = useSetAtom(hydrateWorkflowRunDetailAtom)
  const insertWorkflowResult = useSetAtom(useWorkflowResultAtom)
  const detail = details[runId]
  const [detailError, setDetailError] = useState('')
  const [detailReloadKey, setDetailReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    hydrateRunDetail({ runId })
      .then(() => {
        if (!cancelled) setDetailError('')
      })
      .catch(() => {
        if (!cancelled) setDetailError(t('workflow.runDetail.loadError'))
      })
    return () => {
      cancelled = true
    }
  }, [detailReloadKey, hydrateRunDetail, runId, t])

  useEffect(() => {
    if (detail?.status !== 'running' && detail?.status !== 'waiting') return
    let cancelled = false
    const timer = window.setInterval(() => {
      hydrateRunDetail({ runId })
        .then(() => {
          if (!cancelled) setDetailError('')
        })
        .catch(() => {
          if (!cancelled) setDetailError(t('workflow.runDetail.refreshError'))
        })
    }, 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [detail?.status, hydrateRunDetail, runId, t])

  const referenceRun = (run: WorkflowRunDetail) => {
    insertWorkflowResult({
      result: {
        id: run.id,
        workflowName: run.workflow_name,
        createdAt: run.created_at,
      },
      composerTarget,
    })
    onClose?.()
  }

  const title = detail?.workflow_name || t('workflow.runDetail.title')
  const subtitle = detail
    ? `${formatWorkflowRunShortTimestamp(detail.created_at, i18n.language)} · ${detail.id}`
    : runId
  const referenceable = detail?.status === 'completed' || detail?.status === 'failed'

  return (
    <Modal
      width={1240}
      onClose={onClose}
      contentStyle={{ overflow: 'hidden' }}
      customHeader={
        <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-5 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-blue-subtle text-text-accent">
            {Icons.workflow(20)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-lg font-semibold text-text-primary">{title}</div>
            <div className="mt-0.5 truncate text-sm text-text-secondary">{subtitle}</div>
          </div>
          <Tooltip content={t('workflow.runDetail.close')}>
            <button
              type="button"
              aria-label={t('workflow.runDetail.closeAria')}
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
            >
              {Icons.x(18)}
            </button>
          </Tooltip>
        </div>
      }
    >
      {!detail && detailError ? (
        <WorkflowRunState
          text={detailError}
          onRetry={() => setDetailReloadKey((key) => key + 1)}
        />
      ) : null}
      {!detail && !detailError ? <WorkflowRunState text={t('workflow.runDetail.loading')} /> : null}
      {detail ? (
        <WorkflowRunReader
          key={detail.id}
          run={detail}
          initialFilePath={initialFilePath}
          detailError={detailError}
          onRetryDetail={() => setDetailReloadKey((key) => key + 1)}
          onReference={referenceable ? () => referenceRun(detail) : undefined}
          referenceLabel={
            composerTarget === ComposerTarget.NewSession ? t('workflow.runDetail.useInNewSession') : t('workflow.common.useResult')
          }
        />
      ) : null}
    </Modal>
  )
}

function WorkflowRunState({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-[68vh] max-h-[680px] flex-col items-center justify-center gap-3 text-sm text-text-secondary">
      <span>{text}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-default px-3 text-xs font-semibold hover:bg-bg-hover"
        >
          <RefreshCw size={13} /> {t('workflow.runDetail.retry')}
        </button>
      ) : null}
    </div>
  )
}

function WorkflowRunReader({
  run,
  initialFilePath,
  detailError,
  onRetryDetail,
  onReference,
  referenceLabel,
}: {
  run: WorkflowRunDetail
  initialFilePath?: string
  detailError: string
  onRetryDetail: () => void
  onReference?: () => void
  referenceLabel: string
}) {
  const { t, i18n } = useTranslation()
  const files = useAtomValue(workflowRunFilesAtom)
  const exportWorkflowRun = useSetAtom(exportWorkflowRunAtom)
  const hydrateFile = useSetAtom(hydrateWorkflowRunFileAtom)
  const loadRawFile = useSetAtom(loadWorkflowRunRawFileAtom)
  const [selectedPath, setSelectedPath] = useState<string | null>(initialFilePath ?? null)
  const resultFiles = run.files.filter((file) => file.path.startsWith('result/'))
  const workFiles = run.files.filter((file) => file.path.startsWith('background/work/'))
  const otherFiles = run.files.filter(
    (file) => !file.path.startsWith('result/') && !file.path.startsWith('background/work/'),
  )
  const orderedFiles = [...resultFiles, ...workFiles, ...otherFiles]
  const fileGroups = [
    {
      key: 'result',
      label: t('workflow.runDetail.resultFilesLabel', { count: resultFiles.length }),
      files: resultFiles,
    },
    {
      key: 'work',
      label: t('workflow.runDetail.workFilesLabel', { count: workFiles.length }),
      files: workFiles,
    },
    {
      key: 'other',
      label: t('workflow.runDetail.otherFilesLabel', { count: otherFiles.length }),
      files: otherFiles,
    },
  ].filter((group) => group.files.length > 0)
  const selectedFile = orderedFiles.find((file) => file.path === selectedPath) ?? orderedFiles[0]
  const selectedFileKey = selectedFile ? `${run.id}:${selectedFile.path}` : ''
  const selectedFileContent = selectedFileKey ? files[selectedFileKey] : undefined
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({})
  const [rawPreviews, setRawPreviews] = useState<Record<string, RawPreview>>({})
  const [rawPreviewErrors, setRawPreviewErrors] = useState<Record<string, string>>({})
  const [openingKey, setOpeningKey] = useState<string | null>(null)
  const [openErrors, setOpenErrors] = useState<Record<string, string>>({})
  const [exporting, setExporting] = useState(false)
  const previewUrls = useRef(new Set<string>())
  const previewKind = rawPreviewKind(selectedFile)
  const selectedFileIsText = Boolean(
    selectedFile && TEXT_PREVIEW_SUFFIXES.has(fileSuffix(selectedFile.path)),
  )
  const rawPreview = rawPreviews[selectedFileKey]
  const rawPreviewError = rawPreviewErrors[selectedFileKey] ?? ''

  useEffect(() => {
    if (!selectedFile || !selectedFileIsText || fileErrors[selectedFileKey]) return
    let cancelled = false
    hydrateFile({ runId: run.id, path: selectedFile.path }).catch(() => {
      if (!cancelled) {
        setFileErrors((current) => ({ ...current, [selectedFileKey]: t('workflow.runDetail.fileLoadError') }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [fileErrors, hydrateFile, run.id, selectedFile, selectedFileIsText, selectedFileKey, t])

  useEffect(() => {
    if (!selectedFile || !previewKind || rawPreview || rawPreviewError) return
    let cancelled = false
    loadRawFile({ runId: run.id, path: selectedFile.path })
      .then((file) => {
        if (cancelled) return
        const url = URL.createObjectURL(new Blob([file.content], { type: file.mime }))
        previewUrls.current.add(url)
        setRawPreviews((current) => ({ ...current, [selectedFileKey]: { file, url } }))
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRawPreviewErrors((current) => ({
            ...current,
            [selectedFileKey]: err instanceof Error ? err.message : t('workflow.runDetail.rawPreviewLoadError'),
          }))
        }
      })
    return () => {
      cancelled = true
    }
  }, [loadRawFile, previewKind, rawPreview, rawPreviewError, run.id, selectedFile, selectedFileKey, t])

  useEffect(() => {
    const urls = previewUrls.current
    return () => {
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
    }
  }, [])

  const selectedFileError = fileErrors[selectedFileKey] ?? ''
  const retryFile = () => {
    setFileErrors((current) => {
      const next = { ...current }
      delete next[selectedFileKey]
      return next
    })
  }
  const retryRawPreview = () => {
    setRawPreviewErrors((current) => {
      const next = { ...current }
      delete next[selectedFileKey]
      return next
    })
  }
  const openSelectedFile = async () => {
    if (!selectedFile) return
    setOpeningKey(selectedFileKey)
    setOpenErrors((current) => {
      const next = { ...current }
      delete next[selectedFileKey]
      return next
    })
    try {
      await window.api.shell.openPath(workflowRunFilePath(run.run_dir, selectedFile.path))
    } catch (err: unknown) {
      setOpenErrors((current) => ({
        ...current,
        [selectedFileKey]: err instanceof Error ? err.message : t('workflow.runDetail.openSourceFileError'),
      }))
    } finally {
      setOpeningKey(null)
    }
  }
  const exportResult = async () => {
    setExporting(true)
    try {
      await exportWorkflowRun({ runId: run.id, workflowName: run.workflow_name })
    } finally {
      setExporting(false)
    }
  }

  return (
    <main className="flex h-[68vh] max-h-[680px] min-w-0 flex-1 flex-col bg-bg-surface">
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border-subtle px-5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-text-primary">
              {formatWorkflowRunShortTimestamp(run.created_at, i18n.language)}
            </span>
            <WorkflowRunStatus run={run} />
          </div>
          <div className="mt-1 truncate font-mono text-xs text-text-tertiary">{run.id}</div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => void exportResult()}
            disabled={exporting || orderedFiles.length === 0}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-default px-3 text-xs font-semibold text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download size={13} />
            {exporting ? t('workflow.runDetail.exportingResult') : t('workflow.runDetail.exportResult')}
          </button>
          {onReference ? (
            <button
              type="button"
              onClick={onReference}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-blue px-3 text-xs font-semibold text-white hover:opacity-90"
            >
              <MessageSquarePlus size={14} /> {referenceLabel}
            </button>
          ) : null}
        </div>
      </div>

      <div className="border-b border-border-subtle px-6 py-4">
        {run.workflow_input.text ? (
          <div className="line-clamp-2 text-sm leading-6 text-text-primary">
            {t('workflow.runDetail.workflowInput')}<StructuredInput blocks={workflowRunInputBlocks(run)} />
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-tertiary">
          <span>{t('workflow.runDetail.sourceSession', { id: run.source_session_id })}</span>
          {run.finished_at ? (
            <span>{t('workflow.runDetail.finishedAt', { time: formatWorkflowRunShortTimestamp(run.finished_at, i18n.language) })}</span>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="w-[230px] shrink-0 overflow-y-auto border-r border-border-subtle p-3">
          {detailError ? (
            <button
              type="button"
              onClick={onRetryDetail}
              className="mx-2 mb-2 inline-flex items-center gap-1.5 text-xs font-semibold text-status-error hover:underline"
            >
              <RefreshCw size={12} /> {t('workflow.runDetail.retryDetail', { error: detailError })}
            </button>
          ) : null}
          {fileGroups.map((group) => (
            <div key={group.key} className="mb-3 last:mb-0">
              <div className="px-2 pb-2 text-xs font-semibold text-text-tertiary">
                {group.label}
              </div>
              {group.files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setSelectedPath(file.path)}
                  className={cn(
                    'mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left',
                    selectedFile?.path === file.path
                      ? 'bg-accent-blue-subtle text-text-accent'
                      : 'text-text-secondary hover:bg-bg-hover',
                  )}
                >
                  <FileOutput size={14} className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold">{file.name}</span>
                    <span className="mt-0.5 block truncate font-mono text-2xs text-text-tertiary">
                      {file.path}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ))}
          {orderedFiles.length === 0 ? (
            <div className="px-2 py-4 text-xs leading-5 text-text-tertiary">
              {t('workflow.runDetail.noResultFiles')}
            </div>
          ) : null}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedFile ? (
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-5 py-2.5">
              <span className="min-w-0 truncate text-xs font-semibold text-text-secondary">
                {selectedFile.name}
              </span>
              <button
                type="button"
                onClick={() => void openSelectedFile()}
                disabled={openingKey === selectedFileKey}
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border-default px-2.5 text-xs font-semibold text-text-secondary hover:bg-bg-hover disabled:cursor-wait disabled:opacity-50"
              >
                <ExternalLink size={12} />
                {openingKey === selectedFileKey ? t('workflow.runDetail.openingSourceFile') : t('workflow.runDetail.openSourceFile')}
              </button>
            </div>
          ) : null}
          {openErrors[selectedFileKey] ? (
            <div className="shrink-0 bg-status-error-bg px-5 py-2 text-xs text-status-error">
              {t('workflow.runDetail.openSourceFileFailed', { error: openErrors[selectedFileKey] })}
            </div>
          ) : null}
          {selectedFileContent?.truncated ? (
            <div className="shrink-0 bg-accent-blue-subtle px-5 py-2 text-xs text-text-accent">
              {t('workflow.runDetail.truncatedPreview', { count: (200_000).toLocaleString(i18n.language) })}
            </div>
          ) : null}
          <div
            data-testid="workflow-run-file-preview-scroll"
            className="min-h-0 flex-1 overflow-auto px-7 py-6"
          >
            <WorkflowRunFilePreview
              file={selectedFile}
              content={selectedFileContent}
              loading={Boolean(
                selectedFile && selectedFileIsText && !selectedFileContent && !selectedFileError,
              )}
              error={selectedFileError}
              onRetry={retryFile}
              rawKind={previewKind}
              rawUrl={rawPreview?.url}
              rawLoading={Boolean(
                selectedFile && previewKind && !rawPreview && !rawPreviewError,
              )}
              rawError={rawPreviewError}
              onRetryRaw={retryRawPreview}
            />
            {selectedFileContent?.truncated ? (
              <div
                data-testid="workflow-run-truncated-footer"
                className="mx-auto mt-6 max-w-[760px] rounded-md border border-border-subtle bg-accent-blue-subtle px-4 py-3 text-center text-xs leading-5 text-text-accent"
              >
                {t('workflow.runDetail.truncatedPreviewFooter')}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  )
}

function WorkflowRunFilePreview({
  file,
  content,
  loading,
  error,
  onRetry,
  rawKind,
  rawUrl,
  rawLoading,
  rawError,
  onRetryRaw,
}: {
  file?: WorkflowRunFile
  content?: WorkflowRunFileContent
  loading: boolean
  error: string
  onRetry: () => void
  rawKind: RawPreviewKind | null
  rawUrl?: string
  rawLoading: boolean
  rawError: string
  onRetryRaw: () => void
}) {
  const { t } = useTranslation()
  if (!file) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
        {t('workflow.runDetail.selectFile')}
      </div>
    )
  }
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
        {t('workflow.runDetail.loadingFile')}
      </div>
    )
  }
  if (rawKind && rawLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
        {t('workflow.runDetail.loadingRawPreview')}
      </div>
    )
  }
  if (rawKind && rawError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-status-error">
        <span>{t('workflow.runDetail.rawPreviewFailed', { error: rawError })}</span>
        <button
          type="button"
          onClick={onRetryRaw}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-default px-3 text-xs font-semibold text-text-secondary hover:bg-bg-hover"
        >
          <RefreshCw size={13} /> {t('workflow.runDetail.retry')}
        </button>
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-status-error">
        <span>{error}</span>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-default px-3 text-xs font-semibold text-text-secondary hover:bg-bg-hover"
        >
          <RefreshCw size={13} /> {t('workflow.runDetail.retry')}
        </button>
      </div>
    )
  }
  if (rawKind === 'image' && rawUrl) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <img src={rawUrl} alt={file.name} className="max-h-full max-w-full object-contain" />
      </div>
    )
  }
  if (rawKind === 'pdf' && rawUrl) {
    return (
      <iframe
        src={rawUrl}
        className="h-full min-h-[420px] w-full border-0"
      />
    )
  }
  if (!content || content.content == null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
        {t('workflow.runDetail.textPreviewUnavailable')}
      </div>
    )
  }
  if (file.path.toLowerCase().endsWith('.md')) {
    return (
      <MarkdownMessage
        content={content.content}
        className="mx-auto max-w-[760px] text-base leading-7"
      />
    )
  }
  return <CodeBlock code={content.content} lang={file.path.split('.').at(-1) || 'text'} />
}

export function WorkflowRunStatus({
  run,
  compact = false,
}: {
  run: WorkflowRunSummary
  compact?: boolean
}) {
  const { t } = useTranslation()
  const completed = run.status === 'completed'
  const failed = run.status === 'failed' || run.validation_status === 'failed'
  const inactive = run.status === 'paused' || run.status === 'cancelled'
  let label = t('workflow.runDetail.status.running')
  if (completed) label = t('workflow.runDetail.status.completed')
  else if (failed) label = t('workflow.runDetail.status.failed')
  else if (run.status === 'paused') label = t('workflow.runDetail.status.paused')
  else if (run.status === 'cancelled') label = t('workflow.runDetail.status.cancelled')
  else if (run.status === 'waiting') label = t('workflow.runDetail.status.waiting')

  let tone = 'bg-accent-blue-subtle text-text-accent'
  if (completed) tone = 'bg-status-success-bg text-status-success'
  else if (failed) tone = 'bg-status-error-bg text-status-error'
  else if (inactive) tone = 'bg-bg-hover text-text-tertiary'
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-semibold',
        compact ? 'text-2xs' : 'text-xs',
        tone,
      )}
    >
      {label}
    </span>
  )
}
