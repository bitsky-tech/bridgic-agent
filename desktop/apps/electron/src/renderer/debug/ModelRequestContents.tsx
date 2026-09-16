import { useId, useMemo } from 'react'
import type { DebugModelRequest } from '@shared/debug-model-types'
import { useDebugDraft } from './DebugDrafts'
import { useDebugText } from './DebugSessionProvider'
import { PromptMessageList } from './PromptMessageList'
import { RequestItemBrowser } from './RequestItemBrowser'
import { JsonRecord } from './TraceParts'
import { ModelCallParameters } from './ModelCallParameters'

function ToolDefinitions({ tools, stateKey }: { tools: DebugModelRequest['tools']; stateKey: string }) {
  const text = useDebugText()
  const items = useMemo(() => tools.map((tool, index) => ({
    index, label: String(tool.name ?? '?'), preview: String(tool.description ?? '').replace(/\s+/g, ' ').slice(0, 160), search: JSON.stringify(tool),
  })), [tools])
  return <RequestItemBrowser items={items} stateKey={stateKey} label={text('toolDefinitions')} searchLabel={text('modelCall.searchTools')}>
    {index => <div className="debug-request-tool-schema"><p>{String(tools[index]!.description ?? '')}</p>
      <JsonRecord title={text('modelCall.parameterSchema')} value={tools[index]!.parameters} />
      <JsonRecord title={text('modelCall.toolJson')} value={tools[index]} open={false} />
    </div>}
  </RequestItemBrowser>
}

export function ModelRequestContents({ request, stateKey }: { request: DebugModelRequest; stateKey: string }) {
  const text = useDebugText()
  const id = useId()
  const [tab, setTab] = useDebugDraft<'messages' | 'tools' | 'parameters'>(`request-view:${stateKey}`, () => 'messages')
  const tabs = [
    { key: 'messages' as const, label: text('modelCall.messagesTab'), count: request.messages.length },
    { key: 'tools' as const, label: text('toolDefinitions'), count: request.tools.length },
    { key: 'parameters' as const, label: text('modelCall.parametersTab'), count: null },
  ]
  let content
  if (tab === 'messages') content = <PromptMessageList messages={request.messages} stateKey={`${stateKey}:messages`} />
  else if (tab === 'tools') content = <ToolDefinitions tools={request.tools} stateKey={`${stateKey}:tools`} />
  else content = <ModelCallParameters request={request} />
  return <div className="debug-request-contents">
    <div role="tablist" aria-label={text('modelCall.requestParts')} className="debug-request-tabs">
      {tabs.map((item, index) => <button key={item.key} type="button" role="tab" id={`${id}-${item.key}`} aria-label={item.label} aria-controls={`${id}-content`} aria-selected={tab === item.key} tabIndex={tab === item.key ? 0 : -1} onClick={() => setTab(item.key)}
        onKeyDown={event => {
          let next = index
          if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
          else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
          else if (event.key === 'Home') next = 0
          else if (event.key === 'End') next = tabs.length - 1
          else return
          event.preventDefault()
          setTab(tabs[next]!.key)
          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
        }}>
        {item.label}{item.count != null ? <span>{item.count}</span> : null}
      </button>)}
    </div>
    <div role="tabpanel" id={`${id}-content`} aria-labelledby={`${id}-${tab}`}>
      {content}
    </div>
  </div>
}
