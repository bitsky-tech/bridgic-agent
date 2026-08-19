import { ChevronRight, X } from 'lucide-react'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react'

import './PromptCacheCompareModal.css'

/** `same` is accepted directly from the prompt-compare domain model. */
export type PromptCacheCompareBlockStatus = 'unchanged' | 'same' | 'changed' | 'added' | 'removed'

export interface PromptCacheCompareIdentity {
  id: string
  /** A ready-to-display identity such as "T5 · Round 1". */
  label: string
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
}

export interface PromptCacheCompareBlock {
  id: string
  kind?: string
  label: string
  status: PromptCacheCompareBlockStatus
  baselineText: string | null
  currentText: string | null
  hitTokens?: number | null
  missTokens?: number | null
}

export interface PromptCacheCompareToolSurface extends PromptCacheCompareBlock {
  kind: 'tools'
}

export interface PromptCacheComparisonViewModel {
  id: string
  baseline: PromptCacheCompareIdentity
  current: PromptCacheCompareIdentity
  hitTokens: number
  missTokens: number
  hitRate: number
  firstChangedBlockId?: string | null
  blocks: readonly PromptCacheCompareBlock[]
  /** Tool definitions are a peer request field, not the tail of `messages`. */
  toolSurface?: PromptCacheCompareToolSurface | null
}

export interface PromptCacheCompareLabels {
  title: string
  subtitle: string
  close: string
  baseline: string
  current: string
  inputTokens: string
  outputTokens: string
  cacheHit: string
  cacheMiss: string
  firstMessageDifference: string
  messageBlocks: string
  toolDefinitions: string
  toolSchemaChanged: string
  unchanged: string
  changed: string
  added: string
  removed: string
  expand: string
  collapse: string
  emptyContent: string
  noBlocks: string
}

export interface PromptCacheCompareModalProps {
  open: boolean
  comparison: PromptCacheComparisonViewModel | null
  onClose: () => void
  labels?: Partial<PromptCacheCompareLabels>
  formatNumber?: (value: number) => string
}

export interface PromptCacheHighlightSegment {
  text: string
  changed: boolean
}

export interface PromptCacheTextComparison {
  baseline: PromptCacheHighlightSegment[]
  current: PromptCacheHighlightSegment[]
}

const defaultLabels: PromptCacheCompareLabels = {
  title: 'Prompt cache comparison',
  subtitle: 'Compare the cache baseline with the current model request.',
  close: 'Close comparison',
  baseline: 'Cache baseline',
  current: 'Current request',
  inputTokens: 'Input',
  outputTokens: 'Output',
  cacheHit: 'Hit',
  cacheMiss: 'Miss',
  firstMessageDifference: 'First message change',
  messageBlocks: 'Message blocks',
  toolDefinitions: 'Tool definitions',
  toolSchemaChanged: 'Tool Schema changed',
  unchanged: 'Unchanged',
  changed: 'Changed',
  added: 'Added',
  removed: 'Removed',
  expand: 'Expand',
  collapse: 'Collapse',
  emptyContent: 'No content',
  noBlocks: 'No aligned Message blocks are available.',
}

function clampRate(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function singleSegment(text: string, changed: boolean): PromptCacheHighlightSegment[] {
  return text ? [{ text, changed }] : []
}

/**
 * Split both values into the same unchanged prefix/suffix and a changed middle.
 * The comparison view model owns semantic block alignment; this helper only
 * adds a readable character-level highlight inside an aligned block.
 */
export function comparePromptCacheText(
  baselineText: string | null,
  currentText: string | null,
  status: PromptCacheCompareBlockStatus,
): PromptCacheTextComparison {
  const baseline = baselineText ?? ''
  const current = currentText ?? ''
  if (status === 'unchanged' || status === 'same' || baseline === current) {
    return {
      baseline: singleSegment(baseline, false),
      current: singleSegment(current, false),
    }
  }
  if (status === 'added' || baseline.length === 0) {
    return {
      baseline: singleSegment(baseline, false),
      current: singleSegment(current, true),
    }
  }
  if (status === 'removed' || current.length === 0) {
    return {
      baseline: singleSegment(baseline, true),
      current: singleSegment(current, false),
    }
  }

  const limit = Math.min(baseline.length, current.length)
  let prefixLength = 0
  while (
    prefixLength < limit
    && baseline.charCodeAt(prefixLength) === current.charCodeAt(prefixLength)
  ) prefixLength += 1

  let suffixLength = 0
  while (
    suffixLength < limit - prefixLength
    && baseline.charCodeAt(baseline.length - 1 - suffixLength)
      === current.charCodeAt(current.length - 1 - suffixLength)
  ) suffixLength += 1

  const split = (text: string): PromptCacheHighlightSegment[] => {
    const segments: PromptCacheHighlightSegment[] = []
    const prefix = text.slice(0, prefixLength)
    const middleEnd = suffixLength > 0 ? text.length - suffixLength : text.length
    const middle = text.slice(prefixLength, middleEnd)
    const suffix = suffixLength > 0 ? text.slice(middleEnd) : ''
    if (prefix) segments.push({ text: prefix, changed: false })
    if (middle) segments.push({ text: middle, changed: true })
    if (suffix) segments.push({ text: suffix, changed: false })
    return segments
  }

  return { baseline: split(baseline), current: split(current) }
}

function HighlightedText({
  segments,
  emptyContent,
}: {
  segments: readonly PromptCacheHighlightSegment[]
  emptyContent: string
}) {
  if (segments.length === 0) return <span className="prompt-cache-compare-empty">{emptyContent}</span>
  return segments.map((segment, index) => segment.changed
    ? <mark key={index}>{segment.text}</mark>
    : <span key={index}>{segment.text}</span>)
}

function RequestIdentity({
  identity,
  heading,
  labels,
  formatNumber,
}: {
  identity: PromptCacheCompareIdentity
  heading: string
  labels: PromptCacheCompareLabels
  formatNumber: (value: number) => string
}) {
  const token = (value: number | null | undefined): ReactNode => value == null ? '—' : formatNumber(value)
  return (
    <article className="prompt-cache-compare-identity">
      <span>{heading}</span>
      <strong>{identity.label}</strong>
      {identity.model && <code>{identity.model}</code>}
      <dl>
        <div>
          <dt>{labels.inputTokens}</dt>
          <dd>{token(identity.inputTokens)}</dd>
        </div>
        <div>
          <dt>{labels.outputTokens}</dt>
          <dd>{token(identity.outputTokens)}</dd>
        </div>
      </dl>
    </article>
  )
}

export function PromptCacheCompareModal({
  open,
  comparison,
  onClose,
  labels: labelOverrides,
  formatNumber = (value) => new Intl.NumberFormat().format(value),
}: PromptCacheCompareModalProps) {
  const labels = useMemo<PromptCacheCompareLabels>(
    () => ({ ...defaultLabels, ...labelOverrides }),
    [labelOverrides],
  )
  const headingId = `prompt-cache-compare-${useId().replace(/:/g, '')}`
  const descriptionId = `${headingId}-description`
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [expandedBlockIds, setExpandedBlockIds] = useState<Set<string>>(new Set())
  const comparisonId = comparison?.id ?? null

  useEffect(() => {
    setExpandedBlockIds(new Set())
  }, [comparisonId, open])

  useEffect(() => {
    if (!open || !comparison) return
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => !element.hidden)
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [comparisonId, onClose, open])

  if (!open || !comparison) return null

  const hitRate = clampRate(comparison.hitRate)
  const missRate = 1 - hitRate
  // Keep accepting the original flat shape while callers move to the request-field model.
  const messageBlocks = comparison.blocks.filter((block) => block.kind !== 'tools')
  const toolSurface = comparison.toolSurface
    ?? comparison.blocks.find((block): block is PromptCacheCompareToolSurface => block.kind === 'tools')
    ?? null
  const firstChangedBlock = comparison.firstChangedBlockId
    ? messageBlocks.find((block) => block.id === comparison.firstChangedBlockId) ?? null
    : null
  const statusLabel = (status: PromptCacheCompareBlockStatus) => (
    status === 'same' ? labels.unchanged : labels[status]
  )
  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose()
  }
  const renderBlock = (block: PromptCacheCompareBlock, requestField: 'messages' | 'tools') => {
    const expanded = expandedBlockIds.has(block.id)
    const isFirstChangedBlock = requestField === 'messages' && block.id === firstChangedBlock?.id
    const isChangedToolSurface = requestField === 'tools' && block.status !== 'same' && block.status !== 'unchanged'
    const contentId = `${headingId}-block-${block.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
    const comparisonText = comparePromptCacheText(
      block.baselineText,
      block.currentText,
      block.status,
    )
    const toggle = () => setExpandedBlockIds((current) => {
      const next = new Set(current)
      if (next.has(block.id)) next.delete(block.id)
      else next.add(block.id)
      return next
    })

    return (
      <article
        key={block.id}
        className={`prompt-cache-compare-block is-${block.status}${isFirstChangedBlock ? ' is-first-change' : ''}${isChangedToolSurface ? ' is-tool-surface-change' : ''}${expanded ? ' is-expanded' : ''}`}
        data-block-kind={block.kind}
        data-request-field={requestField}
      >
        <button
          type="button"
          className="prompt-cache-compare-block-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          aria-label={`${expanded ? labels.collapse : labels.expand}: ${block.label}`}
          onClick={toggle}
        >
          <ChevronRight size={16} aria-hidden="true" />
          <strong>{block.label}</strong>
          {(block.hitTokens != null || block.missTokens != null) && (
            <span className="prompt-cache-compare-block-tokens">
              {block.hitTokens != null && <span>{labels.cacheHit} ≈ {formatNumber(block.hitTokens)}</span>}
              {block.missTokens != null && <em>{labels.cacheMiss} ≈ {formatNumber(block.missTokens)}</em>}
            </span>
          )}
          <span className="prompt-cache-compare-badges">
            {isFirstChangedBlock && (
              <span className="prompt-cache-compare-first-badge">
                {labels.firstMessageDifference}
              </span>
            )}
            {isChangedToolSurface && (
              <span className="prompt-cache-compare-tool-change-badge">
                {labels.toolSchemaChanged}
              </span>
            )}
            <span className={`prompt-cache-compare-status is-${block.status}`}>
              {statusLabel(block.status)}
            </span>
          </span>
        </button>

        {expanded && (
          <div id={contentId} className="prompt-cache-compare-block-content">
            <section>
              <h4>{labels.baseline}</h4>
              <pre><HighlightedText segments={comparisonText.baseline} emptyContent={labels.emptyContent} /></pre>
            </section>
            <section>
              <h4>{labels.current}</h4>
              <pre><HighlightedText segments={comparisonText.current} emptyContent={labels.emptyContent} /></pre>
            </section>
          </div>
        )}
      </article>
    )
  }

  return (
    <div className="prompt-cache-compare-backdrop" onMouseDown={closeFromBackdrop}>
      <section
        ref={dialogRef}
        className="prompt-cache-compare-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descriptionId}
      >
        <header className="prompt-cache-compare-header">
          <div>
            <h2 id={headingId}>{labels.title}</h2>
            <p id={descriptionId}>{labels.subtitle}</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="prompt-cache-compare-close"
            aria-label={labels.close}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="prompt-cache-compare-scroll">
          <div className="prompt-cache-compare-identities">
            <RequestIdentity
              identity={comparison.baseline}
              heading={labels.baseline}
              labels={labels}
              formatNumber={formatNumber}
            />
            <span className="prompt-cache-compare-arrow" aria-hidden="true">→</span>
            <RequestIdentity
              identity={comparison.current}
              heading={labels.current}
              labels={labels}
              formatNumber={formatNumber}
            />
          </div>

          <section className="prompt-cache-compare-summary" aria-label={`${labels.cacheHit} / ${labels.cacheMiss}`}>
            <div>
              <span>{labels.cacheHit}</span>
              <strong>{Math.round(hitRate * 100)}%</strong>
              <code>≈ {formatNumber(comparison.hitTokens)}</code>
            </div>
            <div className="is-miss">
              <span>{labels.cacheMiss}</span>
              <strong>{Math.round(missRate * 100)}%</strong>
              <code>≈ {formatNumber(comparison.missTokens)}</code>
            </div>
            <i className="prompt-cache-compare-split" aria-hidden="true">
              <b style={{ width: `${hitRate * 100}%` }} />
            </i>
            {firstChangedBlock && (
              <p className="prompt-cache-compare-first-difference">
                <span>{labels.firstMessageDifference}</span>
                <strong>{firstChangedBlock.label}</strong>
              </p>
            )}
            {toolSurface && toolSurface.status !== 'same' && toolSurface.status !== 'unchanged' && (
              <p className="prompt-cache-compare-tool-difference">
                <strong>{labels.toolSchemaChanged}</strong>
              </p>
            )}
          </section>

          <div className="prompt-cache-compare-request-fields">
            <section
              className="prompt-cache-compare-blocks is-message-field"
              aria-labelledby={`${headingId}-message-blocks`}
            >
              <header>
                <h3 id={`${headingId}-message-blocks`}>{labels.messageBlocks}</h3>
                <span>{messageBlocks.length}</span>
              </header>

              {messageBlocks.length === 0 ? (
                <div className="prompt-cache-compare-no-blocks">{labels.noBlocks}</div>
              ) : (
                <div className="prompt-cache-compare-block-list">
                  {messageBlocks.map((block) => renderBlock(block, 'messages'))}
                </div>
              )}
            </section>

            {toolSurface && (
              <section
                className="prompt-cache-compare-blocks is-tool-field"
                aria-labelledby={`${headingId}-tool-definitions`}
              >
                <header>
                  <h3 id={`${headingId}-tool-definitions`}>{labels.toolDefinitions}</h3>
                </header>
                <div className="prompt-cache-compare-block-list">
                  {renderBlock(toolSurface, 'tools')}
                </div>
              </section>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
