import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react'
import type { JsonValue } from '../api'
import './PromptReadableView.css'

export type PromptReadableFidelity = 'exact' | 'reconstructed' | 'unavailable'
export type PromptSourceFidelity = PromptReadableFidelity | 'partial' | (string & Record<never, never>)

export interface PromptReadableBlock {
  id: string
  /** Canonical assembly kind, used to keep visual accents stable across runs. */
  kind?: string
  label: string
  text: string
  fidelity: PromptSourceFidelity
  description?: string
  sources?: readonly string[]
  limitations?: readonly string[]
  defaultExpanded?: boolean
}

export interface PromptReadableToolCall {
  id: string
  name: string
  arguments: Readonly<Record<string, JsonValue>>
}

export interface PromptReadableMessage {
  id: string
  role: string
  content: string | null
  label?: string
  toolCallId?: string
  toolCalls?: readonly PromptReadableToolCall[]
  copyText?: string
}

export interface PromptReadableLimitation {
  id: string
  status: PromptReadableFidelity
  title: string
  detail?: string
}

export interface PromptReadableFidelityItem {
  id: string
  title: string
  detail?: string
  source: 'block' | 'limitation'
}

export type PromptReadableFidelityGroups = Record<
  PromptReadableFidelity,
  PromptReadableFidelityItem[]
>

export interface PromptReadableLabels {
  blocks: string
  messages: string
  fidelity: string
  copy: string
  copied: string
  emptyContent: string
  noItems: string
  sources: string
  blockLimitations: string
  toolCalls: string
  arguments: string
  exact: string
  exactDescription: string
  reconstructed: string
  reconstructedDescription: string
  unavailable: string
  unavailableDescription: string
  roles: Readonly<Record<string, string>>
}

export interface PromptCopyContext {
  kind: 'block' | 'message'
  id: string
}

export interface PromptReadableViewProps {
  blocks: readonly PromptReadableBlock[]
  messages: readonly PromptReadableMessage[]
  limitations?: readonly PromptReadableLimitation[]
  /** Hide the reconstruction coverage section and per-block fidelity badges. */
  showFidelity?: boolean
  /** Hide per-block reconstruction caveats while keeping the readable block content. */
  showLimitations?: boolean
  labels?: Partial<Omit<PromptReadableLabels, 'roles'>> & {
    roles?: Readonly<Record<string, string>>
  }
  defaultExpandedBlockIds?: readonly string[]
  className?: string
  emptyState?: ReactNode
  /** Return a custom body for selected blocks; return undefined to keep the default body. */
  renderBlockContent?: (block: PromptReadableBlock) => ReactNode
  copyText?: (text: string, context: PromptCopyContext) => void | Promise<void>
  onCopyError?: (error: unknown, context: PromptCopyContext) => void
}

const defaultLabels: PromptReadableLabels = {
  blocks: 'Prompt blocks',
  messages: 'Model messages',
  fidelity: 'Reconstruction coverage',
  copy: 'Copy',
  copied: 'Copied',
  emptyContent: 'No text content',
  noItems: 'None',
  sources: 'Sources',
  blockLimitations: 'What may differ',
  toolCalls: 'Tool calls',
  arguments: 'Arguments',
  exact: 'Exact',
  exactDescription: 'Preserved directly from persisted data or a pinned prompt source.',
  reconstructed: 'Reconstructed',
  reconstructedDescription: 'Reassembled by the Lab; some historical runtime context may differ.',
  unavailable: 'Unavailable',
  unavailableDescription: 'The original value was not persisted and cannot be reproduced.',
  roles: {
    system: 'System',
    developer: 'Developer',
    user: 'User',
    assistant: 'Assistant',
    tool: 'Tool',
  },
}

const fidelityOrder: readonly PromptReadableFidelity[] = [
  'exact',
  'reconstructed',
  'unavailable',
]

export function readableFidelity(value: PromptSourceFidelity): PromptReadableFidelity {
  if (value === 'exact') return 'exact'
  if (value === 'unavailable') return 'unavailable'
  return 'reconstructed'
}

export function buildReadableFidelityGroups(
  blocks: readonly PromptReadableBlock[],
  limitations: readonly PromptReadableLimitation[] = [],
): PromptReadableFidelityGroups {
  const groups: PromptReadableFidelityGroups = {
    exact: [],
    reconstructed: [],
    unavailable: [],
  }
  for (const block of blocks) {
    const status = readableFidelity(block.fidelity)
    groups[status].push({
      id: `block:${block.id}`,
      title: block.label,
      detail: block.limitations?.length ? block.limitations.join(' ') : block.description,
      source: 'block',
    })
  }
  for (const limitation of limitations) {
    groups[limitation.status].push({
      id: `limitation:${limitation.id}`,
      title: limitation.title,
      detail: limitation.detail,
      source: 'limitation',
    })
  }
  return groups
}

function StructuredValue({ value }: { value: JsonValue }) {
  if (value === null) return <span className="prompt-readable-null">null</span>
  if (typeof value === 'boolean') return <span className="prompt-readable-primitive">{value ? 'true' : 'false'}</span>
  if (typeof value === 'number') return <span className="prompt-readable-primitive">{value}</span>
  if (typeof value === 'string') return <span className="prompt-readable-string">{value}</span>
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="prompt-readable-null">—</span>
    return (
      <ol className="prompt-readable-array">
        {value.map((item, index) => <li key={index}><StructuredValue value={item} /></li>)}
      </ol>
    )
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return <span className="prompt-readable-null">—</span>
  return (
    <dl className="prompt-readable-object">
      {entries.map(([key, item]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd><StructuredValue value={item} /></dd>
        </div>
      ))}
    </dl>
  )
}

export function PromptReadableView({
  blocks,
  messages,
  limitations = [],
  showFidelity = true,
  showLimitations = true,
  labels: labelOverrides,
  defaultExpandedBlockIds,
  className = '',
  emptyState,
  renderBlockContent,
  copyText,
  onCopyError,
}: PromptReadableViewProps) {
  const headingPrefix = `prompt-readable-${useId().replace(/:/g, '')}`
  const fidelityHeadingId = `${headingPrefix}-fidelity`
  const blocksHeadingId = `${headingPrefix}-blocks`
  const messagesHeadingId = `${headingPrefix}-messages`
  const labels = useMemo<PromptReadableLabels>(() => ({
    ...defaultLabels,
    ...labelOverrides,
    roles: { ...defaultLabels.roles, ...labelOverrides?.roles },
  }), [labelOverrides])
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(() => {
    if (defaultExpandedBlockIds) return new Set(defaultExpandedBlockIds)
    const explicitlyExpanded = blocks.filter((block) => block.defaultExpanded).map((block) => block.id)
    return new Set(explicitlyExpanded.length ? explicitlyExpanded : blocks[0] ? [blocks[0].id] : [])
  })
  const blockSignature = blocks.map((block) => block.id).join('\u0000')
  const previousBlockSignature = useRef(blockSignature)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const fidelityGroups = useMemo(
    () => buildReadableFidelityGroups(blocks, showLimitations ? limitations : []),
    [blocks, limitations, showLimitations],
  )

  useEffect(() => {
    if (previousBlockSignature.current === blockSignature) return
    previousBlockSignature.current = blockSignature
    const available = new Set(blocks.map((block) => block.id))
    setExpandedBlocks((current) => {
      if (defaultExpandedBlockIds !== undefined) {
        return new Set(defaultExpandedBlockIds.filter((id) => available.has(id)))
      }
      const next = new Set([...current].filter((id) => available.has(id)))
      if (next.size > 0) return next
      const preferred = blocks.find((block) => block.defaultExpanded)?.id
        ?? blocks[0]?.id
      if (preferred) next.add(preferred)
      return next
    })
  }, [blockSignature, blocks, defaultExpandedBlockIds])

  useEffect(() => {
    if (!copiedKey) return
    const timeout = window.setTimeout(() => setCopiedKey(null), 1400)
    return () => window.clearTimeout(timeout)
  }, [copiedKey])

  const copy = async (
    event: MouseEvent<HTMLButtonElement>,
    text: string,
    context: PromptCopyContext,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    if (!copyText) return
    try {
      await copyText(text, context)
      setCopiedKey(`${context.kind}:${context.id}`)
    } catch (error) {
      onCopyError?.(error, context)
    }
  }

  const fidelityLabel = (status: PromptReadableFidelity) => labels[status]
  const fidelityDescription = (status: PromptReadableFidelity) => labels[`${status}Description`]

  if (blocks.length === 0 && messages.length === 0 && (!showFidelity || limitations.length === 0)) {
    return (
      <div className={`prompt-readable-empty ${className}`.trim()} role="status">
        {emptyState ?? labels.emptyContent}
      </div>
    )
  }

  return (
    <div className={`prompt-readable-view ${className}`.trim()}>
      {showFidelity && (
        <section className="prompt-readable-section prompt-readable-fidelity" aria-labelledby={fidelityHeadingId}>
          <h3 id={fidelityHeadingId}>{labels.fidelity}</h3>
          <div className="prompt-fidelity-grid">
            {fidelityOrder.map((status) => {
              const items = fidelityGroups[status]
              return (
                <article key={status} className={`prompt-fidelity-group fidelity-${status}`}>
                  <header>
                    <span className="prompt-fidelity-dot" aria-hidden="true" />
                    <strong>{fidelityLabel(status)}</strong>
                    <span className="prompt-fidelity-count">{items.length}</span>
                  </header>
                  <p>{fidelityDescription(status)}</p>
                  {items.length ? (
                    <ul>
                      {items.map((item) => (
                        <li key={item.id}>
                          <strong>{item.title}</strong>
                          {item.detail && <span>{item.detail}</span>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="prompt-readable-none">{labels.noItems}</span>
                  )}
                </article>
              )
            })}
          </div>
        </section>
      )}

      {blocks.length > 0 && (
        <section className="prompt-readable-section" aria-labelledby={blocksHeadingId}>
          <h3 id={blocksHeadingId}>{labels.blocks}</h3>
          <div className="prompt-block-list">
            {blocks.map((block) => {
              const status = readableFidelity(block.fidelity)
              const open = expandedBlocks.has(block.id)
              const copyKey = `block:${block.id}`
              const customBlockContent = renderBlockContent?.(block)
              return (
                <details
                  key={block.id}
                  className={`prompt-block-card${showFidelity ? ` fidelity-${status}` : ' prompt-block-card-no-fidelity'}`}
                  data-block-kind={block.kind}
                  open={open}
                  onToggle={(event) => {
                    const nextOpen = event.currentTarget.open
                    setExpandedBlocks((current) => {
                      if (current.has(block.id) === nextOpen) return current
                      const next = new Set(current)
                      if (nextOpen) next.add(block.id)
                      else next.delete(block.id)
                      return next
                    })
                  }}
                >
                  <summary>
                    <span className="prompt-block-chevron" aria-hidden="true">›</span>
                    <span className="prompt-block-heading">
                      <strong>{block.label}</strong>
                      {block.description && <span>{block.description}</span>}
                    </span>
                    {showFidelity && (
                      <span className={`prompt-fidelity-badge fidelity-${status}`}>
                        {fidelityLabel(status)}
                      </span>
                    )}
                    {copyText && block.text && (
                      <button
                        type="button"
                        className="prompt-copy-button"
                        onClick={(event) => copy(event, block.text, { kind: 'block', id: block.id })}
                      >
                        {copiedKey === copyKey ? labels.copied : labels.copy}
                      </button>
                    )}
                  </summary>
                  <div className="prompt-block-body">
                    {customBlockContent !== undefined
                      ? customBlockContent
                      : block.text
                        ? <pre>{block.text}</pre>
                        : <p className="prompt-readable-none">{labels.emptyContent}</p>}
                    {block.sources && block.sources.length > 0 && (
                      <div className="prompt-block-meta">
                        <strong>{labels.sources}</strong>
                        <ul>{block.sources.map((source) => <li key={source}>{source}</li>)}</ul>
                      </div>
                    )}
                    {showLimitations && block.limitations && block.limitations.length > 0 && (
                      <div className="prompt-block-meta prompt-block-caveats">
                        <strong>{labels.blockLimitations}</strong>
                        <ul>{block.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
                      </div>
                    )}
                  </div>
                </details>
              )
            })}
          </div>
        </section>
      )}

      {messages.length > 0 && (
        <section className="prompt-readable-section" aria-labelledby={messagesHeadingId}>
          <h3 id={messagesHeadingId}>{labels.messages}</h3>
          <ol className="prompt-message-list">
            {messages.map((message, index) => {
              const role = message.role.toLocaleLowerCase()
              const roleClass = role.replace(/[^a-z0-9_-]/g, '-')
              const copyKey = `message:${message.id}`
              const textToCopy = message.copyText ?? message.content ?? ''
              return (
                <li key={message.id} className={`prompt-message prompt-message-${roleClass}`}>
                  <header>
                    <span className="prompt-message-index">{index + 1}</span>
                    <strong>{message.label || labels.roles[role] || message.role}</strong>
                    {message.toolCallId && <code>{message.toolCallId}</code>}
                    {copyText && textToCopy && (
                      <button
                        type="button"
                        className="prompt-copy-button"
                        onClick={(event) => copy(event, textToCopy, { kind: 'message', id: message.id })}
                      >
                        {copiedKey === copyKey ? labels.copied : labels.copy}
                      </button>
                    )}
                  </header>
                  <div className="prompt-message-bubble">
                    {message.content
                      ? <pre>{message.content}</pre>
                      : <p className="prompt-readable-none">{labels.emptyContent}</p>}
                    {message.toolCalls && message.toolCalls.length > 0 && (
                      <div className="prompt-tool-call-list">
                        <strong>{labels.toolCalls}</strong>
                        {message.toolCalls.map((call) => (
                          <article key={call.id} className="prompt-tool-call">
                            <header>
                              <strong>{call.name}</strong>
                              <code>{call.id}</code>
                            </header>
                            <div>
                              <span className="prompt-tool-arguments-label">{labels.arguments}</span>
                              <StructuredValue value={call.arguments} />
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        </section>
      )}
    </div>
  )
}
