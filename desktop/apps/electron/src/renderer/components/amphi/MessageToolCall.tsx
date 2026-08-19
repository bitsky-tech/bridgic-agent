/**
 * Tool call card — a collapsible presentation of the assistant calling a tool.
 *
 * Header: tool name + status (calling / done·Nms / error); expand to see the input and the result.
 * input and result.output are arbitrary structures and are shown JSON-serialized. The data comes from
 * AgentMessage.toolCalls (the reducer has already collected the tool_call / tool_result events).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Icons } from './Icons'
import type { AgentMessageToolCall } from '@/atoms/agent'

export interface MessageToolCallProps {
  call: AgentMessageToolCall
}

/** Serialize any value into a readable string: strings as-is, everything else as indented JSON, falling back to String() on failure. */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function MessageToolCall({ call }: MessageToolCallProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { name, input, result } = call
  const hasError = result?.isError === true
  let status: string
  if (!result) {
    status = t('messageToolCall.calling')
  } else if (hasError) {
    status = t('messageToolCall.error')
  } else {
    status = t('messageToolCall.completed', { durationMs: result.durationMs })
  }

  return (
    <div className="rounded-md border border-border-subtle bg-bg-hover overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        {open ? Icons.chevronDown(12) : Icons.chevronRight(12)}
        {Icons.terminal(12)}
        <span className="font-mono">{name}</span>
        <span className={cn('ml-auto', hasError ? 'text-status-error' : 'text-text-tertiary')}>
          {status}
        </span>
      </button>
      {open && (
        <div className="px-2.5 pb-2 pt-2 border-t border-border-subtle space-y-2">
          <ToolSection label={t('messageToolCall.parameters')} body={stringify(input)} />
          {result && (
            <ToolSection
              label={hasError ? t('messageToolCall.error') : t('messageToolCall.result')}
              body={stringify(result.output)}
              error={hasError}
            />
          )}
        </div>
      )}
    </div>
  )
}

function ToolSection({ label, body, error }: { label: string; body: string; error?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-xs uppercase tracking-wide text-text-tertiary mb-1">{label}</div>
      <pre
        className={cn(
          // max-h + overflow-auto: tool inputs/results can be very long (reading a whole file, big JSON),
          // and without a height cap the whole card would stretch several screens tall. With a cap, the overflow scrolls internally.
          // whitespace-pre preserves the original formatting without forcing wrapping; horizontal overflow scrolls via overflow-auto.
          'm-0 p-2 rounded bg-bg-app max-h-80 min-w-0 overflow-auto text-xs font-mono whitespace-pre',
          error && 'text-status-error',
        )}
      >
        {body}
      </pre>
    </div>
  )
}
