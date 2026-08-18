import { useAtomValue, useSetAtom } from 'jotai'
import { CircleDot, ExternalLink, FileDown, FolderOpen, ShieldAlert, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { APP_NEW_ISSUE_URL, ISSUE_REPORT_FILE_STEM } from '@shared/app-meta'
import {
  planIssueReport,
  type IssueReportSection,
} from '@shared/issue-report'
import type { SystemDiagnostics } from '@shared/types'
import {
  closeIssueReportAtom,
  issueReportRequestAtom,
  type IssueReportRequestSnapshot,
} from '@/atoms/issue-report'
import { cn } from '@/lib/cn'
import {
  serializeIssueReportAgentTurn,
  type IssueReportAgentTurnLabels,
} from '@/lib/issueReportAgentTurn'
import { rlog } from '@/lib/logger'
import { Icons } from './Icons'
import { Modal } from './Modal'
import { Tooltip } from './Tooltip'

type PendingAction = 'copy' | 'open' | null

interface IncludeOptions {
  systemEnvironment: boolean
  runContext: boolean
  userMessage: boolean
  assistantMessage: boolean
  errorDetails: boolean
}

const EMPTY_INCLUDE: IncludeOptions = {
  systemEnvironment: false,
  runContext: false,
  userMessage: false,
  assistantMessage: false,
  errorDetails: false,
}

function createIssueReportFilename(now = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, '0')
  const timestamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
  ].join('')
  return `${ISSUE_REPORT_FILE_STEM}-${timestamp}.md`
}

function formatLines(entries: Array<[string, string | number | null | undefined]>): string {
  return entries
    .filter((entry): entry is [string, string | number] => entry[1] !== null && entry[1] !== undefined && entry[1] !== '')
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n')
}

function hasAgentTurnContent(request: IssueReportRequestSnapshot): boolean {
  const turn = request.agentTurn
  const hasVisibleBlock = turn?.blocks.some((block) => {
    if (block.type === 'thinking' || block.type === 'text') return block.text.length > 0
    return true
  }) ?? false
  return Boolean(
    request.assistantText
    || turn?.finalAnswer
    || turn?.fallbackText
    || turn?.thinking
    || turn?.toolCalls?.length
    || turn?.error
    || turn?.stopped
    || (request.source === 'message' && request.error)
    || hasVisibleBlock,
  )
}

/** Global singleton report dialog. Its body remounts for every captured request. */
export function ReportIssueDialog() {
  const request = useAtomValue(issueReportRequestAtom)
  if (!request) return null
  return <ReportIssueDialogBody key={request.openedAt} request={request} />
}

function ReportIssueDialogBody({ request }: { request: IssueReportRequestSnapshot }) {
  const { t } = useTranslation()
  const close = useSetAtom(closeIssueReportAtom)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [include, setInclude] = useState<IncludeOptions>(EMPTY_INCLUDE)
  const [pending, setPending] = useState<PendingAction>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exportedPath, setExportedPath] = useState<string | null>(null)
  const [systemDiagnostics, setSystemDiagnostics] = useState<SystemDiagnostics | null>(null)
  const [suggestedFilename] = useState(() => createIssueReportFilename())
  const copiedTimerRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
  }, [])

  useEffect(() => {
    if (!include.systemEnvironment || systemDiagnostics) return undefined
    let cancelled = false
    void window.api.system.getDiagnostics().then((diagnostics) => {
      if (!cancelled) setSystemDiagnostics(diagnostics)
    }).catch((failure) => {
      rlog.warn('[issue-report] could not prepare system diagnostics preview', failure)
    })
    return () => { cancelled = true }
  }, [include.systemEnvironment, systemDiagnostics])

  const messageSource = request.source === 'message'
  const userMessageAvailable = messageSource && Boolean(request.userText?.trim())
  const assistantMessageAvailable = useMemo(
    () => messageSource && hasAgentTurnContent(request),
    [messageSource, request],
  )
  const runContextAvailable = messageSource && Boolean(
    request.model || request.executionMode || request.thinking,
  )
  const errorDetailsAvailable = !messageSource && Boolean(request.error?.trim())
  const agentTurnContent = useMemo(() => {
    if (!include.assistantMessage) return ''
    const labels: IssueReportAgentTurnLabels = {
      displayedReasoning: t('issueReport.agentTurn.displayedReasoning'),
      duration: t('issueReport.agentTurn.duration'),
      empty: t('issueReport.agentTurn.empty'),
      error: t('issueReport.agentTurn.error'),
      event: t('issueReport.agentTurn.event'),
      finalReply: t('issueReport.agentTurn.finalReply'),
      processMessage: t('issueReport.agentTurn.processMessage'),
      status: t('issueReport.agentTurn.status'),
      stopped: t('issueReport.agentTurn.stopped'),
      toolCall: t('issueReport.agentTurn.toolCall'),
      toolFailure: t('issueReport.agentTurn.toolFailure'),
      toolInput: t('issueReport.agentTurn.toolInput'),
      toolPending: t('issueReport.agentTurn.toolPending'),
      toolResult: t('issueReport.agentTurn.toolResult'),
      toolSuccess: t('issueReport.agentTurn.toolSuccess'),
    }
    return serializeIssueReportAgentTurn({
      blocks: request.agentTurn?.blocks ?? [],
      finalAnswer: request.agentTurn?.finalAnswer,
      fallbackText: request.agentTurn?.fallbackText ?? request.assistantText,
      thinking: request.agentTurn?.thinking,
      toolCalls: request.agentTurn?.toolCalls,
      error: request.agentTurn?.error ?? (messageSource ? request.error : undefined),
      stopped: request.agentTurn?.stopped,
    }, labels)
  }, [include.assistantMessage, messageSource, request, t])

  const setOption = useCallback((key: keyof IncludeOptions, checked: boolean) => {
    setInclude((current) => ({ ...current, [key]: checked }))
    setCopied(false)
    setError(null)
    setExportedPath(null)
  }, [])

  const buildSections = useCallback((system?: SystemDiagnostics): IssueReportSection[] => {
    const sections: IssueReportSection[] = []
    if (include.systemEnvironment && system) {
      sections.push({
        heading: t('issueReport.sections.systemEnvironment'),
        format: 'code',
        content: formatLines([
          [t('issueReport.fields.appVersion'), system.appVersion],
          [t('issueReport.fields.platform'), system.platform],
          [t('issueReport.fields.arch'), system.arch],
          [t('issueReport.fields.osRelease'), system.osRelease],
          [t('issueReport.fields.electronVersion'), system.electronVersion],
          [t('issueReport.fields.chromeVersion'), system.chromeVersion],
        ]),
      })
    }
    if (include.errorDetails && errorDetailsAvailable && request.error) {
      sections.push({
        heading: t('issueReport.sections.errorDetails'),
        format: 'code',
        content: request.error,
      })
    }
    if (include.runContext && runContextAvailable) {
      const model = request.model
        ? [request.model.providerId, request.model.modelId].filter(Boolean).join(' / ')
        : undefined
      const runtimeContent = formatLines([
        [t('issueReport.fields.model'), model],
        [t('issueReport.fields.executionMode'), request.executionMode],
        [t('issueReport.fields.thinkingMode'), request.thinking?.mode],
        [t('issueReport.fields.thinkingStage'), request.thinking?.stage],
      ])
      sections.push({
        heading: t('issueReport.sections.runContext'),
        format: 'code',
        content: runtimeContent,
      })
    }
    if (include.userMessage && request.userText) {
      sections.push({
        heading: t('issueReport.sections.userMessage'),
        format: 'code',
        content: request.userText,
      })
    }
    if (include.assistantMessage && agentTurnContent) {
      sections.push({
        heading: t('issueReport.sections.assistantMessage'),
        format: 'code',
        content: agentTurnContent,
      })
    }
    return sections
  }, [agentTurnContent, errorDetailsAvailable, include, request, runContextAvailable, t])

  const previewSections = useMemo(
    () => buildSections(systemDiagnostics ?? undefined),
    [buildSections, systemDiagnostics],
  )
  const previewPlan = useMemo(
    () => planIssueReport({ sections: previewSections }),
    [previewSections],
  )
  const fileMode = previewPlan.mode === 'file' || exportedPath !== null

  const buildPlan = useCallback(async () => {
    const system = include.systemEnvironment
      ? systemDiagnostics ?? await window.api.system.getDiagnostics()
      : undefined
    if (system && !systemDiagnostics) setSystemDiagnostics(system)
    return planIssueReport({ sections: buildSections(system) })
  }, [buildSections, include.systemEnvironment, systemDiagnostics])

  const reportFailure = (failure: unknown, action: Exclude<PendingAction, null>) => {
    rlog.warn(`[issue-report] ${action} failed`, failure)
    setError(t(action === 'copy' ? 'issueReport.errors.copyFailed' : 'issueReport.errors.openFailed'))
  }

  const copyUrl = async () => {
    if (pending) return
    setPending('copy')
    setError(null)
    try {
      await navigator.clipboard.writeText(APP_NEW_ISSUE_URL)
      setCopied(true)
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500)
    } catch (failure) {
      reportFailure(failure, 'copy')
    } finally {
      setPending(null)
    }
  }

  const openGitHub = async () => {
    if (pending) return
    setPending('open')
    setError(null)
    if (exportedPath) {
      try {
        await window.api.shell.openExternal(APP_NEW_ISSUE_URL)
        close()
      } catch (failure) {
        rlog.warn('[issue-report] could not reopen GitHub', failure)
        setError(t('issueReport.errors.openAfterExportFailed'))
        setPending(null)
      }
      return
    }

    try {
      const plan = await buildPlan()
      if (plan.mode === 'file') {
        let exported: Awaited<ReturnType<typeof window.api.issueReport.exportFile>>
        try {
          exported = await window.api.issueReport.exportFile({
            suggestedName: suggestedFilename,
            content: plan.body,
          })
        } catch (failure) {
          rlog.warn('[issue-report] file export failed', failure)
          setError(t('issueReport.errors.exportFailed'))
          setPending(null)
          return
        }
        if (!exported.ok) {
          setPending(null)
          return
        }
        setExportedPath(exported.path)
        try {
          await window.api.shell.openExternal(plan.githubUrl)
        } catch (failure) {
          rlog.warn('[issue-report] GitHub did not open after file export', failure)
          setError(t('issueReport.errors.openAfterExportFailed'))
          setPending(null)
          return
        }
      } else {
        await window.api.shell.openExternal(plan.url)
      }
      close()
    } catch (failure) {
      rlog.warn('[issue-report] open failed', failure)
      setError(t('issueReport.errors.openFailed'))
      setPending(null)
    }
  }

  const showExportedFile = async () => {
    if (!exportedPath) return
    try {
      await window.api.shell.showItemInFolder(exportedPath)
    } catch (failure) {
      rlog.warn('[issue-report] could not reveal exported file', failure)
      setError(t('issueReport.errors.revealFailed'))
    }
  }

  let primaryLabel = t('issueReport.openGitHub')
  if (exportedPath) primaryLabel = t('issueReport.fileMode.retryOpen')
  else if (fileMode) primaryLabel = t('issueReport.fileMode.action')
  if (pending === 'open') {
    primaryLabel = t(fileMode && !exportedPath
      ? 'issueReport.fileMode.exporting'
      : 'issueReport.fileMode.openingGitHub')
  }
  const PrimaryIcon = fileMode && !exportedPath ? FileDown : ExternalLink

  return (
    <Modal
      width={500}
      onClose={pending ? undefined : close}
      backdropClassName="bg-[rgba(0,0,0,0.55)] backdrop-blur-[3px]"
      customHeader={(
        <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-5 py-3.5">
          <span className="text-base font-semibold text-text-primary">{t('issueReport.title')}</span>
          <Tooltip content={t('issueReport.close')}>
            <button
              type="button"
              onClick={close}
              disabled={pending !== null}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={t('issueReport.close')}
            >
              {Icons.x(17)}
            </button>
          </Tooltip>
        </div>
      )}
    >
      <div className="p-5">
        <p className="text-sm leading-relaxed text-text-secondary">
          {t('issueReport.description')}
        </p>

        <div
          data-testid="issue-report-destination"
          className="mt-4 flex items-center gap-3 rounded-lg border border-border-default bg-bg-input p-3"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-bg-hover text-text-secondary">
            <CircleDot size={17} strokeWidth={1.6} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-xs font-medium text-text-secondary">
              {t('issueReport.destination')}
            </div>
            <div className="break-all text-xs leading-relaxed text-text-secondary">
              {APP_NEW_ISSUE_URL}
            </div>
          </div>
          <Tooltip content={copied ? t('issueReport.copied') : t('issueReport.copyLink')}>
            <button
              type="button"
              onClick={() => { void copyUrl() }}
              disabled={pending !== null}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={copied ? t('issueReport.copied') : t('issueReport.copyLink')}
            >
              {copied ? Icons.check(15) : (
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <rect x="5.5" y="5.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M10.5 5V4.5A1.5 1.5 0 009 3H4.5A1.5 1.5 0 003 4.5V9a1.5 1.5 0 001.5 1.5H5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              )}
            </button>
          </Tooltip>
        </div>

        <button
          data-testid="issue-report-primary"
          type="button"
          onClick={() => { void openGitHub() }}
          disabled={pending !== null}
          className="mt-3 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-[image:var(--brand-gradient)] px-4 text-sm font-medium text-text-on-brand hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {primaryLabel}
          <PrimaryIcon size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>

        <p
          data-testid="issue-report-safety-note"
          className="mt-2 flex items-center justify-center gap-1.5 text-center text-xs leading-relaxed text-text-tertiary"
        >
          <ShieldCheck size={13} strokeWidth={1.8} className="shrink-0" aria-hidden="true" />
          {t(fileMode ? 'issueReport.fileMode.githubNotice' : 'issueReport.githubNotice')}
        </p>

        {fileMode && !exportedPath && (
          <div
            data-testid="issue-report-file-mode"
            className="mt-3 flex items-start gap-2.5 rounded-md bg-status-warning-bg px-3 py-2.5"
          >
            <FileDown size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-status-warning" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-xs font-semibold text-text-primary">
                {t('issueReport.fileMode.title')}
              </div>
              <div className="mt-0.5 text-xs leading-relaxed text-text-secondary">
                {t('issueReport.fileMode.description', { filename: suggestedFilename })}
              </div>
            </div>
          </div>
        )}

        {exportedPath && (
          <div
            data-testid="issue-report-exported-file"
            className="mt-3 flex items-start gap-2.5 rounded-md border border-border-default bg-bg-input px-3 py-2.5"
          >
            <FileDown size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-text-primary">
                {t('issueReport.fileMode.exportedTitle')}
              </div>
              <div className="mt-1 break-all font-mono text-xs leading-relaxed text-text-tertiary">
                {exportedPath}
              </div>
              <button
                type="button"
                onClick={() => { void showExportedFile() }}
                className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
              >
                <FolderOpen size={13} strokeWidth={1.7} aria-hidden="true" />
                {t('issueReport.fileMode.showInFolder')}
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-md bg-status-error-bg px-3 py-2 text-xs text-status-error" role="alert">
            {error}
          </div>
        )}

        <div className="-mx-5 -mb-5 mt-5 border-t border-border-subtle">
          <button
            data-testid="issue-report-advanced-toggle"
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left hover:bg-bg-hover"
            aria-expanded={advancedOpen}
          >
            <span className="flex min-w-0 items-center gap-2">
              <SlidersHorizontal
                size={15}
                strokeWidth={1.7}
                className="shrink-0 text-text-tertiary"
                aria-hidden="true"
              />
              <span className="shrink-0 text-sm font-medium text-text-primary">
                {t('issueReport.advanced.title')}
              </span>
              <span className="truncate text-xs text-text-tertiary">
                {t('issueReport.advanced.description')}
              </span>
            </span>
            <span
              className={cn('shrink-0 text-text-tertiary transition-transform', advancedOpen && 'rotate-180')}
              aria-hidden="true"
            >
              {Icons.chevronDown(15)}
            </span>
          </button>

          {advancedOpen && (
            <div
              data-testid="issue-report-advanced-panel"
              className="border-t border-border-subtle bg-bg-elevated px-5 py-4"
            >
              {errorDetailsAvailable && (
                <fieldset>
                  <legend className="mb-2 text-xs font-semibold text-text-secondary">
                    {t('issueReport.advanced.problemTitle')}
                  </legend>
                  <CheckboxRow
                    checked={include.errorDetails}
                    onChange={(checked) => setOption('errorDetails', checked)}
                    label={t('issueReport.advanced.errorDetails')}
                    description={t('issueReport.advanced.errorDetailsDescription')}
                  />
                </fieldset>
              )}

              <fieldset className={errorDetailsAvailable ? 'mt-3.5' : undefined}>
                <legend className="mb-2 text-xs font-semibold text-text-secondary">
                  {t('issueReport.advanced.environmentTitle')}
                </legend>
                <div className="flex flex-col gap-2">
                  <CheckboxRow
                    checked={include.systemEnvironment}
                    onChange={(checked) => setOption('systemEnvironment', checked)}
                    label={t('issueReport.advanced.systemEnvironment')}
                    description={t('issueReport.advanced.systemEnvironmentDescription')}
                  />
                  {messageSource && (
                    <CheckboxRow
                      checked={include.runContext}
                      disabled={!runContextAvailable}
                      onChange={(checked) => setOption('runContext', checked)}
                      label={t('issueReport.advanced.runContext')}
                      description={t('issueReport.advanced.runContextDescription')}
                    />
                  )}
                </div>
              </fieldset>

              {messageSource && (
                <fieldset className="mt-3.5">
                  <legend className="mb-2 text-xs font-semibold text-text-secondary">
                    {t('issueReport.advanced.conversationTitle')}
                  </legend>
                  <div className="flex flex-col gap-2">
                    <CheckboxRow
                      checked={include.userMessage}
                      disabled={!userMessageAvailable}
                      onChange={(checked) => setOption('userMessage', checked)}
                      label={t('issueReport.advanced.userMessage')}
                      description={t('issueReport.advanced.userMessageDescription')}
                    />
                    <CheckboxRow
                      checked={include.assistantMessage}
                      disabled={!assistantMessageAvailable}
                      onChange={(checked) => setOption('assistantMessage', checked)}
                      label={t('issueReport.advanced.assistantMessage')}
                      description={t('issueReport.advanced.assistantMessageDescription')}
                    />
                  </div>
                </fieldset>
              )}

              {(include.userMessage || include.assistantMessage) && (
                <div
                  data-testid="issue-report-sensitive-content-warning"
                  className="mt-3 flex items-start gap-2 rounded-md bg-status-warning-bg px-3 py-2.5 text-xs leading-relaxed text-text-secondary"
                  role="status"
                  aria-live="polite"
                >
                  <ShieldAlert
                    size={15}
                    strokeWidth={1.8}
                    className="mt-0.5 shrink-0 text-status-warning"
                    aria-hidden="true"
                  />
                  <span>
                    <span className="block font-semibold text-text-primary">
                      {t(fileMode
                        ? 'issueReport.advanced.fileSensitiveTitle'
                        : 'issueReport.advanced.sensitiveTitle')}
                    </span>
                    <span className="mt-0.5 block">
                      {t(fileMode
                        ? 'issueReport.advanced.fileSensitiveNotice'
                        : 'issueReport.advanced.sensitiveNotice')}
                    </span>
                  </span>
                </div>
              )}

              {include.errorDetails && (
                <div
                  data-testid="issue-report-error-details-warning"
                  className="mt-3 flex items-start gap-2 rounded-md bg-status-warning-bg px-3 py-2.5 text-xs leading-relaxed text-text-secondary"
                  role="status"
                  aria-live="polite"
                >
                  <ShieldAlert
                    size={15}
                    strokeWidth={1.8}
                    className="mt-0.5 shrink-0 text-status-warning"
                    aria-hidden="true"
                  />
                  <span>
                    <span className="block font-semibold text-text-primary">
                      {t('issueReport.advanced.errorSensitiveTitle')}
                    </span>
                    <span className="mt-0.5 block">
                      {t('issueReport.advanced.errorSensitiveNotice')}
                    </span>
                  </span>
                </div>
              )}

              <div className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-text-tertiary">
                <ShieldCheck size={12} strokeWidth={1.8} className="mt-0.5 shrink-0" aria-hidden="true" />
                {t(fileMode
                  ? 'issueReport.advanced.filePrivacyNotice'
                  : 'issueReport.advanced.privacyNotice')}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

function CheckboxRow({
  checked,
  disabled = false,
  onChange,
  label,
  description,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  label: string
  description: string
}) {
  return (
    <label className={cn(
      'flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 hover:bg-bg-hover',
      disabled && 'cursor-not-allowed opacity-45',
    )}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-brand-blue"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-text-primary">{label}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-text-tertiary">{description}</span>
      </span>
    </label>
  )
}
