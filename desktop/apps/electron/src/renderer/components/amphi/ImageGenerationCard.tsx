/** Compact execution-process card for the generate_image tool. */
import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronRight, FolderOpen, ImageIcon, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentMessageToolCall } from '@/atoms/agent'
import { cn } from '@/lib/cn'
import { parseLocalResourceReference, type LocalResourceReference } from '@/components/markdown/localResource'
import { Collapse } from './Collapse'

export interface ImageGenerationCardProps {
  call: AgentMessageToolCall
}

type ImageGenerationState = 'running' | 'success' | 'error'

function inputString(input: unknown, key: string): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value.trim() : ''
}

function generatedImageReference(output: unknown): LocalResourceReference | null {
  const text = String(output ?? '')
  for (const line of text.split(/\r?\n/)) {
    const reference = parseLocalResourceReference(line)
    if (reference?.kind === 'image') return reference
  }
  return null
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function useRunningDuration(running: boolean): number {
  const [elapsedMs, setElapsedMs] = useState(0)

  useEffect(() => {
    if (!running) return
    const startedAt = Date.now()
    const update = () => setElapsedMs(Date.now() - startedAt)
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [running])

  return elapsedMs
}

export function ImageGenerationCard({ call }: ImageGenerationCardProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [detailsMounted, setDetailsMounted] = useState(false)
  const running = call.result === undefined
  const elapsedMs = useRunningDuration(running)
  let state: ImageGenerationState = 'success'
  if (running) state = 'running'
  else if (call.result?.isError) state = 'error'

  const prompt = inputString(call.input, 'prompt')
  const provider = inputString(call.input, 'provider_id')
  const model = inputString(call.input, 'model')
  const output = String(call.result?.output ?? '')
  const reference = state === 'success' ? generatedImageReference(output) : null
  const duration = running ? elapsedMs : call.result?.durationMs ?? 0

  let status = t('session.imageGeneration.status.completed')
  let statusIcon = <CheckCircle2 size={11} />
  let statusTone = 'text-status-success'
  if (state === 'running') {
    status = t('session.imageGeneration.status.running')
    statusIcon = <LoaderCircle size={11} className="animate-spin" />
    statusTone = 'text-text-accent'
  } else if (state === 'error') {
    status = t('session.imageGeneration.status.failed')
    statusIcon = <AlertCircle size={11} />
    statusTone = 'text-status-error'
  }

  const reveal = (): void => {
    if (reference) void window.api.shell.showItemInFolder(reference.target.path)
  }

  return (
    <section
      data-image-generation-state={state}
      className={cn(
        'w-full overflow-hidden rounded-md border bg-bg-surface transition-colors',
        state === 'error' ? 'border-status-error/40' : 'border-border-default',
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={t('session.imageGeneration.details')}
        onClick={() => {
          setOpen((value) => !value)
          setDetailsMounted(true)
        }}
        className="group flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-bg-hover"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-purple-subtle text-text-accent-purple">
          <ImageIcon size={17} strokeWidth={1.7} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-xs font-semibold text-text-primary">
              {t('session.imageGeneration.title')}
            </span>
            <span className={cn('inline-flex items-center gap-1 text-xs', statusTone)} aria-live="polite">
              {statusIcon}
              {status}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-text-secondary">
            {prompt || t('session.imageGeneration.promptUnavailable')}
          </span>
          {state === 'running' ? (
            <span className="mt-1 flex items-center gap-1.5 text-2xs text-text-accent">
              <span className="agent-activity-wave" aria-hidden="true"><span /><span /><span /></span>
              {t('session.imageGeneration.working')}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 font-mono text-xs text-text-tertiary">
          {formatDuration(duration)}
        </span>
        <ChevronRight
          size={15}
          className={cn(
            'shrink-0 text-text-tertiary transition-transform',
            open ? 'rotate-90' : 'group-hover:translate-x-0.5',
          )}
        />
      </button>

      <Collapse open={open}>
        {detailsMounted ? (
          <div className="border-t border-border-subtle px-3 py-2.5">
            {prompt ? (
              <div>
                <div className="text-2xs font-semibold uppercase tracking-wide text-text-tertiary">
                  {t('session.imageGeneration.prompt')}
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-text-secondary">
                  {prompt}
                </p>
              </div>
            ) : null}

            {provider || model ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {provider ? <span className="rounded bg-bg-hover px-1.5 py-0.5 font-mono text-2xs text-text-tertiary">{provider}</span> : null}
                {model ? <span className="rounded bg-bg-hover px-1.5 py-0.5 font-mono text-2xs text-text-tertiary">{model}</span> : null}
              </div>
            ) : null}

            {state === 'success' && reference ? (
              <div className="mt-2 flex items-center gap-2 border-t border-border-subtle pt-2">
                <span className="min-w-0 flex-1 truncate font-mono text-2xs text-text-tertiary" title={reference.target.path}>
                  {reference.target.name}
                </span>
                <button
                  type="button"
                  onClick={reveal}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-2xs font-medium text-text-secondary hover:bg-bg-hover"
                >
                  <FolderOpen size={12} />
                  {t('session.imageGeneration.reveal')}
                </button>
              </div>
            ) : null}

            {state === 'error' && output ? (
              <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md bg-status-error-bg p-2 font-mono text-2xs leading-relaxed text-status-error">
                {output}
              </pre>
            ) : null}
          </div>
        ) : null}
      </Collapse>
    </section>
  )
}
