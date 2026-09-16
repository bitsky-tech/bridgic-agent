import { useMemo } from 'react'
import { useDebugText } from './DebugSessionProvider'
import { isRequestObject } from './model-request-draft'
import { JsonRecord } from './TraceParts'
import { RequestItemBrowser } from './RequestItemBrowser'

function MessageBlock({ block, index }: { block: unknown; index: number }) {
  const value = isRequestObject(block) ? block : null
  const type = typeof value?.block_type === 'string' ? value.block_type : 'unknown'
  let content = JSON.stringify(block, null, 2)
  if (type === 'text' && typeof value?.text === 'string') content = value.text
  else if (type === 'tool_call') content = JSON.stringify(value?.arguments, null, 2)
  else if (type === 'tool_result') content = typeof value?.content === 'string' ? value.content : JSON.stringify(value?.content, null, 2)
  return <div className="debug-message-block" data-block-type={type}>
    <div className="debug-message-block-heading"><code>blocks[{index}]</code><strong>{type}</strong>
      {type === 'tool_call' && typeof value?.name === 'string' ? <code>{value.name}</code> : null}
      {(type === 'tool_call' || type === 'tool_result') && typeof value?.id === 'string' ? <code className="debug-message-call-id">id: {value.id}</code> : null}
    </div>
    <pre>{content}</pre>
  </div>
}

/** Preserve the complete native list while showing one message's blocks at a time. */
export function PromptMessageList({ messages, stateKey }: { messages: Record<string, unknown>[]; stateKey: string }) {
  const text = useDebugText()
  const items = useMemo(() => messages.map((message, index) => {
    const blocks = Array.isArray(message.blocks) ? message.blocks : []
    const content = blocks.map(block => {
      if (!isRequestObject(block)) return JSON.stringify(block)
      if (block.block_type === 'text') return String(block.text ?? '')
      if (block.block_type === 'tool_call') return `${String(block.name)} ${JSON.stringify(block.arguments)}`
      if (block.block_type === 'tool_result') return typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
      return JSON.stringify(block)
    }).join(' · ') || String(message.content ?? '')
    const role = String(message.role ?? '?')
    return { index, label: role, category: role, preview: content.replace(/\s+/g, ' ').slice(0, 160), search: JSON.stringify(message) }
  }), [messages])
  return <RequestItemBrowser items={items} stateKey={stateKey} label="Message List" searchLabel={text('modelCall.searchMessages')} filterRoles>
    {index => {
      const message = messages[index]!
      const blocks = Array.isArray(message.blocks) ? message.blocks : null
      const metadata = Object.fromEntries(Object.entries(message).filter(([key, value]) => !['role', 'blocks', 'content'].includes(key) && (!isRequestObject(value) || Object.keys(value).length)))
      return <article className="debug-call-message">
          <div className="debug-message-path"><code>messages[{index}]</code><span>{blocks?.length ?? 1} blocks</span></div>
          {blocks ? blocks.map((block, blockIndex) => <MessageBlock key={blockIndex} block={block} index={blockIndex} />)
            : <pre className="debug-message-content">{typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 2)}</pre>}
          {Object.keys(metadata).length ? <JsonRecord title={text('messageMetadata')} value={metadata} open={false} /> : null}
          <JsonRecord title={text('modelCall.rawMessage')} value={message} open={false} />
      </article>
    }}
  </RequestItemBrowser>
}
