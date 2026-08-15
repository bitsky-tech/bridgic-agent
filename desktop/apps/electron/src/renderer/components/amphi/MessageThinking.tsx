/**
 * Chain-of-thought (reasoning) block — the "thinking" entry inside the execution process: lightbulb + a "thinking" label + a soft, lightly tinted panel.
 *
 * **The body text uses the same shade of grey as the rest of the execution flow** (`text-sm` / `text-text-tertiary`, aligned with
 * ProcessTimeline's intermediate prose block). Thinking is process, not conclusion, and visually it should not outweigh the final
 * answer — an early version used `text-base` + `text-text-primary`, on top of MarkdownMessage's `[&_strong]:font-semibold`, and since
 * reasoning summaries are commonly written as `**sub-heading**`, the whole block came out as eye-catching bold text, disconnected from
 * the greyed-out process information around it. Hence `strong` is additionally pulled back to normal weight here: consistent within the
 * block, distinguished only by the panel border and the label, never grabbing attention through boldness.
 *
 * Always visible and not collapsible (aligned with the think entry in the QATLItem design; collapsing happens at the "execution process"
 * container level, not per thinking block). The data comes from the thinking block / AgentMessage.thinking, and the content goes through
 * MarkdownMessage (chains of thought often contain markdown); **pure whitespace (empty after trim) is simply not rendered** — this avoids
 * rendering a misleading empty "thinking" box when the model acts directly in a turn and its reasoning contains only a newline.
 */
import { Icons } from './Icons'
import { useTranslation } from 'react-i18next'
import { StickyScroll } from './StickyScroll'
import { MarkdownMessage } from '@/components/markdown/MarkdownMessage'

export interface MessageThinkingProps {
  /** Chain-of-thought text (markdown). */
  thinking: string
  /** While streaming: the thinking block sticks to its own bottom so the thinking being generated is visible live (manual scroll-up is respected). */
  streaming?: boolean
}

export function MessageThinking({ thinking, streaming = false }: MessageThinkingProps) {
  const { t } = useTranslation()
  // Pure-whitespace chains of thought are not rendered: a thinking model may act directly in a turn and emit just a newline as its reasoning ('\n').
  // Test with trim rather than only against the empty string — '\n' is not an empty string but is visually empty, and rendering it produces a misleading empty "thinking" box.
  if (!thinking.trim()) return null
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-text-secondary">
        {Icons.lightbulb(13)}
        <span className="text-[11px] font-semibold tracking-[0.3px]">{t('message.thinking')}</span>
      </div>
      <StickyScroll
        active={streaming}
        dep={thinking}
        className="max-h-72 overflow-auto rounded-md border border-border-subtle bg-bg-hover px-3.5 py-2.5"
      >
        <MarkdownMessage
          content={thinking}
          className="text-sm leading-[1.7] text-text-tertiary [&_p]:my-1.5 [&_strong]:font-normal"
          streaming={streaming}
        />
      </StickyScroll>
    </div>
  )
}
